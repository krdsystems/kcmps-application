/* ============================================================
   KCMPS Cash Book — shared I/O helpers
   ============================================================
   The Lambdas in this folder are thin shells around ../lib/cashbook.js
   (all the rules) plus this file (all the DynamoDB shapes). Bundled into
   every cashbook zip alongside index.js, the same way mail-parse.js is
   bundled into every mail zip — so the `require("../lib")` -> "./lib"
   packaging rewrite must be applied to THIS file too, not just index.js.
   (That exact miss crashed all five Asset Library Lambdas on their first
   deploy; see backend/infra/README.md.)
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { configPk, metaSk, dayMetricPk, monthMetricPk, summarySk, SITE_ID, SCHEMA_VERSION } = require("../lib");
const { DEFAULT_TXN_CATEGORIES } = require("../lib/cashbook");

const TABLE = process.env.TABLE_NAME;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const CATEGORIES_CONFIG_ID = "TXN_CATEGORIES";

// Categories are config, not code (plan §8) — but the CONFIG# item does
// not have to exist for the feature to work. Same no-migration-needed
// fallback pattern as business-hours.js's DEFAULT_OPERATING_HOURS: an
// absent/malformed item silently yields the seed list, so a fresh
// environment (staging today) is fully functional with zero setup and a
// future Settings API can start writing the item whenever it lands.
async function loadCategories() {
  try {
    const res = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: configPk(CATEGORIES_CONFIG_ID), SK: metaSk() },
    }));
    const list = res.Item && res.Item.categories;
    if (Array.isArray(list) && list.length) return list;
  } catch (err) {
    console.warn("loadCategories: falling back to defaults", err && err.message);
  }
  return DEFAULT_TXN_CATEGORIES;
}

// One METRIC# SUMMARY counter bump, as a TransactWriteItems Update.
// The ADD is atomic and rides the SAME transaction as the row write, so
// a counter can never drift from the rows that produced it — and a
// retried write that fails the row's attribute_not_exists condition
// cancels the whole transaction, taking these ADDs with it (B1).
function rollupUpdate({ pk, scope, periodKey, delta, now }) {
  return {
    Update: {
      TableName: TABLE,
      Key: { PK: pk, SK: summarySk() },
      UpdateExpression:
        "SET tenantId = if_not_exists(tenantId, :site), siteId = if_not_exists(siteId, :site), " +
        "schemaVersion = if_not_exists(schemaVersion, :sv), #scope = :scope, periodKey = :period, " +
        "createdAt = if_not_exists(createdAt, :now), updatedAt = :now, " +
        "deleted = if_not_exists(deleted, :false) " +
        "ADD cashInCentavos :ci, cashOutCentavos :co, netCentavos :net, txnCount :cnt",
      // `scope` is a DynamoDB reserved word.
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: {
        ":site": SITE_ID,
        ":sv": SCHEMA_VERSION,
        ":scope": scope,
        ":period": periodKey,
        ":now": now,
        ":false": false,
        ":ci": delta.cashInCentavos,
        ":co": delta.cashOutCentavos,
        ":net": delta.netCentavos,
        ":cnt": delta.txnCount,
      },
    },
  };
}

// The day + month pair, always written together — a month total must
// never require 31 partition queries (plan §4).
function rollupUpdates({ day, month, delta, now }) {
  return [
    rollupUpdate({ pk: dayMetricPk(day), scope: "DAY", periodKey: day, delta, now }),
    rollupUpdate({ pk: monthMetricPk(month), scope: "MONTH", periodKey: month, delta, now }),
  ];
}

async function getRollup(pk) {
  const res = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: summarySk() } }));
  return res.Item || null;
}

// Every row in one Manila day's partition. Bounded by construction (one
// shop's daily transaction count), but paginated anyway so a busy day
// can never silently truncate a total staff are reading.
async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await dynamo.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// TransactionCanceledException carries a per-item reason array in the
// SAME order as the TransactItems that were submitted. This is how an
// idempotent replay is told apart from a genuine conflict (B1) — without
// checking the index, "something in the transaction failed a condition"
// is not actionable.
function cancellationReasons(err) {
  return (err && Array.isArray(err.CancellationReasons)) ? err.CancellationReasons : [];
}

function conditionFailedAt(err, index) {
  const r = cancellationReasons(err)[index];
  return !!r && r.Code === "ConditionalCheckFailed";
}

function isTransactionCancelled(err) {
  return !!err && (err.name === "TransactionCanceledException" || err.__type === "TransactionCanceledException");
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

module.exports = {
  TABLE,
  dynamo,
  CATEGORIES_CONFIG_ID,
  loadCategories,
  rollupUpdate,
  rollupUpdates,
  getRollup,
  queryAll,
  cancellationReasons,
  conditionFailedAt,
  isTransactionCancelled,
  response,
};
