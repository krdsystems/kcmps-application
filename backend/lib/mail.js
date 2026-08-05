/* ============================================================
   KCMPS backend — per-mailbox access model (SES relay / staff mail panel)
   ============================================================
   The matrix docs/roadmap.md (~608-617) specifies for the staff mail
   panel, encoded here as a PURE module — no AWS SDK, no env reads, no I/O —
   so it unit-tests with the rest of backend/lib/ (`node --test
   backend/lib/lib.test.js`). Every backend/mail/*.js read/write handler
   calls canAccessMailbox(); none of them re-derive the rules locally, so
   the model can't drift between endpoints. That was the explicit warning
   in the roadmap: "getMailboxes decides *visibility*, but every other
   handler must re-check — never trust the client's mailboxId."

   THE SHARPEST TRAP (roadmap's word, not ours): personal-mailbox
   ownership is matched on the VERIFIED JWT `sub` — claims.sub, off the
   object API Gateway's JWT authorizer already validated against Cognito's
   JWKS. It is never read from a request body, query string, or path
   parameter. Accepting a client-supplied sub would let any staff member
   read (and, via send-reply.js, send as) anyone else's personal mailbox.
   canAccessMailbox() takes `claims`, not a bare sub string, specifically
   so a caller cannot accidentally pass one it made up.

   FAIL CLOSED: an unknown mailboxId is denied, not defaulted. Mailboxes
   inbound routing invents on the fly (ingest-inbound.js's
   catchall@/unparseable@) are therefore listed explicitly below, Admin-
   only, rather than being reachable by accident.

   WHY `Staff` APPEARS ON THE SHARED MAILBOXES. The roadmap matrix is
   written in terms of the post-split roles (Sales/Finance/Production/
   Admin), but ../lib/auth.js's header is clear that `Staff` is the
   pre-role-split group *every founder is actually in today* — a
   first-class member of STAFF_ROLES, not a legacy bolt-on. Implementing
   the matrix literally would deny the only real users this feature has.
   So `Staff` is granted the same shared-mailbox reach as Sales (order@ +
   info@) and deliberately NOT admin@/catchall@/unparseable@. When the
   first non-founder hire makes the finer roles real, deleting ROLES.STAFF
   from the two arrays below is the entire change.
   ============================================================ */

const { ROLES, getGroups } = require("./auth");

// Inbound mail lands on mirror.kcmps.com (the SES *receiving* identity);
// outbound replies must be sent from the verified *sending* identity,
// kcmps.com. Two different SES identities on purpose — see
// backend/infra/ses-relay.cfn.yaml.
const MIRROR_DOMAIN = "mirror.kcmps.com";
const SENDING_DOMAIN = "kcmps.com";

// The shared shop mailboxes. `roles` is the allow-list; `canSend` marks
// which ones send-reply.js will accept a reply for. Operational mailboxes
// (catchall/unparseable) are read-only — nobody should ever reply *from*
// an address that only exists because routing failed.
const MAILBOX_ACCESS = Object.freeze({
  "order@mirror.kcmps.com": Object.freeze({
    id: "order@mirror.kcmps.com",
    address: "order@mirror.kcmps.com",
    label: "Orders",
    kind: "shared",
    canSend: true,
    roles: Object.freeze([ROLES.SALES, ROLES.FINANCE, ROLES.ADMIN, ROLES.STAFF]),
  }),
  "info@mirror.kcmps.com": Object.freeze({
    id: "info@mirror.kcmps.com",
    address: "info@mirror.kcmps.com",
    label: "General enquiries",
    kind: "shared",
    canSend: true,
    roles: Object.freeze([ROLES.SALES, ROLES.ADMIN, ROLES.STAFF]),
  }),
  "admin@mirror.kcmps.com": Object.freeze({
    id: "admin@mirror.kcmps.com",
    address: "admin@mirror.kcmps.com",
    label: "Admin",
    kind: "shared",
    canSend: true,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
  "catchall@mirror.kcmps.com": Object.freeze({
    id: "catchall@mirror.kcmps.com",
    address: "catchall@mirror.kcmps.com",
    label: "Unrouted",
    kind: "system",
    canSend: false,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
  "unparseable@mirror.kcmps.com": Object.freeze({
    id: "unparseable@mirror.kcmps.com",
    address: "unparseable@mirror.kcmps.com",
    label: "Unparseable",
    kind: "system",
    canSend: false,
    roles: Object.freeze([ROLES.ADMIN]),
  }),
});

function normalizeMailboxId(mailboxId) {
  return String(mailboxId || "").trim().toLowerCase();
}

/* Personal mailboxes are NOT hardcoded — there is one per staff member and
   the set changes with hiring, so it's configuration (a PERSONAL_MAILBOXES
   env var holding a JSON object) rather than code. This parser is pure and
   never throws: malformed config yields an empty registry, which fails
   closed (no personal mailbox is accessible) instead of crashing every mail
   request. Shape: { "<mailboxId>": "<cognito sub>" }. */
function parsePersonalMailboxes(raw) {
  if (!raw) return {};
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [mailboxId, ownerSub] of Object.entries(obj)) {
    const id = normalizeMailboxId(mailboxId);
    const sub = String(ownerSub || "").trim();
    // Both halves must be non-empty — an entry with a blank sub would
    // otherwise match a claims object that also has no sub.
    if (id && sub) out[id] = sub;
  }
  return out;
}

function personalMailboxDescriptor(mailboxId, ownerSub) {
  const id = normalizeMailboxId(mailboxId);
  return {
    id,
    address: id,
    label: id.split("@")[0] || id,
    kind: "personal",
    canSend: true,
    ownerSub,
  };
}

/* The one authorization decision. `claims` MUST be the verified claims
   object (../lib/auth.js's extractClaims(event)); `personalMailboxes` is a
   registry from parsePersonalMailboxes(). Returns a plain boolean. */
function canAccessMailbox(claims, mailboxId, personalMailboxes) {
  if (!claims) return false;
  const id = normalizeMailboxId(mailboxId);
  if (!id) return false;

  const groups = getGroups(claims);
  if (!groups.length) return false;

  const registry = personalMailboxes && typeof personalMailboxes === "object" ? personalMailboxes : {};

  // Customer never reaches ANY staff mailbox — checked first, before the
  // personal-mailbox lookup. Ordering is load-bearing and a unit test
  // caught it the wrong way round: a customer account whose `sub` also
  // appears in the personal registry (a staffer who once ordered from the
  // shop, or a stale registry entry) would otherwise be let straight in
  // by the sub match, since that branch never looked at groups at all.
  if (!groups.some((g) => g !== ROLES.CUSTOMER)) return false;

  // Personal mailbox: owner only, matched on the verified sub. Checked
  // BEFORE the group matrix so no role — not even Admin — can read a
  // colleague's personal mail by group membership alone.
  if (Object.prototype.hasOwnProperty.call(registry, id)) {
    const sub = claims.sub ? String(claims.sub) : "";
    return !!sub && sub === registry[id];
  }

  const mb = MAILBOX_ACCESS[id];
  if (!mb) return false; // unknown mailbox — fail closed
  return mb.roles.some((r) => groups.includes(r));
}

/* What get-mailboxes.js renders tabs from: every shared mailbox this
   caller may open, plus their own personal mailbox if one is registered.
   Visibility only — every other handler still re-checks with
   canAccessMailbox(). */
function visibleMailboxes(claims, personalMailboxes) {
  if (!claims) return [];
  const registry = personalMailboxes && typeof personalMailboxes === "object" ? personalMailboxes : {};
  const out = [];

  for (const mb of Object.values(MAILBOX_ACCESS)) {
    if (canAccessMailbox(claims, mb.id, registry)) {
      const { roles, ...pub } = mb; // never leak the allow-list to the client
      out.push(pub);
    }
  }

  // Route the personal entries through canAccessMailbox() too rather than
  // re-testing `ownerSub === sub` here — that duplicate check is exactly
  // how the Customer-ordering bug above would have survived in one place
  // after being fixed in the other.
  for (const [id, ownerSub] of Object.entries(registry)) {
    if (canAccessMailbox(claims, id, registry)) out.push(personalMailboxDescriptor(id, ownerSub));
  }
  return out;
}

function isMailbox(mailboxId, personalMailboxes) {
  const id = normalizeMailboxId(mailboxId);
  const registry = personalMailboxes && typeof personalMailboxes === "object" ? personalMailboxes : {};
  return !!MAILBOX_ACCESS[id] || Object.prototype.hasOwnProperty.call(registry, id);
}

function canSendFrom(mailboxId, personalMailboxes) {
  const id = normalizeMailboxId(mailboxId);
  const registry = personalMailboxes && typeof personalMailboxes === "object" ? personalMailboxes : {};
  if (Object.prototype.hasOwnProperty.call(registry, id)) return true;
  const mb = MAILBOX_ACCESS[id];
  return !!mb && mb.canSend === true;
}

/* mirror.kcmps.com is a RECEIVING identity — SES will not send from it.
   A reply from the order@ mailbox goes out as order@kcmps.com, on the
   verified sending identity. Returns null for anything that isn't a
   mirror-domain address, so a caller can't be tricked into sending from
   an arbitrary domain. */
function sendAddressFor(mailboxId) {
  const id = normalizeMailboxId(mailboxId);
  const suffix = `@${MIRROR_DOMAIN}`;
  if (!id.endsWith(suffix)) return null;
  const local = id.slice(0, -suffix.length);
  if (!local) return null;
  return `${local}@${SENDING_DOMAIN}`;
}

module.exports = {
  MIRROR_DOMAIN,
  SENDING_DOMAIN,
  MAILBOX_ACCESS,
  normalizeMailboxId,
  parsePersonalMailboxes,
  canAccessMailbox,
  visibleMailboxes,
  isMailbox,
  canSendFrom,
  sendAddressFor,
};
