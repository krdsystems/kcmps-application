/* ============================================================
   KCMPS staff mail API — GET /mail/mailboxes/{mailboxId}/messages/{messageId}
   ============================================================
   Mirrors dashboard-data.js's getMessage(mailboxId, messageId) — returns
   the full item (bodyText + attachments included, unlike the envelope
   list). `messageId` in the path is the RFC822 Message-ID (URL-encoded by
   the caller, since it contains "<", "@", ">"); this Lambda hashes it the
   same way ingest-inbound.js did on write (../lib/keys.js's
   mailMessageSk()) to do a direct GetItem — see that file's header for why
   the SK has no date component.

   ATTACHMENT URLS (2026-08-07): each attachment whose bytes were extracted
   by ingest-inbound.js (it stamps `ref`, an s3:// URI under
   mail-attachments/ on the GuardDuty-scanned uploads bucket) gets a
   15-minute presigned GET here — but ONLY after the fail-closed scan gate,
   the same two rules staff-api/get-messages.js documents:

    1. SCAN GATE — the standalone SCAN#<ref> item jobs/handle-scan-result.js
       persists is the source of truth. Anything not NO_THREATS_FOUND gets
       no url: no verdict yet = PENDING = blocked (fail closed); an
       infected file is already purged from S3 by that Lambda and the
       attachment renders with its threat explanation instead of a link.
    2. DISPOSITION — backend/lib/upload-types.js's contentDispositionFor():
       images and PDF are served `inline` so staff can open them in a tab;
       every other type (SVG very much included — it is a script container
       and must NEVER render inline) is forced to `attachment` +
       octet-stream. The allowlist is closed; do not widen it here.

   Only refs under mail-attachments/ on this stack's own uploads bucket are
   ever presigned — a ref pointing anywhere else (which ingest would never
   write) is ignored, so a corrupted/hostile record can't turn this into an
   arbitrary-object presigner. Legacy messages (ingested before extraction
   existed) have no ref and render metadata-only, as before.

   AUTH: ../lib/mail.js's canAccessMailbox(), re-checked on the path's
   mailboxId — see that module's header.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { mailboxPk, mailMessageSk, scanResultPk, metaSk, extractClaims, canAccessMailbox, SCAN_STATUS } = require("../lib");
const { contentDispositionFor } = require("../lib/upload-types");

const { hashMessageId } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;
const UPLOADS_BUCKET = (process.env.UPLOADS_BUCKET_NAME || "").trim();
const ATTACHMENT_PREFIX = "mail-attachments/";
const ATTACHMENT_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const mailboxId = decodeURIComponent(event.pathParameters?.mailboxId || "");
  const messageId = decodeURIComponent(event.pathParameters?.messageId || "");
  if (!mailboxId || !messageId) return response(400, { error: "mailboxId and messageId path parameters are required" });
  if (!canAccessMailbox(claims, mailboxId)) {
    // 403, not 404: the caller is authenticated staff, just not for THIS
    // mailbox. Deliberately identical for "mailbox exists but you may not
    // open it" and "no such mailbox" so the response can't be used to
    // enumerate which mailboxes exist.
    return response(403, { error: "Forbidden" });
  }

  const res = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(messageId)) },
  }));
  if (!res.Item) return response(404, { error: "Message not found" });

  return response(200, { message: await withAttachmentUrls(cleanItem(res.Item)) });
};

async function withAttachmentUrls(m) {
  if (!Array.isArray(m.attachments) || !m.attachments.length) return m;
  const attachments = await Promise.all(m.attachments.map(async (a) => {
    if (!a || !a.ref || !UPLOADS_BUCKET) return a; // legacy metadata-only, or presigning not configured
    const parsed = S3_URI_RE.exec(String(a.ref));
    if (!parsed) return a;
    const [, bucket, key] = parsed;
    if (bucket !== UPLOADS_BUCKET || !key.startsWith(ATTACHMENT_PREFIX)) return a; // never presign a foreign ref
    try {
      const verdict = await scanVerdictFor(a.ref);
      if (verdict.scanStatus !== SCAN_STATUS.CLEAN) {
        // Fail closed: PENDING (no SCAN# item yet), THREATS_FOUND, or any
        // unexpected status — no url, surface the state instead.
        return { ...a, scanStatus: verdict.scanStatus, threatInfo: verdict.threatInfo || null };
      }
      const overrides = contentDispositionFor(a.contentType, a.filename);
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: key, ...overrides }),
        { expiresIn: ATTACHMENT_URL_EXPIRY_SECONDS }
      );
      return {
        ...a,
        scanStatus: SCAN_STATUS.CLEAN,
        url,
        // Whether the presigned response will render in a tab (image/PDF)
        // vs force a download — lets the UI label the link honestly.
        inline: overrides.ResponseContentDisposition.startsWith("inline"),
      };
    } catch (err) {
      console.error("get-mail-message: attachment url failed for", a.ref, err.message);
      return a; // no url — fail closed, never fail the whole read
    }
  }));
  return { ...m, attachments };
}

// Same fail-closed lookup asset-library/scan-verdict.js does: the standalone
// SCAN#<ref> item is written unconditionally by handle-scan-result.js, so
// "no item" genuinely means "not scanned yet", never "scanned and lost".
async function scanVerdictFor(ref) {
  const res = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: scanResultPk(ref), SK: metaSk() },
  }));
  if (!res.Item || !res.Item.scanStatus) return { scanStatus: "PENDING" };
  return { scanStatus: res.Item.scanStatus, threatInfo: res.Item.threatInfo || null };
}

function cleanItem(m) {
  const c = { ...m };
  delete c.PK; delete c.SK; delete c.s3Ref;
  delete c.tenantId; delete c.siteId; delete c.schemaVersion; delete c.deleted; delete c.updatedAt; delete c.createdAt;
  return c;
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
