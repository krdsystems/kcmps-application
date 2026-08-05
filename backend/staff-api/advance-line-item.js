/* ============================================================
   KCMPS staff API — POST /line-items/{lineItemId}/advance
   ============================================================
   Validates the requested transition against the state machine and
   writes the line item update + the append-only event record ATOMICALLY
   via TransactWriteItems, so a crash mid-write can never leave a status
   change without its corresponding event (which would silently corrupt
   every metric/cycle-time calc downstream).

   Body shape (mirrors dashboard-data.js's advanceLineItem args):
   {
     "orderId": "ORD-95KLCI",
     "lineItemId": "L10",
     "to": "In Production",
     "station": "PRESS-01",      // optional
     "setupMinutes": 18,          // optional
     "meta": {}                   // optional, passed through to the event
   }

   Ported from ops-dashboard/infra/logic-inputs/api-advance-line-item.js
   against backend/lib conventions (see backend/CLAUDE.md).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, TransactWriteCommand, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { STATUS, orderPk, metaSk, lineItemSk, buildEvent, extractClaims, isStaff, activeStatusAttrs, attrsToRemoveOnTerminal } = require("../lib");

const TABLE = process.env.TABLE_NAME;
// Same FROM_EMAIL gate as the other staff-api/checkout Lambdas — unset
// disables sending entirely, best-effort, never blocks the staff action.
const FROM_EMAIL = process.env.FROM_EMAIL;
const ses = new SESClient({});

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The last 2 of the 4 happy-path customer notifications (see create-
// order.js/verify-payment.js for the first two). Keyed by the `to` status
// this Lambda just wrote — only these 2 transitions notify the customer;
// every other transition (Scheduled, In Production, QC, Ready for
// Dispatch, Rework, terminal Delivered/Picked Up) stays silent, matching
// the Payment System spec's "self-serve progress bar, not a push per
// stage" design.
//
// READY_FOR_DISPATCH was a 3rd touchpoint here until 2026-08-04 — pulled
// after live testing surfaced it as the wrong moment to push: it fires
// the instant QC passes, before the item is actually with a courier, so
// (a) the customer can't act on it either way and (b) the copy leaked an
// internal QA term ("passed quality check") into a customer-facing
// email. DISPATCHED ("shipped out, on its way") is the transition that's
// actually meaningful to a delivery customer, so that's the one that
// stays a push; READY_FOR_DISPATCH now only logs an internal system note
// (see sendInternalNote() below) — staff-visible, never emailed.
const SHIP_STAGE_EMAIL = {
  [STATUS.DISPATCHED]: (order, orderId) => ({
    subject: `Order ${orderId} — shipped out`,
    body: `Hi ${order.customerName},\n\n` +
      `Your order ${orderId} has shipped out and is on its way to you.\n\n— KCMPS`,
  }),
  [STATUS.READY_FOR_PICKUP]: (order, orderId) => ({
    subject: `Order ${orderId} — ready for pickup`,
    body: `Hi ${order.customerName},\n\n` +
      `Your order ${orderId} is ready for pickup at KCMPS.\n\n— KCMPS`,
  }),
};

// Transitions that get a staff-visible correspondence-log note but NEVER
// an actual customer email — distinct from SHIP_STAGE_EMAIL above.
// `actorName: "System"` (not "System (auto-email)") is the tell in
// job-detail.html's Customer correspondence card that nothing was
// actually sent to the customer, just recorded for staff.
const INTERNAL_ONLY_NOTE = {
  [STATUS.READY_FOR_DISPATCH]: "Passed QC — ready for dispatch (internal note, not emailed to customer)",
};

// Legal transitions — mirrors NEXT_STATUS in dashboard-data.js, plus the
// branches (QC pass/fail, verification reject) that need an explicit `to`.
// QC branches on the order's fulfillment method (§6): Delivery orders go
// Ready for Dispatch -> Dispatched -> Delivered; Pickup orders go Ready for
// Pickup -> Picked Up (that order's terminal/Delivered-equivalent state —
// see deriveOrderStatus()). Both post-QC branches are listed as legal from
// QC itself so a staff correction (wrong branch picked) doesn't need a
// second Lambda — the handler below still only offers the one matching the
// order's actual fulfillment method as the *expected* path, but doesn't
// hard-block the other one at the state-machine level.
const LEGAL_TRANSITIONS = {
  [STATUS.ORDER_PLACED]: [STATUS.PENDING_PAYMENT_VERIFICATION], // submitPaymentProof.js does this write, not this Lambda
  [STATUS.PENDING_PAYMENT_VERIFICATION]: [STATUS.CONFIRMED, STATUS.ON_HOLD],
  // CONFIRMED is listed here (not just PENDING_PAYMENT_VERIFICATION) so a
  // held payment can be verified in one click once staff and customer have
  // sorted things out over email/chat — matching verify-payment.js, which
  // accepts On Hold line items directly. The route back to Pending Payment
  // Verification stays legal for the case where the customer does end up
  // resubmitting proof (submit-payment-proof.js).
  [STATUS.ON_HOLD]: [STATUS.PENDING_PAYMENT_VERIFICATION, STATUS.CONFIRMED],
  [STATUS.QUOTED]: [STATUS.PRICED, STATUS.QUOTE_EXPIRED],
  [STATUS.PRICED]: [STATUS.CONFIRMED, STATUS.QUOTE_EXPIRED],
  [STATUS.CONFIRMED]: [STATUS.SCHEDULED],
  [STATUS.SCHEDULED]: [STATUS.IN_PRODUCTION],
  [STATUS.IN_PRODUCTION]: [STATUS.QC],
  [STATUS.QC]: [STATUS.READY_FOR_DISPATCH, STATUS.READY_FOR_PICKUP, STATUS.REWORK],
  [STATUS.REWORK]: [STATUS.IN_PRODUCTION],
  [STATUS.READY_FOR_DISPATCH]: [STATUS.DISPATCHED],
  [STATUS.DISPATCHED]: [STATUS.DELIVERED],
  [STATUS.READY_FOR_PICKUP]: [STATUS.PICKED_UP],
};

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) {
    return response(403, { error: "Staff only" });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  const { orderId, lineItemId, to, station, setupMinutes, meta } = body;
  if (!orderId || !lineItemId || !to) return response(400, { error: "orderId, lineItemId, and to are required" });

  const pk = orderPk(orderId);
  const sk = lineItemSk(lineItemId);
  const current = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
  if (!current.Item) return response(404, { error: "Line item not found" });

  const from = current.Item.status;
  const allowed = LEGAL_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return response(409, { error: `Illegal transition: ${from} -> ${to}. Allowed: ${allowed.join(", ") || "(none — terminal state)"}` });
  }

  const now = new Date().toISOString();
  const gsiAttrs = activeStatusAttrs(to, now);
  const removeAttrs = attrsToRemoveOnTerminal(to);

  const updateParts = ["#status = :to", "enteredStatusAt = :now"];
  const names = { "#status": "status" };
  const values = { ":to": to, ":now": now, ":from": from };
  if (station) { updateParts.push("station = :station"); values[":station"] = station; }
  if (setupMinutes != null) { updateParts.push("setupMinutes = :setup"); values[":setup"] = setupMinutes; }
  if (gsiAttrs) {
    updateParts.push("GSI1PK = :gsi1pk", "GSI1SK = :gsi1sk");
    values[":gsi1pk"] = gsiAttrs.GSI1PK;
    values[":gsi1sk"] = gsiAttrs.GSI1SK;
  }
  let updateExpression = `SET ${updateParts.join(", ")}`;
  if (removeAttrs.length) updateExpression += ` REMOVE ${removeAttrs.join(", ")}`;

  let conflict = false;
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: sk },
          ConditionExpression: "#status = :from", // optimistic lock — fails if someone else moved it first
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: buildEvent({
            orderId, lineItemId, from, to,
            actorSub: claims.sub, actorName: claims.name || claims.email,
            station: station || current.Item.station || null,
            at: now, meta,
          }),
        },
      },
    ],
  })).catch((err) => {
    if (err.name === "TransactionCanceledException") { conflict = true; return; }
    throw err;
  });
  if (conflict) return response(409, { error: "Line item changed concurrently — reload and retry." });

  // orderStatus is NOT recomputed here — the DynamoDB Streams handler
  // (backend/jobs/streams-handler.js) does that asynchronously off the
  // line-item write above, so every code path that changes status (this
  // Lambda, expire-pending-orders.js, a future customer-approval Lambda)
  // gets a consistent rollup without duplicating deriveOrderStatus().

  const buildEmail = SHIP_STAGE_EMAIL[to];
  if (FROM_EMAIL && buildEmail) {
    await sendShipStageEmail(pk, orderId, buildEmail).catch((err) => {
      console.error(`advanceLineItem: SES send failed (${to}):`, err.message);
    });
  }
  const internalNote = INTERNAL_ONLY_NOTE[to];
  if (internalNote) {
    await logCorrespondence(pk, internalNote, "System").catch((err) => {
      console.error(`advanceLineItem: internal note log failed (${to}):`, err.message);
    });
  }

  return response(200, { lineItemId, from, to, at: now });
};

async function sendShipStageEmail(pk, orderId, buildEmail) {
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order || !order.email) return; // guest with no email, or free-text-only contact — nothing to send to
  const { subject, body } = buildEmail(order, orderId);
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    // Bcc admin@kcmps.com — same "the Bcc is the sent-log" reasoning as
    // submit-payment-proof.js, so dashboard/email.html sees this too.
    Destination: { ToAddresses: [order.email], BccAddresses: ["admin@kcmps.com"] },
    Message: { Subject: { Data: subject }, Body: { Text: { Data: body } } },
  }));
  // Surfaces in job-detail.html's "Customer correspondence" card so staff
  // can see at a glance that this touchpoint's email actually went out —
  // best-effort and separate from the send above (a log-write failure
  // must never look like the email itself failed).
  await logCorrespondence(pk, `Emailed customer: ${subject.replace(`Order ${orderId} — `, "")}`).catch((err) => {
    console.error("advanceLineItem: correspondence log failed:", err.message);
  });
}

// actorName defaults to "System (auto-email)" (an SES send actually
// happened) — pass "System" explicitly for an internal-only note
// (INTERNAL_ONLY_NOTE above) so the correspondence card can't be misread
// as "this went to the customer" when it didn't.
async function logCorrespondence(pk, note, actorName) {
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET correspondenceLog = list_append(correspondenceLog, :entry)",
    ExpressionAttributeValues: { ":entry": [{ at: new Date().toISOString(), note, actorName: actorName || "System (auto-email)" }] },
  }));
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
