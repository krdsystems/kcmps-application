/* ============================================================
   KCMPS Design Asset Library — design-manifest.json regeneration
   ============================================================
   Shared by every Lambda that can change which designs are published:
   publish-design.js today, archive/restore next. Factored out so the
   manifest can only ever be produced one way — two writers with two
   slightly different shapes is exactly how a storefront ends up
   rendering half its catalog.

   The manifest is regenerated WHOLE from DynamoDB on every call, never
   patched incrementally. The table is the source of truth; the manifest
   is a derived, cacheable projection of it. That means a failed write
   is self-healing (the next publish/archive rewrites it correctly) and
   there is no drift mode where the manifest remembers something the
   table forgot.

   Same short-Cache-Control / no-CloudFront-invalidation pattern as the
   hero carousel's manifest (storefront-infra/assets-bucket-structure.md)
   — the distribution is CachingDisabled, so a write is live in seconds.

   ── THE MANIFEST CONTRACT ──────────────────────────────────────────
   Documented in full in publish-design.js's header. Do not change the
   field names or the meaning of `image` without updating that header
   AND website/store.js's buildDesignGrid() merge together — they are one
   contract with two ends.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const MANIFEST_VERSION = 1;
const MANIFEST_BASENAME = "design-manifest.json";
// Short enough that a newly published design shows up on the next page
// load, long enough that the storefront isn't refetching it constantly.
const MANIFEST_CACHE_CONTROL = "public, max-age=60";

// A bounded Scan, deliberately — docs/roadmap.md's "no new GSI yet"
// decision. Revisit at ~500 designs, not before; a GSI provisioned for a
// catalog of a few dozen items is cost with no benefit.
async function listPublishedDesigns(tableName) {
  const designs = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND #st = :published AND attribute_not_exists(deletedAt)",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":prefix": "DESIGN#", ":meta": "META", ":published": "published" },
      ExclusiveStartKey,
    }));
    designs.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return designs;
}

// Maps one DESIGN# record to its manifest entry. The ONLY place the
// public shape is built.
function manifestEntry(item, publicPrefix) {
  return {
    id: item.designId,
    name: item.name,
    category: item.category,
    // Site-root-relative, no leading slash — resolves correctly on both
    // kcmps.com and dev.kcmps.com (whose CloudFront maps the dev-site/
    // prefix to the root), so the same manifest field works in both
    // environments with no per-environment client logic.
    image: `${publicPrefix}${item.designId}.${item.webExt}`,
    tags: Array.isArray(item.tags) ? item.tags : [],
    publishedAt: item.publishedAt || item.updatedAt,
  };
}

// `publicPrefix` is the SITE-relative asset path (e.g. "assets/designs/")
// — the same string the manifest's `image` values are built from.
// `keyPrefix` is the BUCKET key prefix the objects actually live under
// (e.g. "dev-site/assets/designs/" on staging). They differ on staging
// and are identical in production; see backend-lambdas.cfn.yaml.
async function regenerateManifest({ tableName, bucket, keyPrefix, publicPrefix }) {
  const items = await listPublishedDesigns(tableName);
  const designs = items
    .map((i) => manifestEntry(i, publicPrefix))
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    count: designs.length,
    designs,
  };

  const key = `${keyPrefix}${MANIFEST_BASENAME}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
    CacheControl: MANIFEST_CACHE_CONTROL,
  }));
  return { key, count: designs.length, manifest };
}

module.exports = {
  MANIFEST_VERSION, MANIFEST_BASENAME, MANIFEST_CACHE_CONTROL,
  listPublishedDesigns, manifestEntry, regenerateManifest,
};
