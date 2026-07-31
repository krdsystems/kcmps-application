/* ============================================================
   KCMPS backend/lib — test suite
   ============================================================
   Plain node:test, no framework dependency. Run: node --test backend/lib/
   ============================================================ */

const test = require("node:test");
const assert = require("node:assert/strict");

const { toCentavos, toPesos, formatPeso, assertCentavos } = require("./money");
const keys = require("./keys");
const { buildEvent } = require("./events");
const { STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES } = require("./constants");
const { hasRole, isStaff, getGroups, ROLES } = require("./auth");
const { deriveOrderStatus } = require("./order-status");

// ---- money.js ----

test("toCentavos converts pesos to integer centavos", () => {
  assert.equal(toCentavos(1500.07), 150007);
  assert.equal(toCentavos(170), 17000);
  assert.equal(toCentavos("1500.07"), 150007);
  assert.equal(toCentavos(0), 0);
});

test("toPesos converts centavos back to a peso float", () => {
  assert.equal(toPesos(150007), 1500.07);
  assert.equal(toPesos(17000), 170);
});

test("money round-trips through toCentavos -> toPesos", () => {
  for (const pesos of [0, 1, 170, 1500.07, 9999.99]) {
    assert.equal(toPesos(toCentavos(pesos)), pesos);
  }
});

test("formatPeso renders the peso symbol, thousands separator, and 2 decimals", () => {
  assert.equal(formatPeso(150007), "₱1,500.07");
  assert.equal(formatPeso(17000), "₱170.00");
  assert.equal(formatPeso(0), "₱0.00");
});

test("assertCentavos throws on non-integer input", () => {
  assert.throws(() => assertCentavos(1500.07), TypeError);
  assert.throws(() => assertCentavos("150007"), TypeError);
  assert.throws(() => assertCentavos(undefined), TypeError);
  assert.doesNotThrow(() => assertCentavos(150007));
});

test("toPesos / formatPeso reject non-integer centavos (no floats allowed in)", () => {
  assert.throws(() => toPesos(1500.07), TypeError);
  assert.throws(() => formatPeso(1500.07), TypeError);
});

// ---- keys.js — must match backend-infra-to-deploy.md §2.1 verbatim ----

test("order / line item / event key builders match §2.1", () => {
  assert.equal(keys.orderPk("1234"), "ORDER#1234");
  assert.equal(keys.metaSk(), "META");
  assert.equal(keys.lineItemSk("L2"), "LINEITEM#L2");
  assert.equal(keys.eventSk("2026-07-24T09:14:00Z", "L2"), "EVENT#2026-07-24T09:14:00Z#L2");
});

test("metric key builders match §2.1", () => {
  assert.equal(keys.dayMetricPk("2026-07-24"), "METRIC#DAY#2026-07-24");
  assert.equal(keys.monthMetricPk("2026-07"), "METRIC#MONTH#2026-07");
  assert.equal(keys.summarySk(), "SUMMARY");
  assert.equal(keys.stationSk("PRESS-01"), "STATION#PRESS-01");
  assert.equal(keys.pillarSk("PRINT"), "PILLAR#PRINT");
});

test("blocker / inventory / client key builders match §2.1", () => {
  assert.equal(keys.blockerPk("2026-07-24"), "BLOCKER#2026-07-24");
  assert.equal(keys.blockerSk("B1"), "B1");
  assert.equal(keys.inventoryPk("DTF-A4"), "INV#DTF-A4");
  assert.equal(keys.clientPk("C1"), "CLIENT#C1");
});

test("GSI1 helpers match §2.3", () => {
  assert.equal(keys.statusPk("Pending Payment Verification"), "STATUS#Pending Payment Verification");
  assert.equal(keys.statusSk("2026-07-24T09:14:00Z"), "2026-07-24T09:14:00Z");
});

test("GSI2 helpers match §2.3", () => {
  assert.equal(keys.clientGsi2Pk("C1"), "CLIENT#C1");
  assert.equal(keys.orderGsi2Sk("2026-07-24T09:14:00Z"), "ORDER#2026-07-24T09:14:00Z");
});

// ---- events.js — must match §2.2 shape ----

test("buildEvent matches the §2.2 record shape exactly", () => {
  const evt = buildEvent({
    orderId: "1234",
    lineItemId: "L2",
    from: "Scheduled",
    to: "In Production",
    actorSub: "cognito-sub-abc",
    station: "PRESS-01",
    meta: { setupMinutes: 22 },
    at: "2026-07-24T09:14:00Z",
  });
  assert.deepEqual(evt, {
    PK: "ORDER#1234",
    SK: "EVENT#2026-07-24T09:14:00Z#L2",
    lineItemId: "L2",
    from: "Scheduled",
    to: "In Production",
    actorSub: "cognito-sub-abc",
    actorName: null,
    station: "PRESS-01",
    at: "2026-07-24T09:14:00Z",
    meta: { setupMinutes: 22 },
  });
});

test("buildEvent defaults meta/station/actorName and requires orderId/lineItemId/to", () => {
  const evt = buildEvent({ orderId: "1", lineItemId: "L1", to: "Quoted", at: "2026-01-01T00:00:00Z" });
  assert.equal(evt.meta && typeof evt.meta, "object");
  assert.deepEqual(evt.meta, {});
  assert.equal(evt.station, null);
  assert.equal(evt.actorName, null);
  assert.equal(evt.from, null);

  assert.throws(() => buildEvent({ lineItemId: "L1", to: "Quoted" }), TypeError);
  assert.throws(() => buildEvent({ orderId: "1", to: "Quoted" }), TypeError);
  assert.throws(() => buildEvent({ orderId: "1", lineItemId: "L1" }), TypeError);
});

// ---- constants.js — ACTIVE_STATUSES / TERMINAL_STATUSES ----

test("ACTIVE_STATUSES excludes exactly the terminal statuses", () => {
  const terminal = [STATUS.DELIVERED, STATUS.CANCELLED, STATUS.AUTO_CANCELLED, STATUS.QUOTE_EXPIRED];
  for (const s of terminal) {
    assert.equal(ACTIVE_STATUSES.has(s), false, `${s} should not be active`);
    assert.equal(TERMINAL_STATUSES.has(s), true, `${s} should be terminal`);
  }
  const active = [
    STATUS.QUOTED, STATUS.PRICED, STATUS.PENDING_PAYMENT_VERIFICATION, STATUS.CONFIRMED,
    STATUS.PAYMENT_REJECTED, STATUS.SCHEDULED, STATUS.IN_PRODUCTION, STATUS.QC,
    STATUS.READY_FOR_DISPATCH, STATUS.DISPATCHED,
  ];
  for (const s of active) {
    assert.equal(ACTIVE_STATUSES.has(s), true, `${s} should be active`);
  }
  assert.equal(ACTIVE_STATUSES.size + TERMINAL_STATUSES.size, Object.keys(STATUS).length);
});

// ---- auth.js ----

test("getGroups handles both the comma-string and array forms of cognito:groups", () => {
  assert.deepEqual(getGroups({ "cognito:groups": "Staff,Admin" }), ["Staff", "Admin"]);
  assert.deepEqual(getGroups({ "cognito:groups": ["Staff", "Admin"] }), ["Staff", "Admin"]);
  assert.deepEqual(getGroups({}), []);
  assert.deepEqual(getGroups(null), []);
});

test("getGroups strips API Gateway HTTP API's bracketed list-claim serialization", () => {
  assert.deepEqual(getGroups({ "cognito:groups": "[Admin]" }), ["Admin"]);
  assert.deepEqual(getGroups({ "cognito:groups": "[Admin, Sales]" }), ["Admin", "Sales"]);
  // Confirmed live (2026-07-31): API Gateway actually space-separates, not
  // comma-separates, multi-value claims — "[Staff Admin]", not "[Staff, Admin]".
  assert.deepEqual(getGroups({ "cognito:groups": "[Staff Admin]" }), ["Staff", "Admin"]);
});

test("hasRole checks membership regardless of cognito:groups form", () => {
  assert.equal(hasRole({ "cognito:groups": "Production,Admin" }, ROLES.ADMIN), true);
  assert.equal(hasRole({ "cognito:groups": ["Production"] }, ROLES.ADMIN), false);
});

test("isStaff is true for any non-Customer role, false for Customer-only or no claims", () => {
  assert.equal(isStaff({ "cognito:groups": "Production" }), true);
  assert.equal(isStaff({ "cognito:groups": ["Sales"] }), true);
  assert.equal(isStaff({ "cognito:groups": "Finance,Admin" }), true);
  assert.equal(isStaff({ "cognito:groups": "Customer" }), false);
  assert.equal(isStaff({}), false);
});

// ---- order-status.js ----

test("deriveOrderStatus: all Delivered -> Delivered", () => {
  assert.equal(deriveOrderStatus(["Delivered", "Delivered"]), "Delivered");
});

test("deriveOrderStatus: one Delivered + one still active -> Partially Fulfilled", () => {
  assert.equal(deriveOrderStatus(["Delivered", "In Production"]), "Partially Fulfilled");
});

test("deriveOrderStatus: Delivered alongside a terminal non-Delivered status is NOT partial", () => {
  // A cancelled/expired line item isn't "still being fulfilled" — the mixed-cart
  // worked example (dashboard-data.js) never exercises this combination directly,
  // but the rule mirrors dashboard-data.js's deriveOrderStatus() exactly.
  assert.equal(deriveOrderStatus(["Delivered", "Cancelled"]), "Delivered");
});

test("deriveOrderStatus: any Pending Payment Verification line wins over other active statuses", () => {
  assert.equal(deriveOrderStatus(["Pending Payment Verification", "In Production"]), "Pending Payment Verification");
});

test("deriveOrderStatus: Quoted-only -> Awaiting Quote, Priced-only -> Awaiting Payment", () => {
  assert.equal(deriveOrderStatus(["Quoted"]), "Awaiting Quote");
  assert.equal(deriveOrderStatus(["Priced"]), "Awaiting Payment");
});

test("deriveOrderStatus: falls back to the single status, or Unknown for an empty list", () => {
  assert.equal(deriveOrderStatus(["Confirmed"]), "Confirmed");
  assert.equal(deriveOrderStatus([]), "Unknown");
});
