/* ============================================================
   KCMPS backend — GuardDuty malware scan result handler
   ============================================================
   EventBridge trigger: source `aws.guardduty`, detail-type
   "GuardDuty Malware Protection Object Scan Result". Fires once per
   uploaded object across EVERY upload prefix on
   kcmps-payment-uploads-est-2026:

     payments/<orderId>-<rand>.<ext>        checkout/submit-payment-proof.js
     design-uploads/<uuid>.<ext>            checkout/upload-design-file.js
     messages/<orderId>/<...>               staff-api/send-message.js
     correspondence/<orderId>/<...>         staff-api/add-correspondence.js

   ...plus one prefix on the SEPARATE, private kcmps-design-originals-*
   bucket (Design Asset Library, docs/roadmap.md "Parallel track — Design
   Asset Library"; not to be confused with design-uploads/ above, which is
   a customer's pre-checkout upload on the payment-uploads bucket):

     designs/<category>/<designId>/original.<ext>  design-library/get-upload-url.js
     designs/<category>/<designId>/web.<ext>       design-library/get-upload-url.js

   That bucket has its own GuardDuty Malware Protection plan and its own
   EventBridge rule (GuardDutyDesignOriginalsScanResultRule in
   backend-lambdas.cfn.yaml) targeting this SAME function, so this handler
   is bucket-agnostic — routing below is by key prefix, which doesn't
   collide across buckets today. A `designs/` verdict usually arrives
   BEFORE its DESIGN#<id> record exists (the files are uploaded in step 1,
   the record is written in step 2 by design-library/publish-design.js),
   so markDesignLibraryFile() annotates the record when there is one and
   otherwise leaves the standalone SCAN#<ref> item below to carry it. That
   item is what design-library/scan-verdict.js reads to enforce the
   fail-closed publish gate, so the verdict is never lost either way.

   Two jobs, in this order:

   1. QUARANTINE. On THREATS_FOUND the object is deleted outright —
      **every version**, not a plain DeleteObject. The bucket is
      versioned, so a normal delete just writes a delete marker and
      leaves the malicious bytes sitting as a noncurrent version until
      the 90-day NoncurrentVersionExpiration rule collects them. That
      would mean "deleted" malware still retrievable by anyone who can
      name a versionId for three months. ListObjectVersions +
      DeleteObjects with explicit VersionIds is the only way to actually
      remove it.

   2. PERSIST THE VERDICT onto whatever record references the object,
      keeping the filename, size, timestamp, uploader and the GuardDuty
      threat names — so the dashboard can still show "this file was here,
      it was infected with X, we destroyed it" rather than the row simply
      vanishing. Losing that history would be worse than useless: staff
      need to know a customer sent something malicious, precisely because
      the file is gone and can't be re-examined.

   Why persist the CLEAN results too, not just threats: it removes a
   per-request S3 call from the read path. get-orders.js used to call
   GetObjectTagging for every attachment on every staff order-list load
   (dozens of S3 round trips to render one page). Now the scan verdict
   lives on the record itself, written once here, and the read path is
   pure DynamoDB. An attachment with no persisted verdict yet is treated
   as PENDING and stays undownloadable — fail closed, so a scan result
   that never arrives can never silently become a download link.

   ORDER RESOLUTION. Three of the four prefixes carry the orderId in the
   key, so the target record is a direct lookup. `design-uploads/` can't:
   those uploads happen pre-checkout, before an orderId exists, so the
   key is a bare uuid. That one case falls back to a bounded Scan for the
   order holding a matching ref — acceptable because it only runs on
   design-file scan results, and the alternative (a reverse-index item
   written at upload time) would need cleaning up for every abandoned
   checkout. A design file whose order was never placed simply has no
   record to mark; the object is still deleted if infected.

   Never throws: an EventBridge failure here would retry the whole event
   and re-delete an already-deleted object. Every failure path logs and
   returns so a poison event can't wedge the rule.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { orderPk, metaSk, scanResultPk, describeThreats } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

// Optimistic-concurrency retries: two files on the same order can be
// scanned simultaneously, and the nested-array updates below are
// read-modify-write. Low volume, so a short retry loop beats a lock.
const MAX_WRITE_ATTEMPTS = 4;

exports.handler = async (event) => {
  const detail = event?.detail || {};
  const bucket = detail.s3ObjectDetails?.bucketName;
  const key = detail.s3ObjectDetails?.objectKey;
  // The result field has moved between schema versions and is documented
  // inconsistently — read every spelling rather than trust one.
  const status =
    detail.scanResultDetails?.scanResultStatus ||
    detail.scanResultDetails?.scanResultStatusCode ||
    detail.scanStatus;
  const threats = (detail.scanResultDetails?.threats || [])
    .map((t) => (typeof t === "string" ? t : t?.name))
    .filter(Boolean);

  if (!bucket || !key) {
    console.error("handle-scan-result: event had no s3ObjectDetails, ignoring:", JSON.stringify(event).slice(0, 500));
    return { ok: false };
  }
  console.log(`handle-scan-result: ${key} -> ${status}${threats.length ? " [" + threats.join(", ") + "]" : ""}`);

  const infected = status === "THREATS_FOUND";
  let deleted = false;
  if (infected) {
    deleted = await purgeAllVersions(bucket, key);
  }

  const verdict = {
    scanStatus: status || "UNKNOWN",
    threats,
    // Plain-English summary resolved HERE, at scan time, and stored on the
    // record — not computed at render time. Keeps the wording out of three
    // separate frontends (staff ticket, customer order page, and whatever
    // reads this next), and means the explanation survives verbatim even
    // if the description table is later reworded. The raw signature stays
    // in `threats` either way, so it is always recomputable.
    threatInfo: describeThreats(threats),
    scannedAt: event.time || new Date().toISOString(),
    quarantined: infected,
    quarantinedAt: infected ? (event.time || new Date().toISOString()) : null,
  };

  // Durable, standalone verdict FIRST — before trying to find a record to
  // annotate. A design file is uploaded pre-checkout, so the scan often
  // finishes while the customer is still filling in the form and there is
  // no order to attach to yet. Annotating the order is the fast path; this
  // item is the source of truth the read paths fall back to. Writing it
  // unconditionally is what stops a verdict from being silently lost.
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: scanResultPk(`s3://${bucket}/${key}`), SK: metaSk() },
      UpdateExpression: "SET scanStatus = :s, threats = :t, threatInfo = :ti, scannedAt = :sa, quarantined = :q, quarantinedAt = :qa, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":s": verdict.scanStatus, ":t": verdict.threats, ":ti": verdict.threatInfo,
        ":sa": verdict.scannedAt, ":q": verdict.quarantined, ":qa": verdict.quarantinedAt,
        // Housekeeping only — these are a fallback cache, not the audit
        // trail (the annotated record is). 180d is well past any window in
        // which an order is still being looked at.
        ":ttl": Math.floor(Date.now() / 1000) + 180 * 24 * 3600,
      },
    }));
  } catch (err) {
    console.error("handle-scan-result: failed to persist standalone verdict for", key, err.message);
  }

  try {
    await recordVerdict(bucket, key, verdict);
  } catch (err) {
    // The object is already gone at this point if it was infected — that's
    // the part that matters. A failed annotation is a visibility problem,
    // not a security one, and retrying the event would re-run the delete.
    console.error("handle-scan-result: failed to annotate record for", key, err.message);
  }

  return { ok: true, key, status, deleted };
};

// Deletes every version + delete-marker for one key. See header for why a
// plain DeleteObject isn't enough on a versioned bucket.
async function purgeAllVersions(bucket, key) {
  try {
    const versions = [];
    let KeyMarker, VersionIdMarker;
    do {
      const res = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker }));
      for (const v of [...(res.Versions || []), ...(res.DeleteMarkers || [])]) {
        // Prefix is a prefix match — make sure we only touch this exact key.
        if (v.Key === key) versions.push({ Key: v.Key, VersionId: v.VersionId });
      }
      KeyMarker = res.NextKeyMarker;
      VersionIdMarker = res.NextVersionIdMarker;
    } while (KeyMarker || VersionIdMarker);

    if (!versions.length) {
      console.warn("handle-scan-result: nothing to purge for", key);
      return false;
    }
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions, Quiet: true } }));
    console.log(`handle-scan-result: purged ${versions.length} version(s) of ${key}`);
    return true;
  } catch (err) {
    console.error("handle-scan-result: purge FAILED for", key, err.message);
    return false;
  }
}

// ---- routing the verdict to whatever record references the object ----

function recordVerdict(bucket, key, verdict) {
  const ref = `s3://${bucket}/${key}`;
  if (key.startsWith("payments/")) return markPaymentScreenshot(key, ref, verdict);
  if (key.startsWith("messages/")) return markMessageAttachment(key, ref, verdict);
  if (key.startsWith("correspondence/")) return markCorrespondenceAttachment(key, ref, verdict);
  if (key.startsWith("design-uploads/")) return markDesignFile(ref, verdict);
  if (key.startsWith("designs/")) return markDesignLibraryFile(key, ref, verdict);
  console.warn("handle-scan-result: unrecognized prefix, nothing to annotate:", key);
  return Promise.resolve();
}

// payments/<orderId>-<rand>.<ext>
function orderIdFromPaymentKey(key) {
  const tail = key.slice("payments/".length);
  const i = tail.lastIndexOf("-");
  return i > 0 ? tail.slice(0, i) : null;
}

async function markPaymentScreenshot(key, ref, verdict) {
  const orderId = orderIdFromPaymentKey(key);
  if (!orderId) return;
  await withRetry(async () => {
    const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk(orderId), SK: metaSk() } }));
    const order = res.Item;
    if (!order || !order.payment || order.payment.screenshotRef !== ref) return;
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: orderPk(orderId), SK: metaSk() },
      // Field names must match what the other three prefixes write
      // (`threats`, `threatInfo`) — the frontend reads one shape. An
      // earlier version wrote `scanThreats` here and omitted threatInfo
      // entirely, so a quarantined GCash proof rendered with no
      // explanation at all while every other attachment type had one.
      UpdateExpression: "SET payment.scanStatus = :s, payment.threats = :t, payment.threatInfo = :ti, payment.quarantined = :q, payment.quarantinedAt = :qa",
      ConditionExpression: "payment.screenshotRef = :ref",
      ExpressionAttributeValues: {
        ":s": verdict.scanStatus, ":t": verdict.threats, ":ti": verdict.threatInfo,
        ":q": verdict.quarantined, ":qa": verdict.quarantinedAt, ":ref": ref,
      },
    }));
  });
}

// correspondence/<orderId>/<...>
async function markCorrespondenceAttachment(key, ref, verdict) {
  const orderId = key.split("/")[1];
  if (!orderId) return;
  await withRetry(async () => {
    const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk(orderId), SK: metaSk() } }));
    const log = res.Item?.correspondenceLog;
    if (!Array.isArray(log)) return;
    let touched = false;
    const next = log.map((entry) => {
      if (!Array.isArray(entry.attachments)) return entry;
      const attachments = entry.attachments.map((a) => {
        if (a.ref !== ref) return a;
        touched = true;
        return { ...a, ...verdict };
      });
      return touched ? { ...entry, attachments } : entry;
    });
    if (!touched) return;
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: orderPk(orderId), SK: metaSk() },
      UpdateExpression: "SET correspondenceLog = :log",
      // Guards the read-modify-write: if another scan result rewrote the
      // log between our Get and this Put, retry instead of clobbering it.
      ConditionExpression: "size(correspondenceLog) = :len",
      ExpressionAttributeValues: { ":log": next, ":len": log.length },
    }));
  });
}

// messages/<orderId>/<...>
async function markMessageAttachment(key, ref, verdict) {
  const orderId = key.split("/")[1];
  if (!orderId) return;
  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": orderPk(orderId), ":prefix": "MSG#" },
  }));
  const msg = (res.Items || []).find((m) => (m.attachments || []).some((a) => a.ref === ref));
  if (!msg) return;
  const attachments = msg.attachments.map((a) => (a.ref === ref ? { ...a, ...verdict } : a));
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: msg.PK, SK: msg.SK },
    UpdateExpression: "SET attachments = :a",
    ExpressionAttributeValues: { ":a": attachments },
  }));
}

// design-uploads/<uuid>.<ext> — no orderId in the key (pre-checkout
// upload), so find the order holding this ref. See header.
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
  // No order references it YET. Two ways this happens, and neither loses
  // the verdict any more: the order genuinely was abandoned, or — far more
  // commonly — the customer is still on the checkout form and the order
  // simply doesn't exist at scan time. The standalone SCAN# item written
  // above is what get-orders.js reads in that case.
  console.log("handle-scan-result: no order references", ref, "yet — standalone verdict stands");
}

// designs/<category>/<designId>/{original,web}.<ext> — Design Asset
// Library originals bucket. Unlike design-uploads/ above, the designId is
// IN the key, so this is a direct Get, never a Scan.
//
// The DESIGN# record usually does NOT exist yet when this fires: the two
// files are PUT by design-library/get-upload-url.js's presigned URLs and
// the record is only written when the designer submits the form
// (publish-design.js), so the scan routinely completes first. That is
// fine and is not a lost verdict — publish-design.js reads the standalone
// SCAN# item (written unconditionally above, before this routing runs)
// via design-library/scan-verdict.js and refuses to publish anything
// without a NO_THREATS_FOUND on BOTH objects. This annotation is the
// convenience copy for the dashboard's library/recycle-bin views, in the
// same spirit as the other three prefixes; the SCAN# item stays the
// source of truth for the fail-closed gate.
async function markDesignLibraryFile(key, ref, verdict) {
  const parts = key.split("/"); // designs/<category>/<designId>/<basename>
  const designId = parts[2];
  const which = (parts[3] || "").startsWith("web") ? "web" : "original";
  if (!designId) return;
  // Two writes: create the map if absent, then set this file's slot inside
  // it. `scanVerdicts`, not `scan` — SCAN is a DynamoDB reserved word, and
  // the resulting ValidationException is swallowed by the caller's catch,
  // so it looks exactly like "nothing happened" (it did, once).
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `DESIGN#${designId}`, SK: metaSk() },
      UpdateExpression: "SET scanVerdicts = if_not_exists(scanVerdicts, :empty)",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":empty": {} },
    }));
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `DESIGN#${designId}`, SK: metaSk() },
      UpdateExpression: "SET scanVerdicts.#w = :v",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#w": which },
      ExpressionAttributeValues: { ":v": { ...verdict, ref } },
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("handle-scan-result: no DESIGN# record for", designId, "yet — standalone verdict stands");
      return;
    }
    throw err;
  }
}

async function withRetry(fn) {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (err.name !== "ConditionalCheckFailedException" || attempt === MAX_WRITE_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
