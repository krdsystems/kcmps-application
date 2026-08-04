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
const { redactForCustomer } = require("./customer-view");
const { resolveUploadType, extensionOf, MAX_UPLOAD_BYTES } = require("./upload-types");
const { describeThreats } = require("./threat-descriptions");

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
  assert.equal(keys.idempotencyPk("abc-123"), "IDEMPOTENCY#abc-123");
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
    tenantId: "SITE#MNL",
    siteId: "SITE#MNL",
    schemaVersion: 1,
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
  assert.equal(evt.tenantId, "SITE#MNL");
  assert.equal(evt.siteId, "SITE#MNL");
  assert.equal(evt.schemaVersion, 1);

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
    STATUS.ON_HOLD, STATUS.SCHEDULED, STATUS.IN_PRODUCTION, STATUS.QC,
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

test("isStaff treats Staff as a first-class role, no legacy-group fallback needed", () => {
  assert.equal(isStaff({ "cognito:groups": "Staff" }), true);
  assert.equal(isStaff({ "cognito:groups": ["Staff"] }), true);
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

// ---- customer-view.js ----

test("redactForCustomer strips staff-internal fields from line items and events", () => {
  const order = {
    orderId: "ORD-1",
    correspondenceLog: [{ at: "2026-01-01T00:00:00Z", actorName: "Staffer", note: "called client" }],
    lineItems: [
      { lineItemId: "L1", name: "Document Printing", qty: 20, station: "PRESS-01", setupMinutes: 10, spoilage: [{ units: 1 }] },
    ],
    events: [
      { at: "2026-01-01T00:00:00Z", from: null, to: "Quoted", actorSub: "sub-1", actorName: "Staffer", station: "PRESS-01", meta: { via: "createOrder" } },
      { at: "2026-01-01T01:00:00Z", from: "Pending Payment Verification", to: "On Hold", actorSub: "sub-1", actorName: "Staffer", meta: { via: "setOnHold", holdReason: "Reference number doesn't match" } },
    ],
  };
  const redacted = redactForCustomer(order);

  assert.equal("correspondenceLog" in redacted, false);
  assert.deepEqual(Object.keys(redacted.lineItems[0]).sort(), ["lineItemId", "name", "qty"]);
  assert.equal(redacted.lineItems[0].qty, 20); // customer-relevant fields survive

  assert.deepEqual(redacted.events[0], { at: "2026-01-01T00:00:00Z", from: null, to: "Quoted", meta: {} });
  assert.deepEqual(redacted.events[1].meta, { holdReason: "Reference number doesn't match" });
  assert.equal("actorName" in redacted.events[1], false);
  assert.equal("station" in redacted.events[1], false);
});

// ---- upload-types.js (customer design-file allowlist) ----

test("resolveUploadType accepts the print/design formats the owner allowlisted", () => {
  assert.equal(resolveUploadType("image/jpeg", "logo.jpg"), "jpg");
  assert.equal(resolveUploadType("image/jpeg", "logo.jpeg"), "jpg"); // canonicalized
  assert.equal(resolveUploadType("image/png", "logo.png"), "png");
  assert.equal(resolveUploadType("image/webp", "art.webp"), "webp");
  assert.equal(resolveUploadType("application/pdf", "catalog.pdf"), "pdf");
  assert.equal(
    resolveUploadType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "flyer.docx"),
    "docx"
  );
});

test("resolveUploadType accepts octet-stream for formats browsers have no MIME mapping for", () => {
  // .ai/.eps/.psd/.tif routinely arrive as application/octet-stream (or with
  // no type at all) — rejecting on MIME alone would block files the owner
  // explicitly wants accepted.
  assert.equal(resolveUploadType("application/octet-stream", "artwork.ai"), "ai");
  assert.equal(resolveUploadType("application/octet-stream", "artwork.psd"), "psd");
  assert.equal(resolveUploadType("", "scan.tif"), "tif");
  assert.equal(resolveUploadType("", "scan.tiff"), "tif"); // canonicalized
});

test("resolveUploadType rejects a spoofed Content-Type that disagrees with the extension", () => {
  // The core server-side gate: a caller claiming image/pdf on an executable
  // must not get a presigned URL, however convincing the declared type is.
  assert.equal(resolveUploadType("application/pdf", "payload.exe"), null);
  assert.equal(resolveUploadType("application/octet-stream", "payload.exe"), null);
  assert.equal(resolveUploadType("application/pdf", "shell.php"), null);
  assert.equal(resolveUploadType("image/jpeg", "trick.pdf"), null); // type/ext disagree
  assert.equal(resolveUploadType("application/octet-stream", "a.jpg.exe"), null); // double extension
});

test("resolveUploadType rejects SVG and archives (deliberately off the allowlist)", () => {
  // SVG is a script container; archives are opaque to Content-Type checks.
  // See upload-types.js's header for why neither is accepted.
  assert.equal(resolveUploadType("image/svg+xml", "logo.svg"), null);
  assert.equal(resolveUploadType("application/octet-stream", "logo.svg"), null);
  assert.equal(resolveUploadType("application/zip", "bundle.zip"), null);
  assert.equal(resolveUploadType("application/x-7z-compressed", "bundle.7z"), null);
  assert.equal(resolveUploadType("text/html", "index.html"), null);
});

test("resolveUploadType rejects path-traversal-shaped and extension-less names", () => {
  assert.equal(resolveUploadType("application/pdf", "../../etc/passwd"), null);
  assert.equal(resolveUploadType("application/octet-stream", "noextension"), null);
  assert.equal(resolveUploadType("application/pdf", ""), null);
});

test("extensionOf pulls a lowercase extension, or empty when there isn't one", () => {
  assert.equal(extensionOf("Logo.PNG"), "png");
  assert.equal(extensionOf("a.b.c.pdf"), "pdf");
  assert.equal(extensionOf("noext"), "");
  assert.equal(extensionOf(null), "");
});

test("MAX_UPLOAD_BYTES is the 50MB print-source-file cap", () => {
  assert.equal(MAX_UPLOAD_BYTES, 50 * 1024 * 1024);
});

// ---- threat-descriptions.js (plain-English malware summaries) ----

test("describeThreats maps AV signature families to plain English", () => {
  assert.equal(describeThreats(["Ransom.Win32.WannaCry"]).label, "Ransomware");
  assert.equal(describeThreats(["Win32.Backdoor.Agent"]).label, "Remote-access malware");
  assert.equal(describeThreats(["PWS:Win32/Fareit"]).label, "Password stealer");
  assert.equal(describeThreats(["Exploit.CVE-2021-40444"]).label, "Booby-trapped document");
  assert.equal(describeThreats(["W97M/Downloader.gen"]).label, "Office file with a harmful macro");
  assert.equal(describeThreats(["Adware.Win32.Bundler"]).label, "Unwanted software");
});

test("describeThreats treats EICAR as a test file, outranking any other match", () => {
  // EICAR's own name contains no scary family, but engines sometimes report
  // it alongside generic signatures — "this is only a test" must win, or
  // staff get told a test file is ransomware.
  const d = describeThreats(["EICAR-Test-File (not a virus)"]);
  assert.equal(d.label, "Antivirus test file");
  assert.equal(d.severity, "info");
  assert.equal(describeThreats(["Trojan.Generic", "EICAR-Test-File"]).severity, "info");
});

test("describeThreats falls back to a non-reassuring generic for unknown names", () => {
  const d = describeThreats(["Some.Vendor.Signature.XYZ"]);
  assert.equal(d.label, "Unrecognized threat");
  assert.equal(d.severity, "high"); // unknown must never read as safe
  assert.match(d.advice, /unsafe/i);
});

test("describeThreats returns null when there are no threats, and keeps the raw signature", () => {
  assert.equal(describeThreats([]), null);
  assert.equal(describeThreats(null), null);
  assert.equal(describeThreats(["Trojan:Win32/Emotet"]).technical, "Trojan:Win32/Emotet");
  assert.equal(describeThreats(["A", "B"]).technical, "A, B");
});
