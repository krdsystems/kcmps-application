/* ============================================================
   KCMPS Ops Dashboard — DynamoDB Streams Lambda
   ============================================================
   Trigger: DynamoDB Streams on the main KCMPS table, view type
   NEW_AND_OLD_IMAGES, filtered (via an event source mapping filter
   criteria, see below) to line-item items only (SK begins_with
   "LINEITEM#").

   Responsibilities (Project Knowledge §5.2–§5.5):
     1. Derive orderStatus on the parent ORDER# item.
     2. Maintain the sparse GSI1 status index (add on transition,
        remove once the line item reaches a terminal state).
     3. Increment METRIC#DAY# / METRIC#MONTH# counters.
     4. Update CLIENT# totalRevenue / lastOrderAt on Delivered.

   This is the ONLY place that writes METRIC# and orderStatus items.
   API Lambdas write line items + EVENT# records; they never touch
   metrics or orderStatus directly — that would risk double-counting
   across concurrent requests. Streams gives exactly-once-ish
   processing per shard iterator checkpoint, which is enough here
   since these are additive counters, not financial ledgers.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE = process.env.TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TERMINAL_STATUSES = new Set(["Delivered", "Cancelled", "Quote Expired", "Auto-Cancelled"]);

exports.handler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName === "REMOVE") continue;
    const newImage = unmarshallLite(record.dynamodb.NewImage);
    if (!newImage || !newImage.SK || !newImage.SK.startsWith("LINEITEM#")) continue;
    const oldImage = record.dynamodb.OldImage ? unmarshallLite(record.dynamodb.OldImage) : null;
    if (oldImage && oldImage.status === newImage.status) continue; // not a status transition

    await Promise.all([
      updateGsi1(newImage),
      recomputeOrderStatus(newImage.PK),
      bumpMetrics(newImage, oldImage),
    ]);
  }
  return { statusCode: 200 };
};

// Streams events arrive pre-marshalled from the console/CLI test payloads
// as plain JSON in some setups and as DynamoDB AttributeValue maps in
// production. This project uses the AWS SDK v3 native Streams integration,
// which already delivers plain JS objects under record.dynamodb.NewImage
// when using the newer "Lambda function URL" style triggers is NOT the
// case here — for a standard DynamoDB Streams event source mapping the
// image is still in AttributeValue form, so unmarshall it.
const { unmarshall } = require("@aws-sdk/util-dynamodb");
function unmarshallLite(av) { return av ? unmarshall(av) : null; }

async function updateGsi1(li) {
  if (TERMINAL_STATUSES.has(li.status)) {
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: li.PK, SK: li.SK },
      UpdateExpression: "REMOVE GSI1PK, GSI1SK",
    }));
  } else {
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: li.PK, SK: li.SK },
      UpdateExpression: "SET GSI1PK = :pk, GSI1SK = :sk",
      ExpressionAttributeValues: {
        ":pk": `STATUS#${li.status}`,
        ":sk": li.enteredStatusAt || new Date().toISOString(),
      },
    }));
  }
}

async function recomputeOrderStatus(orderPk) {
  const lineItems = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": orderPk, ":prefix": "LINEITEM#" },
  }));
  const statuses = (lineItems.Items || []).map((i) => i.status);
  let orderStatus;
  if (statuses.every((s) => s === "Delivered")) orderStatus = "Delivered";
  else if (statuses.some((s) => s === "Delivered") && statuses.some((s) => !["Delivered", "Cancelled", "Quote Expired"].includes(s))) orderStatus = "Partially Fulfilled";
  else if (statuses.some((s) => s === "Pending Payment Verification")) orderStatus = "Pending Payment Verification";
  else if (statuses.some((s) => s === "Rework")) orderStatus = "Rework";
  else if (statuses.some((s) => s === "In Production")) orderStatus = "In Production";
  else if (statuses.some((s) => s === "Quoted")) orderStatus = "Awaiting Quote";
  else if (statuses.some((s) => s === "Priced")) orderStatus = "Awaiting Payment";
  else orderStatus = statuses[0] || "Unknown";

  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: orderPk, SK: "META" },
    UpdateExpression: "SET orderStatus = :s",
    ExpressionAttributeValues: { ":s": orderStatus },
  }));
}

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
function isoMonth(d) { return new Date(d).toISOString().slice(0, 7); }

async function bumpMetrics(li, old) {
  const today = isoDay(new Date());
  const month = isoMonth(new Date());
  const adds = {};

  if (li.status === "Quoted") adds.quotesSent = 1;
  if (li.status === "Confirmed") adds.quotesAccepted = 1;
  if (li.status === "Rework") {
    adds.reworkOpened = 1;
    if (li.meta && li.meta.spoilage && li.meta.spoilage.units) {
      adds.spoilageUnits = li.meta.spoilage.units;
      adds.spoilageValue = li.meta.spoilage.valuePhp || 0;
    }
  }
  if (li.status === "Delivered") {
    adds.jobsCompleted = 1;
    adds.unitsOut = li.qty || 1;
    adds.cashCollected = li.amount || 0;
    const onTime = new Date() <= new Date(li.originalPromisedDate || li.dueDate || Date.now());
    if (onTime) adds.otifHits = 1; else adds.otifMisses = 1;

    await bumpClient(li);
    await bumpMonthPillar(month, li);
  }

  if (Object.keys(adds).length) await addToDay(today, adds);

  if (li.status === "In Production" && li.station) {
    const setupMinutes = (li.meta && li.meta.setupMinutes) || li.setupMinutes || 0;
    await addToDayStation(today, li.station, { productionMinutes: 0, setupMinutes, jobsRun: 1 });
  }
}

async function addToDay(day, adds) {
  const sets = Object.keys(adds).map((k, i) => `#${k} = if_not_exists(#${k}, :zero) + :v${i}`).join(", ");
  const names = Object.fromEntries(Object.keys(adds).map((k) => [`#${k}`, k]));
  const values = Object.fromEntries(Object.keys(adds).map((k, i) => [`:v${i}`, adds[k]]));
  values[":zero"] = 0;
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `METRIC#DAY#${day}`, SK: "SUMMARY" },
    UpdateExpression: `SET ${sets}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function addToDayStation(day, station, adds) {
  const sets = Object.keys(adds).map((k, i) => `#${k} = if_not_exists(#${k}, :zero) + :v${i}`).join(", ");
  const names = Object.fromEntries(Object.keys(adds).map((k) => [`#${k}`, k]));
  const values = Object.fromEntries(Object.keys(adds).map((k, i) => [`:v${i}`, adds[k]]));
  values[":zero"] = 0;
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `METRIC#DAY#${day}`, SK: `STATION#${station}` },
    UpdateExpression: `SET ${sets}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function bumpMonthPillar(month, li) {
  const pillar = li.pillar || "PRINT"; // set by the estimator/checkout Lambda when the line item is created
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `METRIC#MONTH#${month}`, SK: `PILLAR#${pillar}` },
    UpdateExpression: "SET revenue = if_not_exists(revenue, :zero) + :rev, jobCount = if_not_exists(jobCount, :zero) + :one, actualCost = if_not_exists(actualCost, :zero) + :actual, estimatedCost = if_not_exists(estimatedCost, :zero) + :estimated",
    ExpressionAttributeValues: {
      ":rev": li.amount || 0, ":one": 1, ":zero": 0,
      ":actual": li.actualCost || 0, ":estimated": li.estimatedCost || 0,
    },
  }));
}

async function bumpClient(li) {
  const clientId = li.clientId;
  if (!clientId) return;
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `CLIENT#${clientId}`, SK: "META" },
    UpdateExpression: "SET totalRevenue = if_not_exists(totalRevenue, :zero) + :amt, lastOrderAt = :now",
    ExpressionAttributeValues: { ":amt": li.amount || 0, ":zero": 0, ":now": new Date().toISOString() },
  }));
}
