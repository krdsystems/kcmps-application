/* ============================================================
   KCMPS staff/customer API — POST /orders/{orderId}/messages
   ============================================================
   Feature: customer chat via a logged-in account, per-order thread
   (hybrid model — see get-messages.js's header for the account-level
   read path this pairs with).

   Item shape (new type, same table, no infra change):
     PK: ORDER#<id>, SK: MSG#<ISO timestamp>#<msgId>
     { senderSub, senderRole: "customer"|"staff", body, attachmentRef,
       readAt: null, at, orderId }

   Auth: no separate "chat" role — a caller is either staff (any
   isStaff() group, may post to ANY order) or the order's own customer
   (JWT sub must match order.customerSub, same equality check
   cancel-order.js uses). No guest posting — chat requires a logged-in
   account by design (unlike checkout/lookup-order.js's contact-match
   fallback), so this Lambda always requires a verified JWT via API
   Gateway's authorizer, same as every other staff-api/*.js Lambda —
   never optional like checkout/cancel-order.js's tryGetSub().

   GSI2PK/GSI2SK are written on every message (CLIENT#<customerSub>/
   MSG#<at>) even though GSI2 doesn't exist on the table yet
   (backend/infra/foundation.cfn.yaml only provisions GSI1) — this is
   preparation, not activation: adding the index later needs zero
   backfill. Until then, the account-level "my messages across every
   order" view is a client-side fan-out over get-messages.js per order
   (see that file's header) — the same accepted-interim tradeoff
   staff-api/get-orders.js already uses for its own CLIENT#-keyed view.
   ============================================================ */

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SITE_ID, SCHEMA_VERSION, orderPk, metaSk, messageSk, clientGsi2Pk, messageGsi2Sk, extractClaims, isStaff } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const MAX_BODY_LENGTH = 4000;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  const text = (body.body || "").trim();
  if (!text) return response(400, { error: "body is required" });
  if (text.length > MAX_BODY_LENGTH) return response(400, { error: `body must be ${MAX_BODY_LENGTH} characters or fewer` });

  const pk = orderPk(orderId);
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });

  const staff = isStaff(claims);
  if (!staff && claims.sub !== order.customerSub) {
    return response(403, { error: "You don't have access to this order." });
  }

  const at = new Date().toISOString();
  const msgId = randomUUID();
  const item = {
    PK: pk,
    SK: messageSk(at, msgId),
    tenantId: SITE_ID,
    siteId: SITE_ID,
    schemaVersion: SCHEMA_VERSION,
    orderId,
    msgId,
    senderSub: claims.sub,
    senderRole: staff ? "staff" : "customer",
    body: text,
    attachmentRef: body.attachmentRef || null,
    readAt: null,
    at,
  };
  // Index by the ORDER's customer, not the sender — a staff reply must
  // still show up under the customer's own account-level view. Guest
  // orders (customerSub null) simply aren't indexable this way yet, same
  // limitation get-orders.js's CLIENT# view already has.
  if (order.customerSub) {
    item.GSI2PK = clientGsi2Pk(order.customerSub);
    item.GSI2SK = messageGsi2Sk(at);
  }

  await client.send(new PutCommand({ TableName: TABLE, Item: item }));

  return response(201, { message: item });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
