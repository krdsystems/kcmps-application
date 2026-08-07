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
const { STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES, SCAN_STATUS, isCleanScanVerdict } = require("./constants");
const { hasRole, isStaff, getGroups, requireRole, extractClaims, ROLES } = require("./auth");
const { deriveOrderStatus } = require("./order-status");
const { redactForCustomer } = require("./customer-view");
const { resolveUploadType, extensionOf, MAX_UPLOAD_BYTES, contentDispositionFor, INLINE_VIEWABLE_TYPES } = require("./upload-types");
const { sniffFamily, isConfidentMismatch } = require("./magic-bytes");
const { normalizeOrderId } = require("./keys");
const { isValidQuotePrice } = require("./money");
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

test("requireRole allows a caller holding any required role, in every claim form", () => {
  assert.equal(requireRole({ "cognito:groups": "[Admin]" }, ROLES.ADMIN), null);
  assert.equal(requireRole({ "cognito:groups": "[Staff Admin]" }, [ROLES.SALES, ROLES.ADMIN]), null);
  assert.equal(requireRole({ "cognito:groups": ["Production"] }, [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN]), null);
});

test("requireRole denies (403 shape) when no required role is held — fail closed", () => {
  const denied = requireRole({ "cognito:groups": "[Customer]" }, [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN]);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, "Forbidden");
  assert.deepEqual(denied.requiredRoles, [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN]);
  // No claims / no groups at all must also deny, never throw.
  assert.equal(requireRole(null, ROLES.ADMIN).statusCode, 403);
  assert.equal(requireRole({}, ROLES.ADMIN).statusCode, 403);
  // A Finance caller is staff but must NOT pass a Production/Sales/Admin gate
  // (the exact distinction the asset-library write routes rely on).
  assert.equal(requireRole({ "cognito:groups": "[Finance]" }, [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN]).statusCode, 403);
  // Role names are exact — a look-alike group must not satisfy the gate.
  assert.equal(requireRole({ "cognito:groups": "[Administrator]" }, ROLES.ADMIN).statusCode, 403);
});

test("extractClaims only returns the JWT-authorizer claims path, null otherwise", () => {
  const claims = { sub: "abc", "cognito:groups": "[Admin]" };
  assert.equal(extractClaims({ requestContext: { authorizer: { jwt: { claims } } } }), claims);
  // Every partial/absent shape is null — an unauthorized route must read as
  // "no claims", never throw or hand back a truthy empty object.
  assert.equal(extractClaims(undefined), null);
  assert.equal(extractClaims({}), null);
  assert.equal(extractClaims({ requestContext: {} }), null);
  assert.equal(extractClaims({ requestContext: { authorizer: {} } }), null);
  assert.equal(extractClaims({ requestContext: { authorizer: { jwt: {} } } }), null);
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

test("redactForCustomer strips order tags and their audit events entirely", () => {
  const order = {
    orderId: "ORD-1",
    tags: [{ key: "Type", value: "Reprint" }, { key: "Test", value: "" }],
    lineItems: [],
    events: [
      { at: "2026-01-01T00:00:00Z", from: null, to: "Quoted", meta: { via: "createOrder" } },
      {
        at: "2026-01-01T01:00:00Z", from: null, to: "Tags updated", lineItemId: "ORDER",
        actorSub: "sub-1", actorName: "Staffer",
        meta: { via: "setTags", added: [{ key: "Type", value: "Reprint" }], removed: [], changed: [] },
      },
    ],
  };
  const redacted = redactForCustomer(order);

  assert.equal("tags" in redacted, false);
  assert.equal(redacted.events.length, 1);
  assert.equal(redacted.events[0].to, "Quoted");
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

test("resolveUploadType accepts SVG at the upload layer (allowed 2026-08-07 — see upload-types.js header)", () => {
  assert.equal(resolveUploadType("image/svg+xml", "logo.svg"), "svg");
  // Still requires the declared type and extension to agree, same as
  // every other format — this isn't a looser check for SVG specifically.
  assert.equal(resolveUploadType("image/svg+xml", "logo.png"), null);
  assert.equal(resolveUploadType("image/png", "logo.svg"), null);
});

test("resolveUploadType still rejects archives (deliberately off the allowlist)", () => {
  // Archives are opaque to Content-Type checks — see upload-types.js's
  // header for why that category alone is still excluded.
  assert.equal(resolveUploadType("application/zip", "bundle.zip"), null);
  assert.equal(resolveUploadType("application/x-7z-compressed", "bundle.7z"), null);
  assert.equal(resolveUploadType("text/html", "index.html"), null);
});

test("SECURITY: an accepted SVG upload can NEVER be served inline — the two allowlists must stay in disagreement", () => {
  // This is the load-bearing assertion for the whole "SVG allowed but
  // attachment-only" decision: resolveUploadType() accepts image/svg+xml
  // (upload-time gate) but INLINE_VIEWABLE_TYPES/contentDispositionFor()
  // (download-time gate) must never include it. If a future change adds
  // "image/svg+xml" to INLINE_VIEWABLE_TYPES, this test fails.
  assert.equal(resolveUploadType("image/svg+xml", "logo.svg"), "svg");
  assert.equal(INLINE_VIEWABLE_TYPES.has("image/svg+xml"), false);
  const disposition = contentDispositionFor("image/svg+xml", "logo.svg");
  assert.match(disposition.ResponseContentDisposition, /^attachment;/);
  assert.equal(disposition.ResponseContentType, "application/octet-stream");
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

// ---- mail.js (shared-mailbox access model + inbound routing) ----
// Personal mailboxes were removed on 2026-08-06 (owner scope decision: a
// forward-based mirror is a one-way copy, so it's the wrong architecture
// for an individual's inbox). Their tests went with them; everything below
// covers live behaviour only.

const {
  MAILBOX_ACCESS, canAccessMailbox, visibleMailboxes, canSendFrom, sendAddressFor,
  normalizeMailboxId, isMailbox, resolveMailboxes, isRoutableAlias,
  isInfrastructureNotice, assessVerdicts, normalizeVerdict,
  MIRROR_ADDRESS, UNROUTED_MAILBOX, QUARANTINE_MAILBOX,
} = require("./mail");

// mailboxId is the REAL address now, never the mirror address.
const ORDER_MB = "order@kcmps.com";
const INFO_MB = "info@kcmps.com";
const ADMIN_MB = "admin@kcmps.com";

// API Gateway hands groups over as a bracketed space-separated string —
// build claims the same way so these tests exercise getGroups' real path.
const claimsFor = (groups, sub) => ({ "cognito:groups": "[" + groups.join(" ") + "]", sub: sub || "sub-anon" });

test("MAILBOX_ACCESS is keyed by the real address, not the mirror address", () => {
  // The mirror domain is plumbing; it must not leak into the data model or
  // the staff UI. C4 depends on this: mailboxIds are @kcmps.com.
  for (const id of Object.keys(MAILBOX_ACCESS)) {
    assert.equal(id.endsWith("@kcmps.com"), true, id);
    assert.equal(id.includes("mirror."), false, id);
  }
  assert.equal(MIRROR_ADDRESS, "shop@mirror.kcmps.com");
});

test("MAILBOX_ACCESS encodes the roadmap matrix for the shared mailboxes", () => {
  assert.deepEqual([...MAILBOX_ACCESS[ORDER_MB].roles].sort(), ["Admin", "Finance", "Sales"]);
  assert.deepEqual([...MAILBOX_ACCESS[INFO_MB].roles].sort(), ["Admin", "Sales"]);
  assert.deepEqual([...MAILBOX_ACCESS[ADMIN_MB].roles], ["Admin"]);
  // Finance is order@-only: it must NOT reach general enquiries.
  assert.equal(MAILBOX_ACCESS[INFO_MB].roles.includes("Finance"), false);
});

test("canAccessMailbox: order@ allows Sales/Finance/Admin, denies Production", () => {
  assert.equal(canAccessMailbox(claimsFor(["Sales"]), ORDER_MB), true);
  assert.equal(canAccessMailbox(claimsFor(["Finance"]), ORDER_MB), true);
  assert.equal(canAccessMailbox(claimsFor(["Admin"]), ORDER_MB), true);
  assert.equal(canAccessMailbox(claimsFor(["Production"]), ORDER_MB), false);
});

test("canAccessMailbox: info@ allows Sales/Admin, denies Finance and Production", () => {
  assert.equal(canAccessMailbox(claimsFor(["Sales"]), INFO_MB), true);
  assert.equal(canAccessMailbox(claimsFor(["Admin"]), INFO_MB), true);
  assert.equal(canAccessMailbox(claimsFor(["Finance"]), INFO_MB), false);
  assert.equal(canAccessMailbox(claimsFor(["Production"]), INFO_MB), false);
});

test("canAccessMailbox: Customer is denied every mailbox", () => {
  for (const mb of Object.keys(MAILBOX_ACCESS)) {
    assert.equal(canAccessMailbox(claimsFor(["Customer"]), mb), false, mb);
  }
});

test("canAccessMailbox: Production reaches nothing at all", () => {
  // Personal mailboxes are gone, so Production — a role with no mail duty —
  // now has no mail access whatsoever. That is the intended end state.
  const prod = claimsFor(["Production"]);
  for (const mb of Object.keys(MAILBOX_ACCESS)) {
    assert.equal(canAccessMailbox(prod, mb), false, mb);
  }
  assert.deepEqual(visibleMailboxes(prod), []);
});

test("canAccessMailbox is purely group-based — the sub claim cannot influence it", () => {
  // The old model matched a personal mailbox on claims.sub, which made a
  // client-supplied sub the sharpest trap in the feature. There is no
  // sub-reading path left; pin that by varying the sub and asserting the
  // decision never moves.
  for (const sub of ["", "sub-a", "sub-b", "admin@kcmps.com"]) {
    assert.equal(canAccessMailbox(claimsFor(["Sales"], sub), ORDER_MB), true, sub);
    assert.equal(canAccessMailbox(claimsFor(["Sales"], sub), ADMIN_MB), false, sub);
  }
});

test("canAccessMailbox fails closed on unknown mailboxes, empty input, and no groups", () => {
  assert.equal(canAccessMailbox(claimsFor(["Admin"]), "nobody@kcmps.com"), false);
  assert.equal(canAccessMailbox(claimsFor(["Admin"]), "order@evil.example"), false);
  // The retired mirror-address ids must NOT resolve any more.
  assert.equal(canAccessMailbox(claimsFor(["Admin"]), "order@mirror.kcmps.com"), false);
  assert.equal(canAccessMailbox(claimsFor(["Admin"]), ""), false);
  assert.equal(canAccessMailbox(null, ORDER_MB), false);
  assert.equal(canAccessMailbox({ sub: "sub-1" }, ORDER_MB), false); // no groups claim
});

test("canAccessMailbox normalizes case and surrounding whitespace on mailboxId", () => {
  assert.equal(canAccessMailbox(claimsFor(["Sales"]), "  ORDER@KCMPS.com "), true);
});

test("canAccessMailbox: system mailboxes are Admin-only", () => {
  for (const mb of [UNROUTED_MAILBOX, "unparseable@kcmps.com", QUARANTINE_MAILBOX]) {
    assert.equal(canAccessMailbox(claimsFor(["Admin"]), mb), true, mb);
    assert.equal(canAccessMailbox(claimsFor(["Sales"]), mb), false, mb);
    assert.equal(canAccessMailbox(claimsFor(["Staff"]), mb), false, mb);
  }
});

// Owner decision 2026-08-06 (commit 49dad04): `Staff` is the "may open the
// dashboard" tier, not a capability. Mail access must come from a role
// (Sales/Finance/Admin) so a future hire who only needs the job queue can't
// silently read customer correspondence. See lib/mail.js's header.
test("canAccessMailbox: Staff alone opens no mailbox — capability comes from roles, not the access tier", () => {
  const staff = claimsFor(["Staff"]);
  assert.equal(canAccessMailbox(staff, ORDER_MB), false);
  assert.equal(canAccessMailbox(staff, INFO_MB), false);
  assert.equal(canAccessMailbox(staff, ADMIN_MB), false);
  assert.deepEqual(visibleMailboxes(staff), []);

  // ...but Staff+Sales (how a founder account should actually be set up) works.
  const staffSales = claimsFor(["Staff", "Sales"]);
  assert.equal(canAccessMailbox(staffSales, ORDER_MB), true);
  assert.equal(canAccessMailbox(staffSales, INFO_MB), true);
  assert.equal(canAccessMailbox(staffSales, ADMIN_MB), false);
});

test("visibleMailboxes lists what a caller may open and never leaks the roles allow-list", () => {
  const sales = visibleMailboxes(claimsFor(["Sales"]));
  assert.deepEqual(sales.map((m) => m.id).sort(), [INFO_MB, ORDER_MB].sort());
  assert.equal(sales.every((m) => m.roles === undefined), true);

  assert.deepEqual(visibleMailboxes(claimsFor(["Customer"])), []);
  assert.deepEqual(visibleMailboxes(claimsFor(["Finance"])).map((m) => m.id), [ORDER_MB]);
  // Admin sees all 3 shared + all 3 system mailboxes.
  assert.equal(visibleMailboxes(claimsFor(["Admin"])).length, 6);
});

test("canSendFrom allows the shared mailboxes but never the system ones", () => {
  assert.equal(canSendFrom(ORDER_MB), true);
  assert.equal(canSendFrom(INFO_MB), true);
  assert.equal(canSendFrom(ADMIN_MB), true);
  assert.equal(canSendFrom(UNROUTED_MAILBOX), false);
  assert.equal(canSendFrom("unparseable@kcmps.com"), false);
  assert.equal(canSendFrom(QUARANTINE_MAILBOX), false);
  assert.equal(canSendFrom("nobody@kcmps.com"), false);
});

test("sendAddressFor returns the verified sending identity only for sendable mailboxes", () => {
  assert.equal(sendAddressFor(ORDER_MB), "order@kcmps.com");
  assert.equal(sendAddressFor("Info@KCMPS.com"), "info@kcmps.com");
  // System mailboxes, unknown ids, and the retired mirror domain (SES will
  // not send from a receiving identity) all return null so a caller can't
  // be tricked into sending as an arbitrary address.
  assert.equal(sendAddressFor(UNROUTED_MAILBOX), null);
  assert.equal(sendAddressFor("order@mirror.kcmps.com"), null);
  assert.equal(sendAddressFor("order@evil.example"), null);
  assert.equal(sendAddressFor(""), null);
  assert.equal(sendAddressFor(null), null);
});

test("normalizeMailboxId and isMailbox behave for known and unknown ids", () => {
  assert.equal(normalizeMailboxId("  ORDER@KCMPS.com "), ORDER_MB);
  assert.equal(normalizeMailboxId(null), "");
  assert.equal(isMailbox(ORDER_MB), true);
  assert.equal(isMailbox(UNROUTED_MAILBOX), true);
  assert.equal(isMailbox("order@mirror.kcmps.com"), false);
  assert.equal(isMailbox("nope@kcmps.com"), false);
});

// ---- inbound routing ----

test("resolveMailboxes prefers the forwarder header over To:/Cc:", () => {
  // The BCC case, which is the whole reason the envelope header wins: the
  // message names info@ in To: but was actually delivered to order@.
  const r = resolveMailboxes({ forwardedTo: ["order@kcmps.com"], toCc: ["info@kcmps.com"] });
  assert.deepEqual(r.mailboxes, ["order@kcmps.com"]);
  assert.equal(r.routedBy, "forwarder");
});

test("resolveMailboxes falls back to To:/Cc: when no forwarder header is present", () => {
  const r = resolveMailboxes({ forwardedTo: [], toCc: ["Info@KCMPS.com"] });
  assert.deepEqual(r.mailboxes, [INFO_MB]);
  assert.equal(r.routedBy, "to-cc");
});

test("resolveMailboxes routes a true BCC (no To:/Cc: at all) off the forwarder header", () => {
  const r = resolveMailboxes({ forwardedTo: ["order@kcmps.com"], toCc: [] });
  assert.deepEqual(r.mailboxes, ["order@kcmps.com"]);
});

test("resolveMailboxes fans out to every alias named, deduped and normalized", () => {
  const r = resolveMailboxes({ forwardedTo: ["ORDER@kcmps.com", "order@kcmps.com", "info@kcmps.com"] });
  assert.deepEqual(r.mailboxes, [ORDER_MB, INFO_MB]);
});

test("resolveMailboxes sends unknown recipients to ONE unrouted mailbox, never a new one", () => {
  const r = resolveMailboxes({ forwardedTo: ["sales@kcmps.com"], toCc: ["hello@kcmps.com"] });
  assert.deepEqual(r.mailboxes, [UNROUTED_MAILBOX]);
  assert.equal(r.routedBy, "unrouted");
  // Nothing at all -> still unrouted, never empty, never dropped.
  assert.deepEqual(resolveMailboxes({}).mailboxes, [UNROUTED_MAILBOX]);
  assert.deepEqual(resolveMailboxes().mailboxes, [UNROUTED_MAILBOX]);
});

test("resolveMailboxes never routes into a system mailbox by address", () => {
  // A sender must not be able to address their way into quarantine@ or
  // unparseable@ and have it show up as ordinary mail there.
  for (const mb of [QUARANTINE_MAILBOX, "unparseable@kcmps.com", UNROUTED_MAILBOX]) {
    assert.equal(isRoutableAlias(mb), false, mb);
    assert.equal(resolveMailboxes({ toCc: [mb] }).routedBy, "unrouted", mb);
  }
});

test("resolveMailboxes diverts AWS infrastructure notices out of the customer view", () => {
  // Both SNS topics alerting this shop are subscribed to admin@kcmps.com,
  // the exact mailbox being forwarded — without this, every CloudWatch
  // alarm lands next to real customer mail. Backstop only; the primary fix
  // is a Spacemail-side filter (see backend/infra/README.md).
  const r = resolveMailboxes({ forwardedTo: [ADMIN_MB], from: "no-reply@sns.amazonaws.com" });
  assert.deepEqual(r.mailboxes, [UNROUTED_MAILBOX]);
  assert.equal(r.routedBy, "infra-notice");
  assert.equal(isInfrastructureNotice("No-Reply@SNS.amazonaws.com"), true);
  assert.equal(isInfrastructureNotice("no-reply-aws@amazon.com"), true);
  // A real customer must not be caught by it.
  assert.equal(isInfrastructureNotice("someone@gmail.com"), false);
  assert.equal(resolveMailboxes({ forwardedTo: [ADMIN_MB], from: "customer@gmail.com" }).routedBy, "forwarder");
});

// ---- SES verdicts ----

test("assessVerdicts hard-rejects virus and spam", () => {
  assert.equal(assessVerdicts({ virusVerdict: "FAIL", spamVerdict: "PASS" }).quarantine, true);
  assert.equal(assessVerdicts({ virusVerdict: "PASS", spamVerdict: "FAIL" }).quarantine, true);
  assert.match(assessVerdicts({ virusVerdict: "FAIL" }).reason, /virus/i);
  assert.match(assessVerdicts({ virusVerdict: "PASS", spamVerdict: "FAIL" }).reason, /spam/i);
});

test("assessVerdicts NEVER rejects on SPF — forwarding breaks SPF by design", () => {
  // This is the single most important assertion in this block: enforcing
  // SPF would discard every legitimate forwarded message, i.e. all of them.
  const a = assessVerdicts({ spfVerdict: "FAIL", dkimVerdict: "PASS", spamVerdict: "PASS", virusVerdict: "PASS" });
  assert.equal(a.quarantine, false);
  assert.equal(a.reason, null);
  assert.equal(a.verdicts.spf, "FAIL"); // recorded, just not enforced
});

test("assessVerdicts treats a DKIM pass as the positive signal", () => {
  assert.equal(assessVerdicts({ dkimVerdict: "pass" }).authenticated, true);
  // Absent DKIM is "unverified", not "hostile" — plenty of small senders
  // still don't sign, and quarantining them would lose real customer mail.
  assert.equal(assessVerdicts({}).authenticated, false);
  assert.equal(assessVerdicts({}).quarantine, false);
  assert.equal(assessVerdicts({ dkimVerdict: "fail" }).quarantine, false);
});

test("assessVerdicts persists all four verdicts and never launders an unknown one into PASS", () => {
  const a = assessVerdicts({ spfVerdict: "pass", dkimVerdict: "pass", spamVerdict: "PASS", virusVerdict: "PASS" });
  assert.deepEqual(a.verdicts, { spf: "PASS", dkim: "PASS", spam: "PASS", virus: "PASS" });
  assert.equal(a.quarantine, false);

  assert.equal(normalizeVerdict(""), "UNKNOWN");
  assert.equal(normalizeVerdict(null), "UNKNOWN");
  assert.equal(normalizeVerdict("GRAY"), "UNKNOWN");
  assert.equal(normalizeVerdict("PROCESSING_FAILED"), "UNKNOWN");
  assert.equal(normalizeVerdict("softfail"), "FAIL");
  assert.equal(normalizeVerdict("weird"), "WEIRD");
  // A missing scanner verdict must not quarantine (fail-open on scanning is
  // correct here: SES always stamps these, so UNKNOWN means "not an SES
  // receipt", e.g. a replayed test fixture — not "hostile").
  assert.equal(assessVerdicts({ spamVerdict: "", virusVerdict: "" }).quarantine, false);
  // ...but an unrecognized non-PASS value DOES quarantine (fail closed on
  // anything SES actually said that we don't recognize).
  assert.equal(assessVerdicts({ virusVerdict: "weird" }).quarantine, true);
});

/* ---- contentDispositionFor: inline viewing allowlist ----
   Security-relevant: this decides whether a customer-uploaded file renders in
   the browser or is forced to disk. The allowlist must stay closed. */
test("contentDispositionFor: images and PDF are served inline with their real type", () => {
  for (const t of ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]) {
    const r = contentDispositionFor(t, "proof.jpg");
    assert.match(r.ResponseContentDisposition, /^inline;/, t + " should be inline");
    assert.equal(r.ResponseContentType, t);
  }
});

test("contentDispositionFor: SVG and scriptable types are NEVER inline", () => {
  // An SVG is a script container — rendering one executes its JavaScript.
  for (const t of ["image/svg+xml", "text/html", "application/javascript", "text/xml", ""]) {
    const r = contentDispositionFor(t, "x.svg");
    assert.match(r.ResponseContentDisposition, /^attachment;/, t + " must download");
    assert.equal(r.ResponseContentType, "application/octet-stream");
  }
});

test("contentDispositionFor: allowInline:false forces download even for an allowed type", () => {
  const r = contentDispositionFor("application/pdf", "spec.pdf", { allowInline: false });
  assert.match(r.ResponseContentDisposition, /^attachment;/);
  assert.equal(r.ResponseContentType, "application/octet-stream");
});

test("contentDispositionFor: filename cannot break out of the quoted header", () => {
  const r = contentDispositionFor("image/png", 'evil".png\r\nX-Injected: 1');
  assert.ok(!r.ResponseContentDisposition.includes('"evil"'), "quote must not survive");
  assert.ok(!/[\r\n]/.test(r.ResponseContentDisposition), "CR/LF must not survive");
  const r2 = contentDispositionFor("image/png", "é".repeat(300));
  const name = /filename="([^"]*)"/.exec(r2.ResponseContentDisposition)[1];
  assert.ok(name.length <= 120, "filename must be length-capped, got " + name.length);
  assert.equal(contentDispositionFor("image/png", "").ResponseContentDisposition, 'inline; filename="file"');
});

// ---- magic-bytes.js (disguised-file / content-vs-extension detection) ----

test("sniffFamily recognizes real file signatures", () => {
  assert.equal(sniffFamily(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(sniffFamily(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(sniffFamily(Buffer.from("%PDF-1.4", "ascii")), "pdf");
  assert.equal(sniffFamily(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), "ole");
  assert.equal(sniffFamily(Buffer.from([0x50, 0x4b, 0x03, 0x04])), "zip");
  assert.equal(sniffFamily(Buffer.from("8BPS")), "psd");
  assert.equal(sniffFamily(Buffer.from("<?xml version=\"1.0\"?>\n<svg xmlns=\"x\">")), "svg");
  assert.equal(sniffFamily(Buffer.from("<svg width=\"1\">")), "svg");
});

test("sniffFamily returns null for unrecognized/empty content", () => {
  assert.equal(sniffFamily(Buffer.from("just some plain text, not a known format")), null);
  assert.equal(sniffFamily(Buffer.alloc(0)), null);
  assert.equal(sniffFamily(null), null);
});

test("isConfidentMismatch: THE disguised-file UAT case — a JPEG renamed to .pdf", () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(isConfidentMismatch("pdf", jpegBytes), true);
  // The genuine article is not flagged.
  assert.equal(isConfidentMismatch("jpg", jpegBytes), false);
});

test("isConfidentMismatch never flags an inconclusive/unrecognized sniff (avoid false positives on real files)", () => {
  const unknown = Buffer.from("plain ASCII content that matches no signature");
  assert.equal(isConfidentMismatch("pdf", unknown), false);
  assert.equal(isConfidentMismatch("doc", unknown), false);
});

test("isConfidentMismatch accepts either legitimate signature family for .ai/.eps (modern=PDF-based, legacy=PostScript)", () => {
  assert.equal(isConfidentMismatch("ai", Buffer.from("%PDF-1.6 fake-ai")), false);
  assert.equal(isConfidentMismatch("ai", Buffer.from("%!PS-Adobe-3.0")), false);
  assert.equal(isConfidentMismatch("eps", Buffer.from("%!PS-Adobe-3.0 EPSF-3.0")), false);
});

test("isConfidentMismatch: modern Office (docx/xlsx/pptx) must sniff as zip, legacy (doc/xls/ppt) as OLE", () => {
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const oleBytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(isConfidentMismatch("docx", zipBytes), false);
  assert.equal(isConfidentMismatch("docx", oleBytes), true); // a real .doc renamed to .docx
  assert.equal(isConfidentMismatch("doc", oleBytes), false);
  assert.equal(isConfidentMismatch("doc", zipBytes), true); // a real .docx renamed to .doc
});

// ---- keys.js's normalizeOrderId (guest order lookup, bare-suffix UAT fix) ----

test("normalizeOrderId accepts the bare suffix as well as the full ORD- id", () => {
  assert.equal(normalizeOrderId("ORD-3A94793FF8"), "ORD-3A94793FF8");
  assert.equal(normalizeOrderId("3A94793FF8"), "ORD-3A94793FF8");
});

test("normalizeOrderId is case-insensitive and whitespace-tolerant", () => {
  assert.equal(normalizeOrderId("ord-3a94793ff8"), "ORD-3A94793FF8");
  assert.equal(normalizeOrderId("3a94793ff8"), "ORD-3A94793FF8");
  assert.equal(normalizeOrderId("  3A94793FF8  "), "ORD-3A94793FF8");
  assert.equal(normalizeOrderId("  ord-3a94793ff8  "), "ORD-3A94793FF8");
});

test("normalizeOrderId does not double-prefix and handles empty input", () => {
  assert.equal(normalizeOrderId("ORD-ORD-XXXX"), "ORD-ORD-XXXX"); // already has the prefix once, left alone
  assert.equal(normalizeOrderId(""), "");
  assert.equal(normalizeOrderId(null), "");
  assert.equal(normalizeOrderId(undefined), "");
});

// ---- money.js's isValidQuotePrice (custom-quote pricing gate, UAT fix) ----

test("isValidQuotePrice accepts positive finite numbers and numeric strings", () => {
  assert.equal(isValidQuotePrice(250), true);
  assert.equal(isValidQuotePrice(0.5), true);
  assert.equal(isValidQuotePrice("250"), true);
  assert.equal(isValidQuotePrice("250.75"), true);
});

test("isValidQuotePrice rejects zero, negative, non-finite, and non-numeric values", () => {
  assert.equal(isValidQuotePrice(0), false);
  assert.equal(isValidQuotePrice(-10), false);
  assert.equal(isValidQuotePrice(NaN), false);
  assert.equal(isValidQuotePrice(Infinity), false);
  assert.equal(isValidQuotePrice(""), false);
  assert.equal(isValidQuotePrice(null), false);
  assert.equal(isValidQuotePrice(undefined), false);
  assert.equal(isValidQuotePrice("free"), false);
  assert.equal(isValidQuotePrice({}), false);
});

/* ---- constants.js's isCleanScanVerdict / SCAN_STATUS ----
   The ONE fail-closed predicate every upload read path (staff-api/get-
   orders.js, staff-api/get-messages.js, checkout/lookup-order.js) must
   gate a presigned URL behind. Added 2026-08-07 after review found
   checkout/lookup-order.js's payment-screenshot presign had drifted from
   its sibling in staff-api/get-orders.js and skipped this check entirely
   — a pre-existing bug, not introduced by that day's SVG/UAT work. */
test("isCleanScanVerdict is true ONLY for a persisted NO_THREATS_FOUND verdict", () => {
  assert.equal(isCleanScanVerdict({ scanStatus: "NO_THREATS_FOUND" }), true);
  assert.equal(isCleanScanVerdict({ scanStatus: SCAN_STATUS.CLEAN }), true);
});

test("isCleanScanVerdict fails closed: missing, pending, threatened, or absent verdicts are all NOT clean", () => {
  assert.equal(isCleanScanVerdict({ scanStatus: "THREATS_FOUND" }), false);
  assert.equal(isCleanScanVerdict({ scanStatus: "UNSUPPORTED" }), false);
  assert.equal(isCleanScanVerdict({ scanStatus: "PENDING" }), false);
  assert.equal(isCleanScanVerdict({ scanStatus: undefined }), false);
  assert.equal(isCleanScanVerdict({}), false); // no verdict persisted yet at all
  assert.equal(isCleanScanVerdict(null), false);
  assert.equal(isCleanScanVerdict(undefined), false);
});

test("SCAN_STATUS.CLEAN is the exact GuardDuty string every read path compares against", () => {
  assert.equal(SCAN_STATUS.CLEAN, "NO_THREATS_FOUND");
});
