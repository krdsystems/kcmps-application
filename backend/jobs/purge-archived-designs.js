/* ============================================================
   KCMPS backend — purge-archived-designs Lambda
   ============================================================
   Trigger: EventBridge cron, every 15 minutes (same cadence as
   expire-pending-orders.js, whose shape this mirrors).

   The ONLY hard-delete path anywhere in the Design Asset Library
   (docs/roadmap.md "Parallel track — Design Asset Library", "Recycle
   bin — soft delete, two independent layers"). Everything else —
   patch-design.js's archive action, the app-level recycle bin — is
   soft delete only. This sweep is what actually reclaims storage:
   designs archived more than PURGE_AFTER_DAYS ago get their DynamoDB
   item AND both S3 objects (original + web, on the private originals
   bucket) permanently removed.

   The publicly-copied web image (public storefront bucket) is not
   touched here on purpose: manifest.js's regenerateManifest() already
   dropped an archived design from design-manifest.json the moment it
   was archived (it filters on attribute_not_exists(deletedAt)), so an
   orphaned public object is unreachable from the storefront, just not
   yet reclaimed. Cleaning that up too is a straightforward follow-up
   (the role already grants s3:DeleteObject on PublicAssetsKeyPrefix*)
   but is deliberately left out of the first cut of this sweep to keep
   its blast radius to the bucket nothing else serves traffic from.

   AUDIT FIRST: an EVENT# record is written for each purge BEFORE the
   delete happens (not after) — so a botched or interrupted sweep still
   leaves a trail proving what was about to be destroyed, mirroring the
   general append-before-mutate stance the rest of this codebase takes
   (buildEvent() calls inside a TransactWriteItems alongside the state
   change they describe). It is written directly, not inside the same
   transaction as the deletes, because a TransactWriteItems cannot mix
   table item deletes with S3 calls in between — the audit item and the
   DynamoDB item delete ARE transactional together; the S3 object
   deletes happen right after, best-effort per object, so one missing
   S3 object (e.g. already gone) can't block the DynamoDB cleanup.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { designPk, metaSk, eventSk, buildEvent } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const DESIGN_ORIGINALS_BUCKET = process.env.DESIGN_ORIGINALS_BUCKET;

const PURGE_AFTER_DAYS = 90;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async () => {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 3600 * 1000).toISOString();
  const candidates = await scanArchivedBefore(cutoff);

  let purged = 0;
  for (const design of candidates) {
    try {
      await purgeOne(design);
      purged++;
    } catch (err) {
      console.error("purge-archived-designs: failed for", design.PK, err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ scanned: candidates.length, purged }) };
};

// Bounded Scan + filter, same "no GSI until ~500 items" decision as
// manifest.js's listPublishedDesigns() (docs/roadmap.md) — this sweep
// runs every 15 minutes against a small catalog, not a hot path.
async function scanArchivedBefore(cutoff) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND #st = :archived AND attribute_exists(deletedAt) AND deletedAt < :cutoff",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":prefix": "DESIGN#", ":meta": "META", ":archived": "archived", ":cutoff": cutoff },
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function purgeOne(design) {
  const now = new Date().toISOString();
  const pk = designPk(design.designId);

  // buildEvent() is order-shaped; PK overridden to DESIGN#<id> exactly
  // like publish-design.js/patch-design.js so the EVENT# convention is
  // uniform across every writer that touches a design record. Written
  // via the SAME transaction as the DynamoDB item delete — the audit
  // record is what survives once the META item is gone, so it has to
  // land atomically with the delete, not merely "before" it in wall time.
  const auditEvent = {
    ...buildEvent({
      orderId: design.designId, lineItemId: "DESIGN", from: "archived", to: "purged",
      actorSub: "system:purge-archived-designs", at: now,
      meta: {
        reason: `${PURGE_AFTER_DAYS}-day archive retention elapsed`,
        name: design.name, category: design.category,
        s3KeyOriginal: design.s3KeyOriginal, s3KeyWeb: design.s3KeyWeb,
        archivedAt: design.deletedAt,
      },
    }),
    PK: pk,
    SK: eventSk(now, "DESIGN"),
  };

  await client.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: auditEvent } },
      { Delete: { TableName: TABLE, Key: { PK: pk, SK: metaSk() } } },
    ],
  }));

  // S3 deletes are best-effort and happen after the audit+DynamoDB
  // transaction has committed — the audit trail must not depend on
  // whether the objects were still there to delete.
  await Promise.all([
    deleteIfKey(design.s3KeyOriginal),
    deleteIfKey(design.s3KeyWeb),
  ]);
}

async function deleteIfKey(key) {
  if (!key || typeof key !== "string") return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: DESIGN_ORIGINALS_BUCKET, Key: key }));
  } catch (err) {
    console.error("purge-archived-designs: failed to delete S3 object", key, err.message);
  }
}
