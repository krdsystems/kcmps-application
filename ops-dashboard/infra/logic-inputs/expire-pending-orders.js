/* ============================================================
   KCMPS Ops Dashboard — expire-pending-orders Lambda
   ============================================================
   Trigger: EventBridge cron, every 15 minutes.
   Reuses/extends the expirePendingOrders Lambda already referenced
   in the main Technical/Payment System project knowledge (Part 5.5,
   Part 6 of the Ops Dashboard file) — this version adds the 7-day
   quote-expiry rule alongside the existing 48h verification expiry.

   Two sweeps, both driven off the sparse GSI1 status index so
   neither one ever scans the table:
     1. GSI1PK = STATUS#Pending Payment Verification, entered > 48h
        ago -> Auto-Cancelled, release inventory hold, SES to customer.
     2. GSI1PK = STATUS#Priced, entered > 7 days ago with no payment
        -> Quote Expired, price released, SES notice.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const TABLE = process.env.TABLE_NAME;
const SES_SENDER = process.env.SES_SENDER; // e.g. "orders@kcmps.com", must be a verified SES identity
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

const VERIFICATION_EXPIRY_HOURS = 48;
const QUOTE_EXPIRY_DAYS = 7;

exports.handler = async () => {
  await sweep("Pending Payment Verification", VERIFICATION_EXPIRY_HOURS * 3600 * 1000, expireVerification);
  await sweep("Priced", QUOTE_EXPIRY_DAYS * 24 * 3600 * 1000, expireQuote);
  return { statusCode: 200 };
};

async function sweep(status, maxAgeMs, handler) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :cutoff",
    ExpressionAttributeValues: { ":pk": `STATUS#${status}`, ":cutoff": cutoff },
  }));
  for (const item of res.Items || []) {
    try { await handler(item); } catch (err) { console.error("expire sweep failed for", item.PK, item.SK, err); }
  }
}

async function expireVerification(li) {
  const now = new Date().toISOString();
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: li.SK },
          UpdateExpression: "SET #status = :s, enteredStatusAt = :now REMOVE GSI1PK, GSI1SK",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": "Auto-Cancelled", ":now": now },
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: {
            PK: li.PK, SK: `EVENT#${now}#${li.lineItemId}`,
            lineItemId: li.lineItemId, from: li.status, to: "Auto-Cancelled",
            actorSub: "system:expire-pending-orders", at: now,
            meta: { reason: "48h verification window elapsed" },
          },
        },
      },
      // Stamp the order-level payment audit trail (§2.2 of the infra doc)
      // the same way a staff-triggered setOnHold call would, so a
      // 48h auto-expiry is indistinguishable from a manual reject in the
      // ticket's payment history — only actorSub in the EVENT# record
      // above tells you it was automatic.
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: "META" },
          UpdateExpression: "SET payment.holdReason = :reason, payment.verifiedBy = :null, payment.verifiedAt = :null",
          ExpressionAttributeValues: {
            ":reason": "Auto-cancelled — 48h verification window elapsed with no staff action",
            ":null": null,
          },
        },
      },
      // Release any inventory hold placed at checkout, if this line item
      // reserved stock — wire this to your actual hold-tracking item shape.
    ],
  }));
  if (li.customerEmail) {
    await sendMail(li.customerEmail, "Your KCMPS order verification window has expired",
      `We couldn't verify your payment within 48 hours, so this order (${li.PK}) has been automatically cancelled. Please place a new order or contact us if you already paid.`);
  }
}

async function expireQuote(li) {
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: li.SK },
          UpdateExpression: "SET #status = :s, enteredStatusAt = :now REMOVE GSI1PK, GSI1SK",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": "Quote Expired", ":now": new Date().toISOString() },
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: {
            PK: li.PK, SK: `EVENT#${new Date().toISOString()}#${li.lineItemId}`,
            lineItemId: li.lineItemId, from: li.status, to: "Quote Expired",
            actorSub: "system:expire-pending-orders", at: new Date().toISOString(),
            meta: { reason: "7-day quote payment window elapsed" },
          },
        },
      },
    ],
  }));
  if (li.customerEmail) {
    await sendMail(li.customerEmail, "Your KCMPS quote has expired",
      `Your quote for order ${li.PK} was not paid within 7 days and has expired. Reply to this email if you'd still like to proceed and we'll requote.`);
  }
}

async function sendMail(to, subject, body) {
  await ses.send(new SendEmailCommand({
    Source: SES_SENDER,
    Destination: { ToAddresses: [to] },
    Message: { Subject: { Data: subject }, Body: { Text: { Data: body } } },
  }));
}
