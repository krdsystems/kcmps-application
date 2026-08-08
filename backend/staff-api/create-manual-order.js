/* ============================================================
   KCMPS staff API — POST /orders/manual (staff-entered orders)
   ============================================================
   Real backend for jobs.html's "+ New manual order" form — walk-in/
   phone/Messenger-DM orders a staffer logs on the customer's behalf, no
   checkout involved. Until now this wrote only to dashboard-data.js's
   localStorage mock (createManualOrder()): the order existed on exactly
   the one browser/device that created it, invisible everywhere else and
   gone if that browser's storage was ever cleared. Owner-reported
   2026-08-08 as a real cross-device data-consistency bug.

   Deliberately modeled on backend/checkout/create-order.js's real
   TransactWriteItems shape (order META + LINEITEM# + EVENT#, same
   orderId minting, same STATUS vocabulary, same peso-float money for the
   same reason create-order.js gives: converting one Lambda to centavos
   while every other money field in the codebase stays peso floats would
   silently corrupt downstream metrics by 100x) — a manual order and a
   checkout order should be indistinguishable to every OTHER Lambda/page
   that reads orders. source: "manual" is the only marker, same as the
   mock always used, so existing "Manual" badges (jobs.html) and
   isMockOnlyOrder() gates (dashboard-data.js's addCorrespondence/
   verifyPayment/setOnHold) keep working — though isMockOnlyOrder() should
   now never actually match a NEWLY created order, since this Lambda
   writes real DynamoDB items, not the local blob.

   NO "Client" ENTITY. create-order.js never persists one either — a real
   customer order just stores customerName/email/phone flat on the order,
   and dashboard-data.js's normalizeOrder() synthesizes order.client =
   {name} client-side for display. This Lambda does the same. The mock's
   client dropdown/"+ New client" flow stays exactly as-is in jobs.html
   and dashboard-data.js as a LOCAL convenience autocomplete (recent
   names, nothing more) — building a real Client/CRM table is unrelated,
   larger scope nobody asked for; see docs/roadmap.md if that's ever
   wanted for real.

   AUTH: isStaff() (any staff role) — logging a walk-in order is a
   routine staff action, not admin-only, same gate as
   add-correspondence.js. actorSub/actorName on the EVENT# record are the
   VERIFIED caller's own claims, not a free-text field the old mock
   accepted (opts.actorName) — a real improvement, not a regression: the
   audit trail can no longer be spoofed to say someone else logged it.
   ============================================================ */

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const {
  STATUS, baseItem, buildEvent, orderPk, metaSk, lineItemSk,
  activeStatusAttrs, deriveOrderStatus, extractClaims, isStaff,
} = require("../lib");

const TABLE = process.env.TABLE_NAME;
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Mirrors jobs.html's MANUAL_STATUS_OPTIONS exactly — the two vocabularies
// must never drift, since a status this Lambda rejects but the form still
// offers would read as a mysterious 400 to staff.
const ALLOWED_STATUSES = {
  sku: [STATUS.PENDING_PAYMENT_VERIFICATION, STATUS.CONFIRMED],
  custom: [STATUS.QUOTED, STATUS.PRICED, STATUS.CONFIRMED],
};

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return response(400, { error: "Invalid JSON body" }); }

  const customerName = str(body.customerName).trim();
  if (!customerName) return response(400, { error: "customerName is required" });
  const description = str(body.description).trim();
  if (!description) return response(400, { error: "A description is required." });
  const promisedDate = str(body.promisedDate).trim();
  if (!promisedDate || Number.isNaN(Date.parse(promisedDate))) {
    return response(400, { error: "A valid promisedDate is required." });
  }

  const type = body.type === "custom" ? "custom" : "sku";
  const allowed = ALLOWED_STATUSES[type];
  const status = allowed.includes(body.status) ? body.status : allowed[0];
  const qty = Math.max(1, parseInt(body.qty, 10) || 1);
  const priceEachNum = body.priceEach !== "" && body.priceEach != null && !Number.isNaN(parseFloat(body.priceEach))
    ? parseFloat(body.priceEach) : null;
  const priceEach = type === "sku" ? priceEachNum : null;
  const amount = priceEach != null ? Math.round(priceEach * qty * 100) / 100 : 0;

  let payment = null;
  if (status === STATUS.PENDING_PAYMENT_VERIFICATION) {
    const gcashRefNumber = str(body.gcashRefNumber).trim();
    const claimedAmount = parseFloat(body.claimedAmount);
    if (!gcashRefNumber) return response(400, { error: "A GCash reference number is required for Pending Payment Verification." });
    if (!(claimedAmount > 0)) return response(400, { error: "A claimed amount is required for Pending Payment Verification." });
    const now = new Date().toISOString();
    payment = {
      method: "gcash_manual", claimedAmount, gcashRefNumber, submittedAt: now,
      screenshotRef: null, verifiedBy: null, verifiedAt: null, holdReason: null,
    };
  }

  // Confirmed = already paid by whatever method — no proof object for
  // cash, so it's logged as a plain note instead (same reasoning as the
  // mock: forcing cash through a GCash-shaped payment object would mislabel
  // it on job-detail.html, which renders payment.gcashRefNumber verbatim).
  let notes = str(body.notes).trim();
  if (status === STATUS.CONFIRMED && body.paidVia) {
    const viaLabel = body.paidVia === "cash" ? "Cash" : body.paidVia === "gcash" ? "GCash" : "Other";
    const ref = str(body.paidRef).trim();
    const paidNote = `Paid via ${viaLabel}${ref ? ` (ref ${ref})` : ""}.`;
    notes = notes ? `${paidNote} ${notes}` : paidNote;
  }

  const now = new Date().toISOString();
  // Same 40-bit-of-real-UUID scheme as create-order.js, not the mock's
  // 6-char Math.random() id — manual and checkout orders share one ID
  // space, so normalizeOrderId()/lookup-order.js treat them identically.
  const orderId = "ORD-" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const pk = orderPk(orderId);
  const lineItemId = "L1-" + Math.random().toString(36).slice(2, 6).toUpperCase();

  const lineItem = {
    ...baseItem({ status, createdAt: now }),
    PK: pk, SK: lineItemSk(lineItemId),
    lineItemId, orderId, type,
    sku: str(body.sku).trim() || null,
    qty, priceEach, amount,
    description,
    station: null, setupMinutes: null, spoilage: [],
    enteredStatusAt: now, notes,
    ...(activeStatusAttrs(status, now) || {}),
  };

  const orderStatus = deriveOrderStatus([status]);
  const orderItem = {
    ...baseItem({ status: orderStatus, createdAt: now }),
    PK: pk, SK: metaSk(),
    orderId, customerSub: null, customerName,
    email: str(body.email).trim() || null, phone: str(body.phone).trim() || null,
    orderStatus, originalPromisedDate: promisedDate,
    payment, correspondenceLog: [], source: "manual",
  };

  const transactItems = [
    { Put: { TableName: TABLE, Item: orderItem, ConditionExpression: "attribute_not_exists(PK)" } },
    { Put: { TableName: TABLE, Item: lineItem } },
    {
      Put: {
        TableName: TABLE,
        Item: buildEvent({
          orderId, lineItemId, from: null, to: status,
          actorSub: claims.sub, actorName: claims.name || claims.email || "Staff",
          meta: { via: "manualOrder" }, at: now,
        }),
      },
    },
  ];

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      return response(409, { error: "Could not create the order — please retry." });
    }
    throw err;
  }

  return response(201, {
    orderId, orderStatus,
    lineItems: [{ lineItemId, type, status, amount }],
  });
};

function str(v) { return typeof v === "string" ? v : ""; }

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
