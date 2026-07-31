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
        `sku` line items are sitting in Pending Payment Verification with
        order.payment still null.
     2. Customer pays KCMPS's GCash QR, then calls this endpoint with the
        GCash reference number + the amount they claim to have sent.
     3. This Lambda hands back a pre-signed S3 PUT URL for the screenshot
        and writes the `payment` sub-object onto ORDER#<id>/META
        immediately (optimistic — it does not wait for the actual S3
        upload to land; screenshotRef points at where it WILL be once
        the customer's direct-to-S3 PUT completes). Staff cross-check the
        typed reference number against real GCash transaction history
        before verifying either way (Payment_System file: "reference
        number... needed so staff can cross-check... screenshots alone
        are editable") — an incomplete/never-arriving screenshot upload
        is a staff-side judgment call at verification time, not something
        this Lambda needs to police.
     4. Sends the "Order received — under verification" SES email
        (docs/roadmap.md 1.2) if customerContact looks like an email
        address (checkout's "contact" field is free text — phone numbers
        are common and can't receive an email).

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
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { orderPk, metaSk } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
const FROM_EMAIL = process.env.FROM_EMAIL; // must be an SES-verified identity, e.g. order@kcmps.com
const VERIFICATION_SLA_HOURS = Number(process.env.VERIFICATION_SLA_HOURS || 48);
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  await dynamo.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET payment = :payment, updatedAt = :now",
    ExpressionAttributeValues: { ":payment": payment, ":now": now },
  }));

  if (FROM_EMAIL && EMAIL_RE.test(order.customerContact || "")) {
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
    Destination: { ToAddresses: [order.customerContact] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: bodyText } },
    },
  }));
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
