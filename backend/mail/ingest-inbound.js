/* ============================================================
   KCMPS backend — S3-triggered inbound-mail ingest
   ============================================================
   Fires on every ObjectCreated under kcmps-inbound-mail-est-2026's
   inbound/ prefix (C1's SES receipt rule `mirror-domain-catchall` writes
   raw MIME there — see backend/infra/ses-relay.cfn.yaml). Parses the MIME
   and writes one MAILBOX#/MSG# item per matched recipient mailbox — see
   ../lib/keys.js's mailboxPk()/mailMessageSk() header for the key-shape
   reasoning.

   ONE STREAM IN, THREE LOGICAL MAILBOXES OUT. The SES receipt rule no
   longer accepts the whole mirror.kcmps.com domain — its Recipients list
   holds exactly one address, ../lib/mail.js's MIRROR_ADDRESS, which is
   what Spacemail forwards the single real admin@kcmps.com mailbox to.
   That kills the "guess a local part and inject a message into the staff
   UI" surface, but it also means the DELIVERY address carries no routing
   information: it's the same for every message.

   So routing is on the ORIGINAL recipient. ./mail-parse.js pulls the
   forwarder-stamped envelope headers (Delivered-To / X-Original-To / …)
   and, only as a fallback, To:/Cc:; ../lib/mail.js's resolveMailboxes()
   makes the decision. A message BCC'd to order@kcmps.com is exactly why
   the envelope header is preferred — it has no To: header naming order@
   and routing on To:/Cc: would mis-file it.

   Anything matching no known alias goes to ONE unrouted@ mailbox. Never
   silently dropped (the S3 object is the source of truth regardless), and
   never auto-creating a mailbox — an unknown local part must not be able
   to conjure a new tab in the staff UI.

   VERDICTS ARE ENFORCED HERE. ../lib/mail.js's assessVerdicts() reads the
   four SES verdicts off the message headers. Virus or spam = hard reject:
   the message never enters a shared mailbox, only a metadata-only stub in
   quarantine@ (Admin-only, no bodyText, no attachment metadata). SPF is
   recorded but NEVER enforced — forwarding breaks SPF by design, so
   rejecting on it would discard every legitimate message this relay
   exists to carry. See that function's header.

   NEVER CRASH ON MALFORMED MAIL. handle-scan-result.js's own header notes
   a bug where "never throw" once hid a real ValidationException for days
   — so every catch here logs loudly (console.error with the S3 key) before
   falling back, rather than swallowing silently. A parse failure still
   writes a minimal record under UNPARSEABLE_MAILBOX so the S3 ref is never
   lost (staff can still find/download the raw MIME later even if today's
   read-path Lambdas can't render it nicely).

   RESERVED WORDS: this file only does PutCommand (whole-item writes), so
   DynamoDB's reserved-word restriction (which only bites
   Update/FilterExpression attribute names) doesn't apply here — see
   get-mail-messages.js/mark-mail-read.js for where it does.
   ============================================================ */

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { simpleParser } = require("mailparser");
const { mailboxPk, mailMessageSk, baseItem, UNPARSEABLE_MAILBOX, QUARANTINE_MAILBOX } = require("../lib");
const { hashMessageId, toMailFields } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;

/* ------------------------------------------------------------
   ATTACHMENT EXTRACTION (2026-08-07)
   ------------------------------------------------------------
   Attachment bytes live inside the raw MIME in the inbound-mail bucket,
   which has NO GuardDuty Malware Protection plan — so serving them from
   there would bypass the fail-closed scan gate every other download path
   in this codebase enforces. Instead, each attachment part is extracted
   here to its own object under mail-attachments/ on UPLOADS_BUCKET_NAME
   (the payment-uploads bucket, whose GuardDuty plan was extended with
   this fifth prefix). GuardDuty then scans it like any other upload,
   jobs/handle-scan-result.js persists the standalone SCAN#<ref> verdict
   (and purges every version on THREATS_FOUND), and get-mail-message.js
   only presigns a download/view URL for NO_THREATS_FOUND — the exact
   pattern staff-api/get-messages.js uses for order-thread attachments.

   Deterministic keys (<hash of Message-ID>/<index>.<ext>) make this
   naturally idempotent on S3-event retry, same reasoning as the MSG# SK.
   Extraction is best-effort per attachment: a failed PUT leaves that
   attachment metadata-only (no ref -> the UI renders it as before), and
   never fails the ingest. UPLOADS_BUCKET_NAME unset = extraction off.
   Quarantined messages never reach this — their attachments are dropped
   entirely, unchanged. */
const UPLOADS_BUCKET = (process.env.UPLOADS_BUCKET_NAME || "").trim();
const ATTACHMENT_PREFIX = "mail-attachments/";
const MAX_EXTRACTED_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // SES inbound caps whole messages at 40MB anyway

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const records = (event && event.Records) || [];
  const results = await Promise.all(records.map(processRecord));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    // Don't throw for a partial batch (would replay every record, including
    // ones that already wrote fine) — but log loudly so it isn't invisible.
    console.error("ingest-inbound: failed records", JSON.stringify(failed));
  }
  return { batchItemFailures: [] };
};

async function processRecord(record) {
  const bucket = record.s3 && record.s3.bucket && record.s3.bucket.name;
  const key = decodeURIComponent((record.s3 && record.s3.object && record.s3.object.key || "").replace(/\+/g, " "));
  const s3Ref = `s3://${bucket}/${key}`;
  if (!bucket || !key) return { ok: false, reason: "missing bucket/key", record };

  let raw;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    raw = await streamToBuffer(obj.Body);
  } catch (err) {
    console.error("ingest-inbound: failed to fetch", s3Ref, err.message);
    return { ok: false, reason: "s3-get-failed", s3Ref };
  }

  let parsed;
  try {
    parsed = await simpleParser(raw);
  } catch (err) {
    console.error("ingest-inbound: MIME parse failed for", s3Ref, err.message);
    await writeUnparseable(s3Ref, err.message);
    return { ok: false, reason: "parse-failed", s3Ref };
  }

  try {
    const { mailboxes, routedBy, quarantine, quarantineReason, fields } = toMailFields(parsed, { s3Ref });

    if (quarantine) {
      // HARD REJECT. The message body and attachment metadata are dropped
      // on the floor — a quarantined message must not be readable in the
      // staff UI, and the snippet alone is enough of a phishing payload to
      // be worth withholding too. The raw MIME stays in S3 for forensics.
      console.warn("ingest-inbound: quarantined", s3Ref, quarantineReason, JSON.stringify(fields.provenance.verdicts));
      await writeMailItem(QUARANTINE_MAILBOX, {
        ...fields,
        subject: "(quarantined message)",
        snippet: quarantineReason,
        bodyText: "",
        attachments: [],
        hasHtmlPart: false,
        quarantineReason,
        // Keep from/date/provenance so staff can see WHAT arrived and that
        // it was withheld — same "show the verdict, withhold the payload"
        // shape as backend/jobs/handle-scan-result.js.
      });
      return { ok: true, s3Ref, mailboxes: [QUARANTINE_MAILBOX], quarantined: true };
    }

    await extractAttachments(parsed, fields);
    await Promise.all(mailboxes.map((mailboxId) => writeMailItem(mailboxId, fields)));
    return { ok: true, s3Ref, mailboxes, routedBy };
  } catch (err) {
    console.error("ingest-inbound: failed to write item(s) for", s3Ref, err.message);
    return { ok: false, reason: "write-failed", s3Ref };
  }
}

async function writeMailItem(mailboxId, fields) {
  const item = {
    ...baseItem(),
    PK: mailboxPk(mailboxId),
    SK: mailMessageSk(hashMessageId(fields.messageId)),
    mailboxId,
    ...fields,
    threadId: await resolveThreadId(mailboxId, fields),
  };
  delete item.status; // baseItem() stamps status:undefined — mail items have no status field
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
}

/* Prefer the STORED threadId of a parent that already exists in this
   mailbox over the derived one. This is what keeps a thread whole when a
   client's References header is truncated (In-Reply-To pointing at OUR
   reply, whose id is not the thread root) and what lets replies to
   pre-2026-08-07 messages join their original (old-scheme, subject-hash)
   threads instead of forking a second one. Direct parent first
   (In-Reply-To), then the References chain newest-to-oldest; bounded to a
   handful of GetItems. Any lookup failure falls back to the derived id —
   threading must never fail an ingest. */
const MAX_PARENT_LOOKUPS = 5;

async function resolveThreadId(mailboxId, fields) {
  const candidates = [];
  const push = (id) => { const v = String(id || "").trim(); if (v && !candidates.includes(v)) candidates.push(v); };
  push(fields.inReplyTo);
  const refs = Array.isArray(fields.references) ? fields.references : [];
  for (let i = refs.length - 1; i >= 0; i--) push(refs[i]);

  for (const cand of candidates.slice(0, MAX_PARENT_LOOKUPS)) {
    try {
      const res = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(cand)) },
        ProjectionExpression: "threadId",
      }));
      if (res.Item && res.Item.threadId) return res.Item.threadId;
    } catch (err) {
      console.error("ingest-inbound: parent threadId lookup failed for", mailboxId, err.message);
      break;
    }
  }
  return fields.threadId;
}

/* See the ATTACHMENT EXTRACTION block at the top. Mutates
   fields.attachments in place, adding `ref` to each successfully
   extracted part; parts that are oversized, empty, past the count cap, or
   that fail to PUT simply keep no ref (metadata-only, the pre-2026-08-07
   behavior). */
async function extractAttachments(parsed, fields) {
  if (!UPLOADS_BUCKET) return;
  const parts = parsed.attachments || [];
  const metas = fields.attachments || [];
  const msgHash = hashMessageId(fields.messageId);
  const count = Math.min(metas.length, parts.length, MAX_EXTRACTED_ATTACHMENTS);
  for (let i = 0; i < count; i++) {
    const part = parts[i];
    const content = part && part.content;
    if (!content || !content.length || content.length > MAX_ATTACHMENT_BYTES) continue;
    const key = `${ATTACHMENT_PREFIX}${msgHash}/${i}.${safeExtension(part.filename)}`;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: UPLOADS_BUCKET,
        Key: key,
        Body: content,
        // Sender-declared, so sanitized to a bare type token. Only ever
        // rendered inline via contentDispositionFor()'s CLOSED allowlist
        // (backend/lib/upload-types.js) — anything unlisted, SVG included,
        // is forced to attachment + octet-stream at presign time.
        ContentType: safeContentType(part.contentType),
      }));
      metas[i].ref = `s3://${UPLOADS_BUCKET}/${key}`;
    } catch (err) {
      console.error("ingest-inbound: attachment extraction failed for", key, err.message);
    }
  }
}

// Server-chosen key extension — the sender's filename never becomes part of
// the key beyond a strictly [a-z0-9] extension token (same containment idea
// as checkout/upload-design-file.js's server-generated keys).
function safeExtension(filename) {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(String(filename || "").trim());
  return m ? m[1].toLowerCase() : "bin";
}

function safeContentType(contentType) {
  const t = String(contentType || "").toLowerCase().split(";")[0].trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t : "application/octet-stream";
}

async function writeUnparseable(s3Ref, errorMessage) {
  const now = new Date().toISOString();
  const item = {
    ...baseItem(),
    PK: mailboxPk(UNPARSEABLE_MAILBOX),
    SK: mailMessageSk(hashMessageId(s3Ref)),
    mailboxId: UNPARSEABLE_MAILBOX,
    messageId: `<unparseable-${hashMessageId(s3Ref)}@kcmps.com>`,
    threadId: `THR#unparseable#${hashMessageId(s3Ref)}`,
    from: { name: "", address: "" },
    to: [], cc: [],
    subject: "(unparseable message)",
    date: now,
    snippet: `Failed to parse: ${errorMessage}`.slice(0, 200),
    bodyText: "",
    hasHtmlPart: false,
    attachments: [],
    flags: { seen: false, answered: false, flagged: false },
    folder: "INBOX",
    s3Ref,
    // Nothing could be parsed, so every verdict is genuinely unknown —
    // render it as such rather than omitting the block and letting the UI
    // fall back to "no provenance recorded", which reads as older data.
    provenance: {
      verdicts: { spf: "UNKNOWN", dkim: "UNKNOWN", spam: "UNKNOWN", virus: "UNKNOWN" },
      authenticated: false,
      routedBy: "unparseable",
      deliveredTo: [],
      viaExpectedForwarder: null,
      expectedForwarder: null,
    },
  };
  delete item.status;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
