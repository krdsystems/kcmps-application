/* ============================================================
   KCMPS backend — notify-unread-messages Lambda
   ============================================================
   Trigger: EventBridge cron, every 30 minutes.

   "Digest, don't spam" (Ops Dashboard Project Knowledge §5.5's
   governing principle for staff notifications, applied here to
   customer-facing ones too): a customer who hasn't opened a staff
   reply within 2 hours gets ONE reminder email, not one per message.
   Per-message SES stays reserved for the payment-flow touchpoints
   (checkout/submit-payment-proof.js, staff-api/verify-payment.js,
   etc.) — this is the one scheduled, batched exception, mirroring
   expire-pending-orders.js's own cron shape.

   No GSI for "unread messages" exists (see send-message.js's header on
   GSI2 not being provisioned yet) — this is a bounded table Scan
   filtered to MSG# items, same accepted-interim tradeoff as
   staff-api/get-orders.js's CLIENT#-filtered scan. Revisit with a real
   index if message volume ever makes this scan expensive (cost
   governance, docs/cost-governance.md).

   Idempotency: `reminderSentAt` is stamped on every matched message
   after a successful send, and the scan filters it out
   (attribute_not_exists) — so a message is reminded on at most once,
   and a whole order's unread backlog reminds in a single email even if
   several staff messages qualify in the same run.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { metaSk } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const SES_SENDER = process.env.SES_SENDER; // e.g. "orders@kcmps.com", must be a verified SES identity
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNREAD_REMINDER_HOURS = 2;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

exports.handler = async () => {
  const cutoff = new Date(Date.now() - UNREAD_REMINDER_HOURS * 3600 * 1000).toISOString();
  const unread = await scanUnreadStaffMessages(cutoff);
  if (!unread.length) return { statusCode: 200, remindedOrders: 0 };

  const byOrder = new Map();
  unread.forEach((m) => {
    if (!byOrder.has(m.PK)) byOrder.set(m.PK, []);
    byOrder.get(m.PK).push(m);
  });

  let remindedOrders = 0;
  for (const [pk, messages] of byOrder) {
    try {
      const sent = await remindOrder(pk, messages);
      if (sent) remindedOrders++;
    } catch (err) {
      console.error("notify-unread-messages: reminder failed for", pk, err);
    }
  }
  return { statusCode: 200, remindedOrders };
};

async function scanUnreadStaffMessages(cutoff) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(SK, :prefix) AND senderRole = :staff AND readAt = :null AND attribute_not_exists(reminderSentAt) AND #at < :cutoff",
      ExpressionAttributeNames: { "#at": "at" },
      ExpressionAttributeValues: { ":prefix": "MSG#", ":staff": "staff", ":null": null, ":cutoff": cutoff },
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function remindOrder(pk, messages) {
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  const orderId = pk.replace(/^ORDER#/, "");
  const contact = order && order.email;

  const now = new Date().toISOString();
  let sent = false;
  if (SES_SENDER && contact && EMAIL_RE.test(contact)) {
    await ses.send(new SendEmailCommand({
      Source: SES_SENDER,
      // Bcc admin@kcmps.com — same "the Bcc is the sent-log" reasoning as
      // every other customer-facing send in this repo.
      Destination: { ToAddresses: [contact], BccAddresses: ["admin@kcmps.com"] },
      Message: {
        Subject: { Data: `New reply on your KCMPS order ${orderId}` },
        Body: { Text: { Data:
          `Hi ${order.customerName || "there"},\n\n` +
          `We replied to you about order ${orderId} and wanted to make sure you saw it — log in and open the order to read it and reply.\n\n` +
          `— KCMPS`
        } },
      },
    }));
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk, SK: metaSk() },
      UpdateExpression: "SET correspondenceLog = list_append(if_not_exists(correspondenceLog, :empty), :entry)",
      ExpressionAttributeValues: {
        ":empty": [],
        ":entry": [{ at: now, note: "Emailed customer: unread reply reminder", actorName: "System (auto-email)" }],
      },
    })).catch((err) => console.error("notify-unread-messages: correspondence log failed:", err.message));
    sent = true;
  }

  // Stamp reminderSentAt on every matched message for this order regardless
  // of whether the email actually sent (no SES_SENDER configured yet, or a
  // non-email contact) — otherwise a guest/phone-contact order with no
  // deliverable address would get rescanned every 30 minutes forever.
  await Promise.all(messages.map((m) =>
    client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: m.PK, SK: m.SK },
      UpdateExpression: "SET reminderSentAt = :now",
      ExpressionAttributeValues: { ":now": now },
    })).catch((err) => console.error("notify-unread-messages: reminderSentAt stamp failed for", m.SK, err.message))
  ));

  return sent;
}
