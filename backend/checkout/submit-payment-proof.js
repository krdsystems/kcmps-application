/* ============================================================
   KCMPS Checkout (Module 1 — Sales & Order) —
   POST /orders/{orderId}/payment-proof (submitPaymentProof)
   ============================================================
   The customer-facing half of the manual GCash bridge that
   ops-dashboard/infra/logic-inputs/api-verify-payment.js (staff-side)
   has always assumed exists but was never built — see that file's own
   header and backend-infra-to-deploy.md §3's callout that this Lambda
   is "storefront/checkout work, not part of this dashboard build."
   Also the second half of docs/roadmap.md 1.2's checklist.

   Flow (Payment_System_Project_Knowledge.md "Bridge Payment Method"):
     1. Customer has already placed the order via createOrder.js — its
        `sku` line items are sitting in Order Placed (NOT yet Pending
        Payment Verification — there's nothing to verify until this
        Lambda runs) with order.payment still null.
     2. Customer pays KCMPS's GCash QR, then calls this endpoint with the
        GCash reference number + the amount they claim to have sent.
     3. This Lambda hands back a pre-signed S3 PUT URL for the screenshot,
        writes the `payment` sub-object onto ORDER#<id>/META immediately
        (optimistic — it does not wait for the actual S3 upload to land;
        screenshotRef points at where it WILL be once the customer's
        direct-to-S3 PUT completes), and is the ONLY place that ever
        transitions a line item into Pending Payment Verification —
        writing the status + GSI1 change AND an EVENT# record per line
        item, same append-only pattern every other transition uses. Staff
        cross-check the typed reference number against real GCash
        transaction history before verifying either way (Payment_System
        file: "reference number... needed so staff can cross-check...
        screenshots alone are editable") — an incomplete/never-arriving
        screenshot upload is a staff-side judgment call at verification
        time, not something this Lambda needs to police.
     4. Sends the "Order received — under verification" SES email
        (docs/roadmap.md 1.2) if the order has an `email` on file
        (checkout's contact fields are individually optional — phone/
        Messenger-only customers can't receive an email).

   NO OWNERSHIP CHECK on the caller vs. the order. Checkout is guest-
   friendly (createOrder.js's customerSub can be null), so there's no
   reliable identity to check submitters against, and the orderId alone
   isn't a meaningful secret (it's echoed back to the customer to enter
   here on purpose). The actual trust boundary is downstream: staff never
   verify a payment from the typed reference number alone — they cross-
   check it against KCMPS's real GCash transaction history first. Do not
   "fix" this by requiring login without re-reading this note; that would
   be a checkout UX change, not a security fix.

   MONEY: peso floats, not integer centavos — see create-order.js's
   header for why (matches every other currently-drafted Lambda; a
   partial centavo migration would corrupt metrics 100x).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { STATUS, orderPk, metaSk, activeStatusAttrs, buildEvent } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
const FROM_EMAIL = process.env.FROM_EMAIL; // must be an SES-verified identity, e.g. order@kcmps.com
const VERIFICATION_SLA_HOURS = Number(process.env.VERIFICATION_SLA_HOURS || 48);
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESClient({});

exports.handler = async (event) => {
  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  const gcashRefNumber = (body.gcashRefNumber || "").trim();
  const claimedAmount = Number(body.claimedAmount);
  const contentType = body.contentType || "image/jpeg";
  if (!gcashRefNumber) return response(400, { error: "gcashRefNumber is required" });
  if (!(claimedAmount > 0)) return response(400, { error: "claimedAmount must be a positive number" });
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
    return response(400, { error: "contentType must be image/jpeg, image/png, or image/webp" });
  }

  const pk = orderPk(orderId);
  const orderRes = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });
  if (order.payment && order.payment.verifiedAt) {
    return response(409, { error: "This order's payment is already verified." });
  }

  const now = new Date().toISOString();
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const s3Key = `payments/${orderId}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const screenshotRef = `s3://${UPLOADS_BUCKET}/${s3Key}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: s3Key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS }
  );

  const payment = {
    method: "gcash_manual",
    claimedAmount,
    gcashRefNumber,
    screenshotRef,
    submittedAt: now,
    verifiedBy: null,
    verifiedAt: null,
    rejectionReason: null,
  };

  // Still-Order-Placed sku line items are the ones this submission actually
  // covers — this is the one and only place a line item ever becomes
  // Pending Payment Verification (see header). A resubmission after a
  // rejection (Payment Rejected -> Pending Payment Verification) is a
  // separate, already-legal transition (advance-line-item.js's
  // LEGAL_TRANSITIONS) that this Lambda doesn't need to duplicate — those
  // line items aren't Order Placed anymore, so this query naturally skips
  // them here and the customer's resubmission flow re-invokes this same
  // endpoint anyway.
  const placedRes = await dynamo.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    FilterExpression: "#status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":pk": pk, ":prefix": "LINEITEM#", ":status": STATUS.ORDER_PLACED },
  }));
  const placedLineItems = placedRes.Items || [];

  const transactItems = [
    {
      // Optimistic lock on the whole `payment` attribute (not a nested
      // path — payment starts as a NULL scalar, not a map, so
      // attribute_not_exists()/nested-path conditions on it are unsafe).
      // If staff verified/rejected this order's payment between our Get
      // above and this write landing, `payment` will have changed and
      // this condition fails — without it, a resubmission could silently
      // clobber a just-verified payment, wiping verifiedAt/verifiedBy.
      Update: {
        TableName: TABLE,
        Key: { PK: pk, SK: metaSk() },
        ConditionExpression: "payment = :priorPayment",
        UpdateExpression: "SET payment = :payment, updatedAt = :now",
        ExpressionAttributeValues: { ":payment": payment, ":priorPayment": order.payment ?? null, ":now": now },
      },
    },
    // Every Order Placed -> Pending Payment Verification transition is a
    // status write + an append-only EVENT# record, same shape as every
    // other transition in the state machine (backend/lib/events.js).
    ...placedLineItems.flatMap((li) => {
      const gsiAttrs = activeStatusAttrs(STATUS.PENDING_PAYMENT_VERIFICATION, now);
      return [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: li.PK, SK: li.SK },
            ConditionExpression: "#status = :from",
            UpdateExpression: "SET #status = :to, enteredStatusAt = :now, GSI1PK = :gsi1pk, GSI1SK = :gsi1sk",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":now": now, ":from": STATUS.ORDER_PLACED, ":to": STATUS.PENDING_PAYMENT_VERIFICATION,
              ":gsi1pk": gsiAttrs.GSI1PK, ":gsi1sk": gsiAttrs.GSI1SK,
            },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: buildEvent({
              orderId, lineItemId: li.lineItemId, from: STATUS.ORDER_PLACED, to: STATUS.PENDING_PAYMENT_VERIFICATION,
              actorSub: order.customerSub, actorName: order.customerName,
              meta: { via: "submitPaymentProof" }, at: now,
            }),
          },
        },
      ];
    }),
  ];

  await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems })).catch((err) => {
    if (err.name === "TransactionCanceledException") {
      throw Object.assign(new Error("This order's payment changed concurrently — reload and try again."), { statusCode: 409 });
    }
    throw err;
  });

  if (FROM_EMAIL && order.email) {
    await sendReceivedEmail(order, orderId).catch((err) => {
      // Never fail the request over a notification email — the payment
      // proof itself is already durably written by the time this runs.
      console.error("submitPaymentProof: SES send failed:", err.message);
    });
  }

  return response(200, { orderId, uploadUrl, screenshotRef, expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
};

async function sendReceivedEmail(order, orderId) {
  const subject = `Order ${orderId} received — under payment verification`;
  const bodyText =
    `Hi ${order.customerName},\n\n` +
    `We've received your GCash payment details for order ${orderId} and it's now under ` +
    `verification. We'll confirm within ${VERIFICATION_SLA_HOURS} hours.\n\n` +
    `— KCMPS`;
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    // Bcc admin@kcmps.com so every customer notification also lands in the
    // shared inbox dashboard/email.html reads from — the dashboard has no
    // separate "sent" log of its own, so this Bcc IS that log.
    Destination: { ToAddresses: [order.email], BccAddresses: ["admin@kcmps.com"] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: bodyText } },
    },
  }));
  // Surfaces in job-detail.html's "Customer correspondence" card so staff
  // can see at a glance that this touchpoint's email actually went out —
  // best-effort and separate from the send above (a log-write failure
  // must never look like the email itself failed).
  await logCorrespondence(orderPk(orderId), "Emailed customer: order received, pending verification").catch((err) => {
    console.error("submitPaymentProof: correspondence log failed:", err.message);
  });
}

async function logCorrespondence(pk, note) {
  await dynamo.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET correspondenceLog = list_append(correspondenceLog, :entry)",
    ExpressionAttributeValues: { ":entry": [{ at: new Date().toISOString(), note, actorName: "System (auto-email)" }] },
  }));
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
