/* ============================================================
   KCMPS staff API — POST /orders/{orderId}/verify-payment
                     POST /orders/{orderId}/set-on-hold
   ============================================================
   Staff-side half of the manual GCash bridge (Payment System file,
   "Bridge Payment Method: Manual GCash Verification"). The customer-
   facing half that creates the `payment` object this Lambda reads/
   updates is backend/checkout/submit-payment-proof.js.

   ORDER-LEVEL, not line-item-level: one GCash transaction pays for every
   `sku` line item on the order at once, so verifying/holding acts on ALL
   line items currently awaiting verification on that order in a single
   TransactWriteItems call, and stamps the audit fields on
   ORDER#<id>/META's `payment` sub-object — never on individual line
   items. Mirrors dashboard-data.js's verifyPayment()/setOnHold().

   On Hold replaced the old "Payment Rejected" state (see
   lib/constants.js): a held payment isn't rejected, it's parked while the
   two sides sort out whatever was unclear over email/chat. So both
   Pending Payment Verification AND On Hold line items are eligible for
   verification here — staff resolve the confusion, then click Verify
   Payment once and the order proceeds straight to Confirmed, with no
   detour back through Pending Payment Verification and no forcing the
   customer to resubmit proof they already sent.

   Body shape:
     POST /orders/{orderId}/verify-payment   {}          (no body needed)
     POST /orders/{orderId}/set-on-hold      { "reason": "..." }

   Ported from ops-dashboard/infra/logic-inputs/api-verify-payment.js
   against backend/lib conventions (see backend/CLAUDE.md).

   Operating-hours-aware verification SLA clock: staff can verify a
   payment at any hour — the transition to Confirmed and the "payment
   verified" SES email both fire immediately, off-hours or not, never
   gated on operatingHours. What changes is the *downstream* SLA clock:
   if `verifiedAt` itself falls outside operating hours, each line item's
   `enteredStatusAt` (the field backend/jobs/streams-handler.js copies
   onto GSI1SK, which every SLA/aging read keys off) is stamped with the
   next upcoming operating-hours start instead of the real verification
   instant, so the *next* stage's clock doesn't count overnight/weekend
   hours nobody worked. The real instant is never lost — it's on the
   EVENT# record's `meta.verifiedAt` and on `payment.verifiedAt` below,
   both audit trails, just not what the SLA sweep reads. See
   backend/lib/business-hours.js for the pure clock math. Deliberately
   NOT applied to set-on-hold — a hold's only downstream step is an
   out-of-band email/chat conversation, which isn't itself SLA-tracked.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { STATUS, orderPk, metaSk, configPk, lineItemSk, buildEvent, extractClaims, isStaff, attrsToRemoveOnTerminal } = require("../lib");
const { DEFAULT_OPERATING_HOURS, isWithinOperatingHours, nextOperatingStart } = require("../lib/business-hours");

const TABLE = process.env.TABLE_NAME;
// Same FROM_EMAIL/EMAIL_RE gate as submit-payment-proof.js — unset today
// (SES is still sandboxed, see docs/roadmap.md), so this ships dark and
// activates the moment that env var is set, no code change needed.
const FROM_EMAIL = process.env.FROM_EMAIL;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) {
    return response(403, { error: "Staff only" });
  }

  const orderId = event.pathParameters?.orderId;
  const isOnHold = event.rawPath?.endsWith("/set-on-hold") || event.resource?.endsWith("/set-on-hold");
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  if (isOnHold && !body.reason) return response(400, { error: "reason is required to put a payment on hold" });

  const pk = orderPk(orderId);
  const [orderRes, lineItemsRes] = await Promise.all([
    client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } })),
    client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "LINEITEM#" },
    })),
  ]);
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });
  // Verifying needs a real GCash screenshot/reference to check against, but
  // putting a payment on hold doesn't — staff must be able to park an order
  // for any reason (nothing received, unclear instructions, etc.) even
  // before any proof was ever submitted, since sku line items enter
  // "Pending Payment Verification" immediately at checkout
  // (create-order.js), well before submit-payment-proof.js ever runs.
  if (!isOnHold && !order.payment) return response(409, { error: "Order has no GCash payment proof on file" });

  // Verifying accepts BOTH statuses so a held payment can be confirmed
  // directly once staff and customer have sorted things out over email/chat
  // (see file header). Holding only applies to items still pending — an
  // already-held item has nowhere to go, and ON_HOLD -> ON_HOLD isn't a
  // legal transition in advance-line-item.js's LEGAL_TRANSITIONS either.
  const eligibleStatuses = isOnHold
    ? [STATUS.PENDING_PAYMENT_VERIFICATION]
    : [STATUS.PENDING_PAYMENT_VERIFICATION, STATUS.ON_HOLD];
  const pendingLineItems = (lineItemsRes.Items || []).filter((li) => eligibleStatuses.includes(li.status));
  if (!pendingLineItems.length) return response(409, { error: "No line items on this order are awaiting verification" });

  const now = new Date().toISOString();
  const staffName = claims.name || claims.email;
  const toStatus = isOnHold ? STATUS.ON_HOLD : STATUS.CONFIRMED;
  const removeAttrs = attrsToRemoveOnTerminal(toStatus); // both statuses stay active today, kept for consistency if that ever changes

  // slaClockStartsAt anchors the NEXT stage's SLA clock (via
  // enteredStatusAt/GSI1SK); `now` (verifiedAt) stays the real instant on
  // the event/payment audit trail regardless. See file header.
  let slaClockStartsAt = now;
  let verifiedWithinOperatingHours = true;
  if (!isOnHold) {
    const operatingHours = await getOperatingHours();
    verifiedWithinOperatingHours = isWithinOperatingHours(now, operatingHours);
    if (!verifiedWithinOperatingHours) slaClockStartsAt = nextOperatingStart(now, operatingHours);
  }

  const transactItems = [];

  pendingLineItems.forEach((li) => {
    let updateExpression = "SET #status = :to, enteredStatusAt = :entered";
    if (removeAttrs.length) updateExpression += ` REMOVE ${removeAttrs.join(", ")}`;
    // The optimistic-lock `from` is per item, not one value for the whole
    // transaction: a verify can now sweep up a mix of Pending Payment
    // Verification and On Hold line items on the same order, so hardcoding
    // either one would fail the condition (and cancel the entire
    // transaction) for every item in the other status.
    const fromStatus = li.status;
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: pk, SK: li.SK },
        ConditionExpression: "#status = :from",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":to": toStatus, ":from": fromStatus, ":entered": slaClockStartsAt },
      },
    });
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: buildEvent({
          orderId, lineItemId: li.lineItemId, from: fromStatus, to: toStatus,
          actorSub: claims.sub, actorName: staffName, station: li.station || null,
          at: now,
          meta: isOnHold
            ? { via: "setOnHold", holdReason: body.reason }
            : { via: "verifyPayment", verifiedAt: now, slaClockStartsAt, verifiedWithinOperatingHours },
        }),
      },
    });
  });

  // When holding an order that never had any GCash proof submitted,
  // `payment` is still the NULL scalar create-order.js writes at checkout —
  // `SET payment.holdReason = ...` would fail (can't set a nested path on a
  // non-map attribute), so replace the whole attribute in that case instead
  // of patching a nested field.
  const paymentUpdate = isOnHold && !order.payment
    ? {
        UpdateExpression: "SET payment = :payment",
        ExpressionAttributeValues: {
          ":payment": {
            method: null, claimedAmount: null, gcashRefNumber: null, screenshotRef: null,
            submittedAt: null, verifiedBy: null, verifiedAt: null, holdReason: body.reason,
          },
        },
      }
    : {
        UpdateExpression: isOnHold
          ? "SET payment.holdReason = :reason, payment.verifiedBy = :null, payment.verifiedAt = :null"
          : "SET payment.verifiedBy = :staff, payment.verifiedAt = :now, payment.holdReason = :null",
        ExpressionAttributeValues: isOnHold
          ? { ":reason": body.reason, ":null": null }
          : { ":staff": staffName, ":now": now, ":null": null },
      };
  transactItems.push({
    Update: {
      TableName: TABLE,
      Key: { PK: pk, SK: metaSk() },
      ...paymentUpdate,
    },
  });

  await client.send(new TransactWriteCommand({ TransactItems: transactItems })).catch((err) => {
    if (err.name === "TransactionCanceledException") {
      throw Object.assign(new Error("Order's payment or line items changed concurrently — reload and retry."), { statusCode: 409 });
    }
    throw err;
  });

  // orderStatus recomputes asynchronously via backend/jobs/streams-handler.js
  // off the line-item writes above — same pattern as advance-line-item.js,
  // no duplicated rollup logic here.

  // Two of the three customer notifications the Payment System spec calls
  // for were missing (only the "under verification" email at submission
  // time existed) — a customer whose payment was verified or held had no
  // way to find out except by loading the tracking page. Best-effort,
  // same pattern as submit-payment-proof.js: never fail the staff action
  // over a notification, and skip silently for non-email contacts (the
  // checkout contact field is free text — phone numbers can't receive SES).
  if (FROM_EMAIL && order.email) {
    const send = isOnHold ? sendOnHoldEmail : sendVerifiedEmail;
    await send(order, orderId, body.reason).catch((err) => {
      console.error(`verifyPayment: SES send failed (${isOnHold ? "on-hold" : "verify"}):`, err.message);
    });
  }

  return response(200, {
    orderId, action: isOnHold ? "on-hold" : "verified",
    lineItemsAffected: pendingLineItems.map((li) => li.lineItemId), at: now,
  });
};

// CONFIG#OPERATING_HOURS/META doesn't exist until a future Settings API
// (website/dashboard/settings.html) writes one — falling back to
// DEFAULT_OPERATING_HOURS means this feature works correctly with zero
// manual setup, and picks up a real override the moment one is ever
// written, with no migration step either way.
async function getOperatingHours() {
  const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: configPk("OPERATING_HOURS"), SK: metaSk() } }));
  return res.Item || DEFAULT_OPERATING_HOURS;
}

async function sendVerifiedEmail(order, orderId) {
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    // Bcc admin@kcmps.com — same "the Bcc is the sent-log" reasoning as
    // submit-payment-proof.js, so dashboard/email.html sees this too.
    Destination: { ToAddresses: [order.email], BccAddresses: ["admin@kcmps.com"] },
    Message: {
      Subject: { Data: `Order ${orderId} verified — payment confirmed` },
      Body: { Text: { Data:
        `Hi ${order.customerName},\n\n` +
        `Payment confirmed for order ${orderId} — it's moving to production now.\n\n` +
        `— KCMPS`
      } },
    },
  }));
  await logCorrespondence(orderPk(orderId), "Emailed customer: payment confirmed").catch((err) => {
    console.error("verifyPayment: correspondence log failed:", err.message);
  });
}

// Deliberately NOT a "your payment was rejected, please resubmit" email —
// that was the old Payment Rejected flow. A hold means we've almost
// certainly got the money and just need to clear something up, so this is a
// heads-up that a human will follow up, not a task assigned to the customer.
// Nothing here asks them to resubmit proof through the site; production
// resumes the moment staff hit Verify Payment.
async function sendOnHoldEmail(order, orderId, reason) {
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [order.email], BccAddresses: ["admin@kcmps.com"] },
    Message: {
      Subject: { Data: `Order ${orderId} — your payment needs a quick check` },
      Body: { Text: { Data:
        `Hi ${order.customerName},\n\n` +
        `We've put order ${orderId} on hold for a moment while we check something: ${reason}\n\n` +
        `No action needed on the website — we'll follow up by email or chat to sort it out. ` +
        `Once it's cleared up, production starts automatically.\n\n` +
        `— KCMPS`
      } },
    },
  }));
  await logCorrespondence(orderPk(orderId), "Emailed customer: payment on hold").catch((err) => {
    console.error("verifyPayment: correspondence log failed:", err.message);
  });
}

// Surfaces in job-detail.html's "Customer correspondence" card so staff can
// see at a glance that a touchpoint's email actually went out — best-effort
// and separate from the send itself (a log-write failure must never look
// like the email failed).
async function logCorrespondence(pk, note) {
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET correspondenceLog = list_append(correspondenceLog, :entry)",
    ExpressionAttributeValues: { ":entry": [{ at: new Date().toISOString(), note, actorName: "System (auto-email)" }] },
  }));
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
