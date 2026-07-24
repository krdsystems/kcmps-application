/* ============================================================
   KCMPS Ops Dashboard — daily-digest Lambda
   ============================================================
   Trigger: EventBridge cron, twice daily (morning + end-of-day —
   see backend-infra-to-deploy.md §5 for the exact cron expressions).

   Sends ONE SES email to the 4 founders summarizing SLA breaches.
   Per Part 5.5 of the Project Knowledge file: "Digest, don't spam.
   One SES morning digest at start of day plus one end-of-day
   summary, not per-event emails to staff." Per-event SES stays
   reserved for customer notifications (see expire-pending-orders.js).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const TABLE = process.env.TABLE_NAME;
const SES_SENDER = process.env.SES_SENDER;
const STAFF_RECIPIENTS = (process.env.STAFF_DIGEST_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

exports.handler = async () => {
  const [verificationQueue, quoteQueue, dueRisk, todaySummary] = await Promise.all([
    queueByStatus("Pending Payment Verification"),
    queueByStatus("Quoted"),
    dueTodayAtRisk(),
    todayMetric(),
  ]);

  const lines = [];
  lines.push(`KCMPS Ops — ${new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}`);
  lines.push("");
  lines.push(`Pending Payment Verification: ${verificationQueue.length} waiting`);
  verificationQueue.filter((li) => hoursSince(li.GSI1SK) >= 4).forEach((li) =>
    lines.push(`  ⚠ OVER SLA (${hoursSince(li.GSI1SK).toFixed(1)}h) — ${li.PK} / ${li.lineItemId}`));
  lines.push("");
  lines.push(`Awaiting Quote: ${quoteQueue.length} waiting`);
  quoteQueue.filter((li) => hoursSince(li.GSI1SK) >= 18).forEach((li) =>
    lines.push(`  ⚠ OVER SLA (${hoursSince(li.GSI1SK).toFixed(1)}h) — ${li.PK} / ${li.lineItemId}`));
  lines.push("");
  lines.push(`Due today, not yet in production: ${dueRisk.length}`);
  dueRisk.forEach((li) => lines.push(`  ⚠ ${li.PK} / ${li.lineItemId} — status ${li.status}`));
  lines.push("");
  if (todaySummary) {
    lines.push(`Spoilage today: ${todaySummary.spoilageUnits || 0} units (₱${todaySummary.spoilageValue || 0})`);
    lines.push(`Rework opened today: ${todaySummary.reworkOpened || 0}`);
  }

  if (!STAFF_RECIPIENTS.length) {
    console.warn("STAFF_DIGEST_RECIPIENTS is empty — skipping send. Set it as a Lambda env var.");
    return { statusCode: 200, body: "no recipients configured" };
  }

  await ses.send(new SendEmailCommand({
    Source: SES_SENDER,
    Destination: { ToAddresses: STAFF_RECIPIENTS },
    Message: {
      Subject: { Data: `KCMPS Ops digest — ${verificationQueue.length + quoteQueue.length + dueRisk.length} items need attention` },
      Body: { Text: { Data: lines.join("\n") } },
    },
  }));
  return { statusCode: 200 };
};

function hoursSince(iso) { return (Date.now() - new Date(iso).getTime()) / 3600000; }

async function queueByStatus(status) {
  const res = await client.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": `STATUS#${status}` },
  }));
  return res.Items || [];
}

async function dueTodayAtRisk() {
  const today = new Date().toISOString().slice(0, 10);
  const notYetInProd = ["Confirmed", "Scheduled", "Pending Payment Verification", "Quoted", "Priced"];
  const results = [];
  for (const status of notYetInProd) {
    const items = await queueByStatus(status);
    items.forEach((li) => { if (li.originalPromisedDate && li.originalPromisedDate.slice(0, 10) <= today) results.push(li); });
  }
  return results;
}

async function todayMetric() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: `METRIC#DAY#${today}`, SK: "SUMMARY" } }));
  return res.Item || null;
}
