/* ============================================================
   KCMPS backend — Cash Book + job costing, pure logic
   ============================================================
   Everything in docs/cashbook-job-costing-plan-2026-08-18.md that can be
   decided WITHOUT touching AWS lives here: category/sign rules, the
   rollup delta math, Manila day/month key derivation, and every input
   validation. The Lambdas in backend/cashbook/ are then thin I/O shells
   around this module, and cashbook.test.js can prove the rules without a
   table.

   Same house rule as the rest of backend/lib/: NO AWS SDK, NO I/O.

   ------------------------------------------------------------
   SIGN CONVENTION (plan review finding B9) — read before adding a category
   ------------------------------------------------------------
   Amounts are stored **positive-with-direction**: a row carries
   `direction: "in" | "out"` and a POSITIVE `amountCentavos`. The sign a
   total needs is derived from `direction`, never from the amount.

   The ONE deliberate exception is a **sign-carrying category** — a
   category whose config declares `sign: -1`. Today that is exactly
   `refund`, which is modelled as NEGATIVE REVENUE (plan §8, "Refunds as
   negative revenue, never as an expense — otherwise both sides inflate
   and margin lies"). A refund therefore stores `direction: "in"` with a
   NEGATIVE `amountCentavos`.

   The sign is owned by the CATEGORY CONFIG and enforced server-side
   (review finding B5). A client is never trusted with it: whatever sign
   arrives, normalizeAmount() takes the magnitude and re-applies the
   category's own sign. A stale client that posts a positive refund gets
   a correctly-negative stored row plus `normalized: true` on the
   response, rather than either a silent corruption or a hard 400 that
   breaks an old tab.

   ------------------------------------------------------------
   VOIDS, AND WHY EVERY ROW ALWAYS COUNTS (review finding B3)
   ------------------------------------------------------------
   D2 in the plan makes this ledger append-only: a correction is a
   REVERSING ROW, never an edit or a delete. Both rows are kept forever —
   the original with its amount untouched plus a `voided: true` flag, and
   the reversal that cancels it.

   THE INVARIANT, stated once so it can't drift:

       sumRows(a day's TXN rows) == that day's METRIC#DAY rollup

   which holds because a void EXCLUDES the cancelled pair from totals
   (countsTowardTotals() is false for a voided row and false for a
   reversal row) and the rollup is ADDed the NEGATION of the original.
   Net, gross-in, gross-out and count all return to exactly their
   pre-transaction values.

   The alternative model — count every row and let the flipped-direction
   reversal cancel the original — makes NET correct but inflates gross in
   / gross out / txnCount, so a day that had one voided ₱35,000 sale
   would report ₱35,000 in AND ₱35,000 out and 3 transactions, none of
   which happened. That was built first and caught in staging UAT
   (2026-08-18) by reconciling the live rollup against the live rows: net
   matched, every other field did not. Do not reintroduce it: if a future
   view wants "gross activity including corrections", derive it from the
   rows, don't change what the counters mean.

   The invariant is also why a cross-day void stores its reversal in the
   ORIGINAL day's partition (with its own `occurredAt` recording when the
   void actually happened, and `reversalDay` recording today). Filing the
   reversal under today's partition instead would make yesterday's rollup
   disagree with yesterday's rows forever, and no later write could fix
   it without a cross-partition repair job.
   ============================================================ */

const { DEFAULT_OPERATING_HOURS } = require("./business-hours");
const { SITE_ID, SCHEMA_VERSION } = require("./constants");

const MINUTE_MS = 60000;

// Asia/Manila is a fixed +8 with no DST — same reasoning (and the same
// source value) as business-hours.js, which is imported rather than
// re-declaring 480 here so there is one Manila clock in this codebase.
const MANILA_OFFSET_MINUTES = DEFAULT_OPERATING_HOURS.utcOffsetMinutes;

class CashbookValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CashbookValidationError";
  }
}

/* ---------------- categories ---------------- */

// Seed for the CONFIG#TXN_CATEGORIES item (plan §8, "Categories as
// config, not hardcoded"). This constant is the FALLBACK a Lambda uses
// when that item doesn't exist yet — exactly the pattern
// business-hours.js's DEFAULT_OPERATING_HOURS already uses, so
// introducing the config type needs no migration.
//
//   id        stable key stored on every row; never renamed
//   label     display text; safe to edit in Settings later
//   direction "in" (money arrives) | "out" (money leaves)
//   sign      +1 normally; -1 for a sign-carrying category (see header)
//   kind      "revenue" | "expense" — what job costing counts it as
const DEFAULT_TXN_CATEGORIES = Object.freeze([
  { id: "sale", label: "Sale", direction: "in", sign: 1, kind: "revenue" },
  { id: "other_income", label: "Other income", direction: "in", sign: 1, kind: "revenue" },
  // Sign-carrying: negative revenue, NOT an expense. See header.
  { id: "refund", label: "Refund", direction: "in", sign: -1, kind: "revenue" },
  { id: "materials", label: "Materials", direction: "out", sign: 1, kind: "expense" },
  { id: "labor", label: "Labor", direction: "out", sign: 1, kind: "expense" },
  { id: "service", label: "Outsourced service", direction: "out", sign: 1, kind: "expense" },
  { id: "supplies", label: "Shop supplies", direction: "out", sign: 1, kind: "expense" },
  { id: "rent", label: "Rent", direction: "out", sign: 1, kind: "expense" },
  { id: "utilities", label: "Utilities", direction: "out", sign: 1, kind: "expense" },
  { id: "transport", label: "Transport / delivery", direction: "out", sign: 1, kind: "expense" },
  { id: "equipment", label: "Equipment", direction: "out", sign: 1, kind: "expense" },
  { id: "misc", label: "Miscellaneous", direction: "out", sign: 1, kind: "expense" },
]);

// Categories valid on a job COST# line — expenses only. Booking a
// revenue category as a "cost" would make margin nonsense.
function costCategories(categories = DEFAULT_TXN_CATEGORIES) {
  return categories.filter((c) => c.kind === "expense");
}

function categoryById(categoryId, categories = DEFAULT_TXN_CATEGORIES) {
  return categories.find((c) => c && c.id === categoryId) || null;
}

const PAYMENT_METHODS = Object.freeze(["cash", "gcash", "bank", "card"]);

/* ---------------- Manila clock ---------------- */

function shiftedDate(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) throw new CashbookValidationError(`Not a valid timestamp: ${JSON.stringify(iso)}`);
  return new Date(ms + MANILA_OFFSET_MINUTES * MINUTE_MS);
}

// "2026-08-18" — the Manila calendar day an instant falls on. This is the
// partition day (review finding B7): always derived here, on the server,
// from a validated instant. A raw client-supplied "day" string is never
// trusted, because a phone with a wrong clock would otherwise file money
// on the wrong day and bump the wrong rollup — which no void cleanly
// fixes, since the reversal would land in a different partition again.
function manilaDayKey(iso) {
  return shiftedDate(iso).toISOString().slice(0, 10);
}

// "2026-08"
function manilaMonthKey(iso) {
  return shiftedDate(iso).toISOString().slice(0, 7);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isValidDayKey(day) {
  return typeof day === "string" && DAY_RE.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

function isValidMonthKey(month) {
  return typeof month === "string" && MONTH_RE.test(month) && !Number.isNaN(Date.parse(`${month}-01T00:00:00Z`));
}

/* ---------------- occurredAt sanity window (B7) ---------------- */

// A client MAY supply occurredAt (staff logging yesterday's walk-in
// cash), but only inside a window. Past bound is generous enough for
// month-end catch-up; future bound is tight because a future-dated cash
// movement is always either a typo or a wrong device clock.
const OCCURRED_AT_MAX_PAST_MS = 31 * 24 * 60 * MINUTE_MS;
const OCCURRED_AT_MAX_FUTURE_MS = 2 * 60 * MINUTE_MS;

function resolveOccurredAt(raw, nowIso) {
  const now = new Date(nowIso).getTime();
  if (raw === undefined || raw === null || raw === "") return new Date(now).toISOString();
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) throw new CashbookValidationError("occurredAt must be an ISO-8601 timestamp");
  if (ms > now + OCCURRED_AT_MAX_FUTURE_MS) {
    throw new CashbookValidationError("occurredAt is in the future — check the device clock");
  }
  if (ms < now - OCCURRED_AT_MAX_PAST_MS) {
    throw new CashbookValidationError("occurredAt is more than 31 days in the past — log this as a correction instead");
  }
  return new Date(ms).toISOString();
}

/* ---------------- idempotency ids (B1) ---------------- */

// The row's own id IS the client-generated idempotency id, so a retried
// write collides with itself at the item level rather than creating a
// twin. Constrained to a key-safe charset because it becomes part of a
// DynamoDB sort key and of a URL path.
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/;

function validateIdempotencyId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!IDEMPOTENCY_RE.test(id)) {
    throw new CashbookValidationError("idempotencyId must be 8–64 chars of [A-Za-z0-9_.:-] starting alphanumeric");
  }
  return id;
}

// A void's reversal row gets a DERIVED id, not a client-supplied one, so
// the "second void" attempt reproduces the exact same reversal key and is
// refused by that Put's own attribute_not_exists condition even in the
// impossible case where the original row's voided-guard somehow passed.
// Belt and braces on top of the guard in B2's Update.
function reversalIdFor(txnId) {
  return `rev.${txnId}`.slice(0, 64);
}

function isReversal(row) {
  return !!(row && row.reversesTxnId);
}

// Trap 1 seam (review finding B4). verify-payment.js's auto-post is NOT
// wired yet (Phase 2 in the plan) — when it is, it must call the same
// idempotent log path with THIS id, never mint its own. That Lambda
// verifies a whole order's worth of line items in one call and accepts a
// mixed Pending/On-Hold sweep, so one invocation can legitimately produce
// several posts; keying on orderId + paymentId (not orderId alone) is
// what makes each of them individually replay-safe.
function autoPostIdempotencyId(orderId, paymentId) {
  const safe = (s) => String(s || "").replace(/[^A-Za-z0-9_.:-]/g, "");
  const id = `auto.${safe(orderId)}.${safe(paymentId)}`;
  if (!IDEMPOTENCY_RE.test(id)) {
    throw new CashbookValidationError(`Cannot derive a valid idempotency id from ${orderId}/${paymentId}`);
  }
  return id;
}

/* ---------------- amounts ---------------- */

function assertIntegerCentavos(n, field) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new CashbookValidationError(`${field} must be an integer number of centavos`);
  }
  return n;
}

// Server-owned sign (B5). Takes the client's magnitude, discards the
// client's sign, applies the category's. Returns { amountCentavos,
// normalized } where `normalized` is true if the client's sign was wrong
// — surfaced on the API response so a stale client is visible rather than
// silently patched over.
function normalizeAmount(category, rawCentavos) {
  assertIntegerCentavos(rawCentavos, "amountCentavos");
  if (rawCentavos === 0) throw new CashbookValidationError("amountCentavos must not be zero");
  const sign = category.sign === -1 ? -1 : 1;
  const amountCentavos = Math.abs(rawCentavos) * sign;
  return { amountCentavos, normalized: amountCentavos !== rawCentavos };
}

/* ---------------- rollup delta math ---------------- */

// The four counters on a METRIC#DAY / METRIC#MONTH SUMMARY item. Bumped
// with an atomic ADD inside the SAME TransactWriteItems as the row write,
// so a total can never drift from the rows that produced it (plan §4).
const ROLLUP_FIELDS = Object.freeze(["cashInCentavos", "cashOutCentavos", "netCentavos", "txnCount"]);

function emptyRollup() {
  return { cashInCentavos: 0, cashOutCentavos: 0, netCentavos: 0, txnCount: 0 };
}

// One row -> its contribution to the counters.
//   direction "in"  : cashIn += amount,  net += amount
//   direction "out" : cashOut += amount, net -= amount
// A sign-carrying refund (direction "in", negative amount) therefore
// REDUCES both cashIn and net — which is exactly "negative revenue", and
// is why refunds must never be modelled as an expense.
function rollupDelta(row) {
  const amount = assertIntegerCentavos(row.amountCentavos, "amountCentavos");
  if (row.direction === "in") {
    return { cashInCentavos: amount, cashOutCentavos: 0, netCentavos: amount, txnCount: 1 };
  }
  if (row.direction === "out") {
    return { cashInCentavos: 0, cashOutCentavos: amount, netCentavos: -amount, txnCount: 1 };
  }
  throw new CashbookValidationError(`direction must be "in" or "out", got ${JSON.stringify(row.direction)}`);
}

function negateDelta(delta) {
  const out = {};
  for (const f of ROLLUP_FIELDS) out[f] = -(delta[f] || 0);
  return out;
}

function addDeltas(a, b) {
  const out = {};
  for (const f of ROLLUP_FIELDS) out[f] = (a[f] || 0) + (b[f] || 0);
  return out;
}

// A voided row and its reversal are BOTH excluded from totals — the pair
// cancels, and counting them would inflate gross in / gross out / count
// with money that never moved. See the header for the model that was
// tried first and rejected. This is the single predicate the invariant
// rests on; get-day.js's reconciliation check and jobCosting() both go
// through it (directly or by the same rule) so they cannot disagree.
function countsTowardTotals(row) {
  if (!row || typeof row.amountCentavos !== "number") return false;
  if (row.voided) return false;
  if (isReversal(row)) return false;
  return true;
}

// Reconciliation helper (B3 invariant): sum a day's TXN rows and compare
// to that day's METRIC#DAY item. They must be equal, always.
function sumRows(rows) {
  return (rows || []).filter(countsTowardTotals).reduce((acc, r) => addDeltas(acc, rollupDelta(r)), emptyRollup());
}

function rollupFrom(item) {
  const out = emptyRollup();
  if (!item) return out;
  for (const f of ROLLUP_FIELDS) out[f] = typeof item[f] === "number" ? item[f] : 0;
  return out;
}

/* ---------------- validation ---------------- */

function str(v) {
  return typeof v === "string" ? v : "";
}

// A cash-book transaction. Returns the fully normalized field set the
// Lambda writes — the Lambda adds only keys and actor identity.
function validateTransactionInput(input = {}, { categories = DEFAULT_TXN_CATEGORIES, now = new Date().toISOString() } = {}) {
  const idempotencyId = validateIdempotencyId(input.idempotencyId);

  const category = categoryById(str(input.categoryId).trim(), categories);
  if (!category) throw new CashbookValidationError(`Unknown categoryId: ${JSON.stringify(input.categoryId)}`);

  // The client may send a direction, but it is only ever checked against
  // the category's own — never used as the source of truth.
  const direction = category.direction;
  if (input.direction && input.direction !== direction) {
    throw new CashbookValidationError(`Category ${category.id} is always "${direction}", not "${input.direction}"`);
  }

  const { amountCentavos, normalized } = normalizeAmount(category, input.amountCentavos);

  const method = str(input.paymentMethod).trim().toLowerCase();
  if (!PAYMENT_METHODS.includes(method)) {
    throw new CashbookValidationError(`paymentMethod must be one of: ${PAYMENT_METHODS.join(", ")}`);
  }

  const occurredAt = resolveOccurredAt(input.occurredAt, now);
  const note = str(input.note).trim().slice(0, 500);
  const orderId = str(input.orderId).trim() || null;

  return {
    txnId: idempotencyId,
    categoryId: category.id,
    categoryLabel: category.label,
    kind: category.kind,
    direction,
    amountCentavos,
    normalized,
    paymentMethod: method,
    occurredAt,
    day: manilaDayKey(occurredAt),
    month: manilaMonthKey(occurredAt),
    note,
    orderId,
  };
}

// A job cost line. `affectsCash` decides whether a TXN row is written at
// all (review finding B8): false means job-profit-only allocation, and
// the caller must write ONLY the ORDER#/COST# item — no TXN#, no rollup
// bump. The prototype wrote a transaction unconditionally; do not copy
// that shape.
function validateCostInput(input = {}, { categories = DEFAULT_TXN_CATEGORIES, now = new Date().toISOString() } = {}) {
  const idempotencyId = validateIdempotencyId(input.idempotencyId);

  const orderId = str(input.orderId).trim();
  if (!orderId) throw new CashbookValidationError("orderId is required on a cost line");

  const allowed = costCategories(categories);
  const category = allowed.find((c) => c.id === str(input.categoryId).trim());
  if (!category) {
    throw new CashbookValidationError(`Cost category must be one of: ${allowed.map((c) => c.id).join(", ")}`);
  }

  const label = str(input.label).trim();
  if (!label) throw new CashbookValidationError("label is required on a cost line");

  // Qty + unit cost, not a bare total — this is what yields the per-unit
  // economics the plan §5 worked example is built on. qty may be null for
  // a non-per-unit line (a flat rush fee), in which case the amount is
  // taken directly.
  const hasQty = input.qty !== undefined && input.qty !== null && input.qty !== "";
  let qty = null;
  let unitCostCentavos = null;
  let amountCentavos;

  if (hasQty) {
    qty = Number(input.qty);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
      throw new CashbookValidationError("qty must be a positive integer, or omitted for a flat cost");
    }
    unitCostCentavos = assertIntegerCentavos(input.unitCostCentavos, "unitCostCentavos");
    if (unitCostCentavos <= 0) throw new CashbookValidationError("unitCostCentavos must be positive");
    amountCentavos = qty * unitCostCentavos;
    // Stored for auditability (plan §4) but re-derived here, so a client
    // cannot post an amount that disagrees with its own qty x unit.
    if (input.amountCentavos !== undefined && input.amountCentavos !== null &&
        Math.abs(Number(input.amountCentavos)) !== amountCentavos) {
      throw new CashbookValidationError("amountCentavos does not equal qty x unitCostCentavos");
    }
  } else {
    amountCentavos = Math.abs(assertIntegerCentavos(input.amountCentavos, "amountCentavos"));
    if (amountCentavos === 0) throw new CashbookValidationError("amountCentavos must not be zero");
  }

  const affectsCash = input.affectsCash === undefined ? true : input.affectsCash === true;
  if (input.affectsCash !== undefined && typeof input.affectsCash !== "boolean") {
    throw new CashbookValidationError("affectsCash must be a boolean");
  }

  const method = str(input.paymentMethod).trim().toLowerCase();
  if (affectsCash && !PAYMENT_METHODS.includes(method)) {
    throw new CashbookValidationError(`paymentMethod is required when affectsCash is true (one of: ${PAYMENT_METHODS.join(", ")})`);
  }

  const incurredAt = resolveOccurredAt(input.incurredAt || input.occurredAt, now);

  return {
    costId: idempotencyId,
    orderId,
    label,
    categoryId: category.id,
    categoryLabel: category.label,
    qty,
    unitCostCentavos,
    amountCentavos,
    affectsCash,
    paymentMethod: affectsCash ? method : null,
    incurredAt,
    day: manilaDayKey(incurredAt),
    month: manilaMonthKey(incurredAt),
    note: str(input.note).trim().slice(0, 500),
  };
}

function validateVoidReason(raw) {
  const reason = str(raw).trim();
  if (reason.length < 3) throw new CashbookValidationError("A void reason of at least 3 characters is required");
  return reason.slice(0, 500);
}

/* ---------------- job costing ---------------- */

// Given an order's COST# lines and its ORDER#/TXN# pointers, produce the
// profit/margin figures in plan §5. Voided rows on either side are
// excluded here (unlike the day ledger, which keeps them and cancels them
// with a reversal row) — a job's profit is a CURRENT-STATE question, not
// an append-only register, and showing a voided cost inside a profit
// figure would be simply wrong.
function jobCosting({ costLines = [], txnRows = [], units = null } = {}) {
  const liveCosts = costLines.filter((c) => c && !c.voided);
  const liveTxns = txnRows.filter((t) => t && !t.voided && !isReversal(t));

  const costCentavos = liveCosts.reduce((s, c) => s + (c.amountCentavos || 0), 0);
  const cashCostCentavos = liveCosts.filter((c) => c.affectsCash !== false)
    .reduce((s, c) => s + (c.amountCentavos || 0), 0);

  // Revenue is what the ledger says actually came in against this order
  // (cash basis, D1) — sign-carrying refunds subtract themselves.
  const revenueCentavos = liveTxns.filter((t) => t.kind === "revenue")
    .reduce((s, t) => s + (t.amountCentavos || 0), 0);

  const profitCentavos = revenueCentavos - costCentavos;
  const netCashCentavos = revenueCentavos - cashCostCentavos;
  const marginPct = revenueCentavos > 0
    ? Math.round((profitCentavos / revenueCentavos) * 10000) / 100
    : null;

  const perUnit = units && Number.isInteger(units) && units > 0
    ? {
        units,
        revenueCentavos: Math.round(revenueCentavos / units),
        costCentavos: Math.round(costCentavos / units),
        profitCentavos: Math.round(profitCentavos / units),
      }
    : null;

  return {
    revenueCentavos,
    costCentavos,
    cashCostCentavos,
    // Diverges from profit only once an affectsCash:false allocation
    // exists — that divergence is the entire reason the flag was built
    // (plan Trap 2 / §5's salaried-staff worked variant).
    netCashCentavos,
    profitCentavos,
    marginPct,
    perUnit,
    costLineCount: liveCosts.length,
  };
}

/* ---------------- audit event ---------------- */

// EVENT# audit record for a cash-book write. Deliberately NOT
// events.js's buildEvent(): that helper hardcodes PK = ORDER#<id> and
// requires a lineItemId, neither of which exists for a transaction that
// isn't attached to any order. Same field shape otherwise, so a future
// unified audit reader sees one record type.
function buildCashbookEvent({ pk, sk, from, to, actorSub, actorName, at, meta }) {
  if (!pk || !sk || !to) throw new CashbookValidationError("buildCashbookEvent requires pk, sk and to");
  const ts = at || new Date().toISOString();
  return {
    PK: pk,
    SK: sk,
    tenantId: SITE_ID,
    siteId: SITE_ID,
    schemaVersion: SCHEMA_VERSION,
    from: from || null,
    to,
    actorSub: actorSub || null,
    actorName: actorName || null,
    at: ts,
    meta: meta || {},
  };
}

module.exports = {
  CashbookValidationError,
  MANILA_OFFSET_MINUTES,
  DEFAULT_TXN_CATEGORIES,
  PAYMENT_METHODS,
  ROLLUP_FIELDS,
  OCCURRED_AT_MAX_PAST_MS,
  OCCURRED_AT_MAX_FUTURE_MS,
  costCategories,
  categoryById,
  manilaDayKey,
  manilaMonthKey,
  isValidDayKey,
  isValidMonthKey,
  resolveOccurredAt,
  validateIdempotencyId,
  reversalIdFor,
  isReversal,
  autoPostIdempotencyId,
  normalizeAmount,
  emptyRollup,
  rollupDelta,
  negateDelta,
  addDeltas,
  countsTowardTotals,
  sumRows,
  rollupFrom,
  validateTransactionInput,
  validateCostInput,
  validateVoidReason,
  jobCosting,
  buildCashbookEvent,
};
