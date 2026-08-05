/* ============================================================
   KCMPS staff mail API — POST /mail/mailboxes/{mailboxId}/messages/{messageId}/reply
   ============================================================
   The send half of the staff mail panel. Mirrors dashboard-data.js's
   sendReply(mailboxId, messageId, {bodyText, cc}) exactly — including its
   own comment naming the three side effects a real send performs, all
   three of which happen here:

     1. SMTP send            -> SES SendRawEmail
     2. IMAP APPEND to Sent  -> a folder:"SENT" item under the same
                                MAILBOX# PK, same field shape
                                ingest-inbound.js writes
     3. STORE +FLAGS \Answered on the original -> the UpdateCommand below,
                                which also sets \Seen (the mock does both)

   Return shape is the mock's: { sent, list } — `list` re-read from the
   table so the dashboard can repaint without a second round trip. C4's
   seam swap is therefore a function-BODY change in dashboard-data.js with
   no email.html edit, same as every other KCMPS_DASH function.

   RAW MIME, NOT SendEmail. Threading needs In-Reply-To and References
   headers, and SES's simple SendEmail API has no way to set arbitrary
   headers — so this builds the message itself and posts it via
   SendRawEmailCommand. Without those two headers every reply starts a new
   thread in the recipient's client, which is the entire point of a reply.

   FROM IS DERIVED, NEVER SUPPLIED. ../lib/mail.js's sendAddressFor()
   rewrites the mailbox's mirror.kcmps.com address onto the verified
   kcmps.com *sending* identity (mirror.kcmps.com only receives; SES will
   not send from it). The client never gets to influence the From — it
   sends a body and an optional Cc, nothing else.

   RECIPIENT ALLOW-LIST (MAIL_ALLOWED_RECIPIENTS). A staging guardrail,
   not a production feature: when set, only listed addresses can be
   emailed and anything else is a clean 400. Production leaves it unset,
   which means "no restriction". This exists because this Lambda replies
   to REAL ingested mail — on staging, an unguarded reply to a genuine
   customer message would send that customer a test email from the same
   SES identity that carries real order mail, and a bounce there damages
   the sending reputation of live customer email. Fail closed on staging,
   deliberately.

   SES REJECTIONS ARE 4xx, NOT 500. A rejected send is almost always the
   caller's problem (unverified address in sandbox mode, malformed
   recipient, message too large) and staff need to see why — so SES's
   error message is surfaced in a clean JSON body. Only genuinely
   unexpected failures fall through to a 500.

   RESERVED WORDS: `flags`/`answered`/`seen` don't collide with DynamoDB's
   reserved list, but the UpdateExpression uses ExpressionAttributeNames
   anyway — same cheap-insurance convention mark-mail-read.js documents.
   ============================================================ */

const crypto = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const {
  mailboxPk, mailMessageSk, baseItem, extractClaims,
  canAccessMailbox, canSendFrom, sendAddressFor, normalizeMailboxId,
} = require("../lib");
const { hashMessageId } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;
const SENDER_NAME = process.env.MAIL_SENDER_NAME || "KCMPS";
const ALLOWED_RECIPIENTS = (process.env.MAIL_ALLOWED_RECIPIENTS || "")
  .split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);

const MAX_BODY_CHARS = 50000;
const MAX_CC = 5;
const SNIPPET_MAX_CHARS = 200; // matches mail-parse.js's buildSnippet()
const QUERY_CAP = 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const mailboxId = normalizeMailboxId(decodeURIComponent(event.pathParameters?.mailboxId || ""));
  const messageId = decodeURIComponent(event.pathParameters?.messageId || "");
  if (!mailboxId || !messageId) {
    return response(400, { error: "mailboxId and messageId path parameters are required" });
  }

  // Same 403-for-both-cases rule the read Lambdas use — never let the
  // response distinguish "not yours" from "doesn't exist".
  if (!canAccessMailbox(claims, mailboxId)) {
    return response(403, { error: "Forbidden" });
  }
  if (!canSendFrom(mailboxId)) {
    return response(403, { error: "This mailbox is read-only." });
  }
  const fromAddress = sendAddressFor(mailboxId);
  if (!fromAddress) return response(400, { error: "Unknown mailbox address" });

  let payload = {};
  try { payload = event.body ? JSON.parse(event.body) : {}; } catch { return response(400, { error: "Invalid JSON body" }); }

  const bodyText = String(payload.bodyText || "").trim();
  if (!bodyText) return response(400, { error: "Reply body cannot be empty." });
  if (bodyText.length > MAX_BODY_CHARS) return response(400, { error: "Reply body is too long." });

  // Load the original — it supplies the recipient, the subject, the
  // thread, and the headers that make this a reply rather than a new mail.
  const original = (await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(messageId)) },
  }))).Item;
  if (!original) return response(404, { error: "Message not found" });

  const to = original.from && original.from.address ? [original.from] : [];
  if (!to.length) return response(400, { error: "The original message has no reply address." });

  const cc = normalizeCc(payload.cc);
  if (cc.length > MAX_CC) return response(400, { error: `At most ${MAX_CC} Cc recipients.` });

  const blocked = [...to, ...cc]
    .map((a) => String(a.address || "").toLowerCase())
    .filter((a) => !isRecipientAllowed(a));
  if (blocked.length) {
    return response(400, {
      error: "Recipient not permitted in this environment.",
      blocked,
      hint: "MAIL_ALLOWED_RECIPIENTS restricts outbound mail on non-production stacks.",
    });
  }

  const subject = replySubject(original.subject);
  const newMessageId = `<reply-${crypto.randomUUID()}@kcmps.com>`;
  const nowIso = new Date().toISOString();
  const raw = buildRawMessage({
    from: { name: SENDER_NAME, address: fromAddress },
    to, cc, subject, bodyText, newMessageId,
    inReplyTo: original.messageId,
    references: buildReferences(original),
    date: new Date(nowIso),
  });

  try {
    await ses.send(new SendRawEmailCommand({
      Source: fromAddress,
      Destinations: [...to, ...cc].map((a) => a.address),
      RawMessage: { Data: Buffer.from(raw, "utf8") },
    }));
  } catch (err) {
    console.error("send-reply: SES send failed", err.name, err.message);
    // Surface the reason rather than a bare 500 — see this file's header.
    return response(sesStatusFor(err), {
      error: "Email could not be sent.",
      reason: err.message || String(err),
      code: err.name || "SESError",
    });
  }

  // Only after a confirmed send do the two local side effects run. If
  // either write fails the mail has still gone out, so they're logged and
  // reported rather than rolled back (there is no un-send) — the customer
  // got their reply, which matters more than the dashboard's bookkeeping.
  const sent = {
    messageId: newMessageId,
    mailboxId,
    folder: "SENT",
    threadId: original.threadId || null,
    from: { name: SENDER_NAME, address: fromAddress },
    to, cc,
    subject,
    date: nowIso,
    snippet: bodyText.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS),
    bodyText,
    hasHtmlPart: false,
    attachments: [],
    // A message you sent is read and is not itself awaiting an answer —
    // same values the mock stamps.
    flags: { seen: true, answered: false, flagged: false },
    inReplyTo: original.messageId || null,
    relatedOrderId: original.relatedOrderId || null,
  };

  try {
    const item = { ...baseItem(), PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(newMessageId)), ...sent };
    delete item.status; // baseItem() stamps status:undefined — mail items have no status
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(messageId)) },
      ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: "SET #flags.#answered = :true, #flags.#seen = :true",
      ExpressionAttributeNames: { "#flags": "flags", "#answered": "answered", "#seen": "seen" },
      ExpressionAttributeValues: { ":true": true },
    }));
  } catch (err) {
    console.error("send-reply: sent OK but local write failed", err.name, err.message);
    return response(200, { sent, list: null, warning: "Reply was sent but the mailbox record could not be updated." });
  }

  return response(200, { sent, list: await listEnvelopes(mailboxId) });
};

/* ---- helpers ---- */

// "Re: x" once, never "Re: Re: x". Matches the mock's /^re:/i test but
// also tolerates the localized/repeated prefixes real mail arrives with.
function replySubject(subject) {
  const s = String(subject || "").trim() || "(no subject)";
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

// RFC 5322 §3.6.4: References is the original's References chain with its
// Message-ID appended. ingest-inbound.js doesn't persist the inbound
// References header (only the derived threadId), so for a first reply
// this is just the original's Message-ID — correct, if shorter than a
// full-fidelity chain. Persisting inbound `references` is the follow-up
// that would deepen it.
function buildReferences(original) {
  const refs = [];
  if (Array.isArray(original.references)) refs.push(...original.references);
  else if (original.references) refs.push(original.references);
  if (original.messageId && !refs.includes(original.messageId)) refs.push(original.messageId);
  return refs;
}

function normalizeCc(cc) {
  if (!Array.isArray(cc)) return [];
  return cc
    .map((a) => (typeof a === "string" ? { name: "", address: a } : a || {}))
    .map((a) => ({ name: String(a.name || ""), address: String(a.address || "").trim().toLowerCase() }))
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address));
}

// Unset ALLOWED_RECIPIENTS = production = no restriction. See header.
function isRecipientAllowed(address) {
  if (!ALLOWED_RECIPIENTS.length) return true;
  return ALLOWED_RECIPIENTS.includes(address);
}

// SES throttling/service faults are genuinely ours (5xx); everything else
// — rejected addresses, sandbox restrictions, bad MIME — is a 400 the
// caller can act on.
function sesStatusFor(err) {
  const name = err && err.name;
  if (name === "Throttling" || name === "ThrottlingException" || name === "ServiceUnavailable") return 503;
  if (name === "InternalFailure") return 502;
  return 400;
}

// RFC 2047 encoded-word for any header value with non-ASCII (customer
// names and subjects routinely have it). Plain ASCII passes through
// untouched so the common case stays readable in raw MIME.
function encodeHeaderValue(value) {
  const v = String(value || "");
  if (!v) return "";
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function formatAddress(a) {
  const address = String(a.address || "");
  const name = String(a.name || "").trim();
  if (!name) return address;
  return `${encodeHeaderValue(name).includes("=?") ? encodeHeaderValue(name) : `"${name.replace(/"/g, "")}"`} <${address}>`;
}

// Header injection guard: a CR/LF smuggled into a subject or display name
// would let a caller append arbitrary headers (Bcc, a second To) to the
// raw message. Strip them from every header value, always.
function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ");
}

function buildRawMessage({ from, to, cc, subject, bodyText, newMessageId, inReplyTo, references, date }) {
  const headers = [
    `From: ${sanitizeHeader(formatAddress(from))}`,
    `To: ${sanitizeHeader(to.map(formatAddress).join(", "))}`,
  ];
  if (cc.length) headers.push(`Cc: ${sanitizeHeader(cc.map(formatAddress).join(", "))}`);
  headers.push(`Subject: ${sanitizeHeader(encodeHeaderValue(subject))}`);
  headers.push(`Message-ID: ${sanitizeHeader(newMessageId)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(inReplyTo)}`);
  if (references && references.length) headers.push(`References: ${sanitizeHeader(references.join(" "))}`);
  headers.push(`Date: ${date.toUTCString()}`);
  headers.push("MIME-Version: 1.0");
  // text/plain only, matching the panel's read side — email.html renders
  // plain text and nothing else (root CLAUDE.md), so sending HTML would
  // produce mail the dashboard itself can't display.
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  // base64 sidesteps SMTP's 998-octet line limit and 7-bit transports
  // without hand-rolling quoted-printable.
  headers.push("Content-Transfer-Encoding: base64");

  const body = Buffer.from(bodyText, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

// Same envelope projection get-mail-messages.js returns, so the caller can
// repaint the list straight from this response.
async function listEnvelopes(mailboxId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": mailboxPk(mailboxId) },
    Limit: QUERY_CAP,
  }));
  const rows = (res.Items || []).filter((m) => (m.folder || "INBOX") === "INBOX");
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  return {
    mailboxId,
    folder: "INBOX",
    total: rows.length,
    unreadCount: rows.filter((m) => m.flags && m.flags.seen === false).length,
    messages: rows.slice(0, 50).map(envelopeOf),
    nextCursor: null,
  };
}

function envelopeOf(m) {
  const e = { ...m };
  delete e.bodyText; delete e.attachments;
  delete e.PK; delete e.SK; delete e.s3Ref;
  delete e.tenantId; delete e.siteId; delete e.schemaVersion; delete e.deleted; delete e.updatedAt; delete e.createdAt;
  return e;
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
