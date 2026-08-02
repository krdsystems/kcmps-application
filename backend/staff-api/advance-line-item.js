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
const { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { STATUS, orderPk, lineItemSk, buildEvent, extractClaims, getGroups, isStaff, activeStatusAttrs, attrsToRemoveOnTerminal } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const LEGACY_STAFF_GROUP = "Staff"; // see get-orders.js for why both are accepted

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Legal transitions — mirrors NEXT_STATUS in dashboard-data.js, plus the
// branches (QC pass/fail, verification reject) that need an explicit `to`.
const LEGAL_TRANSITIONS = {
  [STATUS.PENDING_PAYMENT_VERIFICATION]: [STATUS.CONFIRMED, STATUS.PAYMENT_REJECTED],
  [STATUS.PAYMENT_REJECTED]: [STATUS.PENDING_PAYMENT_VERIFICATION], // customer resubmits
  [STATUS.QUOTED]: [STATUS.PRICED, STATUS.QUOTE_EXPIRED],
  [STATUS.PRICED]: [STATUS.CONFIRMED, STATUS.QUOTE_EXPIRED],
  [STATUS.CONFIRMED]: [STATUS.SCHEDULED],
  [STATUS.SCHEDULED]: [STATUS.IN_PRODUCTION],
  [STATUS.IN_PRODUCTION]: [STATUS.QC],
  [STATUS.QC]: [STATUS.READY_FOR_DISPATCH, "Rework"],
  Rework: [STATUS.IN_PRODUCTION],
  [STATUS.READY_FOR_DISPATCH]: [STATUS.DISPATCHED],
  [STATUS.DISPATCHED]: [STATUS.DELIVERED],
};

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims) && !getGroups(claims).includes(LEGACY_STAFF_GROUP)) {
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
    if (err.name === "TransactionCanceledException") {
      throw Object.assign(new Error("Line item changed concurrently — reload and retry."), { statusCode: 409 });
    }
    throw err;
  });

  // orderStatus is NOT recomputed here — the DynamoDB Streams handler
  // (backend/jobs/streams-handler.js) does that asynchronously off the
  // line-item write above, so every code path that changes status (this
  // Lambda, expire-pending-orders.js, a future customer-approval Lambda)
  // gets a consistent rollup without duplicating deriveOrderStatus().

  return response(200, { lineItemId, from, to, at: now });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
