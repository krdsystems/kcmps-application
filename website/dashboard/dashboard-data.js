/* ============================================================
   KCMPS Ops Dashboard — DATA LAYER (mock, backend-shaped)
   ============================================================
   No backend exists yet. Everything here reads/writes a single
   localStorage blob, but every function's SIGNATURE AND RETURN
   SHAPE mirrors what the real API (API Gateway + Lambda +
   DynamoDB, see ../../ops-dashboard/infra/backend-infra-to-deploy.md) will return.

   Swapping mock -> real backend later means replacing the body of
   each exported function with a `fetch()` call — nothing that
   calls these functions (today.html, week.html, etc.) should need
   to change. This is the same "one seam" pattern already used by
   store.js for the storefront cart.

   Line-item state machine (mirrors Ops Dashboard Project Knowledge §5.1):
   Pending Payment Verification -> Confirmed -> Scheduled ->
   In Production -> QC -> Ready for Dispatch -> Dispatched -> Delivered
   Custom entry: Quoted -> Priced -> Confirmed -> [rejoins above]
   Exceptions: Quote Expired, Payment Rejected, Cancelled,
   Auto-Cancelled, Rework (loops back to In Production, sets NRFT)

   Mixed cart + GCash bridge (mirrors ../../project_knowledge/
   Payment_System_Project_Knowledge.md, "Bridge Payment Method: Manual
   GCash Verification"):
   - An order can hold BOTH `sku` (pay-now) and `custom` (pay-on-quote)
     line items at once — same orderId, independent per-line status,
     orderStatus is a derived rollup (e.g. "Partially Fulfilled: SKU
     items shipped, custom item in production" — see the seed order
     tagged MIXED-CART below for a worked example).
   - `sku` items pay together as one GCash transaction at checkout, so
     the proof (screenshot, reference number, claimed amount) and the
     verify/reject decision live on the ORDER's `payment` object, not
     per line item — see `getOrder(id).payment` and `verifyPayment` /
     `rejectPayment` below. Verifying/rejecting an order affects every
     `sku` line item currently `Pending Payment Verification` on it
     together, matching "one GCash payment for the sum of sku items."
   - `custom` items get their OWN follow-up payment link per line item
     once priced (`Priced` -> `Confirmed`) — that path stays a plain
     per-line-item transition via `advanceLineItem`, no shared
     order-level payment object involved.
   ============================================================ */

(function (global) {
  const STORAGE_KEY = "kcmps_dashboard_mock_v1";
  const STATIONS = ["PRESS-01", "DIGITAL-01", "3DPRINT-01", "HEATPRESS-01", "FINISHING-01"];
  const STATION_LABELS = {
    "PRESS-01": "Silkscreen Press",
    "DIGITAL-01": "Digital / Large Format",
    "3DPRINT-01": "3D Printing",
    "HEATPRESS-01": "Heat Press / Apparel",
    "FINISHING-01": "Finishing / Packing",
  };
  const PLANNED_HOURS_PER_WEEK = { "PRESS-01": 40, "DIGITAL-01": 32, "3DPRINT-01": 60, "HEATPRESS-01": 36, "FINISHING-01": 30 };

  /* ---- live backend (Milestone 1.3) ----
     getAllOrders/getOrder/verifyPayment/rejectPayment/advanceLineItem are
     the only functions in this file that hit a real backend — everything
     else here (metrics, inventory, clients, mail, manual-order entry,
     rework/spoilage) stays on the localStorage mock, matching the
     roadmap's explicit 1.3 checklist scope.

     Uses the ID token (not the access token) from sessionStorage's
     kcmps_tokens — the JWT authorizer and the Lambdas' role checks both
     need `aud` and `cognito:groups`, which only the ID token carries. */
  const API_BASE = "https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com";
  const TOKEN_STORAGE_KEY = "kcmps_tokens";
  function idToken() {
    try {
      const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      const tokens = raw ? JSON.parse(raw) : null;
      return tokens && tokens.id_token ? tokens.id_token : null;
    } catch { return null; }
  }
  function authHeaders() {
    const token = idToken();
    return token ? { Authorization: "Bearer " + token } : {};
  }
  async function apiFetch(path, opts) {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts && opts.headers) },
    });
    let body = {};
    try { body = await res.json(); } catch { /* empty/non-JSON body */ }
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }

  // Real orders (create-order.js) don't share every field name the mock
  // seed data uses — normalize here, once, so no .html needs to know the
  // difference. `li.name` -> `li.description`, synthesize a flat
  // `order.client.name` from `order.customerContact`/`customerName` since
  // real orders have no nested client object.
  function normalizeOrder(order) {
    order.client = order.client || { name: order.customerName };
    (order.lineItems || []).forEach((li) => { li.description = li.description || li.name; });
    return order;
  }

  // Populated by the last getAllOrders()/getOrder() call so getEventsFor()
  // (called synchronously right after, by job-detail.html's render()) can
  // serve real EVENT# records without a second round trip.
  let liveOrdersCache = null;
  const SPOILAGE_REASONS = [
    { code: "registration", label: "Registration / misalignment" },
    { code: "ink", label: "Ink / colour" },
    { code: "material", label: "Material defect" },
    { code: "operator", label: "Operator error" },
    { code: "prepress", label: "File / prepress error" },
    { code: "machine", label: "Machine fault" },
  ];

  function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
  function isoMonth(d) { return new Date(d).toISOString().slice(0, 7); }
  function nowIso() { return new Date().toISOString(); }
  function hoursAgo(n) { return new Date(Date.now() - n * 3600 * 1000).toISOString(); }
  function daysAgo(n) { return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString(); }
  function daysFromNow(n) { return new Date(Date.now() + n * 24 * 3600 * 1000).toISOString(); }
  function uid(prefix) { return prefix + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(); }

  // Shapes the order.payment.submittedAt/claimedAmount/gcashRefNumber/
  // screenshotRef/verifiedBy/verifiedAt/rejectionReason fields exactly as
  // specified in the Payment System file's "Data Model Addition" section.
  // Module-scoped (not nested in buildSeed()) because createManualOrder()
  // needs it too, for staff-entered orders with GCash proof already in hand.
  function gcashProof(claimedAmount, gcashRefNumber, submittedAt, opts) {
    opts = opts || {};
    return {
      method: "gcash_manual", claimedAmount, gcashRefNumber,
      screenshotRef: opts.screenshotRef || `s3://kcmps-uploads/payments/${gcashRefNumber}.jpg`,
      submittedAt,
      verifiedBy: opts.verifiedBy || null,
      verifiedAt: opts.verifiedAt || null,
      rejectionReason: opts.rejectionReason || null,
    };
  }

  /* ---- seed data: empty by default ----
     Was a large hand-written demo dataset (orders/clients/inventory/
     blockers/metrics) used to develop every dashboard page before any real
     backend existed. Milestone 1.3 cut jobs.html/job-detail.html over to
     the real API — every OTHER page (Today/Week/Month/Clients/Inventory/
     Email/Settings) still reads only this local blob. Per explicit request
     (2026-07-31), a fresh dashboard now starts genuinely empty rather than
     pre-populated with fake demo tickets — mailboxes are the one exception,
     kept as bare folder scaffolding (no messages) since email.html's layout
     assumes at least one mailbox exists. */
  function buildSeed() {
    return {
      orders: [],
      events: [],
      metrics: { day: {}, station: {}, month: {} },
      blockers: [],
      inventory: [],
      clients: [],
      mailboxes: seedMailboxes(),
      emails: [],
      stations: STATIONS,
      seededAt: nowIso(),
    };
  }

  /* ---- seed data: staff mailboxes + mock mail ----
     Shapes mirror an IMAP FETCH deliberately (see the "mail" section further
     down) so swapping these mock functions for real Lambda calls is a
     function-body change with no caller/UI change.

     NOTE: this file must stay identity-free. It loads BEFORE
     dashboard-shell.js, so it cannot read Cognito claims — the personal
     mailbox is seeded with a fixed address and email.html overrides only its
     display label from the signed-in claims. ---- */
  function seedMailboxes() {
    return [
      { id: "order@kcmps.com", address: "order@kcmps.com", label: "Orders", kind: "shared", canSend: true },
      { id: "info@kcmps.com", address: "info@kcmps.com", label: "General enquiries", kind: "shared", canSend: true },
      { id: "me@kcmps.com", address: "me@kcmps.com", label: "My mailbox", kind: "personal", canSend: true },
    ];
  }

  function seedEmails(orders) {
    const ord = (i) => (orders && orders[i] ? orders[i].orderId : null);
    const threadA = uid("THR");
    const msg = (o) => Object.assign({
      messageId: uid("MSG"), uid: 0, folder: "INBOX", threadId: uid("THR"),
      to: [{ name: "", address: o.mailboxId }], cc: [],
      snippet: "", hasHtmlPart: false, attachments: [],
      flags: { seen: true, answered: false, flagged: false }, relatedOrderId: null,
    }, o, { snippet: (o.snippet || o.bodyText || "").replace(/\s+/g, " ").slice(0, 140) });

    let n = 10400;
    const withUid = (m) => Object.assign(m, { uid: n++ });

    return [
      /* — order@kcmps.com — */
      withUid(msg({
        mailboxId: "order@kcmps.com", threadId: threadA,
        from: { name: "Mika Reyes", address: "mika.reyes@gmail.com" },
        subject: "Follow up po sa 30 pcs DTF shirts",
        date: hoursAgo(2), relatedOrderId: ord(0),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Hi KCMPS!\n\nNag-place po ako ng order kahapon for 30 pcs DTF shirts, black.\nNakapag-GCash na po ako kaninang umaga. Pwede po bang ma-confirm kung na-receive niyo na?\n\nSalamat po!\nMika",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "GCash", address: "no-reply@gcash.com" },
        subject: "You have received PHP 9,000.00",
        date: hoursAgo(3),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "You have received PHP 9,000.00 from MIKA R.\nReference No. 8017 442 99331\nDate: today\n\nThis is an automated notification. Do not reply to this message.",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "Ateneo Dev Society", address: "events@ateneodev.org" },
        subject: "Pwede pa bang mag-add ng 10 pcs?",
        date: hoursAgo(7), relatedOrderId: ord(1),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Good afternoon,\n\nMay we add 10 more pieces to our existing order? Same design, sizes L and XL.\nIf it delays the schedule we can also do it as a separate batch.\n\nThank you,\nPaolo",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "Bea Fernandez", address: "bea.fernandez@yahoo.com" },
        subject: "Ready na po ba for pickup?",
        date: daysAgo(1),
        bodyText: "Hello po, tanong ko lang kung pwede na po ma-pickup yung tote bags ko this week? Salamat!",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "GCash", address: "no-reply@gcash.com" },
        subject: "You have received PHP 2,450.00",
        date: daysAgo(1),
        bodyText: "You have received PHP 2,450.00 from BEA F.\nReference No. 8017 118 20044\n\nThis is an automated notification. Do not reply to this message.",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "Grind Coffee Co.", address: "ops@grindcoffee.ph" },
        subject: "Reorder — 50 pcs staff aprons",
        date: daysAgo(2),
        bodyText: "Hi team,\n\nSame spec as our last run — 50 pcs, embroidered logo, charcoal.\nPlease send a quote and we'll process payment right away.\n\nRegards,\nDenise",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com", threadId: threadA,
        from: { name: "KCMPS Orders", address: "order@kcmps.com" },
        subject: "Re: Follow up po sa 30 pcs DTF shirts",
        folder: "SENT", date: hoursAgo(26),
        bodyText: "Hi Mika,\n\nReceived po ang order niyo. Under verification pa po ang payment — we'll confirm within 24 hours.\n\nSalamat po!\nKCMPS",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com", threadId: threadA,
        from: { name: "Mika Reyes", address: "mika.reyes@gmail.com" },
        subject: "Re: Follow up po sa 30 pcs DTF shirts",
        date: hoursAgo(28),
        bodyText: "Sending po the GCash screenshot. Reference number is 8017 442 99331.\n\nThanks!",
        attachments: [{ filename: "gcash-receipt.jpg", sizeBytes: 284310, mimeType: "image/jpeg" }],
      })),

      /* — info@kcmps.com — */
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "Sunrise Ink Supply", address: "sales@sunriseink.com.ph" },
        subject: "Quotation — DTF film & white ink (Q3 pricing)",
        date: hoursAgo(5),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Good day KCMPS,\n\nAttached is our updated quotation for DTF film rolls and white ink.\nPrices are valid for 30 days. Free delivery within Metro Manila for orders over PHP 15,000.\n\nBest regards,\nArnel Cruz\nSunrise Ink Supply",
        attachments: [{ filename: "sunrise-quotation-q3.pdf", sizeBytes: 141882, mimeType: "application/pdf" }],
      })),
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "HeatPro Parts", address: "support@heatpro.asia" },
        subject: "Backorder notice — thermostat assembly",
        date: daysAgo(2),
        bodyText: "Dear customer,\n\nThe thermostat assembly you ordered is on backorder until the 18th.\nWe can ship the rest of your order now, or hold it complete. Please advise.\n\nHeatPro Parts",
      })),
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "PrintTech Expo", address: "news@printtechexpo.com" },
        subject: "Last call: exhibitor booths for 2026",
        date: daysAgo(4), hasHtmlPart: true,
        bodyText: "View this email in your browser. Book your booth before slots run out.",
      })),
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "QC South Barangay", address: "sportsfest@qcsouth.gov.ph" },
        subject: "Request for quotation — 200 pcs event shirts",
        date: daysAgo(5),
        bodyText: "Magandang araw,\n\nWe are canvassing suppliers for 200 pcs event shirts for our sports fest.\nKindly send your quotation with unit price and lead time.\n\nSalamat,\nBarangay QC South",
      })),

      /* — personal — */
      withUid(msg({
        mailboxId: "me@kcmps.com",
        from: { name: "Mikko Dela Cruz", address: "mikko@kcmps.com" },
        subject: "Heat press #2 — still inconsistent",
        date: hoursAgo(9),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Boss, yung heat press #2 pa rin. Nag-vary ng 15 degrees kanina mid-run.\nBaka kailangan na talaga i-replace yung thermostat. Nag-email na ako sa HeatPro.\n\n- Mikko",
      })),
      withUid(msg({
        mailboxId: "me@kcmps.com",
        from: { name: "Spaceship Billing", address: "billing@spaceship.com" },
        subject: "Your invoice is ready",
        date: daysAgo(6),
        bodyText: "Your monthly invoice for kcmps.com services is now available in your account dashboard.",
      })),
    ];
  }

  function deriveOrderStatus(order) {
    const statuses = order.lineItems.map((li) => li.status);
    if (statuses.every((s) => s === "Delivered")) return "Delivered";
    if (statuses.some((s) => s === "Delivered") && statuses.some((s) => s !== "Delivered" && !["Cancelled", "Quote Expired"].includes(s))) return "Partially Fulfilled";
    if (statuses.some((s) => s === "Pending Payment Verification")) return "Pending Payment Verification";
    if (statuses.some((s) => s === "Rework")) return "Rework";
    if (statuses.some((s) => s === "In Production")) return "In Production";
    if (statuses.some((s) => s === "Quoted")) return "Awaiting Quote";
    if (statuses.some((s) => s === "Priced")) return "Awaiting Payment";
    return statuses[0] || "Unknown";
  }

  /* ---- persistence ----
     ADDITIVE MIGRATION, not a key bump. When a new top-level collection is
     added to buildSeed(), anyone with an existing STORAGE_KEY blob would read
     it as `undefined`. Bumping STORAGE_KEY would fix that by throwing away
     every tester's in-progress mock state (advanced jobs, logged spoilage,
     blockers) for a feature that has nothing to do with orders — so instead
     ensureCollections() backfills just the missing collection and saves.
     Follow this pattern for the next collection (Design Library), and keep
     the backfill's related collections under ONE guard so a partial blob
     can't produce e.g. mailboxes-without-messages. ---- */
  function ensureCollections(state) {
    let dirty = false;
    if (!Array.isArray(state.mailboxes) || !Array.isArray(state.emails)) {
      state.mailboxes = seedMailboxes();
      state.emails = seedEmails(state.orders);
      dirty = true;
    }
    state.orders.forEach((o) => {
      if (!Array.isArray(o.correspondenceLog)) { o.correspondenceLog = []; dirty = true; }
    });
    if (dirty) save(state);
    return state;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // ensureCollections runs ONLY here, never in buildSeed() — buildSeed
      // already includes every collection, so calling it there double-seeds.
      if (raw) return ensureCollections(JSON.parse(raw));
    } catch (e) { console.warn("[dash-data] corrupt state, reseeding", e); }
    const seed = buildSeed();
    save(seed);
    return seed;
  }
  function save(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function resetSeed() { const seed = buildSeed(); save(seed); return seed; }

  /* ---- derived helpers ---- */
  function allLineItemsFrom(orders) {
    const out = [];
    orders.forEach((o) => o.lineItems.forEach((li) => out.push(Object.assign({ order: o }, li))));
    return out;
  }
  function allLineItems(state) { return allLineItemsFrom(state.orders); }
  function agingHours(li) { return (Date.now() - new Date(li.enteredStatusAt).getTime()) / 3600000; }
  function sortByAging(list) { return list.slice().sort((a, b) => new Date(a.enteredStatusAt) - new Date(b.enteredStatusAt)); }

  const SLA_HOURS = {
    "Pending Payment Verification": { warn: 2, red: 4, expire: 48 },
    "Quoted": { warn: 12, red: 18, expire: 24 },
    "Priced": { warn: 36, red: 48, expire: 168 },
  };

  // Async because it now merges in real orders (Milestone 1.3's
  // getAllOrders() already merges those with any mock-only manual orders) —
  // a real order advanced via job-detail.html only ever lands in DynamoDB,
  // never in the localStorage blob `load()` reads, so reading `state.orders`
  // alone here would silently never reflect it.
  async function getQueues() {
    const orders = await getAllOrders();
    const items = allLineItemsFrom(orders);
    const q = {
      pendingPaymentVerification: items.filter((li) => li.status === "Pending Payment Verification"),
      awaitingQuote: items.filter((li) => li.type === "custom" && li.status === "Quoted"),
      awaitingCustomerPayment: items.filter((li) => li.status === "Priced"),
      readyToProduce: items.filter((li) => li.status === "Confirmed"),
      inProduction: items.filter((li) => li.status === "In Production"),
      qcHoldRework: items.filter((li) => li.status === "Rework" || li.status === "QC"),
      readyForDispatch: items.filter((li) => li.status === "Ready for Dispatch"),
    };
    Object.keys(q).forEach((k) => { q[k] = sortByAging(q[k]).map(decorateLineItem); });
    return q;
  }

  function decorateLineItem(li) {
    const hrs = agingHours(li);
    const sla = SLA_HOURS[li.status];
    let slaState = "ok";
    if (sla) {
      if (hrs >= sla.red) slaState = "red";
      else if (hrs >= sla.warn) slaState = "warn";
    }
    const dueDate = li.order.originalPromisedDate;
    const dueInDays = dueDate ? Math.ceil((new Date(dueDate) - Date.now()) / 86400000) : null;
    return Object.assign({}, li, {
      agingHours: Math.round(hrs * 10) / 10,
      slaState,
      dueDate,
      dueInDays,
      dueRisk: dueInDays !== null && dueInDays <= 2 && !["Delivered", "Ready for Dispatch", "Dispatched"].includes(li.status),
      // Payment System file's staff-dashboard spec: "New queue: Pending
      // Verification — shows screenshot, reference number, claimed amount,
      // order ID, timestamp." Lives on order.payment (§ header note above),
      // surfaced here so the queue card doesn't need a second lookup.
      payment: li.status === "Pending Payment Verification" ? li.order.payment : null,
    });
  }

  // Async for the same reason as getQueues() above — dueToday/wipCount need
  // real line-item statuses, not just the (now-empty-by-default) mock blob.
  // The yesterday/today spoilage/cash/output rollups still come from
  // state.metrics — no live METRIC# rollup Lambda exists yet (see
  // backend/CLAUDE.md's jobs/ section), so those stay a known, accepted gap.
  async function getTodayNumbers() {
    const state = load();
    const orders = await getAllOrders();
    const items = allLineItemsFrom(orders);
    const todayKey = isoDay(nowIso());
    const yestKey = isoDay(daysAgo(1));
    const dayY = state.metrics.day[yestKey] || { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 0 };
    const dayT = state.metrics.day[todayKey] || { spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0 };
    const dueToday = items.filter((li) => li.dueDate ? isoDay(li.order.originalPromisedDate) === todayKey : isoDay(li.order.originalPromisedDate) <= todayKey);
    const dueTodayList = items.filter((li) => isoDay(li.order.originalPromisedDate) <= todayKey && !["Delivered", "Dispatched", "Cancelled", "Quote Expired"].includes(li.status));
    const atRisk = dueTodayList.filter((li) => !["In Production", "QC", "Ready for Dispatch"].includes(li.status));
    const wipStatuses = ["Confirmed", "Scheduled", "In Production", "QC", "Rework", "Ready for Dispatch"];
    const wip = items.filter((li) => wipStatuses.includes(li.status));
    return {
      dueToday: dueTodayList.length,
      dueTodayAtRisk: atRisk.length,
      outputYesterdayUnits: dayY.unitsOut, outputYesterdayJobs: dayY.jobsCompleted,
      spoilageYesterdayUnits: dayY.spoilageUnits, spoilageYesterdayValue: dayY.spoilageValue,
      reworkOpenedYesterday: dayY.reworkOpened,
      cashCollectedYesterday: dayY.cashCollected,
      spoilageTodayUnits: dayT.spoilageUnits, spoilageTodayValue: dayT.spoilageValue,
      wipCount: wip.length,
    };
  }

  function getLowStock() {
    const state = load();
    return state.inventory.map((i) => Object.assign({}, i, {
      lowStock: i.qty <= i.reorderPoint,
      daysOfCover: i.avgDailyUse > 0 ? Math.floor(i.qty / i.avgDailyUse) : null,
    })).filter((i) => i.lowStock).sort((a, b) => a.daysOfCover - b.daysOfCover);
  }

  function getBlockers(includeResolved) {
    const state = load();
    let list = state.blockers.slice();
    if (!includeResolved) list = list.filter((b) => !b.resolved);
    // recurring tag detection: same tag 3+ times in 30 days (across resolved+open)
    const cutoff = Date.now() - 30 * 86400000;
    const tagCounts = {};
    state.blockers.forEach((b) => { if (new Date(b.createdAt).getTime() >= cutoff) tagCounts[b.tag] = (tagCounts[b.tag] || 0) + 1; });
    return list
      .map((b) => Object.assign({}, b, { recurring: b.tag ? tagCounts[b.tag] >= 3 : false }))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function addBlocker({ text, owner, dueDate, tag }) {
    const state = load();
    if (!text || !owner || !dueDate) throw new Error("Blocker requires text, owner, and dueDate.");
    state.blockers.push({ id: uid("BLK"), text, owner, dueDate, tag: tag || "", createdAt: nowIso(), resolved: false });
    save(state);
    return getBlockers();
  }
  function resolveBlocker(id) {
    const state = load();
    const b = state.blockers.find((x) => x.id === id);
    if (b) b.resolved = true;
    save(state);
    return getBlockers();
  }

  /* ---- line item transitions (mirrors the Streams-derived event write) ---- */
  const NEXT_STATUS = {
    "Pending Payment Verification": "Confirmed",
    "Quoted": "Priced",
    "Priced": "Confirmed",
    "Confirmed": "Scheduled",
    "Scheduled": "In Production",
    "In Production": "QC",
    "QC": "Ready for Dispatch",
    "Ready for Dispatch": "Dispatched",
    "Dispatched": "Delivered",
  };

  // Manual orders (createManualOrder, below) have no backend Lambda in
  // 1.3's scope and only ever exist in the mock — real orders are never
  // written there. Check the mock first so a manual order's buttons keep
  // working exactly as before, and only real orders go over the wire.
  function isMockOnlyOrder(orderId) {
    return !!load().orders.find((o) => o.orderId === orderId);
  }

  async function advanceLineItem(orderId, lineItemId, opts) {
    opts = opts || {};
    if (isMockOnlyOrder(orderId)) return advanceLineItemMock(orderId, lineItemId, opts);
    if (!opts.to) throw new Error("advanceLineItem requires opts.to — no caller depends on the mock's NEXT_STATUS fallback, and the real API doesn't guess.");
    return apiFetch("/line-items/" + encodeURIComponent(lineItemId) + "/advance", {
      method: "POST",
      body: JSON.stringify({
        orderId, lineItemId, to: opts.to,
        station: opts.station, setupMinutes: opts.setupMinutes, meta: opts.meta,
      }),
    });
  }

  function advanceLineItemMock(orderId, lineItemId, opts) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    const li = order && order.lineItems.find((x) => x.lineItemId === lineItemId);
    if (!li) throw new Error("Line item not found: " + orderId + "/" + lineItemId);
    const from = li.status;
    const to = opts.to || NEXT_STATUS[from];
    if (!to) throw new Error("No default next status from '" + from + "' — pass opts.to explicitly.");
    li.status = to;
    li.enteredStatusAt = nowIso();
    if (opts.station) li.station = opts.station;
    if (opts.setupMinutes != null) li.setupMinutes = opts.setupMinutes;
    state.events.push({
      pk: "ORDER#" + orderId, sk: "EVENT#" + nowIso() + "#" + lineItemId,
      orderId, lineItemId, from, to, actorSub: "current-user", actorName: opts.actorName || "You",
      station: li.station || null, at: nowIso(), meta: opts.meta || {},
    });
    order.orderStatus = deriveOrderStatus(order);
    bumpTodayMetric(state, to, li);
    save(state);
    return li;
  }

  /* ---- GCash bridge verify/reject (order-level — see header note) ----
     Mirrors the Payment System file's verifyPayment / rejectPayment
     Lambdas: one GCash transaction verified/rejected together advances
     (or rejects) every `sku` line item on that order still sitting in
     `Pending Payment Verification`, and stamps the audit fields on
     order.payment (verifiedBy/verifiedAt, or rejectionReason). ---- */
  // `staffName` is accepted for call-site compatibility but not sent — the
  // real Lambda derives the actor from the verified JWT claims server-side,
  // which is strictly more trustworthy than a client-supplied name.
  async function verifyPayment(orderId, staffName) {
    if (isMockOnlyOrder(orderId)) return verifyPaymentMock(orderId, staffName);
    return apiFetch("/orders/" + encodeURIComponent(orderId) + "/verify-payment", { method: "POST", body: "{}" });
  }

  function verifyPaymentMock(orderId, staffName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    if (!order.payment) throw new Error("Order has no GCash payment proof on file: " + orderId);
    const pending = order.lineItems.filter((li) => li.status === "Pending Payment Verification");
    if (!pending.length) throw new Error("No line items on this order are awaiting verification.");
    const now = nowIso();
    pending.forEach((li) => {
      const from = li.status;
      li.status = "Confirmed";
      li.enteredStatusAt = now;
      state.events.push({
        pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#" + li.lineItemId,
        orderId, lineItemId: li.lineItemId, from, to: "Confirmed",
        actorSub: "current-user", actorName: staffName || "You",
        station: li.station || null, at: now, meta: { via: "verifyPayment" },
      });
      bumpTodayMetric(state, "Confirmed", li);
    });
    order.payment.verifiedBy = staffName || "You";
    order.payment.verifiedAt = now;
    order.payment.rejectionReason = null;
    order.orderStatus = deriveOrderStatus(order);
    save(state);
    return order;
  }

  async function rejectPayment(orderId, rejectionReason, staffName) {
    if (!rejectionReason) throw new Error("A rejection reason is required.");
    if (isMockOnlyOrder(orderId)) return rejectPaymentMock(orderId, rejectionReason, staffName);
    return apiFetch("/orders/" + encodeURIComponent(orderId) + "/reject-payment", {
      method: "POST",
      body: JSON.stringify({ reason: rejectionReason }),
    });
  }

  function rejectPaymentMock(orderId, rejectionReason, staffName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    const pending = order.lineItems.filter((li) => li.status === "Pending Payment Verification");
    if (!pending.length) throw new Error("No line items on this order are awaiting verification.");
    const now = nowIso();
    pending.forEach((li) => {
      const from = li.status;
      li.status = "Payment Rejected";
      li.enteredStatusAt = now;
      state.events.push({
        pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#" + li.lineItemId,
        orderId, lineItemId: li.lineItemId, from, to: "Payment Rejected",
        actorSub: "current-user", actorName: staffName || "You",
        station: li.station || null, at: now, meta: { via: "rejectPayment", rejectionReason },
      });
    });
    if (order.payment) {
      order.payment.rejectionReason = rejectionReason;
      order.payment.verifiedBy = null;
      order.payment.verifiedAt = null;
    }
    order.orderStatus = deriveOrderStatus(order);
    save(state);
    return order;
  }

  function sendToRework(orderId, lineItemId, spoilage) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    const li = order.lineItems.find((x) => x.lineItemId === lineItemId);
    const from = li.status;
    li.status = "Rework";
    li.enteredStatusAt = nowIso();
    if (spoilage && spoilage.units) {
      li.spoilage.push({ units: spoilage.units, reasonCode: spoilage.reasonCode, valuePhp: spoilage.valuePhp || 0, at: nowIso() });
    }
    state.events.push({ pk: "ORDER#" + orderId, sk: "EVENT#" + nowIso() + "#" + lineItemId, orderId, lineItemId, from, to: "Rework", actorSub: "current-user", actorName: "You", station: li.station, at: nowIso(), meta: { spoilage } });
    order.orderStatus = deriveOrderStatus(order);
    const todayKey = isoDay(nowIso());
    const d = state.metrics.day[todayKey] || (state.metrics.day[todayKey] = { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 0, quotesSent: 0, quotesAccepted: 0, otifHits: 0, otifMisses: 0 });
    d.reworkOpened += 1;
    if (spoilage && spoilage.units) { d.spoilageUnits += spoilage.units; d.spoilageValue += (spoilage.valuePhp || 0); }
    save(state);
    return li;
  }

  function bumpTodayMetric(state, toStatus, li) {
    const todayKey = isoDay(nowIso());
    const d = state.metrics.day[todayKey] || (state.metrics.day[todayKey] = { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 0, quotesSent: 0, quotesAccepted: 0, otifHits: 0, otifMisses: 0 });
    if (toStatus === "Quoted") d.quotesSent += 1;
    // Only a custom item's Priced -> Confirmed transition is a quote
    // acceptance. A sku item's Pending Payment Verification -> Confirmed
    // (via verifyPayment) is a GCash verification, not a quote — counting
    // it here would inflate the Week view's quote-conversion rate.
    if (toStatus === "Confirmed" && li.type === "custom") d.quotesAccepted += 1;
    if (toStatus === "Delivered") {
      d.jobsCompleted += 1; d.unitsOut += (li.qty || 1); d.cashCollected += (li.amount || 0);
      const onTime = new Date() <= new Date(li.order.originalPromisedDate || li.order.createdAt);
      if (onTime) d.otifHits += 1; else d.otifMisses += 1;
    }
    if (toStatus === "In Production" && li.station) {
      const stationDay = state.metrics.station[todayKey] || (state.metrics.station[todayKey] = {});
      const st = stationDay[li.station] || (stationDay[li.station] = { productionMinutes: 0, setupMinutes: 0, jobsRun: 0 });
      st.setupMinutes += (li.setupMinutes || 0);
      st.jobsRun += 1;
    }
  }

  function setSetupMinutes(orderId, lineItemId, minutes, station) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    const li = order.lineItems.find((x) => x.lineItemId === lineItemId);
    li.setupMinutes = minutes;
    if (station) li.station = station;
    save(state);
    return li;
  }

  /* ---- week view ---- */
  function getWeekData() {
    const state = load();
    const items = allLineItems(state);
    const stationAgg = {};
    STATIONS.forEach((s) => { stationAgg[s] = { station: s, label: STATION_LABELS[s], plannedHours: PLANNED_HOURS_PER_WEEK[s], productionMinutes: 0, setupMinutes: 0, jobsRun: 0, wip: 0, jobs: [] }; });
    items.filter((li) => li.station && ["In Production", "QC", "Rework", "Scheduled"].includes(li.status)).forEach((li) => {
      const agg = stationAgg[li.station];
      if (!agg) return;
      agg.wip += 1;
      agg.jobs.push(li);
    });
    // fold in this-week's completed minutes from the metric rollup (last 7 days)
    Object.keys(state.metrics.station || {}).forEach((dateKey) => {
      const dayAgo = (Date.now() - new Date(dateKey).getTime()) / 86400000;
      if (dayAgo > 7) return;
      Object.entries(state.metrics.station[dateKey]).forEach(([st, v]) => {
        if (!stationAgg[st]) return;
        stationAgg[st].productionMinutes += v.productionMinutes;
        stationAgg[st].setupMinutes += v.setupMinutes;
        stationAgg[st].jobsRun += v.jobsRun;
      });
    });
    const stations = Object.values(stationAgg).map((s) => {
      const committedHours = Math.round((s.productionMinutes / 60) * 10) / 10;
      const utilizationPct = s.plannedHours ? Math.round((committedHours / s.plannedHours) * 1000) / 10 : 0;
      const bookableHours = Math.max(0, Math.round((s.plannedHours - committedHours) * 10) / 10);
      const committedPct = s.plannedHours ? Math.round((committedHours / s.plannedHours) * 1000) / 10 : 0;
      return Object.assign(s, { committedHours, utilizationPct, bookableHours, committedPct, overThreshold: committedPct > 85, throughput: s.jobsRun });
    });

    // batching suggestions: group queued/ready items sharing station + a material keyword
    const queueable = items.filter((li) => ["Confirmed", "Scheduled"].includes(li.status));
    const groups = {};
    queueable.forEach((li) => {
      const key = (li.sku || guessMaterial(li.description)) + "|" + (li.station || "unassigned");
      (groups[key] = groups[key] || []).push(li);
    });
    const batching = Object.entries(groups).filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({
      key, count: arr.length, items: arr, estimatedSetupSavedMinutes: (arr.length - 1) * 15,
    }));

    // quote conversion this week
    const last7 = Object.keys(state.metrics.day).filter((d) => (Date.now() - new Date(d).getTime()) / 86400000 <= 7);
    let quotesSent = 0, quotesAccepted = 0;
    last7.forEach((d) => { quotesSent += state.metrics.day[d].quotesSent || 0; quotesAccepted += state.metrics.day[d].quotesAccepted || 0; });

    return {
      stations,
      batching,
      quoteConversion: { quotesSent, quotesAccepted, rate: quotesSent ? Math.round((quotesAccepted / quotesSent) * 100) : null },
      recurringBlockers: getBlockers().filter((b) => b.recurring),
    };
  }
  function guessMaterial(desc) {
    const d = (desc || "").toLowerCase();
    if (d.includes("shirt")) return "shirt-dtf";
    if (d.includes("mug")) return "mug";
    if (d.includes("3d") || d.includes("print") && d.includes("pla")) return "3d-pla";
    if (d.includes("lanyard")) return "lanyard";
    return "misc";
  }

  /* ---- month view ---- */
  function getMonthData() {
    const state = load();
    const key = isoMonth(nowIso());
    const m = state.metrics.month[key] || { summary: {}, pillar: {} };
    const s = m.summary;
    const otifPct = (s.otifHits + s.otifMisses) ? Math.round((s.otifHits / (s.otifHits + s.otifMisses)) * 1000) / 10 : null;
    const nrftPct = s.jobCount ? Math.round((s.nrftCount / s.jobCount) * 1000) / 10 : null;
    const spoilageRate = s.revenue ? Math.round((s.spoilageValue / s.revenue) * 10000) / 100 : null;
    const marginPct = (pillar) => pillar.revenue ? Math.round(((pillar.revenue - pillar.materialCost - pillar.laborCost) / pillar.revenue) * 1000) / 10 : null;
    const pillars = Object.entries(m.pillar || {}).map(([name, p]) => Object.assign({ name }, p, {
      grossMargin: p.revenue - p.materialCost - p.laborCost,
      marginPct: marginPct(p),
      costVariance: p.actualCost - p.estimatedCost,
      costVariancePct: p.estimatedCost ? Math.round(((p.actualCost - p.estimatedCost) / p.estimatedCost) * 1000) / 10 : null,
    }));
    const quietClients = state.clients.filter((c) => c.reorderIntervalDays && (Date.now() - new Date(c.lastOrderAt).getTime()) / 86400000 > c.reorderIntervalDays);
    const topClients = state.clients.slice().sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 10);
    const repeatRevenue = state.clients.filter((c) => c.type === "B2B").reduce((sum, c) => sum + c.totalRevenue, 0);
    const repeatRatePct = s.revenue ? Math.round((repeatRevenue / s.revenue) * 1000) / 10 : null;
    return {
      monthKey: key, summary: s, otifPct, nrftPct, spoilageRate, pillars,
      quietClients, topClients, repeatRatePct,
      cashOutstanding: s.cashOutstanding, cashCollected: s.cashCollected,
    };
  }

  function getStations() { return STATIONS.map((s) => ({ id: s, label: STATION_LABELS[s] })); }
  function getSpoilageReasons() { return SPOILAGE_REASONS.slice(); }
  function getClients() { return load().clients.slice(); }
  function getInventoryAll() { return load().inventory.slice(); }
  function adjustInventory(sku, qty) {
    const state = load();
    const item = state.inventory.find((i) => i.sku === sku);
    if (item) item.qty = qty;
    save(state);
    return state.inventory;
  }
  async function getAllOrders() {
    const { orders } = await apiFetch("/orders", { method: "GET" });
    const normalized = (orders || []).map(normalizeOrder);
    // createManualOrder() (below) still writes mock-only orders — it has
    // no backend Lambda in 1.3's scope. Merge them in so "Log a manual
    // order" doesn't silently vanish from the live jobs list; real orders
    // never carry source:"manual", so there's no collision risk.
    const manualOnly = load().orders.filter((o) => o.source === "manual");
    const merged = normalized.concat(manualOnly);
    liveOrdersCache = merged;
    return merged;
  }
  async function getOrder(orderId) {
    const orders = await getAllOrders();
    return orders.find((o) => o.orderId === orderId);
  }
  // Synchronous by design — job-detail.html's render() calls this
  // immediately after `await getOrder(orderId)`, so liveOrdersCache is
  // already populated from that same fetch.
  function getEventsFor(orderId) {
    // Only real (non-manual) orders carry a real .events array from the
    // backend — a manual order found in the cache (merged in above) has no
    // .events property at all, so it correctly falls through to the mock.
    const live = liveOrdersCache && liveOrdersCache.find((o) => o.orderId === orderId && o.events);
    if (live) return live.events.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    return load().events.filter((e) => e.orderId === orderId).sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  /* ---- manual order entry ----
     For clients who order by chat/DM/in person rather than the storefront
     cart — jobs.html's "Log a manual order" form is the only caller. Produces
     the exact same ORDER#/LINEITEM# shape `makeOrder()` builds for seed data
     (plus a `source: "manual"` flag so the UI can badge it), so every queue,
     the Jobs list, and job-detail.html's advance-this-job actions treat it
     identically to a checkout-originated order — no separate code path
     downstream of creation.

     Status is restricted to values that don't imply an in-app step that
     didn't happen (e.g. never "Ready for Dispatch" straight out of the
     gate). "Pending Payment Verification" always requires a GCash ref +
     claimed amount so order.payment is populated exactly like the real
     checkout bridge — otherwise the ticket's own "Verify payment" button
     would throw (verifyPayment() requires order.payment to exist).

     "Confirmed" covers payment already in hand by ANY method — talk-in/DM
     clients often pay cash on the spot, not just GCash. Cash has no proof
     object to verify (there's no screenshot/ref number to cross-check), so
     it's recorded as a plain note on the line item instead of forcing it
     through the GCash-shaped order.payment object job-detail.html renders
     with GCash-specific labels (reference number, claimed amount). ---- */
  const MANUAL_ORDER_STATUSES = {
    sku: ["Pending Payment Verification", "Confirmed"],
    custom: ["Quoted", "Priced", "Confirmed"],
  };

  function createManualOrder(opts) {
    opts = opts || {};
    const description = (opts.description || "").trim();
    if (!description) throw new Error("A description is required.");
    if (!opts.promisedDate) throw new Error("A promised date is required.");

    const state = load();
    let client;
    if (opts.newClientName && opts.newClientName.trim()) {
      client = {
        id: uid("C"), name: opts.newClientName.trim(),
        type: opts.newClientType === "B2B" ? "B2B" : "B2C",
        totalRevenue: 0, lastOrderAt: nowIso(), reorderIntervalDays: null,
      };
      state.clients.push(client);
    } else {
      client = state.clients.find((c) => c.id === opts.clientId);
      if (!client) throw new Error("Select an existing client or enter a new client name.");
    }

    const type = opts.type === "custom" ? "custom" : "sku";
    const allowedStatuses = MANUAL_ORDER_STATUSES[type];
    const status = allowedStatuses.includes(opts.status) ? opts.status : allowedStatuses[0];
    const qty = Math.max(1, parseInt(opts.qty, 10) || 1);
    const priceEach = opts.priceEach !== "" && opts.priceEach != null && !isNaN(parseFloat(opts.priceEach))
      ? parseFloat(opts.priceEach) : null;
    const amount = priceEach != null ? Math.round(priceEach * qty * 100) / 100 : 0;

    let payment = null;
    if (status === "Pending Payment Verification") {
      const ref = (opts.gcashRefNumber || "").trim();
      const claimed = parseFloat(opts.claimedAmount);
      if (!ref) throw new Error("A GCash reference number is required for Pending Payment Verification.");
      if (!(claimed > 0)) throw new Error("A claimed amount is required for Pending Payment Verification.");
      payment = gcashProof(claimed, ref, nowIso());
    }

    // Confirmed = already paid, by whatever method — logged as a note since
    // cash has no proof object to attach (see header note above).
    let notes = (opts.notes || "").trim();
    if (status === "Confirmed" && opts.paidVia) {
      const viaLabel = opts.paidVia === "cash" ? "Cash" : opts.paidVia === "gcash" ? "GCash" : "Other";
      const ref = (opts.paidRef || "").trim();
      const paidNote = "Paid via " + viaLabel + (ref ? " (ref " + ref + ")" : "") + ".";
      notes = notes ? paidNote + " " + notes : paidNote;
    }

    const now = nowIso();
    const orderId = uid("ORD");
    const lineItemId = uid("L");
    const lineItem = {
      lineItemId, orderId, type, qty,
      priceEach: priceEach != null ? priceEach : 0, amount,
      sku: (opts.sku || "").trim() || undefined,
      description, status, station: null, setupMinutes: null,
      spoilage: [], enteredStatusAt: now,
      notes,
    };
    const order = {
      orderId, client, customerSub: null, createdAt: now,
      originalPromisedDate: opts.promisedDate, lineItems: [lineItem],
      payment, correspondenceLog: [], source: "manual",
    };
    order.orderStatus = deriveOrderStatus(order);
    state.orders.push(order);
    client.lastOrderAt = now;

    state.events.push({
      pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#" + lineItemId,
      orderId, lineItemId, from: null, to: status,
      actorSub: "current-user", actorName: opts.actorName || "You",
      station: null, at: now, meta: { via: "manualOrder" },
    });

    save(state);
    return order;
  }

  // Manual order↔email linking: staff log a note referencing a Spacemail
  // thread (never the email body itself — no mail content is stored here).
  // See docs/roadmap.md "Order↔email linking" for why this replaced the
  // SES-relay/Google-Workspace approach.
  function addCorrespondenceLog(orderId, note, actorName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    if (!note || !note.trim()) throw new Error("A note is required.");
    if (!Array.isArray(order.correspondenceLog)) order.correspondenceLog = [];
    order.correspondenceLog.push({ at: nowIso(), note: note.trim(), actorName: actorName || "—" });
    save(state);
    return order.correspondenceLog;
  }

  /* ============================================================
     MAIL — staff email panel (mock; see docs/roadmap.md "Parallel track —
     Staff email panel")
     ============================================================
     Every shape here is chosen to be directly derivable from a real IMAP
     response, so the eventual swap to getInboxMessages/sendEmail Lambdas is a
     function-BODY change only:

       messageId  <- RFC822 Message-ID      uid       <- IMAP UID (stable cursor)
       from/to/cc <- ENVELOPE               date      <- INTERNALDATE
       snippet    <- BODY.PEEK[1]<0.200>    bodyText  <- text/plain part
       flags      <- \Seen \Answered \Flagged
       hasHtmlPart / attachments <- BODYSTRUCTURE

     The envelope/body split is deliberate: real IMAP fetches the list
     (ENVELOPE) and the body (BODY[]) in two round-trips, so getMessages()
     omits bodyText/attachments and getMessage() adds them. Mirroring that now
     means the list view never has to change shape later.
     ============================================================ */

  function findMailbox(state, mailboxId) {
    const mb = state.mailboxes.find((m) => m.id === mailboxId);
    if (!mb) throw new Error("Unknown mailbox: " + mailboxId);
    return mb;
  }
  function isInbox(m) { return m.folder === "INBOX"; }
  function envelopeOf(m) {
    // strip the body-only fields — the list must not depend on them
    const e = Object.assign({}, m);
    delete e.bodyText;
    delete e.attachments;
    return e;
  }

  function getMailboxes() {
    const state = load();
    return state.mailboxes.map((mb) => {
      const mine = state.emails.filter((m) => m.mailboxId === mb.id && isInbox(m));
      return Object.assign({}, mb, {
        total: mine.length,
        unreadCount: mine.filter((m) => !m.flags.seen).length,
      });
    });
  }

  function getMessages(mailboxId, opts) {
    const o = opts || {};
    const folder = o.folder || "INBOX";
    const limit = o.limit || 50;
    const search = (o.search || "").trim().toLowerCase();
    const state = load();
    findMailbox(state, mailboxId);

    let rows = state.emails.filter((m) => m.mailboxId === mailboxId && m.folder === folder);
    const total = rows.length;
    const unreadCount = rows.filter((m) => !m.flags.seen).length;
    if (search) {
      rows = rows.filter((m) =>
        (m.subject || "").toLowerCase().includes(search) ||
        (m.from.name || "").toLowerCase().includes(search) ||
        (m.from.address || "").toLowerCase().includes(search) ||
        (m.snippet || "").toLowerCase().includes(search)
      );
    }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    const page = rows.slice(0, limit);
    return {
      mailboxId, folder, total, unreadCount,
      messages: page.map(envelopeOf),
      // real backend: lowest UID in the page, fed back as opts.cursor
      nextCursor: rows.length > limit ? page[page.length - 1].uid : null,
    };
  }

  function getMessage(mailboxId, messageId) {
    const state = load();
    findMailbox(state, mailboxId);
    return state.emails.find((m) => m.mailboxId === mailboxId && m.messageId === messageId);
  }

  function getThread(mailboxId, threadId) {
    const state = load();
    findMailbox(state, mailboxId);
    return state.emails
      .filter((m) => m.mailboxId === mailboxId && m.threadId === threadId)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  function markMessageRead(mailboxId, messageId, seen) {
    const state = load();
    findMailbox(state, mailboxId);
    const m = state.emails.find((x) => x.mailboxId === mailboxId && x.messageId === messageId);
    if (!m) throw new Error("Unknown message: " + messageId);
    m.flags.seen = seen !== false;
    save(state);
    return getMessages(mailboxId);
  }

  function sendReply(mailboxId, messageId, payload) {
    const p = payload || {};
    const bodyText = (p.bodyText || "").trim();
    if (!bodyText) throw new Error("Reply body cannot be empty.");
    const state = load();
    const mb = findMailbox(state, mailboxId);
    if (!mb.canSend) throw new Error("This mailbox is read-only.");
    const original = state.emails.find((x) => x.mailboxId === mailboxId && x.messageId === messageId);
    if (!original) throw new Error("Unknown message: " + messageId);

    const subject = /^re:/i.test(original.subject) ? original.subject : "Re: " + original.subject;
    const sent = {
      messageId: uid("MSG"),
      uid: Math.max.apply(null, state.emails.map((m) => m.uid)) + 1,
      mailboxId, folder: "SENT", threadId: original.threadId,
      from: { name: "KCMPS", address: mb.address },
      to: [original.from], cc: p.cc || [],
      subject, date: nowIso(),
      snippet: bodyText.replace(/\s+/g, " ").slice(0, 140),
      bodyText, hasHtmlPart: false, attachments: [],
      flags: { seen: true, answered: false, flagged: false },
      relatedOrderId: original.relatedOrderId || null,
    };
    // The three side effects a real send performs: SMTP send, IMAP APPEND to
    // Sent, and STORE +FLAGS (\Answered) on the original.
    state.emails.push(sent);
    original.flags.answered = true;
    original.flags.seen = true;
    save(state);
    return { sent, list: getMessages(mailboxId) };
  }

  global.KCMPS_DASH = {
    STORAGE_KEY, STATIONS, STATION_LABELS,
    getMailboxes, getMessages, getMessage, getThread, markMessageRead, sendReply,
    getQueues, getTodayNumbers, getLowStock, getBlockers, addBlocker, resolveBlocker,
    advanceLineItem, sendToRework, setSetupMinutes, verifyPayment, rejectPayment,
    getWeekData, getMonthData,
    getStations, getSpoilageReasons, getClients, getInventoryAll, adjustInventory,
    getOrder, getAllOrders, getEventsFor, addCorrespondenceLog,
    createManualOrder,
    resetSeed,
  };
})(window);
