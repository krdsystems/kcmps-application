/* ============================================================
   KCMPS backend — shared shop mailboxes: access model + inbound routing
   ============================================================
   A PURE module — no AWS SDK, no env reads, no I/O — so it unit-tests with
   the rest of backend/lib/ (`node --test backend/lib/lib.test.js`). Every
   backend/mail/*.js read/write handler calls canAccessMailbox(); none of
   them re-derive the rules locally, so the model can't drift between
   endpoints. The roadmap's warning still holds: getMailboxes decides
   *visibility*, but every other handler must re-check — never trust the
   client's mailboxId.

   ------------------------------------------------------------
   OWNER SCOPE DECISION, 2026-08-06: SHARED MAILBOXES ONLY
   ------------------------------------------------------------
   Personal staff-mailbox mirroring is PERMANENTLY OUT OF SCOPE and the
   code path for it has been deleted, not left dormant. A forward-based
   mirror is a one-way copy: it can never reconcile sent mail or read
   state with the real mailbox, so a staffer would see a permanently
   diverging shadow of their own inbox. That is the wrong architecture for
   an individual's mail, and no amount of polish fixes it.

   The previous implementation carried a `PersonalMailboxes` stack
   parameter holding {mailboxId: cognitoSub}. It is gone. Do not
   reintroduce it "inert, just in case" — a dormant parameter is an
   invitation for a future dev to repopulate it and silently revive a
   rejected design. If personal mailboxes are ever genuinely wanted, the
   only correct path is real two-way IMAP/OAuth (Google Workspace / M365),
   which is a paid-seat decision, not a code change. See docs/roadmap.md.

   ------------------------------------------------------------
   ONE REAL MAILBOX, THREE ADDRESSES
   ------------------------------------------------------------
   In Spacemail there is exactly ONE mailbox, admin@kcmps.com.
   order@kcmps.com and info@kcmps.com are ALIASES that deliver into it.
   Both aliases are publicly committed and may never be retired:
   order@ is ORDER_EMAIL in website/store.js + orders-data.js; info@ is in
   the site footer, the JSON-LD schema, and the refunds policy.

   So the relay is ONE Spacemail forwarding rule — admin@kcmps.com to the
   single mirror address below — and ingest-inbound.js splits that one
   stream back into three LOGICAL mailboxes by original recipient. There
   is no per-alias forwarding rule and there must not be: Spacemail
   delivers all three aliases into one mailbox, so a per-alias rule has
   nothing to attach to.

   ------------------------------------------------------------
   mailboxId IS THE REAL ADDRESS
   ------------------------------------------------------------
   `order@kcmps.com`, never `order@mirror.kcmps.com`. It is what staff see
   in the UI and what these access rules key on; mirror.kcmps.com is
   plumbing (an SES *receiving* identity) and leaking it into the data
   model made every mailbox tab read as an address no customer has ever
   written to. An earlier build keyed on the mirror address; those
   MAILBOX#*@mirror.kcmps.com items were throwaway test data.

   ------------------------------------------------------------
   WHY `Staff` IS **NOT** ON THE SHARED MAILBOXES (owner decision)
   ------------------------------------------------------------
   An earlier pass granted `Staff` Sales-equivalent reach, reasoning that
   ./auth.js calls it the pre-role-split group every founder is actually
   in, so a literal matrix would deny the feature's only current users.
   That was reverted deliberately (commit 49dad04).

   The reason is what `Staff` *means*: the docs define it as "dashboard
   access only" — the tier that says you may open the building, with
   Production/Sales/Finance held in reserve for the first non-founder
   hire. Granting mail on the tier means every future dashboard user
   silently inherits the right to read customer correspondence, including
   a part-time production assistant who only needs the job queue. That is
   capability leaking out of the access tier instead of coming from a
   role, and the moment it bites is the first hire — precisely when
   nobody remembers this rule exists.

   Capability comes from roles ONLY. Founders get mail access by being in
   `Admin` (or `Sales`), not by being in `Staff`. DO NOT re-add
   ROLES.STAFF to the arrays below.

   FAIL CLOSED: an unknown mailboxId is denied, not defaulted. The system
   mailboxes routing falls back to (unrouted@/unparseable@/quarantine@)
   are therefore listed explicitly, Admin-only and never sendable, rather
   than being reachable by accident or auto-created on the fly.
   ============================================================ */

const { ROLES, getGroups } = require("./auth");

// Inbound mail lands on mirror.kcmps.com (the SES *receiving* identity) at
// ONE address; outbound replies go from the verified *sending* identity,
// kcmps.com. Two different SES identities on purpose — see
// backend/infra/ses-relay.cfn.yaml.
const MIRROR_DOMAIN = "mirror.kcmps.com";
const SENDING_DOMAIN = "kcmps.com";

/* THE single address Spacemail forwards admin@kcmps.com to, and the ONLY
   recipient the SES receipt rule accepts (the domain catchall was deleted
   — see backend/infra/README.md "Inbound hardening"). Everything else on
   mirror.kcmps.com is rejected at SMTP time, which removes the entire
   "guess a local part and inject a message into the staff UI" surface. */
const MIRROR_ADDRESS = `shop@${MIRROR_DOMAIN}`;

const UNROUTED_MAILBOX = "unrouted@kcmps.com";
const UNPARSEABLE_MAILBOX = "unparseable@kcmps.com";
const QUARANTINE_MAILBOX = "quarantine@kcmps.com";

// The shared shop mailboxes, keyed by REAL address. `roles` is the
// allow-list; `canSend` marks which ones send-reply.js will accept a reply
// for. System mailboxes are read-only — nobody should ever reply *from* an
// address that only exists because routing, parsing, or scanning failed
// (unrouted@/unparseable@/quarantine@ are not real deliverable addresses).
const MAILBOX_ACCESS = Object.freeze({
  "order@kcmps.com": Object.freeze({
    id: "order@kcmps.com",
    address: "order@kcmps.com",
    label: "Orders",
    kind: "shared",
    canSend: true,
    roles: Object.freeze([ROLES.SALES, ROLES.FINANCE, ROLES.ADMIN]),
  }),
  "info@kcmps.com": Object.freeze({
    id: "info@kcmps.com",
    address: "info@kcmps.com",
    label: "General enquiries",
    kind: "shared",
    canSend: true,
    roles: Object.freeze([ROLES.SALES, ROLES.ADMIN]),
  }),
  "admin@kcmps.com": Object.freeze({
    id: "admin@kcmps.com",
    address: "admin@kcmps.com",
    label: "Admin",
    kind: "shared",
    canSend: true,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
  [UNROUTED_MAILBOX]: Object.freeze({
    id: UNROUTED_MAILBOX,
    address: UNROUTED_MAILBOX,
    label: "Unrouted",
    kind: "system",
    canSend: false,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
  [UNPARSEABLE_MAILBOX]: Object.freeze({
    id: UNPARSEABLE_MAILBOX,
    address: UNPARSEABLE_MAILBOX,
    label: "Unparseable",
    kind: "system",
    canSend: false,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
  [QUARANTINE_MAILBOX]: Object.freeze({
    id: QUARANTINE_MAILBOX,
    address: QUARANTINE_MAILBOX,
    label: "Quarantined",
    kind: "system",
    canSend: false,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
});

// The three real aliases inbound mail may be routed to. Deliberately NOT
// derived from MAILBOX_ACCESS — the system mailboxes must never be a
// routing target that a sender can address their way into.
const ROUTABLE_ALIASES = Object.freeze(["admin@kcmps.com", "order@kcmps.com", "info@kcmps.com"]);

function normalizeMailboxId(mailboxId) {
  return String(mailboxId || "").trim().toLowerCase();
}

/* The one authorization decision. `claims` MUST be the verified claims
   object (./auth.js's extractClaims(event)). Purely group-based now that
   personal mailboxes are gone — there is no sub-matching path left, and
   therefore no way for a client-supplied identifier to influence it at
   all. Returns a plain boolean. */
function canAccessMailbox(claims, mailboxId) {
  if (!claims) return false;
  const id = normalizeMailboxId(mailboxId);
  if (!id) return false;

  const groups = getGroups(claims);
  if (!groups.length) return false;

  // Customer never reaches ANY staff mailbox. Redundant with the role
  // matrix below (no mailbox lists ROLES.CUSTOMER) but kept explicit and
  // first: it is the check a future edit to the matrix must not be able to
  // accidentally undo.
  if (!groups.some((g) => g !== ROLES.CUSTOMER)) return false;

  const mb = MAILBOX_ACCESS[id];
  if (!mb) return false; // unknown mailbox — fail closed
  return mb.roles.some((r) => groups.includes(r));
}

/* What get-mailboxes.js renders tabs from: every mailbox this caller may
   actually open. Visibility only — every other handler still re-checks
   with canAccessMailbox(). */
function visibleMailboxes(claims) {
  if (!claims) return [];
  const out = [];
  for (const mb of Object.values(MAILBOX_ACCESS)) {
    if (canAccessMailbox(claims, mb.id)) {
      const { roles, ...pub } = mb; // never leak the allow-list to the client
      out.push(pub);
    }
  }
  return out;
}

function isMailbox(mailboxId) {
  return !!MAILBOX_ACCESS[normalizeMailboxId(mailboxId)];
}

function canSendFrom(mailboxId) {
  const mb = MAILBOX_ACCESS[normalizeMailboxId(mailboxId)];
  return !!mb && mb.canSend === true;
}

/* mailboxId is already the real, verified-sending-identity address, so
   this is now near-identity — but it stays a function, and stays the ONLY
   thing send-reply.js derives its From: from, so a caller can never send
   from an arbitrary address. Returns null for anything that isn't a
   sendable shared mailbox: system mailboxes, unknown ids, and (still)
   anything on the mirror domain, which SES will not send from. */
function sendAddressFor(mailboxId) {
  const id = normalizeMailboxId(mailboxId);
  const mb = MAILBOX_ACCESS[id];
  if (!mb || mb.canSend !== true) return null;
  if (!id.endsWith(`@${SENDING_DOMAIN}`)) return null;
  return id;
}

/* ------------------------------------------------------------
   INBOUND ROUTING
   ------------------------------------------------------------
   ONE inbound stream (everything Spacemail forwards from the single
   admin@kcmps.com mailbox) has to be split back into the three logical
   aliases. The delivery address is useless for this — it is always the
   one MIRROR_ADDRESS — so routing is done on the ORIGINAL recipient.

   HEADER PREFERENCE, AND WHY IT IS NOT `To:`. A message BCC'd to
   order@kcmps.com has no To:/Cc: header naming it at all; routing on
   To:/Cc: would mis-file it (in practice: dump it in unrouted@, where
   nobody is watching). A forwarder-stamped envelope header carries the
   real delivery target instead. FORWARDER_HEADERS below is tried in
   order, first hit wins; To:/Cc: is the LAST resort, not the primary.

   Mail matching no known alias goes to the single UNROUTED_MAILBOX. It is
   never silently dropped (the S3 object is the source of truth either
   way) and it never auto-creates a mailbox — an unknown local part must
   not be able to conjure a new tab in the staff UI.
   ------------------------------------------------------------ */

/* Priority order. `Delivered-To` and `X-Original-To` are what the common
   forwarding MTAs (Postfix, Google) stamp; `X-Envelope-To`/`Envelope-To`/
   `X-Forwarded-To` cover the rest; `Resent-To` is the RFC 5322 resend
   header. See backend/infra/README.md for which of these Spacemail was
   actually observed to stamp. */
const FORWARDER_HEADERS = Object.freeze([
  "delivered-to",
  "x-original-to",
  "x-envelope-to",
  "envelope-to",
  "x-forwarded-to",
  "x-forwarded-for",
  "resent-to",
]);

function isRoutableAlias(address) {
  return ROUTABLE_ALIASES.includes(normalizeMailboxId(address));
}

/* AWS infrastructure notices, kept OUT of the customer-correspondence
   view. Both SNS topics that alert this shop (kcmps-ses-bounce-complaint,
   kcmps-ops-alerts — 37 CloudWatch alarms) are subscribed to
   admin@kcmps.com, which is the exact mailbox being forwarded to the
   mirror. Without this, every bounce notice and every alarm state change
   lands in the dashboard's Admin mailbox next to real customer mail.

   The PRIMARY fix is a Spacemail-side filter excluding these senders from
   the forward — see backend/infra/README.md. This is the defensive
   backstop for a missing or mistyped filter, deliberately a two-address
   exact match and NOT a general filtering framework: the moment this
   becomes a rules engine, mail starts disappearing for reasons nobody can
   reconstruct. Matched mail is routed to unrouted@ — still visible to an
   Admin who goes looking, just not in the correspondence stream. */
const INFRA_NOTICE_SENDERS = Object.freeze([
  "no-reply@sns.amazonaws.com",  // SNS email notifications (AWS's documented sender)
  "no-reply-aws@amazon.com",     // confirmed on a real SES notice in the inbound bucket
]);

function isInfrastructureNotice(fromAddress) {
  return INFRA_NOTICE_SENDERS.includes(normalizeMailboxId(fromAddress));
}

/* Pure routing decision.
     forwardedTo — every address found in FORWARDER_HEADERS, in priority order
     toCc        — every address in To: + Cc:
     from        — the message's From: address, for the infra-notice backstop
   Returns { mailboxes: string[], routedBy: "forwarder"|"to-cc"|"unrouted"|"infra-notice" }.
   mailboxes is never empty. */
function resolveMailboxes({ forwardedTo = [], toCc = [], from = "" } = {}) {
  if (isInfrastructureNotice(from)) {
    return { mailboxes: [UNROUTED_MAILBOX], routedBy: "infra-notice" };
  }

  const fromForwarder = dedupeAliases(forwardedTo);
  if (fromForwarder.length) return { mailboxes: fromForwarder, routedBy: "forwarder" };

  const fromToCc = dedupeAliases(toCc);
  if (fromToCc.length) return { mailboxes: fromToCc, routedBy: "to-cc" };

  return { mailboxes: [UNROUTED_MAILBOX], routedBy: "unrouted" };
}

function dedupeAliases(addresses) {
  const seen = new Set();
  const out = [];
  for (const a of addresses || []) {
    const id = normalizeMailboxId(a);
    if (!isRoutableAlias(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------
   SES AUTHENTICATION VERDICTS
   ------------------------------------------------------------
   HARD-REJECT VIRUS AND SPAM. Those are SES's own scanner saying the
   message is hostile; it must not be written into a staff mailbox as
   ordinary mail.

   DO NOT HARD-REJECT ON SPF. Forwarding breaks SPF by design — the
   forwarder relays with its own envelope sender from its own IPs, so the
   original domain's SPF record will not authorize it. Rejecting on SPF
   here would discard ALL legitimate forwarded mail, which is to say every
   message this relay exists to carry. The SPF verdict is recorded and
   surfaced, never enforced.

   DKIM IS THE POSITIVE SIGNAL. DKIM signatures survive forwarding (the
   body hash and signed headers are unchanged), so a DKIM pass is the one
   verdict that still means what it claims after a hop. Treat it as
   confirmation, and its absence as "unverified", not as "hostile" —
   plenty of small senders still do not sign.

   EXPLICITLY NOT ARC. Authenticated Received Chain is the textbook answer
   for authenticating forwarded mail, and we are deliberately not building
   on it: the IETF rechartered the DMARC working group on 2026-04-16 to
   move ARC to Historic by November 2026. No ARC validation, no ARC
   headers, not now and not as a follow-up.
   ------------------------------------------------------------ */

const VERDICT_PASS = "PASS";
const VERDICT_FAIL = "FAIL";
const VERDICT_UNKNOWN = "UNKNOWN";

function normalizeVerdict(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return VERDICT_UNKNOWN;
  if (s === "PASS") return VERDICT_PASS;
  if (s === "FAIL" || s === "PERMFAIL" || s === "SOFTFAIL" || s === "HARDFAIL") return VERDICT_FAIL;
  if (s === "GRAY" || s === "GREY" || s === "PROCESSING_FAILED" || s === "DISABLED") return VERDICT_UNKNOWN;
  return s; // preserve anything unexpected verbatim rather than laundering it into PASS
}

/* Returns { verdicts: {spf,dkim,spam,virus}, quarantine: bool, reason: string|null,
             authenticated: bool }.
   `quarantine` true means: do not write this into a shared mailbox. */
function assessVerdicts(raw) {
  const verdicts = {
    spf: normalizeVerdict(raw && raw.spfVerdict),
    dkim: normalizeVerdict(raw && raw.dkimVerdict),
    spam: normalizeVerdict(raw && raw.spamVerdict),
    virus: normalizeVerdict(raw && raw.virusVerdict),
  };

  let reason = null;
  if (verdicts.virus !== VERDICT_PASS && verdicts.virus !== VERDICT_UNKNOWN) {
    reason = "SES virus scan did not pass";
  } else if (verdicts.spam !== VERDICT_PASS && verdicts.spam !== VERDICT_UNKNOWN) {
    reason = "SES spam scan did not pass";
  }

  return {
    verdicts,
    quarantine: !!reason,
    reason,
    // The positive signal, surfaced to staff as "this really is from who it
    // says". SPF deliberately plays no part — see the block comment above.
    authenticated: verdicts.dkim === VERDICT_PASS,
  };
}

module.exports = {
  MIRROR_DOMAIN,
  MIRROR_ADDRESS,
  SENDING_DOMAIN,
  MAILBOX_ACCESS,
  ROUTABLE_ALIASES,
  UNROUTED_MAILBOX,
  UNPARSEABLE_MAILBOX,
  QUARANTINE_MAILBOX,
  FORWARDER_HEADERS,
  normalizeMailboxId,
  canAccessMailbox,
  visibleMailboxes,
  isMailbox,
  canSendFrom,
  sendAddressFor,
  isRoutableAlias,
  isInfrastructureNotice,
  INFRA_NOTICE_SENDERS,
  resolveMailboxes,
  normalizeVerdict,
  assessVerdicts,
};
