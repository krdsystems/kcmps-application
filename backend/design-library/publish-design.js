/* ============================================================
   KCMPS Design Asset Library — POST /designs (publishDesign)
   ============================================================
   Step 2 of 2, called by the dashboard's Design Library form after both
   presigned PUTs from design-library/get-upload-url.js have succeeded.
   Writes the DESIGN#<id> META record, appends an audit EVENT#, and — for
   a `published` design only — copies the web-ready image into the public
   storefront bucket and regenerates design-manifest.json there.

   That manifest regeneration is the whole point of the feature: it is
   what makes a newly published design appear in the storefront's design
   picker with no code deploy and no S3 sync.

   ── AUTH ───────────────────────────────────────────────────────────
   JWT route + requireRole(Production/Sales/Admin), identical gate to
   get-upload-url.js. `uploadedBy` is the JWT's VERIFIED `sub` — a `sub`
   in the request body is ignored, always. Likewise the S3 keys: both are
   re-parsed through design-types.js's parseDesignKey(), so a caller can
   only name a key this system would itself have generated (right prefix,
   known catalog leaf, well-formed uuid, allowlisted extension, exact
   basename). Without that check, "copy this key into the public bucket"
   would be an arbitrary private→public exfiltration primitive.

   ── FAIL CLOSED ON MALWARE ─────────────────────────────────────────
   Publishing means making an object world-readable behind our CDN, so
   the scan gate here is stricter than the staff-download gate elsewhere.
   BOTH objects must carry a persisted NO_THREATS_FOUND verdict
   (design-library/scan-verdict.js, reading the standalone SCAN# item
   written by jobs/handle-scan-result.js). No verdict yet is NOT an
   error condition to swallow — it returns 409 `stillScanning` so the
   dashboard can say "still scanning, try again in a moment" and retry.
   A design can always be saved as `status: "draft"` in the meantime; a
   draft copies nothing and touches no public bucket, so the scan gate
   only applies on the publish path.

   ── SOFT DELETE ────────────────────────────────────────────────────
   Records are never hard-deleted here. baseItem() stamps `deleted: false`
   and archive/restore (a later pass) flips `status: "archived"` +
   `deletedAt`. listPublishedDesigns() filters on both, so an archived
   design drops out of the manifest on the next regeneration.

   ============================================================
   THE design-manifest.json CONTRACT — read this before changing it
   ============================================================
   Written to <PUBLIC_ASSETS_KEY_PREFIX>design-manifest.json on the public
   storefront bucket. Consumed by website/store.js's buildDesignGrid(),
   which merges it with each product's static `images[]` in products.js
   (mirroring HERO_MANIFEST_URL's proven pattern). This shape is a
   contract between the two — change it in both places or not at all.

     {
       "version": 1,                          // bump only on a breaking shape change
       "generatedAt": "2026-08-06T04:12:33.891Z",
       "count": 2,
       "designs": [                           // newest publishedAt first
         {
           "id":   "7c0f1a2e-...-9b3d",       // designId; stable, matches DESIGN#<id>
           "name": "Retro Sunset",            // display title, staff-authored
           "category": "dtf",                 // a catalog leaf id from products.js's `leaves`
           "image": "assets/designs/7c0f1a2e-...-9b3d.jpg",
           "tags": ["retro", "summer"],       // may be empty, never absent
           "publishedAt": "2026-08-06T04:12:30.114Z"
         }
       ]
     }

   Notes for the consumer:
   - `image` is SITE-ROOT-RELATIVE with NO leading slash. It resolves on
     both kcmps.com and dev.kcmps.com — dev's CloudFront maps the bucket's
     dev-site/ prefix onto the site root, so the same string is correct in
     both environments. Do NOT prepend an origin or a leading "/".
   - `designs` is always an array; an empty catalog is `[]`, never a
     missing key. A consumer should still treat a fetch failure as "no
     extra designs" and fall back to products.js's static images[] rather
     than rendering an empty picker.
   - `category` is the join key: a design belongs in a product's picker
     when its category equals that product's leaf.
   - Entries are only ever published, non-archived designs — the consumer
     does no status filtering of its own.
   - The file is regenerated whole on every publish/archive, so a
     consumer can cache it by ETag; Cache-Control is 60s.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, CopyObjectCommand } = require("@aws-sdk/client-s3");
const {
  designPk, metaSk, eventSk, baseItem, buildEvent,
  extractClaims, requireRole, ROLES,
} = require("../lib");
const { parseDesignKey, isValidCategory, DESIGN_CATEGORIES } = require("./design-types");
const { checkVerdict } = require("./scan-verdict");
const { regenerateManifest } = require("./manifest");

// The image itself is immutable once published (its key contains the
// designId, and a re-publish of the same id is refused), so unlike the
// manifest it can be cached hard.
const PUBLIC_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const TABLE = process.env.TABLE_NAME;
const DESIGN_ORIGINALS_BUCKET = process.env.DESIGN_ORIGINALS_BUCKET;
const PUBLIC_ASSETS_BUCKET = process.env.PUBLIC_ASSETS_BUCKET;
// Bucket key prefix the published images + manifest are written under.
// Differs from PUBLIC_ASSETS_PATH on staging (dev-site/assets/designs/ vs
// assets/designs/) because dev.kcmps.com's CloudFront serves the bucket's
// dev-site/ prefix as the site root — see backend-lambdas.cfn.yaml.
const PUBLIC_ASSETS_KEY_PREFIX = process.env.PUBLIC_ASSETS_KEY_PREFIX || "assets/designs/";
// Site-relative path the manifest's `image` values are built from.
const PUBLIC_ASSETS_PATH = process.env.PUBLIC_ASSETS_PATH || "assets/designs/";

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const ALLOWED_ROLES = [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN];
const ALLOWED_STATUS = new Set(["draft", "published"]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, ALLOWED_ROLES);
  if (denied) return response(403, { error: "Forbidden — publishing designs requires the Production, Sales or Admin role.", requiredRoles: denied.requiredRoles });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const name = str(body.name).slice(0, MAX_NAME);
  if (!name) return response(400, { error: "name is required" });
  const description = str(body.description).slice(0, MAX_DESCRIPTION);

  const category = str(body.category);
  if (!isValidCategory(category)) {
    return response(400, { error: `category must be one of: ${DESIGN_CATEGORIES.join(", ")}` });
  }

  const status = str(body.status) || "draft";
  if (!ALLOWED_STATUS.has(status)) {
    return response(400, { error: 'status must be "draft" or "published"' });
  }

  const tags = normalizeTags(body.tags);
  if (tags === null) return response(400, { error: `tags must be an array of at most ${MAX_TAGS} strings, each ${MAX_TAG_LENGTH} characters or fewer` });

  // Re-derive everything from the keys instead of trusting the body's
  // designId/category — see the header. Both must belong to the SAME
  // design, so a caller can't pair one design's original with another's
  // web image.
  const original = parseDesignKey(body.s3KeyOriginal, "original");
  const web = parseDesignKey(body.s3KeyWeb, "web");
  if (!original) return response(400, { error: "s3KeyOriginal is not a valid Design Library key" });
  if (!web) return response(400, { error: "s3KeyWeb is not a valid Design Library key" });
  if (original.designId !== web.designId || original.category !== web.category) {
    return response(400, { error: "s3KeyOriginal and s3KeyWeb must belong to the same design" });
  }
  if (original.category !== category) {
    return response(400, { error: "category does not match the uploaded files' category" });
  }

  const designId = original.designId;
  const pk = designPk(designId);

  const existing = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  if (existing.Item) {
    // designId comes from a server-issued presign, so this means the same
    // upload was published twice — treat it as a duplicate rather than
    // silently overwriting an existing record's history.
    return response(409, { error: "This design has already been published.", designId });
  }

  const originalRef = `s3://${DESIGN_ORIGINALS_BUCKET}/${body.s3KeyOriginal}`;
  const webRef = `s3://${DESIGN_ORIGINALS_BUCKET}/${body.s3KeyWeb}`;
  const publishing = status === "published";

  // ---- fail-closed malware gate (publish path only) ----
  if (publishing) {
    const [ov, wv] = await Promise.all([
      checkVerdict(TABLE, originalRef),
      checkVerdict(TABLE, webRef),
    ]);
    const bad = [ov, wv].filter((v) => !v.ok);
    if (bad.length) {
      const pending = bad.every((v) => v.pending);
      return response(409, {
        error: pending
          ? "Still scanning for malware — save as a draft or try publishing again in a moment."
          : "One or both files failed the malware scan and cannot be published.",
        stillScanning: pending,
        scan: bad.map((v) => ({ ref: v.ref, status: v.status, threats: v.threats || [], threatInfo: v.threatInfo || null })),
        designId,
      });
    }
  }

  const now = new Date().toISOString();
  const actorSub = claims.sub;
  const actorName = claims.name || claims.email || null;

  const item = {
    ...baseItem({ status }),
    PK: pk,
    SK: metaSk(),
    designId,
    name,
    description,
    category,
    tags,
    // VERIFIED sub from the JWT the authorizer already validated against
    // Cognito's JWKS — never body.uploadedBy.
    uploadedBy: actorSub,
    uploadedByName: actorName,
    s3KeyOriginal: body.s3KeyOriginal,
    s3KeyWeb: body.s3KeyWeb,
    originalRef,
    webRef,
    // Stored so manifest.js can build the public image path without
    // re-parsing the key on every regeneration.
    webExt: web.ext,
    publishedAt: publishing ? now : null,
    // Soft delete only. archive/restore flips these; nothing hard-deletes.
    deletedAt: undefined,
  };
  delete item.deletedAt; // attribute_not_exists() is the filter, so omit rather than store null

  // buildEvent() is order-shaped (it builds an ORDER# PK); the PK is
  // overridden to DESIGN#<id> so the EVENT# convention, field names and
  // tenant/schema stamping stay identical across item types rather than
  // inventing a second audit shape for this one feature.
  // ---- copy to public BEFORE writing the record ----
  // Order matters and this is the safe direction. If the copy fails, nothing
  // is recorded and the designer sees a plain error they can retry. The
  // reverse order (found the hard way on the first live run, when CopyObject
  // 403'd on tagging permissions) leaves a `published` record pointing at a
  // public image that was never created — a broken storefront tile that no
  // retry path fixes, because publish-design.js refuses to write the same
  // designId twice. The failure mode here is instead a harmless orphan object
  // under the public prefix, which the next publish of that designId
  // overwrites and the purge job collects.
  let publicKey = null;
  if (publishing) {
    publicKey = `${PUBLIC_ASSETS_KEY_PREFIX}${designId}.${web.ext}`;
    await s3.send(new CopyObjectCommand({
      Bucket: PUBLIC_ASSETS_BUCKET,
      Key: publicKey,
      CopySource: `/${DESIGN_ORIGINALS_BUCKET}/${body.s3KeyWeb}`,
      MetadataDirective: "REPLACE",
      ContentType: contentTypeFor(web.ext),
      CacheControl: PUBLIC_IMAGE_CACHE_CONTROL,
      // Do NOT inherit the source object's tags. S3 copies them by default,
      // which (a) requires s3:GetObjectTagging on the source and
      // s3:PutObjectTagging on the destination — an easily-missed IAM
      // dependency that surfaces only as a bare "Access Denied" — and (b)
      // would republish GuardDuty's internal GuardDutyMalwareScanStatus tag
      // onto a public object, where it means nothing and leaks how scanning
      // is wired. The verdict lives in DynamoDB; the public copy carries none.
      TaggingDirective: "REPLACE",
      Tagging: "",
    }));
  }

  const auditEvent = {
    ...buildEvent({
      orderId: designId,
      lineItemId: "DESIGN",
      from: null,
      to: status,
      actorSub,
      actorName,
      at: now,
      meta: { category, name, s3KeyOriginal: body.s3KeyOriginal, s3KeyWeb: body.s3KeyWeb },
    }),
    PK: pk,
    SK: eventSk(now, "DESIGN"),
  };

  await client.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { TableName: TABLE, Item: auditEvent } },
    ],
  }));

  let manifest = null;
  if (publishing) {
    manifest = await regenerateManifest({
      tableName: TABLE,
      bucket: PUBLIC_ASSETS_BUCKET,
      keyPrefix: PUBLIC_ASSETS_KEY_PREFIX,
      publicPrefix: PUBLIC_ASSETS_PATH,
    });
  }

  return response(201, {
    design: item,
    published: publishing,
    manifest: manifest ? { key: manifest.key, count: manifest.count } : null,
  });
};

function contentTypeFor(ext) {
  return { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "application/octet-stream";
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

// Returns a normalized array, or null if the input is unusable.
function normalizeTags(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_TAGS) return null;
  const out = [];
  for (const t of raw) {
    if (typeof t !== "string") return null;
    const tag = t.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
