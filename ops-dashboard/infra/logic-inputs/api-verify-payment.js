/* ============================================================
   KCMPS Ops Dashboard — POST /orders/{orderId}/verify-payment
                          POST /orders/{orderId}/set-on-hold
   ============================================================
   Staff-side half of the manual GCash bridge defined in
   ../../../project_knowledge/Payment_System_Project_Knowledge.md
   ("Bridge Payment Method: Manual GCash Verification"). The
   customer-facing half (submitPaymentProof, which creates the
   `payment` object this Lambda reads/updates) is storefront/
   checkout work, not part of this dashboard build — see
   backend-infra-to-deploy.md §3 for why it's out of scope here.

   ORDER-LEVEL, not line-item-level: one GCash transaction pays for
   every `sku` line item on the order at once (Payment System file,
   "Checkout Flow" step 1), so verifying/rejecting acts on ALL line
   items currently `Pending Payment Verification` on that order in a
   single TransactWriteItems call, and stamps the audit fields on
   `ORDER#<id>` / META's `payment` sub-object — never on individual
   line items. Mirrors dashboard-data.js's verifyPayment()/
   setOnHold() exactly (see backend-infra-to-deploy.md §6 for
   the mock -> real swap).

   Body shape:
     POST /orders/{orderId}/verify-payment   { }  (no body needed)
     POST /orders/{orderId}/set-on-hold   { "reason": "..." }
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE = process.env.TABLE_NAME;
const STAFF_GROUP = "Staff";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) return response(401, { error: "Unauthorized" });
  const groups = typeof claims["cognito:groups"] === "string" ? claims["cognito:groups"].split(",") : (claims["cognito:groups"] || []);
  if (!groups.includes(STAFF_GROUP)) return response(403, { error: "Staff only" });

  const orderId = event.pathParameters?.orderId;
  const isOnHold = event.rawPath?.endsWith("/set-on-hold") || event.resource?.endsWith("/set-on-hold");
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  if (isOnHold && !body.reason) return response(400, { error: "reason is required to reject a payment" });

  const orderPk = `ORDER#${orderId}`;
  const [orderRes, lineItemsRes] = await Promise.all([
    client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk, SK: "META" } })),
    client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": orderPk, ":prefix": "LINEITEM#" },
    })),
  ]);
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });
  if (!order.payment) return response(409, { error: "Order has no GCash payment proof on file" });

  const pendingLineItems = (lineItemsRes.Items || []).filter((li) => li.status === "Pending Payment Verification");
  if (!pendingLineItems.length) return response(409, { error: "No line items on this order are awaiting verification" });

  const now = new Date().toISOString();
  const staffName = claims.name || claims.email;
  const transactItems = [];

  pendingLineItems.forEach((li) => {
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: orderPk, SK: li.SK },
        ConditionExpression: "#status = :from",
        UpdateExpression: "SET #status = :to, enteredStatusAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":to": isOnHold ? "On Hold" : "Confirmed", ":from": "Pending Payment Verification", ":now": now },
      },
    });
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          PK: orderPk, SK: `EVENT#${now}#${li.lineItemId}`,
          lineItemId: li.lineItemId, from: "Pending Payment Verification",
          to: isOnHold ? "On Hold" : "Confirmed",
          actorSub: claims.sub, actorName: staffName, station: li.station || null,
          at: now, meta: isOnHold ? { via: "setOnHold", holdReason: body.reason } : { via: "verifyPayment" },
        },
      },
    });
  });

  transactItems.push({
    Update: {
      TableName: TABLE,
      Key: { PK: orderPk, SK: "META" },
      UpdateExpression: isOnHold
        ? "SET payment.holdReason = :reason, payment.verifiedBy = :null, payment.verifiedAt = :null"
        : "SET payment.verifiedBy = :staff, payment.verifiedAt = :now, payment.holdReason = :null",
      ExpressionAttributeValues: isOnHold
        ? { ":reason": body.reason, ":null": null }
        : { ":staff": staffName, ":now": now, ":null": null },
    },
  });

  await client.send(new TransactWriteCommand({ TransactItems: transactItems })).catch((err) => {
    if (err.name === "TransactionCanceledException") {
      throw Object.assign(new Error("Order's payment or line items changed concurrently — reload and retry."), { statusCode: 409 });
    }
    throw err;
  });

  // orderStatus + METRIC# counters recompute asynchronously via
  // streams-handler.js off the line-item writes above — same pattern as
  // api-advance-line-item.js, no duplicated rollup logic here.

  return response(200, {
    orderId, action: isOnHold ? "rejected" : "verified",
    lineItemsAffected: pendingLineItems.map((li) => li.lineItemId), at: now,
  });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
