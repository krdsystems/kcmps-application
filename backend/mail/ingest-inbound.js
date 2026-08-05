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

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { simpleParser } = require("mailparser");
const { mailboxPk, mailMessageSk, baseItem, UNPARSEABLE_MAILBOX, QUARANTINE_MAILBOX } = require("../lib");
const { hashMessageId, toMailFields } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;

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
