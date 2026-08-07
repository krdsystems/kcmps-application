/* ============================================================
   ONE-TIME OPS SCRIPT — backfill mail threading + attachment refs
   ============================================================
   Companion to the 2026-08-07 threading/attachments fix (see
   mail-parse.js's deriveThreadId header). Existing MAILBOX# items were
   written under the old scheme where a thread ROOT got a THR#subj# id
   while its replies derived THR#ref# ids — this recomputes every
   inbound message's threadId/references/inReplyTo from its raw MIME
   (s3Ref, the source of truth), extracts attachment bytes to the
   scanned uploads bucket exactly like the new ingest does, and then
   re-parents SENT items (which have no s3Ref) onto their original's
   NEW threadId via In-Reply-To.

   SAFE + IDEMPOTENT by construction:
     - every recomputed value is a pure function of the immutable raw
       MIME object, so re-running writes the same values again
     - attachment keys are deterministic (msgHash/index.ext) — re-runs
       overwrite identical bytes
     - only threadId / references / inReplyTo / attachments are ever
       touched; body, flags, provenance, routing are never rewritten
     - a per-item guard verifies the S3 object's parsed Message-ID
       hashes to the item's SK before writing anything
     - DRY RUN by default; pass --apply to write

   Usage (run from repo root, never deployed):
     AWS_PROFILE=kcmps-claude-priv AWS_REGION=ap-southeast-1 \
       node backend/mail/backfill-threading-2026-08-07.js \
       --table kcmps-staging --uploads-bucket kcmps-payment-uploads-staging [--apply]
   ============================================================ */

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { simpleParser } = require("mailparser");
const { hashMessageId, deriveThreadId, normalizeReferences } = require("./mail-parse");
const { mailboxPk, mailMessageSk } = require("../lib");

const args = process.argv.slice(2);
function argOf(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const TABLE = argOf("--table");
const UPLOADS_BUCKET = argOf("--uploads-bucket");
const APPLY = args.includes("--apply");
if (!TABLE) { console.error("--table is required"); process.exit(1); }

const MAILBOXES = ["order@kcmps.com", "info@kcmps.com", "admin@kcmps.com", "unrouted@kcmps.com"];
const ATTACHMENT_PREFIX = "mail-attachments/";
const MAX_EXTRACTED_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function safeExtension(filename) {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(String(filename || "").trim());
  return m ? m[1].toLowerCase() : "bin";
}
function safeContentType(contentType) {
  const t = String(contentType || "").toLowerCase().split(";")[0].trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t : "application/octet-stream";
}

async function main() {
  console.log(`table=${TABLE} uploadsBucket=${UPLOADS_BUCKET || "(none — attachment extraction skipped)"} mode=${APPLY ? "APPLY" : "DRY RUN"}`);
  const byMailbox = {};
  for (const mb of MAILBOXES) {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": mailboxPk(mb) },
    }));
    byMailbox[mb] = res.Items || [];
    console.log(`${mb}: ${byMailbox[mb].length} items`);
  }

  // ---- pass 1: inbound items (have s3Ref) — recompute from raw MIME ----
  for (const mb of MAILBOXES) {
    for (const item of byMailbox[mb]) {
      if (!item.s3Ref) continue;
      const m = S3_URI_RE.exec(item.s3Ref);
      if (!m) { console.warn(`SKIP ${mb} ${item.SK}: malformed s3Ref`); continue; }
      let parsed;
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
        parsed = await simpleParser(await streamToBuffer(obj.Body));
      } catch (err) {
        console.warn(`SKIP ${mb} ${item.SK}: MIME fetch/parse failed — ${err.message}`);
        continue;
      }
      // Guard: this really is the message the item was written from.
      if (parsed.messageId && mailMessageSk(hashMessageId(parsed.messageId)) !== item.SK) {
        console.warn(`SKIP ${mb} ${item.SK}: parsed Message-ID does not hash to this SK`);
        continue;
      }
      const newThreadId = deriveThreadId(parsed);
      const references = normalizeReferences(parsed.references);
      const inReplyTo = parsed.inReplyTo || null;

      // Attachment extraction — mirror ingest-inbound.js exactly.
      const metas = (item.attachments || []).map((a) => ({ ...a }));
      if (UPLOADS_BUCKET && metas.length && mb !== "unrouted@kcmps.com") {
        const parts = parsed.attachments || [];
        const msgHash = hashMessageId(item.messageId);
        const count = Math.min(metas.length, parts.length, MAX_EXTRACTED_ATTACHMENTS);
        for (let i = 0; i < count; i++) {
          const content = parts[i] && parts[i].content;
          if (!content || !content.length || content.length > MAX_ATTACHMENT_BYTES) continue;
          const key = `${ATTACHMENT_PREFIX}${msgHash}/${i}.${safeExtension(parts[i].filename)}`;
          if (APPLY) {
            await s3.send(new PutObjectCommand({
              Bucket: UPLOADS_BUCKET, Key: key, Body: content,
              ContentType: safeContentType(parts[i].contentType),
            }));
          }
          metas[i].ref = `s3://${UPLOADS_BUCKET}/${key}`;
        }
      }

      const changes = [];
      if (item.threadId !== newThreadId) changes.push(`threadId ${item.threadId} -> ${newThreadId}`);
      if (JSON.stringify(item.references || []) !== JSON.stringify(references)) changes.push(`references ${(item.references || []).length} -> ${references.length}`);
      if ((item.inReplyTo || null) !== inReplyTo) changes.push("inReplyTo set");
      if (JSON.stringify(item.attachments || []) !== JSON.stringify(metas)) changes.push("attachment refs added");
      if (!changes.length) { console.log(`OK   ${mb} ${item.SK}: already correct`); continue; }
      console.log(`${APPLY ? "FIX " : "WOULD"} ${mb} ${item.SK} (${item.subject}): ${changes.join("; ")}`);
      item.threadId = newThreadId; // in-memory, so pass 2 sees the new ids
      if (APPLY) {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: item.PK, SK: item.SK },
          ConditionExpression: "attribute_exists(PK)",
          UpdateExpression: "SET threadId = :t, #refs = :r, inReplyTo = :i, attachments = :a",
          ExpressionAttributeNames: { "#refs": "references" },
          ExpressionAttributeValues: { ":t": newThreadId, ":r": references, ":i": inReplyTo, ":a": metas },
        }));
      }
    }
  }

  // ---- pass 2: SENT items (no s3Ref) — inherit parent's new threadId ----
  // Iterate to a fixpoint so a reply-to-a-reply chain settles.
  for (let round = 0; round < 5; round++) {
    let changed = 0;
    for (const mb of MAILBOXES) {
      const bySk = new Map(byMailbox[mb].map((i) => [i.SK, i]));
      for (const item of byMailbox[mb]) {
        if (item.s3Ref || !item.inReplyTo) continue;
        const parent = bySk.get(mailMessageSk(hashMessageId(item.inReplyTo)));
        if (!parent || !parent.threadId || parent.threadId === item.threadId) continue;
        console.log(`${APPLY ? "FIX " : "WOULD"} ${mb} ${item.SK} (SENT): threadId ${item.threadId} -> ${parent.threadId}`);
        item.threadId = parent.threadId;
        changed++;
        if (APPLY) {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { PK: item.PK, SK: item.SK },
            ConditionExpression: "attribute_exists(PK)",
            UpdateExpression: "SET threadId = :t",
            ExpressionAttributeValues: { ":t": parent.threadId },
          }));
        }
      }
    }
    if (!changed) break;
  }
  console.log("done");
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
