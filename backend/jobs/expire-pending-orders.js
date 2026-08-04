/* ============================================================
   KCMPS backend — expire-pending-orders Lambda
   ============================================================
   Trigger: EventBridge cron, every 15 minutes.

   Three sweeps, all driven off the sparse GSI1 status index so none of
   them ever scans the table:
     1. GSI1PK = STATUS#Order Placed, entered > 48h ago -> Auto-Cancelled,
        SES to customer. Covers a customer who placed an order but never
        submitted GCash proof at all — the same 48h SLA window as sweep 2
        below, just starting from checkout instead of proof-submission,
        since createOrder.js no longer tags sku items Pending Payment
        Verification immediately (see that Lambda's header).
     2. GSI1PK = STATUS#Pending Payment Verification, entered > 48h
        ago -> Auto-Cancelled, SES to customer. Covers a customer who
        submitted proof but staff never verified it in time — the clock
        here starts at submitPaymentProof.js, not checkout.
     3. GSI1PK = STATUS#Priced, entered > 7 days ago with no payment
        -> Quote Expired, SES notice.

   SES send is best-effort and degrades gracefully (same pattern as
   backend/checkout/submit-payment-proof.js): if SES_SENDER isn't set or
   the customer contact isn't email-shaped, the sweep still runs, it just
   skips the notification.

   Ported from ops-dashboard/infra/logic-inputs/expire-pending-orders.js
   against backend/lib conventions (see backend/CLAUDE.md).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { STATUS, statusPk, metaSk, buildEvent, attrsToRemoveOnTerminal } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const SES_SENDER = process.env.SES_SENDER; // e.g. "orders@kcmps.com", must be a verified SES identity
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

const VERIFICATION_EXPIRY_HOURS = 48;
const QUOTE_EXPIRY_DAYS = 7;

exports.handler = async () => {
  await sweep(STATUS.ORDER_PLACED, VERIFICATION_EXPIRY_HOURS * 3600 * 1000, expireVerification);
  await sweep(STATUS.PENDING_PAYMENT_VERIFICATION, VERIFICATION_EXPIRY_HOURS * 3600 * 1000, expireVerification);
  await sweep(STATUS.PRICED, QUOTE_EXPIRY_DAYS * 24 * 3600 * 1000, expireQuote);
  return { statusCode: 200 };
};

async function sweep(status, maxAgeMs, handler) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  let ExclusiveStartKey;
  do {
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :cutoff",
      ExpressionAttributeValues: { ":pk": statusPk(status), ":cutoff": cutoff },
      ExclusiveStartKey,
    }));
    for (const item of res.Items || []) {
      try { await handler(item); } catch (err) { console.error("expire sweep failed for", item.PK, item.SK, err); }
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

async function expireVerification(li) {
  const now = new Date().toISOString();
  const removeAttrs = attrsToRemoveOnTerminal(STATUS.AUTO_CANCELLED);
  const reason = "Auto-cancelled — 48h verification window elapsed with no staff action";

  // order.payment is the NULL scalar create-order.js writes at checkout
  // until submitPaymentProof.js turns it into a map — `SET
  // payment.holdReason = ...` fails with ValidationException against
  // a non-map attribute, which cancels this whole transaction (silently,
  // since the caller in sweep() only logs and moves on). That meant this
  // sweep could never actually expire an order nobody had paid for — the
  // one case it exists to catch. Mirror verify-payment.js's null-payment
  // branch: replace the whole attribute when there's no payment object to
  // patch a nested path onto.
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: li.PK, SK: "META" } }));
  const hasPayment = !!orderRes.Item?.payment;
  const paymentUpdate = hasPayment
    ? {
        UpdateExpression: "SET payment.holdReason = :reason, payment.verifiedBy = :null, payment.verifiedAt = :null",
        ExpressionAttributeValues: { ":reason": reason, ":null": null },
      }
    : {
        UpdateExpression: "SET payment = :payment",
        ExpressionAttributeValues: {
          ":payment": {
            method: null, claimedAmount: null, gcashRefNumber: null, screenshotRef: null,
            submittedAt: null, verifiedBy: null, verifiedAt: null, holdReason: reason,
          },
        },
      };

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
          Item: buildEvent({
            orderId: li.orderId, lineItemId: li.lineItemId, from: li.status, to: STATUS.AUTO_CANCELLED,
            actorSub: "system:expire-pending-orders", at: now,
            meta: { reason: "48h verification window elapsed" },
          }),
        },
      },
      // Stamp the order-level payment audit trail the same way a
      // staff-triggered setOnHold call would, so a 48h auto-expiry reads
      // the same as a manual hold in the ticket's payment history — only
      // actorSub in the EVENT# record above tells you it was automatic.
      {
        Update: {
          TableName: TABLE,
          Key: { PK: li.PK, SK: "META" },
          ...paymentUpdate,
        },
      },
    ],
  }));
  const contact = await getCustomerContact(li.PK);
  await sendMailIfEmail(li.PK, contact, "Your KCMPS order verification window has expired",
    `We couldn't verify your payment within 48 hours, so this order (${li.PK}) has been automatically cancelled. Please place a new order or contact us if you already paid.`,
    "Emailed customer: order auto-cancelled (verification window expired)");
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
          Item: buildEvent({
            orderId: li.orderId, lineItemId: li.lineItemId, from: li.status, to: STATUS.QUOTE_EXPIRED,
            actorSub: "system:expire-pending-orders", at: now,
            meta: { reason: "7-day quote payment window elapsed" },
          }),
        },
      },
    ],
  }));
  const contact = await getCustomerContact(li.PK);
  await sendMailIfEmail(li.PK, contact, "Your KCMPS quote has expired",
    `Your quote for order ${li.PK} was not paid within 7 days and has expired. Reply to this email if you'd still like to proceed and we'll requote.`,
    "Emailed customer: quote expired");
}

async function getCustomerContact(orderPkValue) {
  const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPkValue, SK: metaSk() } }));
  return res.Item?.email || null;
}

async function sendMailIfEmail(pk, contact, subject, body, correspondenceNote) {
  if (!SES_SENDER || !contact || !EMAIL_RE.test(contact)) return;
  try {
    await ses.send(new SendEmailCommand({
      Source: SES_SENDER,
      // Bcc admin@kcmps.com — same "the Bcc is the sent-log" reasoning as
      // submit-payment-proof.js, so dashboard/email.html sees this too.
      Destination: { ToAddresses: [contact], BccAddresses: ["admin@kcmps.com"] },
      Message: { Subject: { Data: subject }, Body: { Text: { Data: body } } },
    }));
  } catch (err) {
    console.error("expire-pending-orders: SES send failed (degrading gracefully):", err.message);
    return;
  }
  // Surfaces in job-detail.html's "Customer correspondence" card so staff
  // can see at a glance that this touchpoint's email actually went out.
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET correspondenceLog = list_append(correspondenceLog, :entry)",
    ExpressionAttributeValues: { ":entry": [{ at: new Date().toISOString(), note: correspondenceNote, actorName: "System (auto-email)" }] },
  })).catch((err) => {
    console.error("expire-pending-orders: correspondence log failed:", err.message);
  });
}
