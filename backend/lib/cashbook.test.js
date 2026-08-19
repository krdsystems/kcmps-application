/* ============================================================
   Unit tests for lib/cashbook.js
   ============================================================
   Run: node --test backend/lib/cashbook.test.js

   NAME THE FILE. Never `node --test backend/lib/` — the bare directory
   form is a false green in this repo (exits 0 even on failure); see
   backend/CLAUDE.md.
   ============================================================ */

const test = require("node:test");
const assert = require("node:assert");

const cb = require("./cashbook");

/* ---------------- Manila clock (B7 / D4) ---------------- */

test("manilaDayKey files a late-evening Manila instant under the Manila day, not the UTC one", () => {
  // 2026-08-18T20:30 Manila == 2026-08-18T12:30Z. Naive UTC slicing gives
  // the same day here, so also check the case that actually breaks:
  // 2026-08-18T23:30 Manila == 2026-08-18T15:30Z -> still 08-18,
  // and 2026-08-19T01:00 Manila == 2026-08-18T17:00Z -> must be 08-19.
  assert.equal(cb.manilaDayKey("2026-08-18T15:30:00Z"), "2026-08-18");
  assert.equal(cb.manilaDayKey("2026-08-18T17:00:00Z"), "2026-08-19");
  assert.equal(cb.manilaDayKey("2026-08-18T16:00:00Z"), "2026-08-19");
});

test("manilaMonthKey rolls the month over on Manila time", () => {
  // 2026-08-31T17:00Z == 2026-09-01T01:00 Manila.
  assert.equal(cb.manilaMonthKey("2026-08-31T17:00:00Z"), "2026-09");
  assert.equal(cb.manilaMonthKey("2026-08-31T15:00:00Z"), "2026-08");
});

test("day/month key validators reject junk", () => {
  assert.equal(cb.isValidDayKey("2026-08-18"), true);
  assert.equal(cb.isValidDayKey("2026-8-18"), false);
  assert.equal(cb.isValidDayKey("2026-13-01"), false);
  assert.equal(cb.isValidDayKey(""), false);
  assert.equal(cb.isValidMonthKey("2026-08"), true);
  assert.equal(cb.isValidMonthKey("2026-08-18"), false);
});

/* ---------------- occurredAt sanity window (B7) ---------------- */

test("resolveOccurredAt defaults to now and accepts a recent client timestamp", () => {
  const now = "2026-08-18T04:00:00.000Z";
  assert.equal(cb.resolveOccurredAt(undefined, now), now);
  assert.equal(cb.resolveOccurredAt("", now), now);
  assert.equal(cb.resolveOccurredAt("2026-08-17T02:00:00.000Z", now), "2026-08-17T02:00:00.000Z");
});

test("resolveOccurredAt rejects a future or far-past client timestamp", () => {
  const now = "2026-08-18T04:00:00.000Z";
  assert.throws(() => cb.resolveOccurredAt("2026-08-19T04:00:00Z", now), cb.CashbookValidationError);
  assert.throws(() => cb.resolveOccurredAt("2026-01-01T00:00:00Z", now), cb.CashbookValidationError);
  assert.throws(() => cb.resolveOccurredAt("not a date", now), cb.CashbookValidationError);
  // Just inside the 2h future tolerance is fine (clock skew, not a typo).
  assert.equal(cb.resolveOccurredAt("2026-08-18T05:30:00.000Z", now), "2026-08-18T05:30:00.000Z");
});

/* ---------------- sign enforcement (B5 / B9) ---------------- */

test("normalizeAmount forces the category's sign, ignoring the client's", () => {
  const sale = cb.categoryById("sale");
  const refund = cb.categoryById("refund");

  assert.deepEqual(cb.normalizeAmount(sale, 3500000), { amountCentavos: 3500000, normalized: false });
  // A stale client posting a POSITIVE refund is corrected, not trusted.
  assert.deepEqual(cb.normalizeAmount(refund, 50000), { amountCentavos: -50000, normalized: true });
  // A correct client posting a negative refund passes through untouched.
  assert.deepEqual(cb.normalizeAmount(refund, -50000), { amountCentavos: -50000, normalized: false });
  // A client trying to sneak a negative sale is also corrected.
  assert.deepEqual(cb.normalizeAmount(sale, -50000), { amountCentavos: 50000, normalized: true });
});

test("normalizeAmount rejects zero and non-integer centavos", () => {
  const sale = cb.categoryById("sale");
  assert.throws(() => cb.normalizeAmount(sale, 0), cb.CashbookValidationError);
  assert.throws(() => cb.normalizeAmount(sale, 12.5), cb.CashbookValidationError);
  assert.throws(() => cb.normalizeAmount(sale, "100"), cb.CashbookValidationError);
});

test("refund is negative revenue, never an expense", () => {
  const refund = cb.categoryById("refund");
  assert.equal(refund.kind, "revenue");
  assert.equal(refund.direction, "in");
  assert.equal(refund.sign, -1);
  // Its rollup contribution reduces BOTH cash in and net.
  const d = cb.rollupDelta({ direction: "in", amountCentavos: -50000 });
  assert.equal(d.cashInCentavos, -50000);
  assert.equal(d.cashOutCentavos, 0);
  assert.equal(d.netCentavos, -50000);
});

/* ---------------- rollup delta math ---------------- */

test("rollupDelta signs in/out correctly", () => {
  assert.deepEqual(cb.rollupDelta({ direction: "in", amountCentavos: 10000 }),
    { cashInCentavos: 10000, cashOutCentavos: 0, netCentavos: 10000, txnCount: 1 });
  assert.deepEqual(cb.rollupDelta({ direction: "out", amountCentavos: 4000 }),
    { cashInCentavos: 0, cashOutCentavos: 4000, netCentavos: -4000, txnCount: 1 });
  assert.throws(() => cb.rollupDelta({ direction: "sideways", amountCentavos: 1 }), cb.CashbookValidationError);
});

test("negateDelta is an exact inverse — a void returns rollups to their prior values", () => {
  const d = cb.rollupDelta({ direction: "out", amountCentavos: 1950000 });
  const back = cb.addDeltas(d, cb.negateDelta(d));
  assert.deepEqual(back, cb.emptyRollup());
});

// This is the reconciliation the live day view performs on every read,
// reproduced here against the exact sequence of ADDs the void Lambda
// issues. Caught a real mismatch in staging UAT on 2026-08-18 — see the
// module header. Do not weaken it to check netCentavos alone: net was
// the ONE field that matched under the broken model.
test("sumRows equals the rollup after a void — every field, not just net (B3)", () => {
  const sale = { txnId: "t1", direction: "in", amountCentavos: 3500000 };
  const cost = { txnId: "t2", direction: "out", amountCentavos: 1950000 };

  // Live rollup, built the way the transactions actually build it.
  let rollup = cb.addDeltas(cb.rollupDelta(sale), cb.rollupDelta(cost));
  assert.deepEqual(rollup, { cashInCentavos: 3500000, cashOutCentavos: 1950000, netCentavos: 1550000, txnCount: 2 });

  const before = { ...rollup };

  // Void the cost: flag the original, append the reversal into the SAME
  // day partition, ADD the negation of the original to the counters.
  const voidedCost = { ...cost, voided: true };
  const reversal = {
    txnId: "rev.t2", reversesTxnId: "t2",
    direction: "in", amountCentavos: 1950000, // direction flipped, amount kept
  };
  rollup = cb.addDeltas(rollup, cb.negateDelta(cb.rollupDelta(cost)));

  // Counters are back to exactly what they were before the cost existed.
  assert.deepEqual(rollup, { cashInCentavos: 3500000, cashOutCentavos: 0, netCentavos: 3500000, txnCount: 1 });
  assert.notDeepEqual(rollup, before);

  // ...and the rows in that partition still sum to the same thing, with
  // both halves of the cancelled pair physically present.
  const rowsInPartition = [sale, voidedCost, reversal];
  assert.equal(rowsInPartition.length, 3, "append-only: nothing was deleted");
  assert.deepEqual(cb.sumRows(rowsInPartition), rollup);
});

test("countsTowardTotals excludes both halves of a cancelled pair", () => {
  assert.equal(cb.countsTowardTotals({ direction: "in", amountCentavos: 1 }), true);
  assert.equal(cb.countsTowardTotals({ direction: "in", amountCentavos: 1, voided: true }), false);
  assert.equal(cb.countsTowardTotals({ direction: "out", amountCentavos: 1, reversesTxnId: "t" }), false);
  assert.equal(cb.countsTowardTotals({ direction: "in" }), false);
  assert.equal(cb.countsTowardTotals(null), false);
});

test("a void restores every counter to its exact pre-transaction value", () => {
  const start = { cashInCentavos: 900, cashOutCentavos: 100, netCentavos: 800, txnCount: 4 };
  const row = { direction: "out", amountCentavos: 123456 };
  const after = cb.addDeltas(start, cb.rollupDelta(row));
  assert.deepEqual(after, { cashInCentavos: 900, cashOutCentavos: 123556, netCentavos: -122656, txnCount: 5 });
  const restored = cb.addDeltas(after, cb.negateDelta(cb.rollupDelta(row)));
  assert.deepEqual(restored, start);
});

test("rollupFrom tolerates a missing/partial METRIC item", () => {
  assert.deepEqual(cb.rollupFrom(null), cb.emptyRollup());
  assert.deepEqual(cb.rollupFrom({ netCentavos: 5 }),
    { cashInCentavos: 0, cashOutCentavos: 0, netCentavos: 5, txnCount: 0 });
});

/* ---------------- idempotency ids (B1) ---------------- */

test("validateIdempotencyId enforces a key-safe charset and length", () => {
  assert.equal(cb.validateIdempotencyId("  abc12345  "), "abc12345");
  assert.throws(() => cb.validateIdempotencyId("short"), cb.CashbookValidationError);
  assert.throws(() => cb.validateIdempotencyId("has space here"), cb.CashbookValidationError);
  assert.throws(() => cb.validateIdempotencyId("has/slash1234"), cb.CashbookValidationError);
  assert.throws(() => cb.validateIdempotencyId("_leadingunderscore"), cb.CashbookValidationError);
  assert.throws(() => cb.validateIdempotencyId(undefined), cb.CashbookValidationError);
});

test("reversalIdFor is deterministic — the same void attempt reproduces the same key", () => {
  assert.equal(cb.reversalIdFor("abc12345"), "rev.abc12345");
  assert.equal(cb.reversalIdFor("abc12345"), cb.reversalIdFor("abc12345"));
});

test("autoPostIdempotencyId keys on orderId AND paymentId (B4)", () => {
  const a = cb.autoPostIdempotencyId("ORD-3A94793FF8", "pay-1");
  const b = cb.autoPostIdempotencyId("ORD-3A94793FF8", "pay-2");
  assert.notEqual(a, b, "one verify-payment sweep can post several times; each must be separately replay-safe");
  assert.equal(a, cb.autoPostIdempotencyId("ORD-3A94793FF8", "pay-1"));
  assert.doesNotThrow(() => cb.validateIdempotencyId(a));
});

/* ---------------- transaction validation ---------------- */

const NOW = "2026-08-18T04:00:00.000Z"; // 12:00 Manila

test("validateTransactionInput normalizes a good sale", () => {
  const t = cb.validateTransactionInput({
    idempotencyId: "txn-abc12345",
    categoryId: "sale",
    amountCentavos: 3500000,
    paymentMethod: "GCash",
    note: "  totebags  ",
    orderId: "ORD-XYZ",
  }, { now: NOW });

  assert.equal(t.txnId, "txn-abc12345");
  assert.equal(t.direction, "in");
  assert.equal(t.kind, "revenue");
  assert.equal(t.amountCentavos, 3500000);
  assert.equal(t.normalized, false);
  assert.equal(t.paymentMethod, "gcash");
  assert.equal(t.day, "2026-08-18");
  assert.equal(t.month, "2026-08");
  assert.equal(t.note, "totebags");
  assert.equal(t.orderId, "ORD-XYZ");
});

test("validateTransactionInput rejects an unknown category and a bad method", () => {
  const base = { idempotencyId: "txn-abc12345", amountCentavos: 100, paymentMethod: "cash" };
  assert.throws(() => cb.validateTransactionInput({ ...base, categoryId: "nope" }, { now: NOW }), cb.CashbookValidationError);
  assert.throws(() => cb.validateTransactionInput({ ...base, categoryId: "sale", paymentMethod: "crypto" }, { now: NOW }), cb.CashbookValidationError);
});

test("validateTransactionInput refuses a client direction that contradicts the category", () => {
  assert.throws(() => cb.validateTransactionInput({
    idempotencyId: "txn-abc12345", categoryId: "materials", direction: "in",
    amountCentavos: 100, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

test("a stale client's positive refund is stored negative and flagged normalized (B5)", () => {
  const t = cb.validateTransactionInput({
    idempotencyId: "txn-refund123", categoryId: "refund",
    amountCentavos: 50000, paymentMethod: "gcash",
  }, { now: NOW });
  assert.equal(t.amountCentavos, -50000);
  assert.equal(t.normalized, true);
  assert.equal(t.direction, "in");
});

test("the partition day comes from the SERVER's Manila clock, not a client 'day' field", () => {
  const t = cb.validateTransactionInput({
    idempotencyId: "txn-abc12345", categoryId: "sale",
    amountCentavos: 100, paymentMethod: "cash",
    day: "1999-01-01", month: "1999-01", // ignored outright
  }, { now: NOW });
  assert.equal(t.day, "2026-08-18");
  assert.equal(t.month, "2026-08");
});

/* ---------------- subcategories ---------------- */

test("validateTransactionInput accepts a valid category/subcategory pair", () => {
  const t = cb.validateTransactionInput({
    idempotencyId: "txn-sub123456", categoryId: "sale", subcategoryId: "print_office",
    amountCentavos: 100000, paymentMethod: "cash",
  }, { now: NOW });
  assert.equal(t.subcategoryId, "print_office");
  assert.equal(t.subcategoryLabel, "Print — office");
});

test("validateTransactionInput allows an absent subcategory — it is optional", () => {
  const t = cb.validateTransactionInput({
    idempotencyId: "txn-nosub12345", categoryId: "sale",
    amountCentavos: 100000, paymentMethod: "cash",
  }, { now: NOW });
  assert.equal(t.subcategoryId, null);
  assert.equal(t.subcategoryLabel, null);
});

test("validateTransactionInput rejects an unknown subcategoryId", () => {
  assert.throws(() => cb.validateTransactionInput({
    idempotencyId: "txn-badsub1234", categoryId: "sale", subcategoryId: "nope",
    amountCentavos: 100000, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

test("validateTransactionInput rejects a subcategory that belongs to a DIFFERENT category", () => {
  // "blanks" is a materials subcategory, not a sale subcategory.
  assert.throws(() => cb.validateTransactionInput({
    idempotencyId: "txn-crosssub12", categoryId: "sale", subcategoryId: "blanks",
    amountCentavos: 100000, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

test("validateTransactionInput rejects a subcategoryId on a category that has none", () => {
  assert.throws(() => cb.validateTransactionInput({
    idempotencyId: "txn-noleaf12345", categoryId: "rent", subcategoryId: "anything",
    amountCentavos: 100000, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

test("validateCostInput accepts and rejects subcategories the same way", () => {
  const c = cb.validateCostInput({
    idempotencyId: "cost-sub123456", orderId: "ORD-XYZ", label: "DTF transfers",
    categoryId: "materials", subcategoryId: "transfers",
    qty: 10, unitCostCentavos: 5000, paymentMethod: "cash",
  }, { now: NOW });
  assert.equal(c.subcategoryId, "transfers");
  assert.equal(c.subcategoryLabel, "Transfers (DTF/vinyl/subli)");

  assert.throws(() => cb.validateCostInput({
    idempotencyId: "cost-badsub1234", orderId: "ORD-XYZ", label: "x",
    categoryId: "materials", subcategoryId: "piece_rate", // belongs to labor
    amountCentavos: 1000, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

test("subcategoryLabel resolver looks up a label without re-deriving it ad hoc", () => {
  assert.equal(cb.subcategoryLabel("materials", "ink"), "Ink & toner");
  assert.equal(cb.subcategoryLabel("materials", null), null);
  assert.equal(cb.subcategoryLabel("materials", "nope"), null);
  assert.equal(cb.subcategoryLabel("rent", "anything"), null);
});

/* ---------------- cost-line validation (B8) ---------------- */

test("validateCostInput derives amount from qty x unit cost", () => {
  const c = cb.validateCostInput({
    idempotencyId: "cost-abc12345", orderId: "ORD-XYZ", label: "Totebag blanks",
    categoryId: "materials", qty: 150, unitCostCentavos: 13000, paymentMethod: "cash",
  }, { now: NOW });
  assert.equal(c.amountCentavos, 1950000);
  assert.equal(c.qty, 150);
  assert.equal(c.unitCostCentavos, 13000);
  assert.equal(c.affectsCash, true);
});

test("validateCostInput rejects an amount that disagrees with qty x unit", () => {
  assert.throws(() => cb.validateCostInput({
    idempotencyId: "cost-abc12345", orderId: "ORD-XYZ", label: "x",
    categoryId: "materials", qty: 150, unitCostCentavos: 13000,
    amountCentavos: 999, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

test("a flat cost line (no qty) is allowed", () => {
  const c = cb.validateCostInput({
    idempotencyId: "cost-rush1234", orderId: "ORD-XYZ", label: "Rush fee",
    categoryId: "service", amountCentavos: 50000, paymentMethod: "cash",
  }, { now: NOW });
  assert.equal(c.qty, null);
  assert.equal(c.unitCostCentavos, null);
  assert.equal(c.amountCentavos, 50000);
});

test("affectsCash:false needs no payment method — it is an allocation, not a cash movement (B8)", () => {
  const c = cb.validateCostInput({
    idempotencyId: "cost-dtf12345", orderId: "ORD-XYZ", label: "DTF from stock",
    categoryId: "materials", qty: 150, unitCostCentavos: 1307, affectsCash: false,
  }, { now: NOW });
  assert.equal(c.affectsCash, false);
  assert.equal(c.paymentMethod, null);
});

test("affectsCash:true DOES require a payment method", () => {
  assert.throws(() => cb.validateCostInput({
    idempotencyId: "cost-dtf12345", orderId: "ORD-XYZ", label: "DTF",
    categoryId: "materials", amountCentavos: 1000,
  }, { now: NOW }), cb.CashbookValidationError);
});

test("a revenue category is not a valid cost category", () => {
  assert.throws(() => cb.validateCostInput({
    idempotencyId: "cost-abc12345", orderId: "ORD-XYZ", label: "x",
    categoryId: "sale", amountCentavos: 1000, paymentMethod: "cash",
  }, { now: NOW }), cb.CashbookValidationError);
});

/* ---------------- void ---------------- */

test("validateVoidReason requires real text", () => {
  assert.equal(cb.validateVoidReason("  wrong amount  "), "wrong amount");
  assert.throws(() => cb.validateVoidReason(""), cb.CashbookValidationError);
  assert.throws(() => cb.validateVoidReason("ok"), cb.CashbookValidationError);
  assert.throws(() => cb.validateVoidReason(undefined), cb.CashbookValidationError);
});

test("isReversal identifies a reversing row", () => {
  assert.equal(cb.isReversal({ reversesTxnId: "t1" }), true);
  assert.equal(cb.isReversal({}), false);
  assert.equal(cb.isReversal(null), false);
});

/* ---------------- job costing (plan §5 worked example) ---------------- */

test("jobCosting reproduces the owner's real totebag job exactly", () => {
  const costLines = [
    { label: "Totebag blanks", amountCentavos: 1950000, affectsCash: true },
    { label: "DTF transfers", amountCentavos: 196000, affectsCash: true },
    { label: "Rush fee", amountCentavos: 50000, affectsCash: true },
    { label: "Labor", amountCentavos: 150000, affectsCash: true },
  ];
  const txnRows = [{ kind: "revenue", amountCentavos: 3500000 }];

  const r = cb.jobCosting({ costLines, txnRows, units: 150 });
  assert.equal(r.revenueCentavos, 3500000);          // ₱35,000.00
  assert.equal(r.costCentavos, 2346000);             // ₱23,460.00
  assert.equal(r.profitCentavos, 1154000);           // ₱11,540.00
  assert.equal(r.marginPct, 32.97);
  // Every line is cash today (D7), so net cash == profit.
  assert.equal(r.netCashCentavos, 1154000);
  assert.equal(r.perUnit.profitCentavos, 7693);      // ₱76.93/bag
});

test("an affectsCash:false line splits profit from net cash — the whole reason the flag exists", () => {
  const costLines = [
    { label: "Totebag blanks", amountCentavos: 1950000, affectsCash: true },
    { label: "DTF transfers", amountCentavos: 196000, affectsCash: true },
    { label: "Rush fee", amountCentavos: 50000, affectsCash: true },
    // Salaried staffer: hits job profit, not the drawer.
    { label: "Labor", amountCentavos: 150000, affectsCash: false },
  ];
  const r = cb.jobCosting({ costLines, txnRows: [{ kind: "revenue", amountCentavos: 3500000 }] });
  assert.equal(r.profitCentavos, 1154000);   // ₱11,540.00 — unchanged
  assert.equal(r.netCashCentavos, 1304000);  // ₱13,040.00 — plan §5's variant
});

test("jobCosting excludes voided cost lines and voided/reversal txn rows", () => {
  const r = cb.jobCosting({
    costLines: [
      { amountCentavos: 100000, affectsCash: true },
      { amountCentavos: 999999, affectsCash: true, voided: true },
    ],
    txnRows: [
      { kind: "revenue", amountCentavos: 500000 },
      { kind: "revenue", amountCentavos: 200000, voided: true },
      { kind: "revenue", amountCentavos: 200000, reversesTxnId: "t9" },
    ],
  });
  assert.equal(r.costCentavos, 100000);
  assert.equal(r.revenueCentavos, 500000);
  assert.equal(r.profitCentavos, 400000);
});

test("jobCosting reports a null margin rather than dividing by zero revenue", () => {
  const r = cb.jobCosting({ costLines: [{ amountCentavos: 5000, affectsCash: true }], txnRows: [] });
  assert.equal(r.marginPct, null);
  assert.equal(r.profitCentavos, -5000);
});

test("a refund inside a job's ledger reduces that job's revenue", () => {
  const r = cb.jobCosting({
    costLines: [],
    txnRows: [
      { kind: "revenue", amountCentavos: 3500000 },
      { kind: "revenue", amountCentavos: -500000 }, // refund, sign-carrying
    ],
  });
  assert.equal(r.revenueCentavos, 3000000);
});

/* ---------------- audit event ---------------- */

test("buildCashbookEvent stamps the launch-blocking conventions", () => {
  const e = cb.buildCashbookEvent({
    pk: "TXN#2026-08-18", sk: "EVENT#2026-08-18T04:00:00.000Z#txn-abc12345",
    to: "Transaction logged", actorSub: "sub-1", at: NOW, meta: { via: "manual" },
  });
  assert.equal(e.PK, "TXN#2026-08-18");
  assert.equal(e.tenantId, "SITE#MNL");
  assert.equal(e.siteId, "SITE#MNL");
  assert.equal(e.schemaVersion, 1);
  assert.equal(e.to, "Transaction logged");
  assert.deepEqual(e.meta, { via: "manual" });
  assert.throws(() => cb.buildCashbookEvent({ pk: "x", sk: "y" }), cb.CashbookValidationError);
});

/* ---------------- category config integrity ---------------- */

test("every default category is well-formed", () => {
  const ids = new Set();
  for (const c of cb.DEFAULT_TXN_CATEGORIES) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing category id: ${c.id}`);
    ids.add(c.id);
    assert.ok(["in", "out"].includes(c.direction), `bad direction on ${c.id}`);
    assert.ok([1, -1].includes(c.sign), `bad sign on ${c.id}`);
    assert.ok(["revenue", "expense"].includes(c.kind), `bad kind on ${c.id}`);
    // An expense is always money leaving; a sign-carrying expense would
    // make "cash out" go up when cash came in.
    if (c.kind === "expense") {
      assert.equal(c.direction, "out", `${c.id} is an expense but not an outflow`);
      assert.equal(c.sign, 1, `${c.id} is an expense with a carried sign — model it as negative revenue instead`);
    }
  }
});

test("costCategories excludes every revenue category", () => {
  const ids = cb.costCategories().map((c) => c.id);
  assert.ok(!ids.includes("sale"));
  assert.ok(!ids.includes("refund"));
  assert.ok(ids.includes("materials"));
});
