/* ============================================================
   KCMPS staff/customer API — POST /orders/{orderId}/messages
   ============================================================
   Feature: customer chat via a logged-in account, per-order thread
   (hybrid model — see get-messages.js's header for the account-level
   read path this pairs with).

   Item shape (new type, same table, no infra change):
     PK: ORDER#<id>, SK: MSG#<ISO timestamp>#<msgId>
     { senderSub, senderRole: "customer"|"staff", body,
       attachments: [{filename, contentType, ref}], readAt: null, at, orderId }

   Attachments (added 2026-08-04): same two-step presigned-upload flow as
   submit-payment-proof.js / add-correspondence.js — this Lambda hands
   back a PUT URL per requested attachment, the browser uploads directly
   to S3, this Lambda never sees file bytes. `body` or at least one
   attachment is required (not necessarily both — a photo with no caption
   is a valid message). `attachments[].ref` is an s3:// URI; get-
   messages.js presigns a GET url per attachment on read, same pattern as
   get-orders.js's payment.screenshotUrl.

   Auth: no separate "chat" role — a caller is either staff (any
   isStaff() group, may post to ANY order) or the order's own customer
   (JWT sub must match order.customerSub, same equality check
   cancel-order.js uses). No guest posting — chat requires a logged-in
   account by design (unlike checkout/lookup-order.js's contact-match
   fallback), so this Lambda always requires a verified JWT via API
   Gateway's authorizer, same as every other staff-api/*.js Lambda —
   never optional like checkout/cancel-order.js's tryGetSub().

   GSI2PK/GSI2SK are written on every message (CLIENT#<customerSub>/
   MSG#<at>) even though GSI2 doesn't exist on the table yet
   (backend/infra/foundation.cfn.yaml only provisions GSI1) — this is
   preparation, not activation: adding the index later needs zero
   backfill. Until then, the account-level "my messages across every
   order" view is a client-side fan-out over get-messages.js per order
   (see that file's header) — the same accepted-interim tradeoff
   staff-api/get-orders.js already uses for its own CLIENT#-keyed view.
   ============================================================ */

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { SITE_ID, SCHEMA_VERSION, orderPk, metaSk, messageSk, clientGsi2Pk, messageGsi2Sk, extractClaims, isStaff } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const MAX_BODY_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }
  const text = (body.body || "").trim();
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (text.length > MAX_BODY_LENGTH) return response(400, { error: `body must be ${MAX_BODY_LENGTH} characters or fewer` });
  if (rawAttachments.length > MAX_ATTACHMENTS) return response(400, { error: `At most ${MAX_ATTACHMENTS} attachments per message` });
  for (const a of rawAttachments) {
    if (!a || typeof a.filename !== "string" || !a.filename.trim()) return response(400, { error: "Each attachment needs a filename" });
    if (!ALLOWED_CONTENT_TYPES.has(a.contentType)) {
      return response(400, { error: `contentType must be one of: ${Array.from(ALLOWED_CONTENT_TYPES).join(", ")}` });
    }
  }
  if (!text && !rawAttachments.length) return response(400, { error: "body or at least one attachment is required" });

  const pk = orderPk(orderId);
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });

  const staff = isStaff(claims);
  if (!staff && claims.sub !== order.customerSub) {
    return response(403, { error: "You don't have access to this order." });
  }

  const at = new Date().toISOString();
  const msgId = randomUUID();

  const attachments = [];
  const uploads = [];
  for (const a of rawAttachments) {
    const safeName = sanitizeFilename(a.filename);
    const s3Key = `messages/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: s3Key, ContentType: a.contentType }),
      { expiresIn: UPLOAD_URL_EXPIRY_SECONDS }
    );
    attachments.push({ filename: safeName, contentType: a.contentType, ref: `s3://${UPLOADS_BUCKET}/${s3Key}` });
    uploads.push({ s3Key, uploadUrl });
  }

  const item = {
    PK: pk,
    SK: messageSk(at, msgId),
    tenantId: SITE_ID,
    siteId: SITE_ID,
    schemaVersion: SCHEMA_VERSION,
    orderId,
    msgId,
    senderSub: claims.sub,
    senderRole: staff ? "staff" : "customer",
    body: text,
    attachments,
    readAt: null,
    at,
  };
  // Index by the ORDER's customer, not the sender — a staff reply must
  // still show up under the customer's own account-level view. Guest
  // orders (customerSub null) simply aren't indexable this way yet, same
  // limitation get-orders.js's CLIENT# view already has.
  if (order.customerSub) {
    item.GSI2PK = clientGsi2Pk(order.customerSub);
    item.GSI2SK = messageGsi2Sk(at);
  }

  await client.send(new PutCommand({ TableName: TABLE, Item: item }));

  return response(201, { message: item, uploads });
};

// See add-correspondence.js's identical helper — strips path separators/
// non-alnum chars and caps length so a browser-supplied filename can't
// inject S3 key structure into the object key.
function sanitizeFilename(name) {
  const base = name.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(-100) || "file";
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
