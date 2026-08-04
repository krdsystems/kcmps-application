/* ============================================================
   KCMPS staff API — GET /orders
   ============================================================
   Role-filtered order read (Payment System file Part 6: "Shared truth,
   filtered by role. Same ORDER# record; the customer sees their own line
   items via the sub claim, staff see all via the group claim.").

   API Gateway's Cognito JWT authorizer has already verified the token
   signature by the time this Lambda runs — claims arrive pre-verified in
   event.requestContext.authorizer.jwt.claims (backend/lib/auth.js's
   extractClaims()). Never trust a client-decoded token instead.

   Ported from ops-dashboard/infra/logic-inputs/api-get-orders.js against
   backend/lib conventions (see backend/CLAUDE.md) — same behavior, no
   duplicated key-building/claims-normalizing logic.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { extractClaims, isStaff } = require("../lib/auth");
const { scanResultPk, metaSk } = require("../lib/keys");
const { redactForCustomer } = require("../lib/customer-view");

const TABLE = process.env.TABLE_NAME;
const SCREENSHOT_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const staff = isStaff(claims);
  const orders = staff ? await getAllOrders() : await getOrdersForSub(claims.sub);
  if (staff) {
    await Promise.all(orders.map(withCorrespondenceUrls));
    await Promise.all(orders.map(withDesignFileUrls));
  }
  if (!staff) orders.forEach(redactForCustomer); // strips correspondenceLog entirely — customers never see it
  orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return response(200, { orders });
};

async function getAllOrders() {
  // A full Scan is acceptable here ONLY because this is a bounded,
  // infrequent, staff-only read (the "all jobs" list), not a per-load
  // dashboard metric. If order volume grows large, paginate this with a
  // real query pattern (e.g. a GSI on createdAt) instead.
  const items = await scanAll({
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META" },
  });
  return Promise.all(items.map(attachLineItems));
}

async function getOrdersForSub(sub) {
  // Requires a CLIENT#-keyed GSI once the CRM view matures. Until then, a
  // bounded scan filtered by customerSub is acceptable at KCMPS's current
  // order volume.
  const items = await scanAll({
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND customerSub = :sub",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META", ":sub": sub },
  });
  return Promise.all(items.map(attachLineItems));
}

// Scan's 1MB page cap applies BEFORE FilterExpression, and this table also
// holds LINEITEM#/EVENT# items — so a single un-paginated Scan can return a
// page that's entirely filtered out, or only partial results, well before
// order volume looks "large" by item COUNT. Loop on LastEvaluatedKey so a
// customer's own order (or a staff member's jobs list) never silently goes
// missing instead of erroring.
async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}


async function attachLineItems(order) {
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
  return { ...order, payment, lineItems: lineItemsRes.Items || [], events: eventsRes.Items || [] };
}

// ---- attachment download rules (one place, three call sites) ----
//
// Every uploaded file in this system — GCash proof, correspondence
// attachment, message attachment, customer design file — is subject to the
// same two rules, so they live in one helper rather than being reimplemented
// per prefix (they previously were, and the message/correspondence paths
// silently had neither):
//
//  1. SCAN GATE. jobs/handle-scan-result.js persists GuardDuty's verdict
//     onto the record as `scanStatus`. Anything other than NO_THREATS_FOUND
//     gets NO url at all, so staff cannot click through to a file that is
//     infected, still scanning, or unscannable. An attachment with no
//     persisted verdict is PENDING — fail closed. Infected files are also
//     already DELETED from S3 by that Lambda; the record survives so the
//     dashboard can show what arrived and why it's gone.
//
//     This deliberately does NOT call S3 to check status: doing so meant a
//     GetObjectTagging round trip per attachment per order on every staff
//     list load. The verdict is written once, on the scan event, and read
//     from DynamoDB here.
//
//  2. FORCED DOWNLOAD. Presigned GETs carry
//     ResponseContentDisposition=attachment and
//     ResponseContentType=application/octet-stream, so a browser can never
//     render or execute an upload inline regardless of its real content.
//     Set on the READ side, not baked in at PUT time, so it stays entirely
//     server-controlled — the uploading client can't influence it.
//     (Exception: the GCash screenshot, which staff need to actually LOOK
//     at in an <img> to verify a payment. It keeps an inline-viewable url,
//     but only once it has passed the same scan gate — see below.)
function isClean(att) {
  return att && att.scanStatus === "NO_THREATS_FOUND";
}

// An attachment normally carries its verdict inline, annotated by
// jobs/handle-scan-result.js. When it doesn't, fall back to the standalone
// SCAN# item that Lambda always writes (see keys.js's scanResultPk).
//
// This is not a rare edge case for design files: they are uploaded BEFORE
// checkout, so GuardDuty routinely finishes scanning while the customer is
// still filling in the form — there is no order to annotate at that moment.
// Without this fallback the verdict is lost and the file shows "Scanning…"
// forever, which for a CLEAN file means staff can never download legitimate
// artwork. A point GetItem, and only for attachments still missing a
// verdict, so it costs nothing on the normal path.
async function resolveVerdict(att) {
  if (!att || !att.ref || att.scanStatus) return att;
  try {
    const res = await client.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: scanResultPk(att.ref), SK: metaSk() },
    }));
    if (!res.Item) return att;
    const { scanStatus, threats, threatInfo, scannedAt, quarantined, quarantinedAt } = res.Item;
    return { ...att, scanStatus, threats, threatInfo, scannedAt, quarantined, quarantinedAt };
  } catch (err) {
    console.error("get-orders: scan-verdict lookup failed for", att.ref, err.message);
    return att;
  }
}

// Shared by correspondence + message + design-file attachments.
async function attachDownloadUrl(raw) {
  const att = await resolveVerdict(raw);
  if (!att || !att.ref) return att;
  if (!isClean(att)) return { ...att, url: null, scanStatus: att.scanStatus || "PENDING" };
  const url = await presignS3Uri(att.ref, {
    ResponseContentDisposition: `attachment; filename="${downloadFilename(att.filename)}"`,
    ResponseContentType: "application/octet-stream",
  });
  return { ...att, url };
}

// The GCash screenshot is the one upload staff must see rendered, not
// downloaded — the whole verification flow is "look at the image, compare
// the reference number". So it keeps an inline url, but only after passing
// the same scan gate as everything else; an unscanned or infected proof
// shows as blocked and the payment simply can't be verified from a preview.
async function withScreenshotUrl(raw) {
  if (!raw || !raw.screenshotRef) return raw;
  // Same fallback as attachments — `payment` stores the ref under a
  // different field name, so adapt it for resolveVerdict().
  const resolved = await resolveVerdict({ ...raw, ref: raw.screenshotRef });
  const payment = { ...raw, ...resolved, ref: undefined };
  delete payment.ref;
  if (!isClean(payment)) {
    return { ...payment, screenshotUrl: null, scanStatus: payment.scanStatus || "PENDING" };
  }
  const screenshotUrl = await presignS3Uri(payment.screenshotRef);
  return screenshotUrl ? { ...payment, screenshotUrl } : payment;
}

async function withCorrespondenceUrls(order) {
  if (!Array.isArray(order.correspondenceLog) || !order.correspondenceLog.length) return order;
  order.correspondenceLog = await Promise.all(order.correspondenceLog.map(async (entry) => {
    if (!Array.isArray(entry.attachments) || !entry.attachments.length) return entry;
    return { ...entry, attachments: await Promise.all(entry.attachments.map(attachDownloadUrl)) };
  }));
  return order;
}

async function withDesignFileUrls(order) {
  if (!Array.isArray(order.designFiles) || !order.designFiles.length) return order;
  order.designFiles = await Promise.all(order.designFiles.map(attachDownloadUrl));
  return order;
}

async function presignS3Uri(s3Uri, opts) {
  if (!s3Uri) return null;
  const match = S3_URI_RE.exec(s3Uri);
  if (!match) return null;
  const [, bucket, key] = match;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ...(opts || {}) }), { expiresIn: SCREENSHOT_URL_EXPIRY_SECONDS });
  } catch (err) {
    console.error("get-orders: failed to presign", s3Uri, err.message);
    return null;
  }
}

// The filename lands inside a quoted Content-Disposition header value, so
// quotes/backslashes/control chars (incl. CR/LF — header injection) have to
// go. Non-ASCII is dropped rather than RFC 5987-encoded: this is a
// convenience label on a download, not something worth a second encoding
// scheme, and the real name is always shown in the dashboard next to it.
function downloadFilename(name) {
  const cleaned = String(name || "file")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
