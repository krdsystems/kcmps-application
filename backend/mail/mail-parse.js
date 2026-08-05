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
const { FORWARDER_HEADERS, resolveMailboxes, assessVerdicts } = require("../lib");

const MIRROR_DOMAIN = "mirror.kcmps.com";
const SNIPPET_MAX_CHARS = 200;

/* The hostname the `Received:` chain should mention if the message really
   came via Spacemail's forwarder. Config, not code — set
   EXPECTED_FORWARDER_HOST on the ingest Lambda. Unset means "unknown", and
   the UI renders no provenance claim at all rather than a false negative. */
const EXPECTED_FORWARDER_HOST = (process.env.EXPECTED_FORWARDER_HOST || "").trim().toLowerCase();

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

/* ------------------------------------------------------------
   ROUTING + PROVENANCE HEADER EXTRACTION
   ------------------------------------------------------------
   Everything below only *extracts* raw values out of the parsed MIME. The
   decisions (which mailbox, quarantine or not) live in ../lib/mail.js's
   resolveMailboxes()/assessVerdicts(), which are pure and unit-tested —
   don't reimplement either of them here.
   ------------------------------------------------------------ */

// Case-insensitive header read. mailparser exposes parsed.headers as a Map
// keyed by lowercased header name; a repeated header comes back as an
// array. Always returns a flat string[].
function headerValues(parsed, name) {
  const h = parsed && parsed.headers;
  if (!h || typeof h.get !== "function") return [];
  const v = h.get(String(name).toLowerCase());
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => (typeof x === "string" ? x : (x && x.text) || String(x || ""))).filter(Boolean);
}

const ADDRESS_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function addressesIn(text) {
  return (String(text || "").match(ADDRESS_RE) || []).map((a) => a.toLowerCase());
}

/* Every address found in the forwarder-stamped envelope headers, in
   ../lib/mail.js's FORWARDER_HEADERS priority order. This is what routing
   PREFERS over To:/Cc: — a message BCC'd to order@kcmps.com has no To:
   header naming it, and would otherwise be mis-filed. Returns raw
   addresses; the alias filtering is resolveMailboxes()' job. */
function extractForwardedRecipients(parsed) {
  const out = [];
  for (const name of FORWARDER_HEADERS) {
    for (const raw of headerValues(parsed, name)) out.push(...addressesIn(raw));
  }
  return out;
}

// Every address in To: + Cc:, lowercased. The fallback routing input.
function extractToCcRecipients(parsed) {
  return []
    .concat(parsed.to && parsed.to.value || [])
    .concat(parsed.cc && parsed.cc.value || [])
    .map((a) => String(a.address || "").toLowerCase().trim())
    .filter(Boolean);
}

/* SES's four verdicts, read off the headers SES stamps onto the raw MIME
   it writes to S3.

   WHY HEADERS AND NOT THE RECEIPT PAYLOAD: the receipt rule uses an S3
   action and this Lambda is triggered by the S3 ObjectCreated event, so
   there is no SES `receipt` object in the event at all — only the message
   SES already annotated. SES stamps `X-SES-Spam-Verdict` and
   `X-SES-Virus-Verdict` directly, and folds SPF/DKIM into
   `Authentication-Results` (plus a standalone `Received-SPF`). Confirmed
   against real messages in kcmps-inbound-mail-est-2026.

   Missing header -> "" -> normalizeVerdict() yields UNKNOWN, which
   assessVerdicts() treats as "record it, don't quarantine on it". Only an
   explicit non-PASS virus/spam verdict quarantines — see that function. */
function extractSesVerdicts(parsed) {
  const authResults = headerValues(parsed, "authentication-results").join(" ; ");
  return {
    spamVerdict: firstWord(headerValues(parsed, "x-ses-spam-verdict")[0]),
    virusVerdict: firstWord(headerValues(parsed, "x-ses-virus-verdict")[0]),
    spfVerdict: verdictFromAuthResults(authResults, "spf") || spfFromReceivedSpf(headerValues(parsed, "received-spf")[0]),
    dkimVerdict: verdictFromAuthResults(authResults, "dkim"),
  };
}

function firstWord(s) {
  return String(s || "").trim().split(/\s+/)[0] || "";
}

// `Authentication-Results:` is a semicolon-separated list of
// `method=result` clauses with optional trailing properties, e.g.
// "spf=pass (spfCheck: ...) client-ip=...; dkim=pass header.i=@kcmps.com".
// A message can carry MULTIPLE dkim= clauses (one per signature); a single
// pass is a pass, so "any pass wins" is the correct fold here.
function verdictFromAuthResults(text, method) {
  const re = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, "gi");
  let m, seen = null;
  while ((m = re.exec(String(text || "")))) {
    const v = m[1].toLowerCase();
    if (v === "pass") return "pass";
    if (!seen) seen = v;
  }
  return seen || "";
}

function spfFromReceivedSpf(text) {
  return String(text || "").trim().split(/\s+/)[0].toLowerCase() || "";
}

/* Did the message actually traverse the forwarder we expect? Scans the
   `Received:` chain for the expected hostname/domain. A false here doesn't
   block anything — it is surfaced in the staff UI so a message that
   arrived by some other path is visibly odd rather than invisibly
   trusted. */
function receivedViaExpectedForwarder(parsed, expectedHost) {
  const needle = String(expectedHost || "").trim().toLowerCase();
  if (!needle) return null; // not configured — "unknown", not "no"
  const chain = headerValues(parsed, "received").join("\n").toLowerCase();
  return chain.includes(needle);
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

  const forwardedTo = extractForwardedRecipients(parsed);
  const toCc = extractToCcRecipients(parsed);
  const routing = resolveMailboxes({ forwardedTo, toCc, from: (fromList[0] || {}).address || "" });
  const assessment = assessVerdicts(extractSesVerdicts(parsed));

  return {
    mailboxes: routing.mailboxes,
    routedBy: routing.routedBy,
    quarantine: assessment.quarantine,
    quarantineReason: assessment.reason,
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
      /* PROVENANCE — persisted on every message item and rendered in
         website/dashboard/email.html so staff can see when a message did
         not arrive by the expected path. All four verdicts are stored
         even though only virus/spam gate anything (see assessVerdicts). */
      provenance: {
        verdicts: assessment.verdicts,
        authenticated: assessment.authenticated,
        routedBy: routing.routedBy,
        // The original recipient(s) we actually routed on, for the "why is
        // this in this mailbox" question.
        deliveredTo: dedupeStrings(routing.routedBy === "to-cc" ? toCc : forwardedTo).slice(0, 5),
        viaExpectedForwarder: receivedViaExpectedForwarder(parsed, EXPECTED_FORWARDER_HOST),
        expectedForwarder: EXPECTED_FORWARDER_HOST || null,
      },
    },
  };
}

function dedupeStrings(list) {
  return [...new Set((list || []).map((s) => String(s || "").toLowerCase()).filter(Boolean))];
}

module.exports = {
  MIRROR_DOMAIN,
  EXPECTED_FORWARDER_HOST,
  hashMessageId,
  deriveThreadId,
  headerValues,
  extractForwardedRecipients,
  extractToCcRecipients,
  extractSesVerdicts,
  receivedViaExpectedForwarder,
  toMailFields,
  buildSnippet,
  normalizeSubjectForThread,
};
