/* ============================================================
   KCMPS backend — S3-triggered inbound-mail ingest
   ============================================================
   Fires on every ObjectCreated under kcmps-inbound-mail-est-2026's
   inbound/ prefix (C1's SES receipt rule `mirror-domain-catchall` writes
   raw MIME there — see backend/infra/ses-relay.cfn.yaml). Parses the MIME
   and writes one MAILBOX#/MSG# item per matched recipient mailbox — see
   ../lib/keys.js's mailboxPk()/mailMessageSk() header for the key-shape
   reasoning.

   SINGLE DOMAIN-WIDE CATCHALL, NOT PER-MAILBOX: the receipt rule doesn't
   split by recipient, so routing is done here by parsing the MIME To/Cc
   headers (extractMailboxRecipients() in ./mail-parse.js), never by S3
   key. A message with no mirror.kcmps.com address in To/Cc (Bcc'd,
   forwarded, or a sender that omitted them) falls back to CATCHALL_MAILBOX
   below rather than being silently dropped — the S3 object (source of
   truth) is never the thing that's lost; only the routing may be
   imprecise. See ./mail-parse.js's header for why this is inherent to a
   plain-S3 SES receipt action (no envelope-recipient header is injected).

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

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { simpleParser } = require("mailparser");
const { mailboxPk, mailMessageSk, baseItem } = require("../lib");
const { hashMessageId, toMailFields } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;
const CATCHALL_MAILBOX = "catchall@mirror.kcmps.com";
const UNPARSEABLE_MAILBOX = "unparseable@mirror.kcmps.com";

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
    const { mailboxes, fields } = toMailFields(parsed, { s3Ref });
    const targets = mailboxes.length ? mailboxes : [CATCHALL_MAILBOX];
    await Promise.all(targets.map((mailboxId) => writeMailItem(mailboxId, fields)));
    return { ok: true, s3Ref, mailboxes: targets };
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
  };
  delete item.status; // baseItem() stamps status:undefined — mail items have no status field
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
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
