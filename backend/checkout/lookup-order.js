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

   ── Screenshot presign: fail-closed scan gate (fixed 2026-08-07) ────
   This is a PRE-EXISTING BUG, not something introduced by the SVG/UAT
   pass — found in review while cross-checking that pass's inline-SVG
   audit. withScreenshotUrl() below used to call getSignedUrl() directly
   with no scan-verdict check at all, unlike its sibling
   staff-api/get-orders.js's withScreenshotUrl(), which correctly
   withholds the url (scanStatus: "PENDING"/whatever GuardDuty found)
   until a persisted NO_THREATS_FOUND verdict exists. That contradicted
   the fail-closed invariant documented in both CLAUDE.md files ("no
   NO_THREATS_FOUND verdict = no download link, ever") on the one path a
   completely unauthenticated caller (this Lambda has no authorizer —
   only contactsMatch() gates it) can reach.
   Real-world severity was moderate-low today only because
   submit-payment-proof.js hard-restricts payment uploads to
   image/(jpeg|png|webp) (no script-bearing type can land in `payments/`)
   and handle-scan-result.js purges every version of an infected object
   (so a THREATS_FOUND file would 404, not serve malware) — but it was a
   live gap in the documented contract and a landmine for the moment
   payment uploads are ever widened (a "PDF receipt" is a very plausible
   future ask). Fixed by porting get-orders.js's resolveVerdict() pattern
   here and gating on the SAME shared predicate
   (backend/lib/constants.js's isCleanScanVerdict()) get-orders.js now
   also uses, instead of each Lambda keeping its own copy of "is this
   clean" to drift out of sync again.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { orderPk, normalizeOrderId, metaSk, scanResultPk, redactForCustomer, contactsMatch, isCleanScanVerdict } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const SCREENSHOT_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;
const ARTIFICIAL_DELAY_MS = 300;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  // Accept both "ORD-3A94793FF8" and the bare "3A94793FF8" a customer
  // often copies (case-insensitive, whitespace-tolerant) — see
  // normalizeOrderId()'s header (backend/lib/keys.js) for why this is
  // safe to do before the auth check below without weakening it.
  const orderId = normalizeOrderId(body.orderId);
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

// Mirrors staff-api/get-orders.js's withScreenshotUrl() exactly — same
// fail-closed gate, same standalone-verdict fallback, same shared
// isCleanScanVerdict() predicate. See this file's header for why this
// used to skip the gate entirely.
async function withScreenshotUrl(raw) {
  if (!raw || !raw.screenshotRef) return raw;
  const resolved = await resolveVerdict(raw);
  if (!isCleanScanVerdict(resolved)) {
    return { ...resolved, screenshotUrl: null, scanStatus: resolved.scanStatus || "PENDING" };
  }
  const match = S3_URI_RE.exec(resolved.screenshotRef);
  if (!match) return resolved;
  const [, bucket, key] = match;
  try {
    const screenshotUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: SCREENSHOT_URL_EXPIRY_SECONDS });
    return { ...resolved, screenshotUrl };
  } catch (err) {
    console.error("lookupOrder: failed to presign screenshotUrl:", err.message);
    return resolved;
  }
}

// `payment` is usually already annotated in place by handle-scan-
// result.js's markPaymentScreenshot() by the time this runs (the payment
// sub-object exists before the customer's S3 PUT even completes — see
// submit-payment-proof.js). Falls back to the standalone SCAN#<ref> item
// for the same race get-orders.js's resolveVerdict() covers: a scan that
// completes before that annotation write lands.
async function resolveVerdict(payment) {
  if (payment.scanStatus) return payment;
  try {
    const res = await client.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: scanResultPk(payment.screenshotRef), SK: metaSk() },
    }));
    if (!res.Item) return payment;
    const { scanStatus, threats, threatInfo, scannedAt, quarantined, quarantinedAt } = res.Item;
    return { ...payment, scanStatus, threats, threatInfo, scannedAt, quarantined, quarantinedAt };
  } catch (err) {
    console.error("lookupOrder: scan-verdict lookup failed for", payment.screenshotRef, err.message);
    return payment;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
