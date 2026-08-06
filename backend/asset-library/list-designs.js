/* ============================================================
   KCMPS Asset Library — GET /assets (listDesigns)
   ============================================================
   (Formerly the Design Library's GET /designs — renamed 2026-08-07; the
   DESIGN# key prefix stays, see docs/asset-library-rebuild-plan §5.)

   Staff-only read of every DESIGN#<id> META item, including archived
   ones (the dashboard's Recycle bin tab filters client-side on the
   `archived` flag this handler adds).

   ── AUTH ───────────────────────────────────────────────────────────
   JWT route, gated on isStaff() — deliberately looser than the write
   routes' requireRole(Production/Sales/Admin). This is a read; a Finance
   login browsing the library isn't the concern the write gate exists
   for. Customer-group callers are simply not staff and get 403.

   ── SCAN + DOWNLOAD RULES ───────────────────────────────────────────
   Fail closed, per file, exactly like every other upload surface:
     - `originalDownloadUrl`: presigned GET for the source file, only on
       the ORIGINAL's clean verdict, always forced to
       Content-Disposition: attachment + application/octet-stream so a
       browser can never render a PSD/AI/PDF/SVG inline (SVG especially —
       it can carry script; see design-types.js).
     - `webThumbUrl`: presigned GET for the WEB-READY file, only on the
       WEB file's clean verdict. This is what gives every draft card a
       real thumbnail (the "grey boxes" UAT failure). Web files are
       raster-only by allowlist (JPG/PNG/WebP — SVG can never be a web
       file), so serving them with their image content-type is safe.
     - `scanStatusOriginal` / `scanStatusWeb` are returned SEPARATELY —
       the old single `scanStatus` (original only) let a card read
       "Draft" while the publish gate 409'd on the web file. `scanPending`
       and `scanFailed` are the aggregate booleans the UI keys off.

   ── EVENTS ──────────────────────────────────────────────────────────
   Each design carries its EVENT# audit items (`events`, newest first) so
   the detail drawer's History panel — including the approval trail — is
   rendered from the real audit records. One extra bounded scan; fine at
   current volume (same "no GSI until ~500" decision as manifest.js).

   ── ?view=pending-summary ───────────────────────────────────────────
   A lightweight branch backing the dashboard's approval banner: returns
   { count, items } of pending_approval assets only, with NO presigning
   and no events — cheap enough to poll on the unread-badge cadence
   without burning presign calls. Same isStaff() gate (it's a read; the
   approve/reject ACTIONS are the Admin-gated part, in patch-design.js).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { extractClaims, isStaff } = require("../lib");
const { checkVerdict, CLEAN } = require("./scan-verdict");

const TABLE = process.env.TABLE_NAME;
const DOWNLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const view = event.queryStringParameters && event.queryStringParameters.view;

  const items = await scanAll({
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta",
    ExpressionAttributeValues: { ":prefix": "DESIGN#", ":meta": "META" },
  });

  if (view === "pending-summary") {
    const pending = items.filter((i) => i.status === "pending_approval");
    return response(200, {
      count: pending.length,
      items: pending.map((i) => ({
        designId: i.designId, name: i.name, category: i.category,
        submittedBy: i.submittedBy || null, submittedByName: i.submittedByName || null,
        submittedAt: i.submittedAt || null, approvalSnapshot: i.approvalSnapshot || null,
      })),
    });
  }

  const eventItems = await scanAll({
    FilterExpression: "begins_with(PK, :prefix) AND begins_with(SK, :evt)",
    ExpressionAttributeValues: { ":prefix": "DESIGN#", ":evt": "EVENT#" },
  });
  const eventsByPk = new Map();
  for (const e of eventItems) {
    if (!eventsByPk.has(e.PK)) eventsByPk.set(e.PK, []);
    eventsByPk.get(e.PK).push(e);
  }

  const designs = await Promise.all(items.map((item) => decorate(item, eventsByPk.get(item.PK) || [])));
  designs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return response(200, { designs });
};

// Scan's 1MB page cap applies before FilterExpression — loop on
// LastEvaluatedKey so a page that's entirely filtered out never silently
// drops a design.
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

async function decorate(item, events) {
  const archived = item.status === "archived" || !!item.deletedAt;

  // Read the standalone SCAN#<ref> items (scan-verdict.js) — the same
  // fail-closed source of truth every publish path gates on, NOT the
  // `scanVerdicts` convenience copy on the DESIGN# record (which only
  // lands if the record already existed when GuardDuty's event fired).
  const [ov, wv] = await Promise.all([
    item.originalRef ? checkVerdict(TABLE, item.originalRef) : { status: "PENDING", ok: false, pending: true },
    item.webRef ? checkVerdict(TABLE, item.webRef) : { status: "PENDING", ok: false, pending: true },
  ]);

  const [originalDownloadUrl, webThumbUrl] = await Promise.all([
    ov.ok ? presignAttachment(item.originalRef, item.name) : null,
    wv.ok ? presignInlineImage(item.webRef, item.webExt || extFromKey(item.s3KeyWeb)) : null,
  ]);

  return {
    ...item,
    archived,
    scanStatusOriginal: ov.status,
    scanStatusWeb: wv.status,
    scanPending: !!(ov.pending || wv.pending),
    scanFailed: !!((!ov.ok && !ov.pending) || (!wv.ok && !wv.pending)),
    scanThreats: [...(ov.threats || []), ...(wv.threats || [])],
    // Legacy aggregate kept for one release so nothing keys off a missing
    // field mid-deploy; new code reads the split fields above.
    scanStatus: ov.status === CLEAN && wv.status === CLEAN ? CLEAN : (ov.status !== CLEAN ? ov.status : wv.status),
    originalDownloadUrl,
    webThumbUrl,
    events: events
      .slice()
      .sort((a, b) => String(b.SK).localeCompare(String(a.SK)))
      .map((e) => ({ at: e.at, from: e.from || null, to: e.to, actorName: e.actorName || null, meta: e.meta || {} })),
  };
}

// Source files download-only, always: attachment + octet-stream, so a
// PSD/AI/PDF/SVG can never render inline regardless of what it claims.
async function presignAttachment(s3Uri, name) {
  return presign(s3Uri, {
    ResponseContentDisposition: `attachment; filename="${downloadFilename(name)}"`,
    ResponseContentType: "application/octet-stream",
  });
}

// Web-ready files are raster-only by allowlist (design-types.js's
// WEB_TYPES — SVG structurally cannot appear here), so an inline image
// content-type is safe and is what lets the dashboard <img> render it.
async function presignInlineImage(s3Uri, ext) {
  const types = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  const contentType = types[String(ext || "").toLowerCase()];
  if (!contentType) return null; // unknown extension: no inline URL, fail closed
  return presign(s3Uri, {
    ResponseContentDisposition: "inline",
    ResponseContentType: contentType,
  });
}

async function presign(s3Uri, overrides) {
  if (!s3Uri) return null;
  const match = S3_URI_RE.exec(s3Uri);
  if (!match) return null;
  const [, bucket, key] = match;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...overrides,
    }), { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
  } catch (err) {
    console.error("list-designs: failed to presign", s3Uri, err.message);
    return null;
  }
}

function extFromKey(key) {
  const m = /\.([a-z0-9]+)$/i.exec(String(key || ""));
  return m ? m[1].toLowerCase() : "";
}

// Same sanitization as get-orders.js's downloadFilename() — quotes/
// backslashes/control chars stripped (header-injection guard), non-ASCII
// dropped rather than RFC 5987-encoded (a convenience label only).
function downloadFilename(name) {
  const cleaned = String(name || "asset")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || "asset";
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
