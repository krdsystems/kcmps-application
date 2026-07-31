/* ============================================================
   KCMPS backend — DynamoDB Streams Lambda
   ============================================================
   Trigger: DynamoDB Streams on the `kcmps` table, view type
   NEW_AND_OLD_IMAGES, event source mapping filtered to line-item items
   only (SK begins_with "LINEITEM#").

   Responsibilities:
     1. Derive orderStatus on the parent ORDER# item (backend/lib's
        deriveOrderStatus() — the one rollup implementation shared with
        dashboard-data.js's mock and backend/lib/lib.test.js's coverage).
     2. Maintain the sparse GSI1 status index (add on transition, remove
        once the line item reaches a terminal state).

   METRIC# day/month rollups from the original draft
   (ops-dashboard/infra/logic-inputs/streams-handler.js) are deferred —
   see docs/roadmap.md's Milestone 1.3 note — nothing here writes them
   yet, so the dashboard's Home/metrics pages stay on mock data until
   that's built as its own pass.

   This is the ONLY place that writes orderStatus. API Lambdas
   (backend/staff-api/*.js, backend/jobs/expire-pending-orders.js) write
   line items + EVENT# records; they never touch orderStatus directly —
   that would risk double-counting/races across concurrent requests.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { metaSk, activeStatusAttrs, attrsToRemoveOnTerminal, deriveOrderStatus } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName === "REMOVE") continue;
    const newImage = record.dynamodb.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
    if (!newImage || !newImage.SK || !newImage.SK.startsWith("LINEITEM#")) continue;
    const oldImage = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage) : null;
    if (oldImage && oldImage.status === newImage.status) continue; // not a status transition

    await Promise.all([updateGsi1(newImage), recomputeOrderStatus(newImage.PK)]);
  }
  return { statusCode: 200 };
};

async function updateGsi1(li) {
  const removeAttrs = attrsToRemoveOnTerminal(li.status);
  if (removeAttrs.length) {
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: li.PK, SK: li.SK },
      UpdateExpression: `REMOVE ${removeAttrs.join(", ")}`,
    }));
    return;
  }
  const gsiAttrs = activeStatusAttrs(li.status, li.enteredStatusAt || new Date().toISOString());
  if (!gsiAttrs) return; // status not in ACTIVE_STATUSES and not terminal — shouldn't happen, but nothing to index
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: li.PK, SK: li.SK },
    UpdateExpression: "SET GSI1PK = :pk, GSI1SK = :sk",
    ExpressionAttributeValues: { ":pk": gsiAttrs.GSI1PK, ":sk": gsiAttrs.GSI1SK },
  }));
}

async function recomputeOrderStatus(orderPkValue) {
  const lineItems = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": orderPkValue, ":prefix": "LINEITEM#" },
  }));
  const statuses = (lineItems.Items || []).map((i) => i.status);
  const orderStatus = deriveOrderStatus(statuses);

  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: orderPkValue, SK: metaSk() },
    UpdateExpression: "SET orderStatus = :s",
    ExpressionAttributeValues: { ":s": orderStatus },
  }));
}
