/* ============================================================
   KCMPS Asset Library — POST /assets (publishDesign)
   ============================================================
   Step 2 of 2, called by the dashboard's Asset Library upload modal after
   both presigned PUTs from get-upload-url.js have succeeded. Writes the
   DESIGN#<id> META record and an audit EVENT#.

   ── DRAFT-ONLY SINCE THE APPROVAL WORKFLOW (2026-08-07) ────────────
   This endpoint now creates DRAFTS only. `status: "published"` is
   rejected outright: publishing requires the all-Admin approval flow in
   patch-design.js (submit -> approve...), and accepting "published" here
   would hand any Production/Sales caller a one-request approval bypass.
   The rename window (zero production routes, zero external consumers) is
   also the window to close this — there is nothing to stay compatible
   with. The publish machinery (public-bucket copy + manifest
   regeneration) lives in patch-design.js's finalizePublish(); the
   manifest contract below is unchanged.

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
   (scan-verdict.js, reading the standalone SCAN# item
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
const {
  designPk, metaSk, eventSk, baseItem, buildEvent,
  extractClaims, requireRole, ROLES,
} = require("../lib");
const { parseDesignKey, isValidCategory, DESIGN_CATEGORIES } = require("./design-types");

const TABLE = process.env.TABLE_NAME;
const DESIGN_ORIGINALS_BUCKET = process.env.DESIGN_ORIGINALS_BUCKET;

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const ALLOWED_ROLES = [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN];
// Draft only — see the header. "published" was removed with the approval
// workflow; the only publish paths are patch-design.js's approve-final,
// single-admin submit, and Admin break-glass.
const ALLOWED_STATUS = new Set(["draft"]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, ALLOWED_ROLES);
  if (denied) return response(403, { error: "Forbidden — creating assets requires the Production, Sales or Admin role.", requiredRoles: denied.requiredRoles });

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
    return response(400, {
      error: status === "published"
        ? 'Direct publishing is no longer supported — save as "draft", then submit it for Admin approval (PATCH /assets/{id} action "submit").'
        : 'status must be "draft"',
    });
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
    return response(409, { error: "An asset record already exists for this upload.", designId });
  }

  const originalRef = `s3://${DESIGN_ORIGINALS_BUCKET}/${body.s3KeyOriginal}`;
  const webRef = `s3://${DESIGN_ORIGINALS_BUCKET}/${body.s3KeyWeb}`;
  // No scan gate here: a draft copies nothing and touches no public
  // bucket. The fail-closed verdict pair is enforced where publishing
  // actually happens — patch-design.js's submit/approve/break-glass.

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
    publishedAt: null,
    // Soft delete only. archive/restore flips these; nothing hard-deletes.
    deletedAt: undefined,
  };
  delete item.deletedAt; // attribute_not_exists() is the filter, so omit rather than store null

  // buildEvent() is order-shaped (it builds an ORDER# PK); the PK is
  // overridden to DESIGN#<id> so the EVENT# convention, field names and
  // tenant/schema stamping stay identical across item types rather than
  // inventing a second audit shape for this one feature.
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

  return response(201, { design: item, published: false, manifest: null });
};

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
