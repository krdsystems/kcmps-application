/* ============================================================
   KCMPS Asset Library — POST /assets/upload-url (getUploadUrl)
   ============================================================
   Step 1 of 2. Hands the dashboard's Design Library upload form a pair
   of pre-signed S3 PUT URLs — one for the source file (PSD/AI/PDF), one
   for the designer-supplied web-ready image (JPG/PNG/WebP). The browser
   PUTs both directly to S3; **no file bytes ever pass through this
   Lambda**, which is what makes a 300MB PSD a non-event instead of a
   payload/timeout problem. Same presign→direct-PUT shape as
   backend/checkout/upload-design-file.js and submit-payment-proof.js.

   Step 2 is publish-design.js (POST /assets), which the
   browser calls after both PUTs succeed. Nothing is recorded in DynamoDB
   here — an upload that is never published is just an orphan object pair
   (same tradeoff as the pre-checkout customer upload path).

   ── AUTH — unlike the customer upload path, this one is gated ───────
   JWT-authorized route, and additionally restricted to the
   Production/Sales/Admin Cognito groups via backend/lib/auth.js's
   requireRole() (docs/roadmap.md's "access = existing Production/Sales/
   Admin groups" decision — no new 6th role). NOT isStaff(): a Finance
   login has no business writing to the design library, and rolling our
   own group check here instead of using requireRole() is exactly how the
   bracketed-space-separated `cognito:groups` serialization gotcha
   (backend/lib/auth.js's getGroups()) gets reintroduced.

   `uploadedBy` is the JWT's verified `sub` and is resolved in
   publish-design.js from the same claims object — never from the request
   body. Nothing in the body can name a user, a bucket, or a key.

   ── What is validated, and where ───────────────────────────────────
     1. asset-library.html (client): type/size, before a presign is
        requested. UX only, trivially bypassed, never trusted.
     2. HERE: category must be a known catalog leaf; contentType AND
        filename extension must both land in design-types.js's allowlist
        and agree; size must be > 0 and <= 300MB.
     3. The signed URLs themselves: one exact key, one Content-Type, one
        exact Content-Length, 15-minute expiry. ContentLength is part of
        the signature, so a client that lied about `size` to get past
        step 2 still cannot upload more bytes than it declared — S3
        rejects the PUT. That is what makes the 300MB cap real.
     4. The S3 key is ALWAYS server-generated: designs/<category>/
        <randomUUID>/{original,web}.<validated-ext>. The designer's
        filename never reaches a key.
     5. Both objects land on the PRIVATE originals bucket, inside the
        `designs/` prefix GuardDuty Malware Protection watches. The
        web-ready file only reaches the public storefront bucket via
        publish-design.js's server-side copy, and only on a clean scan
        verdict — fail closed.
   ============================================================ */

const { randomUUID } = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { extractClaims, requireRole, ROLES } = require("../lib");
const {
  MAX_DESIGN_BYTES, DESIGN_CATEGORIES,
  resolveOriginalType, resolveWebType, isValidCategory, originalKey, webKey,
} = require("./design-types");

const DESIGN_ORIGINALS_BUCKET = process.env.DESIGN_ORIGINALS_BUCKET;
// Same 15-minute precedent as every other presign in this codebase: long
// enough for a 300MB PSD on a Manila connection, short enough that a
// leaked URL isn't a durable write primitive.
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const ALLOWED_ROLES = [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN];

const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, ALLOWED_ROLES);
  if (denied) return response(403, { error: "Forbidden — Design Library uploads require the Production, Sales or Admin role.", requiredRoles: denied.requiredRoles });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!isValidCategory(category)) {
    return response(400, { error: `category must be one of: ${DESIGN_CATEGORIES.join(", ")}` });
  }

  const originalExt = validateFile(body.original, resolveOriginalType,
    "the source file needs a filename with a recognisable extension.");
  if (originalExt.error) return response(400, { error: `original: ${originalExt.error}` });
  const webExt = validateFile(body.web, resolveWebType,
    "that image type isn't accepted. Web-ready image: JPG, PNG, or WebP.");
  if (webExt.error) return response(400, { error: `web: ${webExt.error}` });

  // Server-generated, and the ONLY identity a key is built from.
  const designId = randomUUID();
  const originalS3Key = originalKey(category, designId, originalExt.ext);
  const webS3Key = webKey(category, designId, webExt.ext);

  const [originalUploadUrl, webUploadUrl] = await Promise.all([
    presign(originalS3Key, body.original.contentType, Number(body.original.size)),
    presign(webS3Key, body.web.contentType, Number(body.web.size)),
  ]);

  return response(200, {
    designId,
    category,
    expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
    original: {
      s3Key: originalS3Key,
      ref: `s3://${DESIGN_ORIGINALS_BUCKET}/${originalS3Key}`,
      uploadUrl: originalUploadUrl,
    },
    web: {
      s3Key: webS3Key,
      ref: `s3://${DESIGN_ORIGINALS_BUCKET}/${webS3Key}`,
      uploadUrl: webUploadUrl,
    },
  });
};

function validateFile(file, resolver, noTypeMessage) {
  if (!file || typeof file !== "object") return { error: "filename, contentType and size are required" };
  const filename = typeof file.filename === "string" ? file.filename.trim() : "";
  const size = Number(file.size);
  if (!filename) return { error: "filename is required" };
  if (!Number.isFinite(size) || size <= 0) return { error: "size must be a positive number" };
  if (size > MAX_DESIGN_BYTES) {
    return { error: `file is too large — the limit is ${Math.floor(MAX_DESIGN_BYTES / (1024 * 1024))}MB per file.` };
  }
  const ext = resolver(file.contentType, filename);
  if (!ext) return { error: noTypeMessage };
  return { ext };
}

function presign(Key, ContentType, ContentLength) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: DESIGN_ORIGINALS_BUCKET, Key, ContentType, ContentLength }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS }
  );
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
