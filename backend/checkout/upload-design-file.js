/* ============================================================
   KCMPS Checkout (Module 1 — Sales & Order) —
   POST /design-uploads (uploadDesignFile)
   ============================================================
   Hands the checkout form a pre-signed S3 PUT URL so a customer can
   attach their actual artwork/print file instead of pasting a Drive
   link. Replaces nothing — store.js's "Custom request details / design
   links" textarea stays alongside this, because plenty of customers
   legitimately do want to paste a folder link (and the multi-file case
   is exactly what the archive formats we don't accept would have been
   for — see backend/lib/upload-types.js).

   Same presign → direct-browser-PUT pattern as submit-payment-proof.js:
   **no file bytes ever pass through this Lambda**, which is what keeps a
   50MB print source file from being a Lambda payload/timeout problem and
   keeps malicious content out of our execution environment entirely.

   PRE-CHECKOUT, so there is no orderId yet. The file is attached while
   the customer is still filling in the checkout form; the order is only
   created when they hit "Place order". So the S3 key is keyed by a
   server-generated uploadId, and store.js carries the returned refs into
   create-order.js's `designFiles` payload, which persists them on the
   ORDER#<id>/META record. An upload whose order is never placed is just
   an orphan object (see the lifecycle note in docs/cost-governance.md).

   NO AUTH, deliberately — same reasoning as submit-payment-proof.js's
   own "NO OWNERSHIP CHECK" note: checkout is guest-friendly, so there's
   no identity to check against. The mitigations are that this endpoint
   only ever WRITES to a server-chosen key under one prefix (a caller can
   never overwrite an existing object, name a key, or read anything
   back), the route is throttled, and every object is scanned + private.

   ── What is validated, and where ──────────────────────────────────
   Defense in depth; each layer assumes the one above it was bypassed.
     1. store.js (client): extension + MIME + size, before a presign is
        even requested. UX only — trivially bypassed, never trusted.
     2. HERE (server): re-validates the declared contentType AND filename
        extension against backend/lib/upload-types.js's allowlist, both
        of which must agree (see resolveUploadType()'s comment on why one
        alone is not enough). Refuses to issue a URL otherwise. This is
        the real gate.
     3. The signed URL itself: scoped to ONE key, ONE Content-Type, ONE
        exact Content-Length, expiring in 15 minutes. Because
        ContentLength is part of the signature, a client that lied about
        `size` to get past the server-side size check still cannot upload
        more bytes than it declared — S3 rejects the PUT outright. That
        makes the size limit a real server-side constraint rather than a
        client-side courtesy.
     4. S3 object key: ALWAYS server-generated (`randomUUID()` + an
        extension derived from the *validated* type). The customer's
        filename never touches the key — no path traversal, no `../`, no
        null-byte/extension-confusion tricks. It is kept only as a
        display string on the order record and is escaped like every
        other customer-supplied string when the dashboard renders it.
     5. Serving: the bucket is private with Block Public Access on.
        Uploads are NEVER served from the site's origin and never
        rendered inline — staff-api/get-orders.js presigns short-lived
        GET URLs with ResponseContentDisposition=attachment and
        ResponseContentType=application/octet-stream, so the browser
        always downloads and never executes/renders. That is what keeps
        an uploaded file from being stored XSS or a drive-by.
        (ContentDisposition is forced at GET time, not baked in at PUT
        time, because a signed PUT header would have to be echoed exactly
        by the browser to match the signature — fragile, and it would let
        the *client* influence the stored disposition. Setting it on the
        read side keeps it entirely server-controlled.)

   ── Malware scanning: what exists (decision 2026-08-04) ───────────
   **GuardDuty Malware Protection for S3 is enabled on this bucket** —
   every uploaded object is scanned on write, and tagged with
   `GuardDutyMalwareScanStatus` (NO_THREATS_FOUND / THREATS_FOUND /
   UNSUPPORTED / ACCESS_DENIED / FAILED). staff-api/get-orders.js reads
   that tag and job-detail.html refuses to hand staff a download link for
   anything not cleanly scanned, so an infected file cannot be one click
   away from the machine that drives the press.

   Cost: **measured live (docs/cost-governance.md lines 77–94):** with 42 objects / 56 MB
   across all uploads in 2026-07-31→08-05, the cost is **$0.00/mo** (free tier). At an
   estimated ~200 uploads/mo averaging ~10MB that projects to ~₱10 (~2% of cap) — under the
   cap, negligible
   enough relative to a ~$1/mo baseline to be logged rather than shipped
   silently. Recorded in docs/cost-governance.md's decision log per that
   file's rule. Scanning is capped by a monthly GB limit on the GuardDuty
   side so a pathological upload spike can't run the bill away.

   What this does NOT do: it is signature/heuristic AV, not a guarantee.
   A novel or targeted payload can pass a clean scan. Layers 3–5 above
   (private bucket, never inline, never origin-served, server-chosen key)
   are what make a *missed* detection non-catastrophic — treat the scan
   as the last layer, not the only one, and never relax the containment
   rules on the strength of "but it's scanned."
   ============================================================ */

const { randomUUID } = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { MAX_UPLOAD_BYTES, resolveUploadType } = require("../lib");

const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
// Same 15-minute precedent as submit-payment-proof.js — long enough for a
// large file on a slow Manila connection, short enough that a leaked URL
// isn't a durable write primitive.
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const KEY_PREFIX = "design-uploads";

const s3 = new S3Client({});

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const size = Number(body.size);

  if (!filename) return response(400, { error: "filename is required" });
  if (!Number.isFinite(size) || size <= 0) return response(400, { error: "size must be a positive number" });
  if (size > MAX_UPLOAD_BYTES) {
    return response(400, { error: `File is too large — the limit is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.` });
  }

  // THE security gate — see header. Both the declared type and the
  // filename's extension must land inside the allowlist and agree.
  const ext = resolveUploadType(contentType, filename);
  if (!ext) {
    return response(400, {
      error: "That file type isn't accepted. Send images (JPG, PNG, WEBP, TIFF), print files (PDF, AI, EPS, PSD), or Office documents (DOC, DOCX, XLS, XLSX, PPT, PPTX) — or paste a link to the file instead.",
    });
  }

  const uploadId = randomUUID();
  // Customer filename is NEVER part of the key. Extension comes from the
  // validated type, not from the name we were handed.
  const s3Key = `${KEY_PREFIX}/${uploadId}.${ext}`;
  const fileRef = `s3://${UPLOADS_BUCKET}/${s3Key}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: s3Key,
      ContentType: contentType || "application/octet-stream",
      // Signed, so the browser must PUT exactly this many bytes — see
      // layer 3 in the header. This is what makes the size cap real.
      ContentLength: size,
    }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS }
  );

  return response(200, {
    uploadId,
    fileRef,
    uploadUrl,
    // Echoed back for the client to store alongside the ref and send to
    // create-order.js — display-only, escaped wherever it's rendered.
    filename: displayFilename(filename),
    contentType,
    size,
    expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
  });
};

// The original filename survives only as a label staff see on the ticket.
// It never reaches an S3 key, a shell, or a filesystem path — but it DOES
// reach the dashboard's DOM, so strip control characters and path
// separators here and cap the length, then let job-detail.html's
// escapeHtml() handle the HTML-context escaping (same treatment every
// other customer-supplied string gets).
function displayFilename(name) {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim()
    .slice(0, 150) || "design-file";
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
