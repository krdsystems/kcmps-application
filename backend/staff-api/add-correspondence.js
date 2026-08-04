/* ============================================================
   KCMPS staff API — POST /orders/{orderId}/correspondence
   ============================================================
   Staff-authored notes on the "Customer correspondence" card
   (job-detail.html) — a manual log of touchpoints that happened outside
   this system (email, chat, phone), separate from the order message
   thread (send-message.js/get-messages.js) and from the SYSTEM-authored
   entries other Lambdas append on real customer-email sends (see
   verify-payment.js/advance-line-item.js/submit-payment-proof.js/
   expire-pending-orders.js's own `correspondenceLog` appends).

   Did not exist as a live endpoint before 2026-08-04 — the dashboard's
   "Log" button called dashboard-data.js's addCorrespondenceLog()
   directly against the localStorage mock (`state.orders.find(...)`),
   which only ever finds manually-entered mock orders. For any real
   (backend-created) order it silently threw "Order not found" — staff
   notes on real tickets were never actually persisted. This Lambda is
   both the attachment feature and the fix for that gap.

   Body shape: { note?: string, attachments?: [{filename, contentType}] }
   — note or at least one attachment is required, not necessarily both
   (a screenshot with no comment is a valid log entry). Attachments follow
   the same two-step presigned-upload flow as submit-payment-proof.js:
   this Lambda hands back a PUT URL per attachment; the browser uploads
   directly to S3, this Lambda never sees the file bytes.

   Response: { entry, uploads: [{s3Key, uploadUrl}] } — `entry` is the
   correspondenceLog item as written (attachments carry `s3Key`, not yet
   `url` — get-orders.js presigns a GET url for display on the next read,
   mirroring its existing payment.screenshotUrl pattern).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { orderPk, metaSk, extractClaims, isStaff } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const MAX_NOTE_LENGTH = 2000;
const MAX_ATTACHMENTS = 5;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  const note = (body.note || "").trim();
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (note.length > MAX_NOTE_LENGTH) return response(400, { error: `note must be ${MAX_NOTE_LENGTH} characters or fewer` });
  if (rawAttachments.length > MAX_ATTACHMENTS) return response(400, { error: `At most ${MAX_ATTACHMENTS} attachments per entry` });
  for (const a of rawAttachments) {
    if (!a || typeof a.filename !== "string" || !a.filename.trim()) return response(400, { error: "Each attachment needs a filename" });
    if (!ALLOWED_CONTENT_TYPES.has(a.contentType)) {
      return response(400, { error: `contentType must be one of: ${Array.from(ALLOWED_CONTENT_TYPES).join(", ")}` });
    }
  }
  if (!note && !rawAttachments.length) return response(400, { error: "A note or at least one attachment is required." });

  const pk = orderPk(orderId);
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  if (!orderRes.Item) return response(404, { error: "Order not found" });

  const at = new Date().toISOString();
  const staffName = claims.name || claims.email;

  const attachments = [];
  const uploads = [];
  for (const a of rawAttachments) {
    const safeName = sanitizeFilename(a.filename);
    const s3Key = `correspondence/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: s3Key, ContentType: a.contentType }),
      { expiresIn: UPLOAD_URL_EXPIRY_SECONDS }
    );
    const ref = `s3://${UPLOADS_BUCKET}/${s3Key}`;
    attachments.push({ filename: safeName, contentType: a.contentType, ref });
    uploads.push({ s3Key, uploadUrl });
  }

  const entry = { at, note, actorName: staffName || "—", attachments };

  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET correspondenceLog = list_append(if_not_exists(correspondenceLog, :empty), :entry)",
    ExpressionAttributeValues: { ":entry": [entry], ":empty": [] },
  }));

  return response(200, { entry, uploads });
};

// Strips path separators and anything not alnum/dot/dash/underscore, and
// caps length — s3Key already scopes by orderId + a random suffix, this is
// just about not letting a browser-supplied filename inject S3 key
// structure (e.g. "../" or a slash) or absurd length into the object key.
function sanitizeFilename(name) {
  const base = name.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(-100) || "file";
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
