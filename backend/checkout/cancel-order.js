/* ============================================================
   KCMPS Checkout — POST /orders/{orderId}/cancel
   ============================================================
   Customer self-service cancel (My Orders plan, Phase 3). No API Gateway
   authorizer — guest checkout is a hard requirement (create-order.js's
   header), so this Lambda does its own two-tier authorization, same shape
   as lookup-order.js:
     1. A Bearer ID token, IF sent and valid AND its sub matches this
        order's customerSub -> authorized as the account owner.
     2. Otherwise, a `contact` in the body matching any of the order's
        contact fields (backend/lib/customer-view.js's contactsMatch, same
        normalization as lookup-order.js) -> authorized as the guest who
        placed it.
   A token that verifies but belongs to a DIFFERENT sub is a real "you're
   logged in as someone else" case (403, not the enumeration-safe 404
   below — the caller already proved an identity, there's nothing to hide
   by being direct). A missing/invalid token or a non-matching contact
   gets the same generic, artificially-delayed 404 lookup-order.js uses,
   so a wrong orderId and a wrong contact are indistinguishable.

   ONLY allowed while every line item is still pre-production (Order
   Placed, Quoted, Priced, Pending Payment Verification, or Payment
   Rejected) — the moment ANY line item is Confirmed or beyond, KCMPS has
   committed material/schedule to it, so cancellation becomes a staff
   conversation, not a button (409, pointed at support).

   Writes a Cancelled status + EVENT# per line item, same
   TransactWriteItems/optimistic-lock shape as verify-payment.js. Does
   NOT write orderStatus — backend/jobs/streams-handler.js is the only
   writer of that field (see its own header).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { STATUS, orderPk, metaSk, eventSk, attrsToRemoveOnTerminal, contactsMatch } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const ARTIFICIAL_DELAY_MS = 300;

const CANCELLABLE_STATUSES = new Set([
  STATUS.ORDER_PLACED, STATUS.QUOTED, STATUS.PRICED, STATUS.PENDING_PAYMENT_VERIFICATION, STATUS.ON_HOLD,
]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const verifier = USER_POOL_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "id", clientId: CLIENT_ID })
  : null;

exports.handler = async (event) => {
  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk(orderId), SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order) { await sleep(ARTIFICIAL_DELAY_MS); return response(404, { error: "No order found for that order ID and contact." }); }

  const sub = await tryGetSub(event);
  let actorSub = null;
  if (sub) {
    if (sub !== order.customerSub) return response(403, { error: "You don't have access to this order." });
    actorSub = sub;
  } else {
    if (!contactsMatch(body.contact || "", order)) {
      await sleep(ARTIFICIAL_DELAY_MS);
      return response(404, { error: "No order found for that order ID and contact." });
    }
  }

  const lineItemsRes = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "LINEITEM#" },
  }));
  const lineItems = lineItemsRes.Items || [];
  if (!lineItems.length) return response(409, { error: "This order has no line items to cancel." });

  const notCancellable = lineItems.filter((li) => !CANCELLABLE_STATUSES.has(li.status));
  if (notCancellable.length) {
    return response(409, {
      error: "This order is already in production and can't be cancelled online — message us and we'll help.",
    });
  }

  const now = new Date().toISOString();
  const removeAttrs = attrsToRemoveOnTerminal(STATUS.CANCELLED);
  const transactItems = [];

  lineItems.forEach((li) => {
    let updateExpression = "SET #status = :to, enteredStatusAt = :now";
    if (removeAttrs.length) updateExpression += ` REMOVE ${removeAttrs.join(", ")}`;
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: order.PK, SK: li.SK },
        ConditionExpression: "#status = :from",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":to": STATUS.CANCELLED, ":from": li.status, ":now": now },
      },
    });
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          PK: order.PK, SK: eventSk(now, li.lineItemId),
          lineItemId: li.lineItemId, from: li.status, to: STATUS.CANCELLED,
          actorSub, actorName: order.customerName,
          station: null, at: now, meta: { via: "customerCancel", reason: body.reason || null },
        },
      },
    });
  });

  // Same conflict-flag pattern as create-order.js/submit-payment-proof.js/
  // verify-payment.js/advance-line-item.js: set a flag inside the .catch
  // (re-throwing anything that isn't TransactionCanceledException), then
  // return the 409 JSON inline in the handler — a thrown Error with
  // .statusCode attached would never be caught by anything and would
  // surface to the caller as a raw Lambda/API Gateway error instead.
  let conflict = false;
  await client.send(new TransactWriteCommand({ TransactItems: transactItems })).catch((err) => {
    if (err.name === "TransactionCanceledException") { conflict = true; return; }
    throw err;
  });
  if (conflict) return response(409, { error: "This order changed just now — reload and try again." });

  // orderStatus recomputes asynchronously via streams-handler.js, same as
  // verify-payment.js / advance-line-item.js — no duplicated rollup logic.

  return response(200, { orderId, action: "cancelled", lineItemsAffected: lineItems.map((li) => li.lineItemId), at: now });
};

// Mirrors create-order.js's tryGetSub — verifies a Bearer token IF one was
// sent, returns null (no identity proven) on any absence/failure rather
// than throwing, since a guest caller is expected to hit this same path.
async function tryGetSub(event) {
  if (!verifier) return null;
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  try {
    const payload = await verifier.verify(token);
    return payload.sub || null;
  } catch (err) {
    console.warn("cancelOrder: ignoring unverifiable token, falling back to contact match:", err.message);
    return null;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
