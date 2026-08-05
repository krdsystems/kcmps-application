/* ============================================================
   KCMPS Design Asset Library — GET /designs (listDesigns)
   ============================================================
   Staff-only read of every DESIGN#<id> META item, including archived
   ones (the dashboard's Recycle bin tab filters client-side on the
   `archived` flag this handler adds — see design-library.html's planned
   grid, docs/roadmap.md "Parallel track — Design Asset Library").

   ── AUTH ───────────────────────────────────────────────────────────
   JWT route, gated on isStaff() — deliberately looser than the write
   routes' requireRole(Production/Sales/Admin). This is a read, and a
   Finance login browsing the library isn't the concern the write gate
   exists for (see get-upload-url.js's header for why THAT one is
   stricter). Mirrors get-orders.js's staff-vs-customer split, except
   there is no customer-facing branch here at all — Customer-group
   callers are simply not staff and get 403.

   ── SCAN + DOWNLOAD RULES ───────────────────────────────────────────
   Exactly get-orders.js's attachDownloadUrl() pattern, ported rather
   than imported (that module isn't a shared lib — see backend/CLAUDE.md
   on backend/staff-api/ vs backend/design-library/ being separate
   Lambda groups with their own package.json). A presigned GET for the
   ORIGINAL file is handed back only when its persisted GuardDuty verdict
   is NO_THREATS_FOUND (design-library/scan-verdict.js's CLEAN constant),
   forced to `Content-Disposition: attachment` so a browser can never
   render a PSD/AI/PDF inline regardless of what it claims to be. No
   verdict yet, or a bad verdict, means no url at all — fail closed,
   same as every other upload surface in this codebase.

   The web-ready copy is NOT separately presigned here: once a design is
   published it's already a public, CDN-served URL (manifest.js's
   `image` field is what the dashboard would show as a thumbnail), and
   while still a draft its private-bucket web object isn't yet something
   worth a second presigned round trip — the original's presigned link
   already lets staff review the source art.

   ── SCALE NOTE ───────────────────────────────────────────────────────
   A bounded Scan, same "no GSI until ~500 items" decision as
   manifest.js's listPublishedDesigns() (docs/roadmap.md). This handler
   does NOT filter on status/deletedAt the way that one does — it needs
   every design, published or not, archived or not, so the recycle bin
   has something to show.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { extractClaims, isStaff } = require("../lib");
const { checkVerdict } = require("./scan-verdict");

const TABLE = process.env.TABLE_NAME;
const DOWNLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const items = await scanAll({
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta",
    ExpressionAttributeValues: { ":prefix": "DESIGN#", ":meta": "META" },
  });

  const designs = await Promise.all(items.map(withOriginalDownloadUrl));
  designs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return response(200, { designs });
};

// Scan's 1MB page cap applies before FilterExpression, same reasoning as
// get-orders.js's scanAll() — loop on LastEvaluatedKey so a page that's
// entirely filtered out (or partial) never silently drops a design.
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

async function withOriginalDownloadUrl(item) {
  const archived = item.status === "archived" || !!item.deletedAt;
  if (!item.originalRef) return { ...item, archived, scanStatus: "PENDING", originalDownloadUrl: null };
  // Read the standalone SCAN#<ref> item (scan-verdict.js), the same
  // fail-closed source of truth publish-design.js gates on — NOT the
  // `scanVerdicts` convenience copy handle-scan-result.js writes onto the
  // DESIGN# record, which can lag or be absent (that annotation only
  // lands if the DESIGN# item already exists at the moment GuardDuty's
  // event fires; the standalone item is written unconditionally, always).
  const verdict = await checkVerdict(TABLE, item.originalRef);
  const originalDownloadUrl = verdict.ok ? await presignS3Uri(item.originalRef, item.name) : null;
  return { ...item, archived, scanStatus: verdict.status, originalDownloadUrl };
}

async function presignS3Uri(s3Uri, name) {
  if (!s3Uri) return null;
  const match = S3_URI_RE.exec(s3Uri);
  if (!match) return null;
  const [, bucket, key] = match;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${downloadFilename(name)}"`,
      ResponseContentType: "application/octet-stream",
    }), { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
  } catch (err) {
    console.error("list-designs: failed to presign", s3Uri, err.message);
    return null;
  }
}

// Same sanitization as get-orders.js's downloadFilename() — quotes/
// backslashes/control chars stripped (header-injection guard), non-ASCII
// dropped rather than RFC 5987-encoded (a convenience label only, the
// real name is always shown next to it in the dashboard).
function downloadFilename(name) {
  const cleaned = String(name || "design")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || "design";
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
