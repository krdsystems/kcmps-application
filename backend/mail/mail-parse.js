/* ============================================================
   KCMPS backend — inbound-mail MIME parsing helpers
   ============================================================
   Shared by ingest-inbound.js only (not a general ../lib/ module — it
   depends on `mailparser`, a vendored npm dependency zipped alongside this
   Lambda, unlike everything in ../lib which is pure-JS/no-deps). Kept as
   its own file so ingest-inbound.js's handler body stays readable and so
   the field-mapping logic (the part most likely to need a tweak once real
   mail is seen) is easy to find and unit-test in isolation later.

   Field mapping -> the dashboard-data.js mock contract (root CLAUDE.md's
   "Ops dashboard mock data/API" row, docs/roadmap.md ~1122-1246):

     messageId   <- RFC822 Message-ID header (parsed.messageId)
     threadId    <- References[0], else In-Reply-To, else a hash of the
                    normalized subject (strips leading Re:/Fwd:) — mirrors
                    what a real client does when a message has no thread
                    headers at all (first-time contact)
     from/to/cc  <- parsed.from.value / parsed.to.value / parsed.cc.value,
                    each already {name, address} — same shape the mock uses
     subject     <- parsed.subject
     date        <- parsed.date (falls back to Date.now() if the message
                    has no Date header at all, which does happen with some
                    autoresponders/bounces)
     snippet     <- first ~200 chars of bodyText, whitespace-collapsed
     bodyText    <- parsed.text (text/plain part)
     hasHtmlPart <- !!parsed.html
     attachments <- parsed.attachments, METADATA ONLY (filename,
                    contentType, size) — the raw bytes stay in the original
                    S3 object; see root CLAUDE.md's malware-scanning row
                    before ever adding a byte-copy/download path for these
   ============================================================ */

const crypto = require("crypto");

const MIRROR_DOMAIN = "mirror.kcmps.com";
const SNIPPET_MAX_CHARS = 200;

function hashMessageId(messageId) {
  return crypto.createHash("sha256").update(String(messageId || "")).digest("hex").slice(0, 32);
}

function normalizeSubjectForThread(subject) {
  return String(subject || "")
    .replace(/^\s*(re|fwd?)\s*:\s*/gi, "")
    .trim()
    .toLowerCase();
}

function deriveThreadId(parsed) {
  const refs = parsed.references;
  const firstRef = Array.isArray(refs) ? refs[0] : refs;
  if (firstRef) return `THR#ref#${hashMessageId(firstRef)}`;
  if (parsed.inReplyTo) return `THR#ref#${hashMessageId(parsed.inReplyTo)}`;
  const normalized = normalizeSubjectForThread(parsed.subject);
  return `THR#subj#${hashMessageId(normalized || parsed.messageId || Math.random().toString(36))}`;
}

// Every mirror.kcmps.com address seen in To/Cc, lowercased and deduped —
// each is a "mailbox" a mail item gets written under. mailparser exposes
// .to/.cc as either a single AddressObject or undefined for a single
// recipient, or an AddressObject for multiple (already merged) — .value is
// always the flat {name,address}[] either way.
function extractMailboxRecipients(parsed) {
  const addrs = []
    .concat(parsed.to && parsed.to.value || [])
    .concat(parsed.cc && parsed.cc.value || []);
  const seen = new Set();
  const out = [];
  for (const a of addrs) {
    const address = String(a.address || "").toLowerCase().trim();
    if (!address || !address.endsWith(`@${MIRROR_DOMAIN}`)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

function toAddressList(addressObject) {
  return (addressObject && addressObject.value || []).map((a) => ({
    name: a.name || "",
    address: String(a.address || "").toLowerCase(),
  }));
}

function buildSnippet(bodyText) {
  return String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS);
}

// Returns { mailboxes: string[], fields: {...} } — `fields` is everything
// that's identical across every mailbox this message gets written to;
// ingest-inbound.js spreads it once per recipient mailbox.
function toMailFields(parsed, { s3Ref }) {
  const bodyText = parsed.text || "";
  const fromList = toAddressList(parsed.from);
  const attachments = (parsed.attachments || []).map((att) => ({
    filename: att.filename || "attachment",
    contentType: att.contentType || "application/octet-stream",
    size: typeof att.size === "number" ? att.size : (att.content ? att.content.length : 0),
  }));
  const dateIso = (parsed.date instanceof Date && !isNaN(parsed.date)) ? parsed.date.toISOString() : new Date().toISOString();

  return {
    mailboxes: extractMailboxRecipients(parsed),
    fields: {
      messageId: parsed.messageId || `<generated-${hashMessageId(s3Ref + dateIso)}@kcmps.com>`,
      threadId: deriveThreadId(parsed),
      from: fromList[0] || { name: "", address: "" },
      to: toAddressList(parsed.to),
      cc: toAddressList(parsed.cc),
      subject: parsed.subject || "(no subject)",
      date: dateIso,
      snippet: buildSnippet(bodyText),
      bodyText,
      hasHtmlPart: !!parsed.html,
      attachments,
      flags: { seen: false, answered: false, flagged: false },
      folder: "INBOX",
      s3Ref,
    },
  };
}

module.exports = { MIRROR_DOMAIN, hashMessageId, deriveThreadId, extractMailboxRecipients, toMailFields, buildSnippet, normalizeSubjectForThread };
