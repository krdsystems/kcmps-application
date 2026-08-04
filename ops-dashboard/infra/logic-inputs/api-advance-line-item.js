/* ============================================================
   KCMPS Ops Dashboard — POST /line-items/{lineItemId}/advance Lambda
   ============================================================
   Validates the requested transition against the state machine
   (Project Knowledge §5.1) and writes the line item update + the
   append-only event record ATOMICALLY via TransactWriteItems, so
   a crash mid-write can never leave a status change without its
   corresponding event (which would silently corrupt every metric
   and cycle-time calculation downstream).

   Body shape (mirrors dashboard-data.js's advanceLineItem args):
   {
     "orderId": "ORD-95KLCI",
     "lineItemId": "L10",
     "to": "In Production",
     "station": "PRESS-01",      // optional
     "setupMinutes": 18,          // optional
     "meta": {}                   // optional, passed through to the event
   }

   Staff-only. See api-get-orders.js for the JWT verification pattern
   (identical here — omitted inline for brevity, import the same
   getVerifiedClaims helper in a real deployment, e.g. from a shared
   Lambda layer).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE = process.env.TABLE_NAME;
const STAFF_GROUP = "Staff";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Legal transitions — mirrors NEXT_STATUS in dashboard-data.js, plus the
// branches (QC pass/fail, verification reject) that need an explicit `to`.
const LEGAL_TRANSITIONS = {
  "Pending Payment Verification": ["Confirmed", "On Hold"],
  "On Hold": ["Pending Payment Verification", "Confirmed"], // resolved over email/chat, then verified in one click
  "Quoted": ["Priced", "Quote Expired"],
  "Priced": ["Confirmed", "Quote Expired"],
  "Confirmed": ["Scheduled"],
  "Scheduled": ["In Production"],
  "In Production": ["QC"],
  "QC": ["Ready for Dispatch", "Rework"],
  "Rework": ["In Production"],
  "Ready for Dispatch": ["Dispatched"],
  "Dispatched": ["Delivered"],
};

exports.handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) return response(401, { error: "Unauthorized" });
  const groups = typeof claims["cognito:groups"] === "string" ? claims["cognito:groups"].split(",") : (claims["cognito:groups"] || []);
  if (!groups.includes(STAFF_GROUP)) return response(403, { error: "Staff only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  const { orderId, lineItemId, to, station, setupMinutes, meta } = body;
  if (!orderId || !lineItemId || !to) return response(400, { error: "orderId, lineItemId, and to are required" });

  const pk = `ORDER#${orderId}`;
  const sk = `LINEITEM#${lineItemId}`;
  const current = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
  if (!current.Item) return response(404, { error: "Line item not found" });

  const from = current.Item.status;
  const allowed = LEGAL_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return response(409, { error: `Illegal transition: ${from} -> ${to}. Allowed: ${allowed.join(", ") || "(none — terminal state)"}` });
  }

  const now = new Date().toISOString();
  const updateParts = ["#status = :to", "enteredStatusAt = :now"];
  const names = { "#status": "status" };
  const values = { ":to": to, ":now": now };
  if (station) { updateParts.push("station = :station"); values[":station"] = station; }
  if (setupMinutes != null) { updateParts.push("setupMinutes = :setup"); values[":setup"] = setupMinutes; }

  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: sk },
          ConditionExpression: "#status = :from", // optimistic lock — fails if someone else moved it first
          UpdateExpression: `SET ${updateParts.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ...values, ":from": from },
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: {
            PK: pk, SK: `EVENT#${now}#${lineItemId}`,
            lineItemId, from, to,
            actorSub: claims.sub, actorName: claims.name || claims.email,
            station: station || current.Item.station || null,
            at: now, meta: meta || {},
          },
        },
      },
    ],
  })).catch((err) => {
    if (err.name === "TransactionCanceledException") {
      throw Object.assign(new Error("Line item changed concurrently — reload and retry."), { statusCode: 409 });
    }
    throw err;
  });

  // orderStatus + METRIC# counters are NOT updated here — the DynamoDB
  // Streams handler (streams-handler.js) does that asynchronously off the
  // line-item write above, so every code path that changes status (this
  // Lambda, expire-pending-orders.js, a future customer-approval Lambda)
  // gets metrics for free without duplicating the rollup logic.

  return response(200, { lineItemId, from, to, at: now });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
