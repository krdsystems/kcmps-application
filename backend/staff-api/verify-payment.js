/* ============================================================
   KCMPS staff API — POST /orders/{orderId}/verify-payment
                     POST /orders/{orderId}/reject-payment
   ============================================================
   Staff-side half of the manual GCash bridge (Payment System file,
   "Bridge Payment Method: Manual GCash Verification"). The customer-
   facing half that creates the `payment` object this Lambda reads/
   updates is backend/checkout/submit-payment-proof.js.

   ORDER-LEVEL, not line-item-level: one GCash transaction pays for every
   `sku` line item on the order at once, so verifying/rejecting acts on
   ALL line items currently Pending Payment Verification on that order in
   a single TransactWriteItems call, and stamps the audit fields on
   ORDER#<id>/META's `payment` sub-object — never on individual line
   items. Mirrors dashboard-data.js's verifyPayment()/rejectPayment().

   Body shape:
     POST /orders/{orderId}/verify-payment   {}          (no body needed)
     POST /orders/{orderId}/reject-payment   { "reason": "..." }

   Ported from ops-dashboard/infra/logic-inputs/api-verify-payment.js
   against backend/lib conventions (see backend/CLAUDE.md).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { STATUS, orderPk, metaSk, lineItemSk, buildEvent, extractClaims, getGroups, isStaff, attrsToRemoveOnTerminal } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const LEGACY_STAFF_GROUP = "Staff"; // see get-orders.js for why both are accepted

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims) && !getGroups(claims).includes(LEGACY_STAFF_GROUP)) {
    return response(403, { error: "Staff only" });
  }

  const orderId = event.pathParameters?.orderId;
  const isReject = event.rawPath?.endsWith("/reject-payment") || event.resource?.endsWith("/reject-payment");
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  if (isReject && !body.reason) return response(400, { error: "reason is required to reject a payment" });

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
  // rejecting doesn't — staff must be able to reject an order for any reason
  // (customer never paid, wrong item, etc.) even before any proof was ever
  // submitted, since sku line items enter "Pending Payment Verification"
  // immediately at checkout (create-order.js), well before submit-payment-
  // proof.js ever runs.
  if (!isReject && !order.payment) return response(409, { error: "Order has no GCash payment proof on file" });

  const pendingLineItems = (lineItemsRes.Items || []).filter((li) => li.status === STATUS.PENDING_PAYMENT_VERIFICATION);
  if (!pendingLineItems.length) return response(409, { error: "No line items on this order are awaiting verification" });

  const now = new Date().toISOString();
  const staffName = claims.name || claims.email;
  const toStatus = isReject ? STATUS.PAYMENT_REJECTED : STATUS.CONFIRMED;
  const removeAttrs = attrsToRemoveOnTerminal(toStatus); // both statuses stay active today, kept for consistency if that ever changes
  const transactItems = [];

  pendingLineItems.forEach((li) => {
    let updateExpression = "SET #status = :to, enteredStatusAt = :now";
    if (removeAttrs.length) updateExpression += ` REMOVE ${removeAttrs.join(", ")}`;
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: pk, SK: li.SK },
        ConditionExpression: "#status = :from",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":to": toStatus, ":from": STATUS.PENDING_PAYMENT_VERIFICATION, ":now": now },
      },
    });
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: buildEvent({
          orderId, lineItemId: li.lineItemId, from: STATUS.PENDING_PAYMENT_VERIFICATION, to: toStatus,
          actorSub: claims.sub, actorName: staffName, station: li.station || null,
          at: now, meta: isReject ? { via: "rejectPayment", rejectionReason: body.reason } : { via: "verifyPayment" },
        }),
      },
    });
  });

  // When rejecting an order that never had any GCash proof submitted,
  // `payment` is still the NULL scalar create-order.js writes at checkout —
  // `SET payment.rejectionReason = ...` would fail (can't set a nested path
  // on a non-map attribute), so replace the whole attribute in that case
  // instead of patching a nested field.
  const paymentUpdate = isReject && !order.payment
    ? {
        UpdateExpression: "SET payment = :payment",
        ExpressionAttributeValues: {
          ":payment": {
            method: null, claimedAmount: null, gcashRefNumber: null, screenshotRef: null,
            submittedAt: null, verifiedBy: null, verifiedAt: null, rejectionReason: body.reason,
          },
        },
      }
    : {
        UpdateExpression: isReject
          ? "SET payment.rejectionReason = :reason, payment.verifiedBy = :null, payment.verifiedAt = :null"
          : "SET payment.verifiedBy = :staff, payment.verifiedAt = :now, payment.rejectionReason = :null",
        ExpressionAttributeValues: isReject
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

  return response(200, {
    orderId, action: isReject ? "rejected" : "verified",
    lineItemsAffected: pendingLineItems.map((li) => li.lineItemId), at: now,
  });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
