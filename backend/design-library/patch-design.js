/* ============================================================
   KCMPS Design Asset Library — PATCH /designs/{id} (patchDesign)
   ============================================================
   One handler for every metadata/state edit a design can undergo after
   it's been created by publish-design.js:

     - metadata edit:        name / description / tags
     - archive (soft delete): status -> "archived", deletedAt stamped
     - restore:                clears status back to its pre-archive value
                                (draft or published) and deletedAt
     - draft -> published:     the gap publish-design.js's header calls
                                out ("a design saved as a draft today
                                cannot later be published without it") —
                                runs the SAME fail-closed scan gate and
                                public-bucket copy as the original publish
                                path, via the shared helpers below rather
                                than a second copy of that logic

   Any request that changes what's published (archiving a published
   design, restoring one back to published, or promoting draft ->
   published) ends with manifest.js's regenerateManifest() — the single
   manifest writer, reused, never duplicated (see manifest.js's header).

   ── AUTH ───────────────────────────────────────────────────────────
   JWT route + requireRole(Production/Sales/Admin) — identical gate to
   get-upload-url.js/publish-design.js. Editing/archiving/publishing a
   design is a write, so this is deliberately stricter than list-
   designs.js's isStaff() read gate; a Finance login gets 403 here.

   ── WHAT THIS NEVER DOES ────────────────────────────────────────────
   No hard delete, ever — that is purge-archived-designs.js's job alone,
   gated on a 90-day age check this handler doesn't perform. "Delete" in
   the dashboard UI is always this archive path.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, CopyObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const {
  designPk, metaSk, eventSk, buildEvent,
  extractClaims, requireRole, ROLES,
} = require("../lib");
const { parseDesignKey } = require("./design-types");
const { checkVerdict } = require("./scan-verdict");
const { regenerateManifest } = require("./manifest");

const PUBLIC_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const TABLE = process.env.TABLE_NAME;
const DESIGN_ORIGINALS_BUCKET = process.env.DESIGN_ORIGINALS_BUCKET;
const PUBLIC_ASSETS_BUCKET = process.env.PUBLIC_ASSETS_BUCKET;
const PUBLIC_ASSETS_KEY_PREFIX = process.env.PUBLIC_ASSETS_KEY_PREFIX || "assets/designs/";
const PUBLIC_ASSETS_PATH = process.env.PUBLIC_ASSETS_PATH || "assets/designs/";

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const ALLOWED_ROLES = [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN];
const ACTIONS = new Set(["update", "archive", "restore", "publish"]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, ALLOWED_ROLES);
  if (denied) return response(403, { error: "Forbidden — editing designs requires the Production, Sales or Admin role.", requiredRoles: denied.requiredRoles });

  const designId = event.pathParameters && event.pathParameters.id;
  if (!designId) return response(400, { error: "Missing design id in path" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const action = str(body.action) || "update";
  if (!ACTIONS.has(action)) {
    return response(400, { error: `action must be one of: ${[...ACTIONS].join(", ")}` });
  }

  const pk = designPk(designId);
  const existing = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  if (!existing.Item) return response(404, { error: "Design not found" });
  const design = existing.Item;

  const actorSub = claims.sub;
  const actorName = claims.name || claims.email || null;
  const now = new Date().toISOString();

  if (action === "archive") return handleArchive(design, pk, actorSub, actorName, now);
  if (action === "restore") return handleRestore(design, pk, actorSub, actorName, now);
  if (action === "publish") return handlePublish(design, pk, actorSub, actorName, now);
  return handleUpdate(design, pk, body, actorSub, actorName, now);
};

// ---- metadata-only edit: name / description / tags. Never touches
// status/deletedAt/S3 — those go through the dedicated actions above so
// each state transition has exactly one code path. ----
async function handleUpdate(design, pk, body, actorSub, actorName, now) {
  const sets = [];
  const names = {};
  const values = {};

  if (body.name !== undefined) {
    const name = str(body.name).slice(0, MAX_NAME);
    if (!name) return response(400, { error: "name cannot be empty" });
    sets.push("#name = :name"); names["#name"] = "name"; values[":name"] = name;
  }
  if (body.description !== undefined) {
    sets.push("description = :description"); values[":description"] = str(body.description).slice(0, MAX_DESCRIPTION);
  }
  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags === null) return response(400, { error: `tags must be an array of at most ${MAX_TAGS} strings, each ${MAX_TAG_LENGTH} characters or fewer` });
    sets.push("tags = :tags"); values[":tags"] = tags;
  }
  if (!sets.length) return response(400, { error: "Nothing to update — provide name, description, and/or tags" });

  sets.push("updatedAt = :now"); values[":now"] = now;

  const res = await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  }));

  return response(200, { design: res.Attributes });
}

// ---- archive: soft delete only. Never touches S3 or DynamoDB-deletes
// anything — purge-archived-designs.js is the only hard-delete path. ----
async function handleArchive(design, pk, actorSub, actorName, now) {
  if (design.status === "archived") return response(200, { design });

  const auditEvent = buildDesignEvent(pk, design.designId, design.status, "archived", actorSub, actorName, now, { reason: "archived via dashboard" });

  const res = await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: metaSk() },
          // Remember what the status was before archiving so restore()
          // can put it back exactly (draft vs published matter — a
          // restored published design should still be in the manifest,
          // a restored draft should not).
          UpdateExpression: "SET preArchiveStatus = #status, #status = :archived, deletedAt = :now, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":archived": "archived", ":now": now },
        },
      },
      { Put: { TableName: TABLE, Item: auditEvent } },
    ],
  }));

  let manifest = null;
  if (design.status === "published") {
    manifest = await regenerateManifest({
      tableName: TABLE, bucket: PUBLIC_ASSETS_BUCKET,
      keyPrefix: PUBLIC_ASSETS_KEY_PREFIX, publicPrefix: PUBLIC_ASSETS_PATH,
    });
  }

  return response(200, {
    design: { ...design, status: "archived", preArchiveStatus: design.status, deletedAt: now, updatedAt: now },
    manifest: manifest ? { key: manifest.key, count: manifest.count } : null,
  });
}

// ---- restore: clears the archive, putting status back to whatever it
// was before (draft or published). A restored published design re-enters
// the manifest on the next regeneration; its public S3 object was never
// touched by archive, so nothing needs re-copying. ----
async function handleRestore(design, pk, actorSub, actorName, now) {
  if (design.status !== "archived") return response(200, { design });

  const restoredStatus = design.preArchiveStatus === "published" ? "published" : "draft";
  const auditEvent = buildDesignEvent(pk, design.designId, "archived", restoredStatus, actorSub, actorName, now, { reason: "restored from recycle bin" });

  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: metaSk() },
          UpdateExpression: "SET #status = :status, updatedAt = :now REMOVE deletedAt, preArchiveStatus",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": restoredStatus, ":now": now },
        },
      },
      { Put: { TableName: TABLE, Item: auditEvent } },
    ],
  }));

  let manifest = null;
  if (restoredStatus === "published") {
    manifest = await regenerateManifest({
      tableName: TABLE, bucket: PUBLIC_ASSETS_BUCKET,
      keyPrefix: PUBLIC_ASSETS_KEY_PREFIX, publicPrefix: PUBLIC_ASSETS_PATH,
    });
  }

  const { deletedAt, preArchiveStatus, ...rest } = design;
  return response(200, {
    design: { ...rest, status: restoredStatus, updatedAt: now },
    manifest: manifest ? { key: manifest.key, count: manifest.count } : null,
  });
}

// ---- draft -> published: closes the gap publish-design.js's header
// flags. Reuses the exact same fail-closed scan check + public-bucket
// copy that Lambda performs on its own publish path — do not duplicate
// that logic differently here, or the two publish paths (new design vs.
// promoted draft) could drift on what "safe to publish" means. ----
async function handlePublish(design, pk, actorSub, actorName, now) {
  if (design.status === "archived") return response(409, { error: "Cannot publish an archived design — restore it first." });
  if (design.status === "published") return response(200, { design, published: true, manifest: null });

  const original = parseDesignKey(design.s3KeyOriginal, "original");
  const web = parseDesignKey(design.s3KeyWeb, "web");
  if (!original || !web) return response(500, { error: "Design record has an invalid stored S3 key and cannot be published." });

  const [ov, wv] = await Promise.all([
    checkVerdict(TABLE, design.originalRef),
    checkVerdict(TABLE, design.webRef),
  ]);
  const bad = [ov, wv].filter((v) => !v.ok);
  if (bad.length) {
    const pending = bad.every((v) => v.pending);
    return response(409, {
      error: pending
        ? "Still scanning for malware — try publishing again in a moment."
        : "One or both files failed the malware scan and cannot be published.",
      stillScanning: pending,
      scan: bad.map((v) => ({ ref: v.ref, status: v.status, threats: v.threats || [], threatInfo: v.threatInfo || null })),
    });
  }

  // Same ordering rule as publish-design.js: copy to public BEFORE the
  // DynamoDB write. A failed copy here just leaves an orphan object under
  // the public prefix (harmless, collected by the purge job / overwritten
  // by the next publish attempt) rather than a record pointing at
  // nothing.
  const publicKey = `${PUBLIC_ASSETS_KEY_PREFIX}${design.designId}.${web.ext}`;
  await s3.send(new CopyObjectCommand({
    Bucket: PUBLIC_ASSETS_BUCKET,
    Key: publicKey,
    CopySource: `/${DESIGN_ORIGINALS_BUCKET}/${design.s3KeyWeb}`,
    MetadataDirective: "REPLACE",
    ContentType: contentTypeFor(web.ext),
    CacheControl: PUBLIC_IMAGE_CACHE_CONTROL,
    TaggingDirective: "REPLACE",
    Tagging: "",
  }));

  const auditEvent = buildDesignEvent(pk, design.designId, design.status, "published", actorSub, actorName, now, { reason: "draft promoted to published" });

  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: metaSk() },
          UpdateExpression: "SET #status = :published, publishedAt = :now, updatedAt = :now, webExt = :ext",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":published": "published", ":now": now, ":ext": web.ext },
        },
      },
      { Put: { TableName: TABLE, Item: auditEvent } },
    ],
  }));

  const manifest = await regenerateManifest({
    tableName: TABLE, bucket: PUBLIC_ASSETS_BUCKET,
    keyPrefix: PUBLIC_ASSETS_KEY_PREFIX, publicPrefix: PUBLIC_ASSETS_PATH,
  });

  return response(200, {
    design: { ...design, status: "published", publishedAt: now, updatedAt: now, webExt: web.ext },
    published: true,
    manifest: { key: manifest.key, count: manifest.count },
  });
}

// buildEvent() is order-shaped (its PK is ORDER#<orderId>) — overridden
// to DESIGN#<id> here, same trick publish-design.js uses, so the EVENT#
// convention/field names/tenant stamping stay identical across item
// types rather than inventing a second audit shape for this feature.
function buildDesignEvent(pk, designId, from, to, actorSub, actorName, at, meta) {
  return {
    ...buildEvent({ orderId: designId, lineItemId: "DESIGN", from: from || null, to, actorSub, actorName, at, meta }),
    PK: pk,
    SK: eventSk(at, "DESIGN"),
  };
}

function contentTypeFor(ext) {
  return { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "application/octet-stream";
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

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
