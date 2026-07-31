/* ============================================================
   KCMPS backend — expire-pending-orders Lambda
   ============================================================
   Trigger: EventBridge cron, every 15 minutes.

   Two sweeps, both driven off the sparse GSI1 status index so neither
   one ever scans the table:
     1. GSI1PK = STATUS#Pending Payment Verification, entered > 48h
        ago -> Auto-Cancelled, SES to customer.
     2. GSI1PK = STATUS#Priced, entered > 7 days ago with no payment
        -> Quote Expired, SES notice.

   SES send is best-effort and degrades gracefully (same pattern as
   backend/checkout/submit-payment-proof.js): if SES_SENDER isn't set or
   the customer contact isn't email-shaped, the sweep still runs, it just
   skips the notification.

   Ported from ops-dashboard/infra/logic-inputs/expire-pending-orders.js
   against backend/lib conventions (see backend/CLAUDE.md).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { STATUS, statusPk, metaSk, eventSk, attrsToRemoveOnTerminal } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const SES_SENDER = process.env.SES_SENDER; // e.g. "orders@kcmps.com", must be a verified SES identity
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

const VERIFICATION_EXPIRY_HOURS = 48;
const QUOTE_EXPIRY_DAYS = 7;

exports.handler = async () => {
  await sweep(STATUS.PENDING_PAYMENT_VERIFICATION, VERIFICATION_EXPIRY_HOURS * 3600 * 1000, expireVerification);
  await sweep(STATUS.PRICED, QUOTE_EXPIRY_DAYS * 24 * 3600 * 1000, expireQuote);
  return { statusCode: 200 };
};

async function sweep(status, maxAgeMs, handler) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :cutoff",
    ExpressionAttributeValues: { ":pk": statusPk(status), ":cutoff": cutoff },
  }));
  for (const item of res.Items || []) {
    try { await handler(item); } catch (err) { console.error("expire sweep failed for", item.PK, item.SK, err); }
  }
}

async function expireVerification(li) {
  const now = new Date().toISOString();
  const removeAttrs = attrsToRemoveOnTerminal(STATUS.AUTO_CANCELLED);
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: li.SK },
          UpdateExpression: `SET #status = :s, enteredStatusAt = :now REMOVE ${removeAttrs.join(", ")}`,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": STATUS.AUTO_CANCELLED, ":now": now },
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: {
            PK: li.PK, SK: eventSk(now, li.lineItemId),
            lineItemId: li.lineItemId, from: li.status, to: STATUS.AUTO_CANCELLED,
            actorSub: "system:expire-pending-orders", at: now,
            meta: { reason: "48h verification window elapsed" },
          },
        },
      },
      // Stamp the order-level payment audit trail the same way a
      // staff-triggered rejectPayment call would, so a 48h auto-expiry is
      // indistinguishable from a manual reject in the ticket's payment
      // history — only actorSub in the EVENT# record above tells you it
      // was automatic.
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: "META" },
          UpdateExpression: "SET payment.rejectionReason = :reason, payment.verifiedBy = :null, payment.verifiedAt = :null",
          ExpressionAttributeValues: {
            ":reason": "Auto-cancelled — 48h verification window elapsed with no staff action",
            ":null": null,
          },
        },
      },
    ],
  }));
  const contact = await getCustomerContact(li.PK);
  await sendMailIfEmail(contact, "Your KCMPS order verification window has expired",
    `We couldn't verify your payment within 48 hours, so this order (${li.PK}) has been automatically cancelled. Please place a new order or contact us if you already paid.`);
}

async function expireQuote(li) {
  const now = new Date().toISOString();
  const removeAttrs = attrsToRemoveOnTerminal(STATUS.QUOTE_EXPIRED);
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: li.SK },
          UpdateExpression: `SET #status = :s, enteredStatusAt = :now REMOVE ${removeAttrs.join(", ")}`,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": STATUS.QUOTE_EXPIRED, ":now": now },
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: {
            PK: li.PK, SK: eventSk(now, li.lineItemId),
            lineItemId: li.lineItemId, from: li.status, to: STATUS.QUOTE_EXPIRED,
            actorSub: "system:expire-pending-orders", at: now,
            meta: { reason: "7-day quote payment window elapsed" },
          },
        },
      },
    ],
  }));
  const contact = await getCustomerContact(li.PK);
  await sendMailIfEmail(contact, "Your KCMPS quote has expired",
    `Your quote for order ${li.PK} was not paid within 7 days and has expired. Reply to this email if you'd still like to proceed and we'll requote.`);
}

async function getCustomerContact(orderPkValue) {
  const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPkValue, SK: metaSk() } }));
  return res.Item?.customerContact || null;
}

async function sendMailIfEmail(contact, subject, body) {
  if (!SES_SENDER || !contact || !EMAIL_RE.test(contact)) return;
  try {
    await ses.send(new SendEmailCommand({
      Source: SES_SENDER,
      Destination: { ToAddresses: [contact] },
      Message: { Subject: { Data: subject }, Body: { Text: { Data: body } } },
    }));
  } catch (err) {
    console.error("expire-pending-orders: SES send failed (degrading gracefully):", err.message);
  }
}
