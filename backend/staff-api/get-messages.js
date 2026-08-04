/* ============================================================
   KCMPS staff/customer API — GET /orders/{orderId}/messages
   ============================================================
   Order-scoped read of the thread send-message.js writes. Same
   staff-vs-customer branch as get-orders.js: staff sees any order's
   thread, the order's own customer (JWT sub === order.customerSub) sees
   theirs, anyone else gets 403.

   Account-level view (Payment System file's "reused pattern"
   principle, and this feature's own account-level requirement): NOT a
   separate endpoint yet. GSI2 (CLIENT#<sub>/MSG#<at>) isn't provisioned
   on the table (see send-message.js's header), so a true one-query
   "all my messages across every order" view is deferred until that
   index exists. Until then, the equivalent view is: call GET /orders
   (already returns every order the caller can see) then this endpoint
   per order — more round trips, same accepted-interim tradeoff
   get-orders.js's own CLIENT# comment documents. Frontend deliberately
   only builds order-scoped panels for now (order-detail.html,
   dashboard/job-detail.html), not a global inbox, so this gap doesn't
   block anything asked for.

   Side effect: marks the OTHER party's messages as read on every call —
   a customer loading this thread marks staff messages read, staff
   loading it marks customer messages read. This is what backend/jobs/
   notify-unread-messages.js's 2-hour reminder checks against, and it's
   the only "mark read" path — no separate endpoint, per the "reused
   pattern" simplicity principle. Best-effort: a failed mark-read never
   blocks the read response, since a stale readAt just means one extra
   reminder email at worst.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { orderPk, metaSk, extractClaims, isStaff } = require("../lib");

const TABLE = process.env.TABLE_NAME;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  const pk = orderPk(orderId);
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });

  const staff = isStaff(claims);
  if (!staff && claims.sub !== order.customerSub) {
    return response(403, { error: "You don't have access to this order." });
  }

  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": "MSG#" },
  }));
  const messages = (res.Items || []).sort((a, b) => (a.at || "").localeCompare(b.at || ""));

  const otherPartyRole = staff ? "customer" : "staff";
  const toMarkRead = messages.filter((m) => m.senderRole === otherPartyRole && !m.readAt);
  if (toMarkRead.length) {
    const now = new Date().toISOString();
    await Promise.all(toMarkRead.map((m) =>
      client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: "SET readAt = :now",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":now": now },
      })).then(() => { m.readAt = now; }).catch((err) => {
        console.error("get-messages: mark-read failed for", m.SK, err.message);
      })
    ));
  }

  return response(200, { messages });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
