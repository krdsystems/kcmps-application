/* ============================================================
   KCMPS backend — disguised-file (content/extension mismatch) detector
   ============================================================
   NOT DEPLOYED (as of 2026-08-13). This file is written but has no Lambda
   behind it in either environment — no `kcmps-validate-upload-content` or
   `kcmps-staging-validate-upload-content` function exists in production or
   staging. Its only inbound reference anywhere in the repo is a comment in
   backend/lib/magic-bytes.js. Before this does anything it needs: an S3
   ObjectCreated trigger on the relevant upload prefix(es), an execution
   role/IAM grants, and a CloudFormation entry (staging via
   backend-lambdas.cfn.yaml, production via whatever manages production's
   CLI Lambdas today). Do not assume the disguised-file gap described below
   is actually closed until this is deployed.

   UAT finding (2026-08-07): a JPEG renamed to `invoice.pdf` uploads
   successfully. Root cause: upload-design-file.js's resolveUploadType()
   (backend/lib/upload-types.js) can only catch a MISMATCH between the
   declared Content-Type and the filename extension — when both agree
   (as they trivially do on a renamed file, since the browser derives
   Content-Type from the extension too), there is nothing in that check
   left to catch. Only the file's actual bytes can catch it.

   ── Why this can't live in upload-design-file.js ───────────────────
   Uploads go browser -> S3 directly via a presigned PUT (see that
   Lambda's header) specifically so a 50MB print file never becomes a
   Lambda payload. That means upload-design-file.js issues the URL and
   returns *before* any byte of the file exists — there is nothing to
   sniff at that point, structurally, not just as an oversight.

   ── Where this DOES live: an S3 ObjectCreated event, after the fact ──
   Same shape as jobs/handle-scan-result.js's GuardDuty trigger — this
   fires once an object actually lands in S3, reads a short byte range
   (not the whole file), sniffs its real file-signature family
   (backend/lib/magic-bytes.js, pure/unit-tested), and compares it
   against what the key's extension claims to be. On a confident
   mismatch it purges every version of the object (identical reasoning
   to handle-scan-result.js's quarantine step — the bucket is versioned,
   so a plain delete isn't enough) and persists a blocking verdict onto
   whatever record references it, reusing the EXACT SAME `SCAN#<ref>`
   item and `scanStatus` field GuardDuty verdicts live on
   (backend/lib/keys.js's scanResultPk()). That is deliberate, not a
   shortcut: every read path (staff-api/get-orders.js, get-messages.js,
   design-library/list-designs.js) already fails closed on anything
   other than `scanStatus === "NO_THREATS_FOUND"`, so writing
   `CONTENT_TYPE_MISMATCH` here blocks the download link with ZERO
   changes to any read path — the same fail-closed gate that already
   exists for malware also now covers a disguised file.

   Scope: the checkout design-upload prefix, where the UAT finding was
   reproduced (`design-uploads/`). The same disguised-file gap
   structurally exists on `payments/`/`messages/`/`correspondence/` too
   (all reachable via a presigned PUT with a declared Content-Type), but
   this pass only wires the one prefix the UAT flagged — see routing
   note below on how to extend it.

   ── Ordering with GuardDuty ─────────────────────────────────────────
   This event and the GuardDuty scan-result event are independent and
   may arrive in either order. Both write to the SAME SCAN#<ref> item
   with the SAME `scanStatus` field, so whichever writes LAST wins on
   that item — a clean GuardDuty verdict arriving after this handler
   would silently clear a CONTENT_TYPE_MISMATCH block. This is a known,
   accepted gap for this pass (content mismatches are rare and the
   window is short — GuardDuty scans typically complete within minutes
   of upload, and object-creation events fire near-instantly), not a
   silent bug: a future hardening pass should make handle-scan-result.js
   preserve an existing CONTENT_TYPE_MISMATCH rather than overwrite it
   (e.g. a conditional write that only proceeds if the current status
   isn't already a block). Flagged here rather than fixed silently.

   ── INFRA THIS LAMBDA NEEDS (not deployed by this change) ───────────
   1. S3 EventBridge notifications enabled on kcmps-payment-uploads-*
      (may already be on for the GuardDuty rule — check before assuming).
   2. An EventBridge rule: source `aws.s3`, detail-type
      "Object Created", filtered to the `design-uploads/` prefix,
      targeting this Lambda.
   3. IAM: s3:GetObject (range reads) + s3:ListBucketVersions +
      s3:DeleteObject on the uploads bucket, dynamodb:GetItem/Query/
      UpdateItem/Scan on TABLE — same shape as handle-scan-result.js's
      existing role, so this can likely reuse or clone it.
   4. Log group with 30-day retention at creation (see backend/CLAUDE.md's
      "Cost convention" section).
   This is an OWNER-GATED deploy — implemented here as code only, per
   the task brief's staging-first / no-silent-infra rule.

   Never throws: a retried event must not fail loudly and must not
   re-delete an already-deleted object destructively (purge is
   idempotent — see purgeAllVersions()).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand, ListObjectVersionsCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { orderPk, metaSk, scanResultPk, extensionOf, isConfidentMismatch } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const MISMATCH_STATUS = "CONTENT_TYPE_MISMATCH";
// Enough bytes to cover every signature this module checks (SVG's bounded
// text scan is the largest at 512) plus headroom.
const SNIFF_RANGE_BYTES = 1024;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const bucket = event?.detail?.bucket?.name;
  const key = event?.detail?.object?.key;
  if (!bucket || !key) {
    console.error("validate-upload-content: event had no bucket/key, ignoring:", JSON.stringify(event).slice(0, 500));
    return { ok: false };
  }

  // Only the prefix this pass covers — see header. Anything else is
  // silently ignored so the same EventBridge rule can safely be widened
  // to more prefixes later without code here needing to change first.
  if (!key.startsWith("design-uploads/")) {
    return { ok: true, skipped: "unhandled prefix" };
  }

  const ext = extensionOf(key);
  if (!ext) return { ok: true, skipped: "no extension" };

  let mismatch;
  try {
    const buf = await getRange(bucket, key, SNIFF_RANGE_BYTES);
    mismatch = isConfidentMismatch(ext, buf);
  } catch (err) {
    // Object gone, access denied, whatever — never block the pipeline on
    // a read failure. A missing object also means there's nothing left
    // to purge, so this is a safe no-op, not a fail-open on the check
    // (the object either already doesn't exist or GuardDuty/normal flow
    // will still see it).
    console.error("validate-upload-content: range read failed for", key, err.message);
    return { ok: false, error: err.message };
  }

  if (!mismatch) return { ok: true, key, mismatch: false };

  console.log(`validate-upload-content: content/extension mismatch for ${key} (claims .${ext})`);
  const ref = `s3://${bucket}/${key}`;
  const now = new Date().toISOString();
  const verdict = {
    scanStatus: MISMATCH_STATUS,
    threats: [],
    threatInfo: {
      label: "File content doesn't match its type",
      explanation: `This file was uploaded as a .${ext} but its actual content doesn't match that format — a common sign of a renamed or disguised file.`,
      advice: "Do not open this file. Ask the customer to re-send the correct file.",
      severity: "high",
    },
    scannedAt: now,
    quarantined: true,
    quarantinedAt: now,
  };

  await purgeAllVersions(bucket, key).catch((err) => {
    console.error("validate-upload-content: purge FAILED for", key, err.message);
  });

  // Standalone verdict first, same reasoning as handle-scan-result.js: a
  // design file is uploaded pre-checkout, so there's routinely no order
  // yet to annotate directly.
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: scanResultPk(ref), SK: metaSk() },
      UpdateExpression: "SET scanStatus = :s, threats = :t, threatInfo = :ti, scannedAt = :sa, quarantined = :q, quarantinedAt = :qa, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":s": verdict.scanStatus, ":t": verdict.threats, ":ti": verdict.threatInfo,
        ":sa": verdict.scannedAt, ":q": verdict.quarantined, ":qa": verdict.quarantinedAt,
        ":ttl": Math.floor(Date.now() / 1000) + 180 * 24 * 3600,
      },
    }));
  } catch (err) {
    console.error("validate-upload-content: failed to persist standalone verdict for", key, err.message);
  }

  try {
    await markDesignFile(ref, verdict);
  } catch (err) {
    console.error("validate-upload-content: failed to annotate order for", key, err.message);
  }

  return { ok: true, key, mismatch: true };
};

async function getRange(bucket, key, bytes) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Identical to handle-scan-result.js's purgeAllVersions — deletes every
// version + delete-marker for the exact key so nothing survives
// retrievable by versionId. Duplicated rather than imported: jobs/ files
// are independent Lambda packages in this repo (see backend/CLAUDE.md),
// not a shared module.
async function purgeAllVersions(bucket, key) {
  const versions = [];
  let KeyMarker, VersionIdMarker;
  do {
    const res = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker }));
    for (const v of [...(res.Versions || []), ...(res.DeleteMarkers || [])]) {
      if (v.Key === key) versions.push({ Key: v.Key, VersionId: v.VersionId });
    }
    KeyMarker = res.NextKeyMarker;
    VersionIdMarker = res.NextVersionIdMarker;
  } while (KeyMarker || VersionIdMarker);
  if (!versions.length) return false;
  await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions, Quiet: true } }));
  return true;
}

// design-uploads/<uuid>.<ext> — no orderId in the key (pre-checkout
// upload), so find the order holding this ref. Mirrors handle-scan-
// result.js's markDesignFile() exactly (same bounded-Scan tradeoff,
// same "no order yet is not a lost verdict" reasoning).
async function markDesignFile(ref, verdict) {
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND attribute_exists(designFiles)",
      ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META" },
      ExclusiveStartKey,
    }));
    for (const order of res.Items || []) {
      if (!(order.designFiles || []).some((f) => f.ref === ref)) continue;
      const designFiles = order.designFiles.map((f) => (f.ref === ref ? { ...f, ...verdict } : f));
      await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: order.PK, SK: metaSk() },
        UpdateExpression: "SET designFiles = :d",
        ExpressionAttributeValues: { ":d": designFiles },
      }));
      return;
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  console.log("validate-upload-content: no order references", ref, "yet — standalone verdict stands");
}
