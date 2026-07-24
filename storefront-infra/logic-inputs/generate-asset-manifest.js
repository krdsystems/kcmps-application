/* ============================================================
   KCMPS Storefront — Asset Manifest Generator Lambda
   ============================================================
   Trigger: S3 event notification (ObjectCreated:*, ObjectRemoved:*)
   on the private product-image bucket, filtered to prefix "assets/".

   Responsibilities:
     1. List every object under each category prefix (see
        ../assets-bucket-structure.md §1 for the prefix convention).
     2. Group keys by <category>/<sku>/, pick the primary image per
        sku (any file whose name STARTS WITH "01-main" — e.g. plain
        "01-main.jpg" or "01-main-original-filename.jpg", the latter
        used to keep a human-readable trace back to the source art
        file; see assets-bucket-structure.md §1). Alphabetically-first
        as a fallback so a missing 01-main doesn't drop the sku.
     3. Write assets/manifest.json back to the same bucket.

   This is the ONLY place that writes manifest.json. The frontend
   (website/index.html hero carousel) only ever reads it — never
   calls ListObjectsV2 at request time (see doc §2 for why).

   Not deployed yet — website/assets/manifest.json is a hand-written
   sample in the same shape so local dev works without this Lambda.
   ============================================================ */

const { S3Client, ListObjectsV2Command, PutObjectCommand } = require("@aws-sdk/client-s3");

const BUCKET = process.env.ASSETS_BUCKET;
const CATEGORIES = ["printing-office-supplies", "design", "merch"];
const MANIFEST_KEY = "manifest.json";
const PRIMARY_RE = /^01-main.*\.(jpe?g|png)$/i;

const s3 = new S3Client({});

exports.handler = async () => {
  const categories = {};

  for (const category of CATEGORIES) {
    categories[category] = await listCategory(category);
  }

  const manifest = { generatedAt: new Date().toISOString(), categories };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: MANIFEST_KEY,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
    // Short TTL so a stale manifest.json self-heals within minutes even if
    // CloudFront invalidation isn't wired in — see doc §2.1.
    CacheControl: "public, max-age=300",
  }));

  return manifest;
};

async function listCategory(category) {
  const prefix = `assets/${category}/`;
  const bySku = new Map(); // sku -> string[] of keys, in listing order

  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken,
    }));

    for (const obj of page.Contents || []) {
      const rest = obj.Key.slice(prefix.length); // "<sku>/<file>"
      const slash = rest.indexOf("/");
      if (slash === -1) continue; // stray object directly under the category prefix
      const sku = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!file || file.includes("/")) continue; // skip nested junk, not one level deep
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku).push(obj.Key);
    }

    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);

  const skus = [];
  for (const [sku, keys] of bySku) {
    keys.sort(); // alphabetical, so 01-main sorts first when present
    const primaryIndex = keys.findIndex((k) => PRIMARY_RE.test(k.slice(k.lastIndexOf("/") + 1)));
    const ordered = primaryIndex > 0
      ? [keys[primaryIndex], ...keys.slice(0, primaryIndex), ...keys.slice(primaryIndex + 1)]
      : keys;

    if (primaryIndex === -1) {
      console.warn(`[generate-asset-manifest] ${category}/${sku}: no 01-main.* file, falling back to alphabetically-first image (${ordered[0]})`);
    }

    skus.push({
      sku,
      featured: false, // no admin UI yet — flip by hand, or extend this Lambda to read an S3 object tag on the primary image
      primary: ordered[0],
      images: ordered,
    });
  }

  skus.sort((a, b) => a.sku.localeCompare(b.sku));
  return skus;
}
