/* ============================================================
   KCMPS Checkout — POST /orders/lookup
   ============================================================
   Guest order lookup (My Orders plan, Phase 3). Guest checkout is a hard
   requirement (create-order.js's header), so a guest's order has
   customerSub: null and is permanently invisible to GET /orders (which
   filters strictly on the caller's sub). This is their only way back to
   an order they never logged in to place.

   SECURITY MODEL: orderId is a 6-char base36 string — deliberately "not a
   meaningful secret" (see submit-payment-proof.js's header, which accepts
   the same tradeoff for the payment-proof endpoint). The contact match
   below IS the authentication here, so it must not leak whether a
   mismatch was a wrong orderId or a wrong contact:
     - identical generic 404 for both cases (no enumeration oracle)
     - a small artificial delay before every failure response, so a
       nonexistent order and a wrong-contact order take about the same
       time to answer
     - the API Gateway route this is wired to (see backend/infra/README.md)
       should carry a low per-route throttle — this Lambda does not rate-
       limit itself, that's infra's job.

   Returns the same redacted shape backend/staff-api/get-orders.js gives a
   customer (backend/lib/customer-view.js) — never the staff-internal
   fields.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { orderPk, metaSk, redactForCustomer, contactsMatch } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const SCREENSHOT_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;
const ARTIFICIAL_DELAY_MS = 300;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const orderId = (body.orderId || "").trim();
  const contact = (body.contact || "").trim();
  if (!orderId || !contact) return response(400, { error: "orderId and contact are required" });

  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk(orderId), SK: metaSk() } }));
  const order = orderRes.Item;

  if (!order || !contactsMatch(contact, order)) {
    await sleep(ARTIFICIAL_DELAY_MS);
    return response(404, { error: "No order found for that order ID and contact." });
  }

  const [lineItemsRes, eventsRes] = await Promise.all([
    client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "LINEITEM#" },
    })),
    client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "EVENT#" },
    })),
  ]);
  const payment = await withScreenshotUrl(order.payment);
  const full = { ...order, payment, lineItems: lineItemsRes.Items || [], events: eventsRes.Items || [] };

  return response(200, { order: redactForCustomer(full) });
};

async function withScreenshotUrl(payment) {
  if (!payment || !payment.screenshotRef) return payment;
  const match = S3_URI_RE.exec(payment.screenshotRef);
  if (!match) return payment;
  const [, bucket, key] = match;
  try {
    const screenshotUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: SCREENSHOT_URL_EXPIRY_SECONDS });
    return { ...payment, screenshotUrl };
  } catch (err) {
    console.error("lookupOrder: failed to presign screenshotUrl:", err.message);
    return payment;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
