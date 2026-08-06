/* ============================================================
   KCMPS Asset Library — fail-closed malware verdict lookup
   ============================================================
   GuardDuty Malware Protection watches the `designs/` prefix on the
   private originals bucket, and backend/jobs/handle-scan-result.js
   persists every verdict — including clean ones — as a standalone
   SCAN#<s3://bucket/key> / META item (backend/lib/keys.js's
   scanResultPk()).

   That standalone item, not an annotation on some parent record, is
   what this reads, and that is deliberate: a design's two objects are
   uploaded BEFORE any DESIGN# record exists (get-upload-url.js is step
   1, publish-design.js is step 2), so at scan time there is nothing to
   annotate. This is the same scanned-before-the-parent-record race that
   pre-checkout customer design uploads hit, and handle-scan-result.js
   already writes the standalone item unconditionally, before routing, to
   cover it. Reading it here is what closes the loop.

   FAIL CLOSED, three ways, because "no verdict" and "bad verdict" are
   different problems with the same correct answer — do not publish:
     - NO_THREATS_FOUND        -> clean, publish may proceed
     - no SCAN# item at all    -> still scanning, refuse (retryable)
     - anything else           -> refuse (THREATS_FOUND / UNSUPPORTED /
                                  ACCESS_DENIED / FAILED)
   Never invert this into a denylist of bad statuses: a status string
   nobody anticipated would then read as "fine."
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { scanResultPk, metaSk } = require("../lib");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CLEAN = "NO_THREATS_FOUND";

// Returns { ok: true } or { ok: false, pending, status, threats, threatInfo }.
async function checkVerdict(tableName, ref) {
  const res = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: scanResultPk(ref), SK: metaSk() },
  }));
  const item = res.Item;
  if (!item || !item.scanStatus) {
    return { ok: false, pending: true, status: "PENDING", ref };
  }
  if (item.scanStatus === CLEAN) return { ok: true, status: CLEAN, ref };
  return {
    ok: false,
    pending: false,
    status: item.scanStatus,
    threats: item.threats || [],
    threatInfo: item.threatInfo || null,
    quarantined: !!item.quarantined,
    ref,
  };
}

module.exports = { CLEAN, checkVerdict };
