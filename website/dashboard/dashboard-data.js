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
   Exceptions: Quote Expired, On Hold, Cancelled,
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
     verify/hold decision live on the ORDER's `payment` object, not
     per line item — see `getOrder(id).payment` and `verifyPayment` /
     `setOnHold` below. Verifying/holding an order affects every `sku`
     line item currently awaiting verification on it together, matching
     "one GCash payment for the sum of sku items."
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
     getAllOrders/getOrder/verifyPayment/setOnHold/advanceLineItem are
     the only functions in this file that hit a real backend — everything
     else here (metrics, inventory, clients, mail, manual-order entry,
     rework/spoilage) stays on the localStorage mock, matching the
     roadmap's explicit 1.3 checklist scope.

     Uses the ID token (not the access token) from sessionStorage's
     kcmps_tokens — the JWT authorizer and the Lambdas' role checks both
     need `aud` and `cognito:groups`, which only the ID token carries. */
  // dev.kcmps.com routes staff dashboard pages to the staging backend too
  // (kcmps-backend-staging, API id 162ufc121j) — same branch as store.js's
  // CHECKOUT_API_BASE / orders-data.js's API_BASE.
  const API_BASE = (typeof location !== "undefined" && location.hostname === "dev.kcmps.com")
    ? "https://162ufc121j.execute-api.ap-southeast-1.amazonaws.com"
    : "https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com";
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
    // Mirrors orders-data.js's customer-side 401 semantics (clear tokens,
    // treat the session as gone) — but instead of an immediate hard
    // redirect, this surfaces through the shell's session-guard overlay
    // (stage 2) so staff aren't bounced mid-task and don't lose whatever
    // they were typing. The caller's promise still rejects (every existing
    // caller already has error handling for a failed apiFetch), it just
    // also raises the overlay first.
    if (res.status === 401) {
      try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
      if (global.KCMPS_DASH_SHELL && global.KCMPS_DASH_SHELL.escalateSessionGuard) {
        global.KCMPS_DASH_SHELL.escalateSessionGuard();
      }
      throw new Error("Your session has expired. Please refresh or log in again.");
    }
    let body = {};
    try { body = await res.json(); } catch { /* empty/non-JSON body */ }
    if (!res.ok) {
      // Callers that need more than a message (e.g. verifyStaffPin's 429
      // lockout handling) read status/body off the error object.
      const err = new Error(body.error || res.statusText);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // Real orders (create-order.js) don't share every field name the mock
  // seed data uses — normalize here, once, so no .html needs to know the
  // difference. `li.name` -> `li.description`, synthesize a flat
  // `order.client.name` from `order.customerName` since real orders have
  // no nested client object.
  function normalizeOrder(order) {
    order.client = order.client || { name: order.customerName };
    (order.lineItems || []).forEach((li) => { li.description = li.description || li.name; });
    order.tags = Array.isArray(order.tags) ? order.tags : [];
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
  // screenshotRef/verifiedBy/verifiedAt/holdReason fields exactly as
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
      holdReason: opts.holdReason || null,
    };
  }

  /* ---- seed data: empty by default ----
     Was a large hand-written demo dataset (orders/clients/inventory/
     blockers/metrics) used to develop every dashboard page before any real
     backend existed. Milestone 1.3 cut jobs.html/job-detail.html over to
     the real API — every OTHER page (Today/Week/Month/Clients/Inventory/
     Settings) still reads only this local blob. Per explicit request
     (2026-07-31), a fresh dashboard now starts genuinely empty rather than
     pre-populated with fake demo tickets. Mail (email.html) moved to the
     real backend/mail/*.js API on 2026-08-06 (see the "MAIL" section
     below) — it never reads this blob at all anymore, so there is no
     mailboxes/emails seed here to keep in sync. */
  function buildSeed() {
    return {
      orders: [],
      events: [],
      metrics: { day: {}, station: {}, month: {} },
      blockers: [],
      inventory: [],
      clients: [],
      stations: STATIONS,
      // Cash Book prototype (see the CASH BOOK section far below). Unlike
      // orders, this one IS seeded — it's a mock-data preview page whose
      // whole point is the owner's worked totebag example, and an empty
      // ledger would demonstrate nothing.
      seededAt: nowIso(),
    };
  }

  // Delivered (courier) and Picked Up (pickup fulfillment) are equivalent
  // terminal states for rollup purposes — §6's two fulfillment branches.
  function isFulfilled(s) { return s === "Delivered" || s === "Picked Up"; }

  // Single shared "already done — don't count toward due/at-risk" set, used
  // by both decorateLineItem()'s dueRisk and getTodayNumbers()'s
  // dueTodayList/atRisk. Two independently-maintained inline copies of this
  // same list (2026-08-13) is exactly how "Picked Up" got left out of both
  // and the Today tab kept showing stale at-risk hours for orders already
  // picked up — see backend/lib/constants.js's STATUS enum for the
  // case-sensitive canonical strings. Deliberately NOT the same set as that
  // file's TERMINAL_STATUSES: this list also treats "Dispatched" as done
  // (already out the door, no longer "due"), which isn't a backend terminal
  // status since Dispatched still transitions to Delivered.
  const FULFILLED_STATUSES = ["Delivered", "Dispatched", "Picked Up", "Cancelled", "Quote Expired"];
  // "Still in progress but already at a safe stage" — used alongside
  // FULFILLED_STATUSES by both dueRisk and atRisk so the two computations
  // can't silently diverge. Kept separate from FULFILLED_STATUSES on
  // purpose: these line items aren't done, they're just not "at risk" of
  // missing their promise date anymore.
  const SAFE_STAGE_STATUSES = ["In Production", "QC", "Ready for Dispatch"];

  function deriveOrderStatus(order) {
    const statuses = order.lineItems.map((li) => li.status);
    if (statuses.every(isFulfilled)) return "Delivered";
    if (statuses.some(isFulfilled) && statuses.some((s) => !isFulfilled(s) && !["Cancelled", "Quote Expired"].includes(s))) return "Partially Fulfilled";
    if (statuses.some((s) => s === "Pending Payment Verification")) return "Pending Payment Verification";
    if (statuses.some((s) => s === "Order Placed")) return "Order Placed";
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
    // A pre-2026-08-06 blob may still carry stale mock `mailboxes`/`emails`
    // collections — mail is live now (see the "MAIL" section below), so
    // drop them rather than re-seed; nothing reads them anymore.
    if (state.mailboxes !== undefined || state.emails !== undefined) {
      delete state.mailboxes;
      delete state.emails;
      dirty = true;
    }
    state.orders.forEach((o) => {
      if (!Array.isArray(o.correspondenceLog)) { o.correspondenceLog = []; dirty = true; }
    });
    /* Cash Book (2026-08-18). ADDITIVE — a pre-existing blob has no
       `cashbook` key at all, and bumping STORAGE_KEY to "fix" that would
       throw away every tester's advanced jobs / logged spoilage / blockers
       for a feature unrelated to any of them. Its three collections
       (transactions, costLines, jobs) sit under ONE guard on purpose: a
       partial backfill could produce cost lines with no job to attribute
       them to, which reads as data loss rather than a missing feature. */
    // The cashbook mock collection is GONE — the Cash Book reads the real
    // backend now (backend/cashbook/). A pre-existing blob may still carry
    // a stale `cashbook` key; it is simply never read, and is left in place
    // rather than triggering a STORAGE_KEY bump that would throw away every
    // tester's unrelated in-progress mock state.
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

  /* ---- operating-hours-aware verification SLA clock ----
     Mirrors backend/lib/business-hours.js's pure clock math (kept as a
     second copy, not a shared module, only because this repo has no
     bundler to share one across backend/frontend — see that file's own
     header for why a fixed +8h offset is exact for Asia/Manila with zero
     timezone-library dependency). Only "Pending Payment Verification"
     (the verification SLA, §5.5) uses this — Quoted/Priced stay
     wall-clock for now, unchanged from before this feature.

     A verification's `enteredStatusAt` is already SLA-clock-adjusted by
     backend/staff-api/verify-payment.js the moment it's written (rolled
     forward to the next operating-hours start if verified off-hours), so
     this only needs to walk operating-hours gaps AFTER that point, same
     as every other status's plain wall-clock read. */
  const OPERATING_HOURS = {
    utcOffsetMinutes: 480, // Asia/Manila, fixed UTC+8, no DST
    days: {
      sun: null,
      mon: { open: "09:00", close: "18:00" },
      tue: { open: "09:00", close: "18:00" },
      wed: { open: "09:00", close: "18:00" },
      thu: { open: "09:00", close: "18:00" },
      fri: { open: "09:00", close: "18:00" },
      // sat: null — closed. Was 09:00–14:00 until 2026-08-06; the studio runs
      // Monday–Friday only. Must match backend/lib/business-hours.js exactly or
      // the dashboard's aging display disagrees with the server's SLA clock.
      sat: null,
    },
  };
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  function parseHHMM(hhmm) { const parts = hhmm.split(":").map(Number); return parts[0] * 60 + parts[1]; }
  function businessMinutesBetween(startIso, endIso, operatingHours) {
    const oh = operatingHours || OPERATING_HOURS;
    const startMs = new Date(startIso).getTime() + oh.utcOffsetMinutes * 60000;
    const endMs = new Date(endIso).getTime() + oh.utcOffsetMinutes * 60000;
    if (endMs <= startMs) return 0;
    let total = 0;
    let dayStartMs = new Date(startMs); dayStartMs.setUTCHours(0, 0, 0, 0); dayStartMs = dayStartMs.getTime();
    while (dayStartMs < endMs) {
      const dayEndMs = dayStartMs + 86400000;
      const dow = DAY_KEYS[new Date(dayStartMs).getUTCDay()];
      const window = oh.days[dow];
      if (window) {
        const openMs = dayStartMs + parseHHMM(window.open) * 60000;
        const closeMs = dayStartMs + parseHHMM(window.close) * 60000;
        const overlapStart = Math.max(startMs, openMs);
        const overlapEnd = Math.min(endMs, closeMs);
        if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 60000;
      }
      dayStartMs = dayEndMs;
    }
    return total;
  }
  function agingBusinessHours(li) { return businessMinutesBetween(li.enteredStatusAt, new Date().toISOString()) / 60; }

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
      readyForDispatch: items.filter((li) => li.status === "Ready for Dispatch" || li.status === "Ready for Pickup"),
      // A REVIEW queue, not an action queue (§3.1 Row 1) — nothing for staff
      // to advance here, just visibility into who cancelled vs. who timed
      // out, so no SLA color-coding (decorateLineItem's slaState stays "ok"
      // since SLA_HOURS has no entry for either status below).
      cancelled: items.filter((li) => li.status === "Cancelled" || li.status === "Auto-Cancelled"),
    };
    Object.keys(q).forEach((k) => { q[k] = sortByAging(q[k]).map(decorateLineItem); });
    return q;
  }

  function decorateLineItem(li) {
    // Verification SLA red/warn thresholds are operating-hours-aware
    // (overnight/weekend gaps don't count); every other status stays
    // wall-clock, unchanged. See agingBusinessHours()'s header above.
    const hrs = li.status === "Pending Payment Verification" ? agingBusinessHours(li) : agingHours(li);
    // `enteredStatusAt` can legitimately be a FUTURE timestamp: when staff
    // verify a payment outside operating hours, verify-payment.js anchors
    // the newly-Confirmed line item's clock to the next opening (so the
    // production SLA doesn't start counting before the shop is actually
    // open — see that Lambda's header). If the dashboard is loaded before
    // that moment arrives, `hrs` comes out negative — e.g. -7.8h — and an
    // unguarded fmtHours() rendered that as "-468m", which reads as a bug
    // rather than "this job's clock hasn't started yet." Clamp the aging
    // number to 0 and expose the real start time separately so the UI can
    // say "Opens 9:00 AM" instead of a negative number.
    const queuedUntil = hrs < 0 ? li.enteredStatusAt : null;
    const clampedHrs = Math.max(0, hrs);
    const sla = SLA_HOURS[li.status];
    let slaState = "ok";
    if (sla && !queuedUntil) {
      if (clampedHrs >= sla.red) slaState = "red";
      else if (clampedHrs >= sla.warn) slaState = "warn";
    }
    const dueDate = li.order.originalPromisedDate;
    const dueInDays = dueDate ? Math.ceil((new Date(dueDate) - Date.now()) / 86400000) : null;
    return Object.assign({}, li, {
      agingHours: Math.round(clampedHrs * 10) / 10,
      queuedUntil,
      slaState,
      dueDate,
      dueInDays,
      dueRisk: dueInDays !== null && dueInDays <= 2 && !FULFILLED_STATUSES.includes(li.status) && !SAFE_STAGE_STATUSES.includes(li.status),
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
    const dueTodayList = items.filter((li) => isoDay(li.order.originalPromisedDate) <= todayKey && !FULFILLED_STATUSES.includes(li.status));
    const atRisk = dueTodayList.filter((li) => !SAFE_STAGE_STATUSES.includes(li.status));
    const wipStatuses = ["Confirmed", "Scheduled", "In Production", "QC", "Rework", "Ready for Dispatch"];
    const wip = items.filter((li) => wipStatuses.includes(li.status));
    return {
      dueToday: dueTodayList.length,
      dueTodayAtRisk: atRisk.length,
      // Decorated (agingHours/dueDate/etc) and pre-sorted the same way
      // getQueues() shapes its items, so today.html's stat-card drill-down
      // can reuse the exact same row-rendering function as the queue cards
      // above it — one render path, not a second one that could drift.
      dueTodayItems: sortByAging(dueTodayList).map(decorateLineItem),
      outputYesterdayUnits: dayY.unitsOut, outputYesterdayJobs: dayY.jobsCompleted,
      spoilageYesterdayUnits: dayY.spoilageUnits, spoilageYesterdayValue: dayY.spoilageValue,
      reworkOpenedYesterday: dayY.reworkOpened,
      cashCollectedYesterday: dayY.cashCollected,
      spoilageTodayUnits: dayT.spoilageUnits, spoilageTodayValue: dayT.spoilageValue,
      wipCount: wip.length,
      wipItems: sortByAging(wip).map(decorateLineItem),
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
    "Order Placed": "Pending Payment Verification",
    "Pending Payment Verification": "Confirmed",
    "Quoted": "Priced",
    "Priced": "Confirmed",
    "Confirmed": "Scheduled",
    "Scheduled": "In Production",
    "In Production": "QC",
    "QC": "Ready for Dispatch",
    "Rework": "In Production",
    "Ready for Dispatch": "Dispatched",
    "Dispatched": "Delivered",
    "Ready for Pickup": "Picked Up",
  };

  // LEGACY PATH as of 2026-08-08: createManualOrder() (below) now writes
  // real orders via POST /orders/manual, so a NEWLY created manual order
  // is never in state.orders and this correctly returns false for it,
  // routing it through the normal real-order code paths like any other
  // order. This only still matches manual orders created BEFORE that
  // change, which exist solely in whichever browser's localStorage
  // created them — kept so their action buttons (correspondence,
  // verify-payment, etc.) don't break while any pre-migration stragglers
  // still exist. Safe to delete once none remain.
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
        // Required by advance-line-item.js on Quoted -> Priced ONLY (it 400s
        // without one) and ignored on every other transition. Forwarded
        // unconditionally rather than branching on `to` here — the server
        // owns which transitions need it, and duplicating that rule in the
        // seam is how the two would drift apart.
        priceEach: opts.priceEach,
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
    // Mirror advance-line-item.js's rule so a manual/mock order can't do
    // what the UAT caught real orders doing: reach Priced with nothing to
    // pay. Same transition, same requirement, same derived amount — if the
    // two ever disagree, staff learn one behaviour and get the other.
    if (from === "Quoted" && to === "Priced") {
      const price = parseFloat(opts.priceEach);
      if (!(price > 0) || !isFinite(price)) {
        throw new Error("A price per unit is required before sending a quote to the customer.");
      }
      li.priceEach = price;
      li.amount = Math.round(price * (li.qty || 1) * 100) / 100;
    }
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

  /* ---- GCash bridge verify/hold (order-level — see header note) ----
     Mirrors the Payment System file's verifyPayment / setOnHold Lambdas:
     one GCash transaction verified (or held) together advances every
     `sku` line item on that order still awaiting verification, and
     stamps the audit fields on order.payment (verifiedBy/verifiedAt, or
     holdReason). Verify accepts `On Hold` line items as well as
     `Pending Payment Verification` ones, so once staff and customer have
     sorted out whatever the hold was about over email/chat, one Verify
     Payment click takes the order straight to Confirmed. ---- */
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
    // Mirrors verify-payment.js's eligible-status list: a held payment is
    // verifiable directly, no detour back through Pending Payment
    // Verification.
    const pending = order.lineItems.filter((li) => li.status === "Pending Payment Verification" || li.status === "On Hold");
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
    order.payment.holdReason = null;
    order.orderStatus = deriveOrderStatus(order);
    save(state);
    return order;
  }

  async function setOnHold(orderId, holdReason, staffName) {
    if (!holdReason) throw new Error("A reason is required to put a payment on hold.");
    if (isMockOnlyOrder(orderId)) return setOnHoldMock(orderId, holdReason, staffName);
    return apiFetch("/orders/" + encodeURIComponent(orderId) + "/set-on-hold", {
      method: "POST",
      body: JSON.stringify({ reason: holdReason }),
    });
  }

  function setOnHoldMock(orderId, holdReason, staffName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    const pending = order.lineItems.filter((li) => li.status === "Pending Payment Verification");
    if (!pending.length) throw new Error("No line items on this order are awaiting verification.");
    const now = nowIso();
    pending.forEach((li) => {
      const from = li.status;
      li.status = "On Hold";
      li.enteredStatusAt = now;
      state.events.push({
        pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#" + li.lineItemId,
        orderId, lineItemId: li.lineItemId, from, to: "On Hold",
        actorSub: "current-user", actorName: staffName || "You",
        station: li.station || null, at: now, meta: { via: "setOnHold", holdReason },
      });
    });
    if (order.payment) {
      order.payment.holdReason = holdReason;
      order.payment.verifiedBy = null;
      order.payment.verifiedAt = null;
    }
    order.orderStatus = deriveOrderStatus(order);
    save(state);
    return order;
  }

  /* ---- order messages (staff side of the customer chat feature) ----
     backend/staff-api/get-messages.js / send-message.js — no mock
     fallback (unlike verifyPayment/etc.'s isMockOnlyOrder() branch)
     since a manually-entered mock order has no customerSub to chat
     with in the first place; job-detail.html only renders this panel
     for real orders. Named getOrderMessages/sendOrderMessage, not
     getMessages/sendMessage, to not collide with this file's existing
     IMAP-mock getMessages(mailboxId)/sendReply() for email.html. */
  // `markRead` is opt-in (see get-messages.js's header) — pass true only
  // from a real engagement signal (job-detail.html fires it on the reply
  // box's focus event), never from the initial page-load fetch or the 8s
  // background poll, so simply opening a ticket to glance at it doesn't
  // silently clear its own unread badge before anyone sees it.
  async function getOrderMessages(orderId, markRead) {
    const qs = markRead ? "?markRead=true" : "";
    const res = await apiFetch("/orders/" + encodeURIComponent(orderId) + "/messages" + qs);
    return res.messages || [];
  }

  function markMessagesRead(orderId) {
    return getOrderMessages(orderId, true);
  }

  // `files` (optional array of browser File objects) follows the same
  // two-step presigned-upload flow as addCorrespondence() — see
  // uploadAttachments() above.
  async function sendOrderMessage(orderId, text, files) {
    files = files || [];
    const attachments = files.map((f) => ({ filename: f.name, contentType: f.type }));
    const res = await apiFetch("/orders/" + encodeURIComponent(orderId) + "/messages", {
      method: "POST",
      body: JSON.stringify({ body: text, attachments }),
    });
    await uploadAttachments(files, res.uploads);
    return res.message;
  }

  // backend/staff-api/get-unread-messages.js — the same `{ threads,
  // totalUnread }` shape a future Messages tab renders as full rows;
  // today only `totalUnread` (the sidebar badge) and each thread's
  // `orderId`/`unreadCount` (jobs.html's per-row chip) are read. Keep
  // that future tab in mind before reshaping this response — it's
  // deliberately already list-of-threads, not just a count.
  async function getUnreadMessageSummary() {
    return apiFetch("/messages/unread");
  }

  // QC -> Rework is a normal line-item transition (advance-line-item.js's
  // LEGAL_TRANSITIONS already allows it) — this used to unconditionally
  // touch the localStorage mock (state.orders.find(...)), so a real
  // (backend-created) order's line item could never actually enter Rework
  // at all: `order` came back undefined and the next line threw, a dead end
  // for every non-mock order. Gated the same way as its siblings
  // (advanceLineItem/verifyPayment/setOnHold) so real orders route over
  // the wire instead. There's no dedicated spoilage-logging Lambda yet (see
  // backend/CLAUDE.md's staff-api/ table) — the spoilage detail rides along
  // as the transition event's `meta` so it's still durably recorded, just
  // not yet a queryable field on the line item itself.
  async function sendToRework(orderId, lineItemId, spoilage) {
    if (isMockOnlyOrder(orderId)) return sendToReworkMock(orderId, lineItemId, spoilage);
    return apiFetch("/line-items/" + encodeURIComponent(lineItemId) + "/advance", {
      method: "POST",
      body: JSON.stringify({ orderId, lineItemId, to: "Rework", meta: { spoilage } }),
    });
  }

  function sendToReworkMock(orderId, lineItemId, spoilage) {
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
  // Per-staffer UI preferences (jobs.html's draggable column order, first
  // consumer) — backend/staff-api/dashboard-prefs.js, USER#<sub>/PREFS.
  // Server-side, not localStorage, specifically so it follows a staffer
  // across devices. PATCH shallow-merges server-side, so setDashboardPref
  // only ever needs to send the one key it's changing.
  async function getDashboardPrefs() {
    return apiFetch("/staff/prefs", { method: "GET" });
  }
  async function setDashboardPref(key, value) {
    return apiFetch("/staff/prefs", { method: "PATCH", body: JSON.stringify({ data: { [key]: value } }) });
  }

  async function getAllOrders() {
    const { orders } = await apiFetch("/orders", { method: "GET" });
    const normalized = (orders || []).map(normalizeOrder);
    // LEGACY as of 2026-08-08: createManualOrder() (below) now writes real
    // orders via POST /orders/manual, which already come back in `orders`
    // above with source:"manual" intact — this merge is no longer needed
    // for anything created from here on. Kept only so manual orders
    // created BEFORE that change (which exist solely in whichever
    // browser's localStorage created them) don't silently vanish from
    // that one browser's jobs list. Real orders never carry
    // source:"manual", so there's no collision risk either way. Safe to
    // delete once no pre-migration stragglers remain.
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

  // Real backend as of 2026-08-08 — POST /orders/manual
  // (backend/staff-api/create-manual-order.js). Used to write straight to
  // the localStorage mock, which meant a manual order existed only on the
  // one browser/device that created it — invisible to every other device,
  // gone if that browser's storage was ever cleared. Real orders and
  // manual orders now share one backend and one ID space; source:"manual"
  // (set server-side) is still the only marker, so existing "Manual"
  // badges keep working unchanged.
  //
  // The "pick an existing client or add a new one" flow stays exactly as
  // it was, but it's now PURELY a local convenience autocomplete (recent
  // names), not the order's actual identity — the real backend has no
  // Client entity, same as a checkout order (create-order.js), which
  // stores customerName flat on the order. Client-side validation here is
  // a fast-fail UX nicety; the server re-validates everything for real.
  async function createManualOrder(opts) {
    opts = opts || {};
    const description = (opts.description || "").trim();
    if (!description) throw new Error("A description is required.");
    if (!opts.promisedDate) throw new Error("A promised date is required.");

    const state = load();
    let customerName;
    if (opts.newClientName && opts.newClientName.trim()) {
      customerName = opts.newClientName.trim();
    } else {
      const client = state.clients.find((c) => c.id === opts.clientId);
      if (!client) throw new Error("Select an existing client or enter a new client name.");
      customerName = client.name;
    }

    const type = opts.type === "custom" ? "custom" : "sku";
    const allowedStatuses = MANUAL_ORDER_STATUSES[type];
    const status = allowedStatuses.includes(opts.status) ? opts.status : allowedStatuses[0];
    if (status === "Pending Payment Verification") {
      if (!(opts.gcashRefNumber || "").trim()) throw new Error("A GCash reference number is required for Pending Payment Verification.");
      if (!(parseFloat(opts.claimedAmount) > 0)) throw new Error("A claimed amount is required for Pending Payment Verification.");
    }

    const result = await apiFetch("/orders/manual", {
      method: "POST",
      body: JSON.stringify({
        customerName, description, type,
        sku: opts.sku, qty: opts.qty, priceEach: opts.priceEach,
        promisedDate: opts.promisedDate, status,
        gcashRefNumber: opts.gcashRefNumber, claimedAmount: opts.claimedAmount,
        paidVia: opts.paidVia, paidRef: opts.paidRef, notes: opts.notes,
      }),
    });

    // Only after a confirmed create: remember a brand-new name locally so
    // it shows up in the dropdown next time. Doing this before the API
    // call risked polluting the "recent clients" list with a name from an
    // order that never actually got created.
    if (opts.newClientName && opts.newClientName.trim()) {
      state.clients.push({
        id: uid("C"), name: customerName,
        type: opts.newClientType === "B2B" ? "B2B" : "B2C",
        totalRevenue: 0, lastOrderAt: nowIso(), reorderIntervalDays: null,
      });
      save(state);
    }

    liveOrdersCache = null; // force a fresh fetch — the new order is real now
    return result;
  }

  // Manual order↔email linking: staff log a note referencing a Spacemail
  // thread (never the email body itself — no mail content is stored here),
  // optionally with attachments (screenshots of the actual email, etc.).
  // See docs/roadmap.md "Order↔email linking" for why this replaced the
  // SES-relay/Google-Workspace approach, and its 2026-08-04 entry for the
  // attachment feature + the fact this used to be entirely mock: real
  // (backend-created) orders are never in `state.orders`, so this always
  // threw "Order not found" for them before add-correspondence.js existed
  // — gated by isMockOnlyOrder() now, same as verifyPayment/setOnHold/etc.
  // `files` is an array of browser File objects; mock orders have no S3 to
  // upload to, so attachments are rejected there rather than silently
  // dropped.
  async function addCorrespondence(orderId, note, files, actorName) {
    files = files || [];
    if (isMockOnlyOrder(orderId)) {
      if (files.length) throw new Error("Attachments aren't supported on manually-entered orders.");
      return addCorrespondenceLogMock(orderId, note, actorName);
    }
    const attachments = files.map((f) => ({ filename: f.name, contentType: f.type }));
    const res = await apiFetch("/orders/" + encodeURIComponent(orderId) + "/correspondence", {
      method: "POST",
      body: JSON.stringify({ note, attachments }),
    });
    await uploadAttachments(files, res.uploads);
    return res.entry;
  }

  function addCorrespondenceLogMock(orderId, note, actorName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    if (!note || !note.trim()) throw new Error("A note is required.");
    if (!Array.isArray(order.correspondenceLog)) order.correspondenceLog = [];
    const entry = { at: nowIso(), note: note.trim(), actorName: actorName || "—", attachments: [] };
    order.correspondenceLog.push(entry);
    save(state);
    return entry;
  }

  /* ---- order tags (AWS-style key/value chips) ----
     backend/staff-api/set-order-tags.js — a small staff-set key/value
     list per order, for filtering/reporting (Type=Reprint, Priority=Rush,
     Test=…), separate from the order-status state machine. Full-set PUT:
     the caller (job-detail.html's tag editor) always sends the COMPLETE
     desired tag list, never one add/remove call per tag — see the
     Lambda's header for why. Real validation (length caps, character
     allowlist, max count, duplicate-key rejection) is server-side in
     backend/lib/tags.js; the constants below are UI-only (maxlength
     attributes, a client-side pre-check for a snappier error before the
     round trip) and must not be treated as the source of truth. */
  const MAX_TAGS_PER_ORDER = 20;
  const TAG_KEY_MAX = 40;
  const TAG_VALUE_MAX = 120;

  // Small "quick add" starter set the tag editor offers as one-click
  // chips — purely a client-side convenience list, NOT enforced or even
  // known to the backend (which accepts any key/value obeying the
  // general rules above). Edit this ONE array to change what staff see
  // as suggestions; nothing else needs to change.
  const DEFAULT_ORDER_TAGS = [
    { key: "Environment", value: "Test", hint: "Synthetic/internal order — exclude from real metrics" },
    { key: "Priority", value: "Rush", hint: "Needs expedited turnaround" },
    { key: "Type", value: "Reprint", hint: "Remake/redo of a prior job, not new revenue" },
    { key: "Channel", value: "Walk-in", hint: "Taken in person/phone/DM, not through online checkout" },
    { key: "Client", value: "VIP", hint: "Repeat/high-value client — handle with extra care" },
  ];
  function getDefaultOrderTags() { return DEFAULT_ORDER_TAGS.slice(); }

  // `tags` is the COMPLETE desired list — [{key, value}], value may be
  // "". Returns the normalized, stored list on success.
  async function setOrderTags(orderId, tags, actorName) {
    if (isMockOnlyOrder(orderId)) return setOrderTagsMock(orderId, tags, actorName);
    const res = await apiFetch("/orders/" + encodeURIComponent(orderId) + "/tags", {
      method: "POST",
      body: JSON.stringify({ tags }),
    });
    return res.tags;
  }

  function setOrderTagsMock(orderId, tags, actorName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    const now = nowIso();
    order.tags = tags;
    state.events.push({
      pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#ORDER",
      orderId, lineItemId: "ORDER", from: null, to: "Tags updated",
      actorSub: "current-user", actorName: actorName || "You",
      station: null, at: now, meta: { via: "setTags" },
    });
    save(state);
    return order.tags;
  }

  // Shared by addCorrespondence/sendOrderMessage — `uploads` is the
  // {s3Key, uploadUrl} list the Lambda returned, positionally matching
  // `files` (same order the caller built the `attachments` metadata in).
  // Direct browser→S3 PUT, same two-step flow as store.js's
  // submitPaymentProof().
  async function uploadAttachments(files, uploads) {
    await Promise.all((uploads || []).map((u, i) => {
      const file = files[i];
      if (!file) return Promise.resolve();
      return fetch(u.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then((res) => {
        if (!res.ok) throw new Error("Upload failed for " + file.name + " (" + res.status + ")");
      });
    }));
  }

  /* ============================================================
     MAIL — staff email panel (LIVE since 2026-08-06)
     ============================================================
     Real fetch() calls to backend/mail/*.js (get-mailboxes.js,
     get-mail-messages.js, get-mail-message.js, mark-mail-read.js,
     send-reply.js), routed through apiFetch() like every other live
     KCMPS_DASH function — no localStorage fallback, matching
     getAllOrders/verifyPayment/etc. Signatures and return shapes are kept
     byte-compatible with the mock this replaced, so email.html's render
     functions needed no structural change — only its call sites gained
     `await` (these are now async).

     Three contract deltas vs. the old mock, absorbed here so callers don't
     have to know about them:
       - no `uid` field on any message (the mock had one)
       - `nextCursor` is an opaque base64 token, passed back verbatim as
         `cursor` — never treat it as a number
       - `snippet` is 200 chars server-side (mock was 140)
     Messages also carry a `provenance` field the mock never had —
     email.html's renderProvenance() already reads it, untouched here.

     mailboxId/messageId are URL-encoded in every path — messageId
     contains "<", "@", ">" (it's an RFC822 Message-ID). ============ */

  function mailPath(mailboxId, rest) {
    return "/mail/mailboxes/" + encodeURIComponent(mailboxId) + (rest || "");
  }

  async function getMailboxes() {
    const { mailboxes } = await apiFetch("/mail/mailboxes", { method: "GET" });
    return mailboxes || [];
  }

  async function getMessages(mailboxId, opts) {
    const o = opts || {};
    const qs = new URLSearchParams();
    if (o.folder) qs.set("folder", o.folder);
    if (o.limit) qs.set("limit", String(o.limit));
    if (o.search) qs.set("search", o.search);
    if (o.cursor) qs.set("cursor", o.cursor);
    const q = qs.toString();
    return apiFetch(mailPath(mailboxId, "/messages" + (q ? "?" + q : "")), { method: "GET" });
  }

  async function getMessage(mailboxId, messageId) {
    const { message } = await apiFetch(mailPath(mailboxId, "/messages/" + encodeURIComponent(messageId)), { method: "GET" });
    return message;
  }

  /* No dedicated thread endpoint on the real API — get-mail-messages.js's
     envelopes already carry threadId, so threading stays client-side (see
     docs/email-tab-redesign-2026-08-06.md §4 — a GSI-backed thread endpoint
     is deferred, not justified at this mailbox volume). What changed
     2026-08-06: this used to re-page INBOX+SENT (up to 2x200 envelopes)
     on EVERY getThread() call, i.e. every single message open — wasteful,
     and the actual root cause was never the fetch shape, it was doing it
     on every open instead of once per mailbox visit. Now it fetches once
     per mailbox switch and serves every getThread() call in that mailbox
     from the cached snapshot, dropping N-opens-in-a-row from N fetches to
     1. Callers force a refresh (`{forceRefresh: true}`) after an action
     that changes the mailbox's own messages — sendReply() below does this
     automatically; email.html also does it after an explicit Reload. */
  let _threadCacheMailboxId = null;
  let _threadCachePromise = null;

  function _loadThreadCache(mailboxId) {
    if (_threadCacheMailboxId === mailboxId && _threadCachePromise) return _threadCachePromise;
    _threadCacheMailboxId = mailboxId;
    _threadCachePromise = Promise.all([
      getMessages(mailboxId, { folder: "INBOX", limit: 200 }),
      getMessages(mailboxId, { folder: "SENT", limit: 200 }),
    ]).then(([inbox, sent]) => [...(inbox.messages || []), ...(sent.messages || [])]);
    return _threadCachePromise;
  }

  // Envelope fields only — email.html's thread cards read t.date/t.snippet/
  // t.messageId/t.from/t.flags for the collapsed rows, then lazily fetch
  // getMessage() for the one a staffer actually expands. Never t.bodyText
  // straight off this, same as before.
  async function getThread(mailboxId, threadId, opts) {
    if (!threadId) return [];
    if (opts && opts.forceRefresh) { _threadCacheMailboxId = null; _threadCachePromise = null; }
    const all = await _loadThreadCache(mailboxId);
    return all.filter((m) => m.threadId === threadId).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  async function markMessageRead(mailboxId, messageId, seen) {
    await apiFetch(mailPath(mailboxId, "/messages/" + encodeURIComponent(messageId) + "/read"), {
      method: "POST",
      body: JSON.stringify({ seen: seen !== false }),
    });
    return getMessages(mailboxId);
  }

  // Returns { sent, list } like the mock. On the rare "sent but local
  // write failed" path the backend returns 200 with list: null plus a
  // `warning` — that is not a failure (the email already went out, there
  // is no un-send), so it is passed through rather than thrown; the caller
  // renders the warning.
  async function sendReply(mailboxId, messageId, payload) {
    const p = payload || {};
    const result = await apiFetch(mailPath(mailboxId, "/messages/" + encodeURIComponent(messageId) + "/reply"), {
      method: "POST",
      body: JSON.stringify({ bodyText: p.bodyText, cc: p.cc }),
    });
    // A reply adds a new message to this mailbox's INBOX/SENT — drop the
    // thread cache so the conversation view email.html re-renders right
    // after a successful send picks it up instead of serving a stale
    // pre-reply snapshot.
    if (_threadCacheMailboxId === mailboxId) { _threadCacheMailboxId = null; _threadCachePromise = null; }
    return result;
  }

  /* ---- Asset Library (formerly Design Library — renamed 2026-08-07) ----
     Behind the same KCMPS_DASH seam as getAllOrders/verifyPayment/etc — live-only,
     no localStorage fallback, matching how those functions work. Backend is
     backend/asset-library/*.js (get-upload-url.js/publish-design.js/list-designs.js/
     patch-design.js), routes /assets*. Production got its own bucket + Lambdas +
     routes on 2026-08-07 (see root CLAUDE.md's "Design asset library" row), so the
     backend now exists everywhere this file does. assetApiAvailable() is kept as a
     stub rather than deleted — asset-library.html's callers still check it, and a
     stub costs nothing — but it always returns true now. */

  function assetApiAvailable() {
    return true;
  }

  async function getAssets() {
    const { designs } = await apiFetch("/assets", { method: "GET" });
    return designs || [];
  }

  // Lightweight approval-queue summary for the Admin banner — no presigns,
  // no events, cheap enough to poll. Returns { count, items }.
  async function getAssetApprovalSummary() {
    return apiFetch("/assets?view=pending-summary", { method: "GET" });
  }

  // Step 1 of 2 — presigned PUT URLs for the original + web-ready files.
  // meta: { category, original: {filename, contentType, size}, web: {filename, contentType, size} }
  async function getAssetUploadUrls(meta) {
    return apiFetch("/assets/upload-url", { method: "POST", body: JSON.stringify(meta) });
  }

  // Step 2 of 2 — called after both presigned PUTs succeed. Always creates a
  // DRAFT (the backend rejects status "published" outright — publishing goes
  // through the submit/approve workflow below). meta: { name, description,
  // category, tags, s3KeyOriginal, s3KeyWeb }.
  async function createAsset(meta) {
    return apiFetch("/assets", { method: "POST", body: JSON.stringify({ ...meta, status: "draft" }) });
  }

  async function updateAsset(id, patch) {
    return assetPatch(id, { action: "update", ...patch });
  }

  async function archiveAsset(id) {
    return assetPatch(id, { action: "archive" });
  }

  async function restoreAsset(id) {
    return assetPatch(id, { action: "restore" });
  }

  // draft -> pending_approval. May 409 with { stillScanning: true } while
  // GuardDuty hasn't verdicted both files — the page treats that as the
  // self-resolving "Scanning…" state, never a user error. If the caller is
  // the ONLY Admin, the backend publishes immediately (response.published).
  async function submitAssetForApproval(id) {
    return assetPatch(id, { action: "submit" });
  }

  // Admin-only. The approval completing the current Admin set publishes
  // inline (response.published === true).
  async function approveAsset(id) {
    return assetPatch(id, { action: "approve" });
  }

  // Admin-only veto — reason is required, returns the asset to draft and
  // clears all collected approvals.
  async function rejectAsset(id, reason) {
    return assetPatch(id, { action: "reject", reason });
  }

  // Admin-only break-glass direct publish (mandatory reason, audited with
  // breakGlass: true). The malware-scan gate still applies in full.
  async function publishAssetDirect(id, reason) {
    return assetPatch(id, { action: "publish", reason });
  }

  function assetPatch(id, body) {
    return apiFetch("/assets/" + encodeURIComponent(id), {
      method: "PATCH", body: JSON.stringify(body),
    });
  }

  /* ============================================================
     CASH BOOK + JOB COSTING  (LIVE — backend/cashbook/, staging 2026-08-19)
     ============================================================
     Real backend for docs/cashbook-job-costing-plan-2026-08-18.md Phase 1.
     Every function below is a fetch() against the same API_BASE (and the
     same hostname branch, and the same JWT helper) as getAllOrders/
     setOrderTags/etc. — the localStorage prototype this replaced is gone,
     seed and all, so a stale mock can never shadow real money.

     The migration was exactly what the seam promised: function names and
     return shapes are unchanged and cashbook.html's data access did not
     move. Only two page changes were needed, both for states the mock
     could not produce — a 403 (month totals and job costing are
     Admin-only now) and the reconciliation banner.

     API ROUTES  (auth per the owner's O1 decision)
       GET  /cashbook/categories                 isStaff
       GET  /cashbook/day/{day}                  isStaff
       GET  /cashbook/month/{month}              ADMIN
       POST /cashbook/transactions               isStaff
       POST /cashbook/transactions/{id}/void     ADMIN
       POST /orders/{orderId}/costs              isStaff
       GET  /orders/{orderId}/costing            ADMIN

     Four rules from the plan are load-bearing here, not stylistic:

     D3 MONEY IS INTEGER CENTAVOS. pesosToCentavos() is the ONLY float->int
        conversion, applied once at the input edge (mirrors
        backend/lib/money.js's toCentavos). Nothing below ever adds,
        multiplies or stores a peso float. Percentages are the one place a
        float appears, and only as a derived display value.

     D4 DATES ARE ASIA/MANILA (fixed +8, no DST). A naive
        new Date().toISOString().slice(0,10) files every evening
        transaction under TOMORROW — 16:00 UTC onward is already the next
        Manila day. manilaDayOf() shifts before slicing. Same fixed-offset
        approach as backend/lib/business-hours.js, which is why no timezone
        library is needed.

     D2 APPEND-ONLY. There is no edit and no delete. A void writes a
        REVERSING entry and flags the original `voided: true`. This is now
        enforced SERVER-SIDE in one transaction (double-void guard,
        reversal filed in the ORIGINAL day's partition, both rollups
        negated together), and the day read returns `reconciles` so a
        total that disagrees with its own rows is visible instead of
        silent. Nothing on this side re-computes a rollup any more —
        a second local copy of that arithmetic is exactly how two answers
        drift apart.

     T2 EVERY COST LINE CARRIES affectsCash. Job profit counts ALL cost
        lines; the cash book counts only affectsCash:true ones. Today every
        line is cash (labor is piece-rate, D7) so the two agree — the split
        is built now because retrofitting it means re-deriving which
        historical lines were cash, and that information is gone.
     ============================================================ */

  const MANILA_OFFSET_MS = 8 * 3600 * 1000;

  // ISO instant -> "YYYY-MM-DD" in Asia/Manila. See D4 above.
  function manilaDayOf(dateLike) {
    const t = dateLike == null ? Date.now() : new Date(dateLike).getTime();
    return new Date(t + MANILA_OFFSET_MS).toISOString().slice(0, 10);
  }
  function manilaToday() { return manilaDayOf(null); }
  function manilaMonthOf(dayKey) { return String(dayKey).slice(0, 7); }
  // Day-key arithmetic done on the key itself (UTC midnight + n days), never
  // on a local Date — so it can't drift across a Manila/UTC boundary.
  function manilaShiftDay(dayKey, deltaDays) {
    const t = Date.parse(dayKey + "T00:00:00Z") + deltaDays * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  // "YYYY-MM-DD" + "HH:MM" Manila -> a real UTC ISO instant. Used by the
  // seed so demo rows land at plausible shop hours on the right Manila day.
  function manilaIsoAt(dayKey, hhmm) {
    return new Date(Date.parse(dayKey + "T" + hhmm + ":00+08:00")).toISOString();
  }
  function manilaDayLabel(dayKey) {
    // Rendered from the +08:00 instant so the weekday is Manila's, not the
    // viewer's — a staffer's phone travelling is not a reason for the
    // ledger's day label to change.
    const d = new Date(Date.parse(dayKey + "T12:00:00+08:00"));
    return d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "Asia/Manila" });
  }
  function manilaTimeLabel(iso) {
    return new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
  }
  function manilaMonthLabel(monthKey) {
    return new Date(Date.parse(monthKey + "-01T12:00:00+08:00"))
      .toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" });
  }

  /* ---- money (mirrors backend/lib/money.js exactly) ----
     Reimplemented rather than imported because website/ has no module
     system (CLAUDE.md: no build step, no bundler). The SEMANTICS must stay
     identical to backend/lib/money.js — if that file's rounding changes,
     change this too. */
  function pesosToCentavos(pesos) {
    const n = typeof pesos === "string" ? Number(pesos) : pesos;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new TypeError("Expected a finite peso amount, got " + JSON.stringify(pesos));
    }
    return Math.round(n * 100);
  }
  // F7: negatives render as "−₱850.00" (real minus sign U+2212, prefixed
  // before the currency symbol), never "₱-850.00" — the latter reads as a
  // developer artifact, not a peso amount.
  function formatCentavos(centavos) {
    if (!Number.isInteger(centavos)) throw new TypeError("Expected integer centavos, got " + JSON.stringify(centavos));
    const neg = centavos < 0;
    const abs = Math.abs(centavos);
    return (neg ? "−" : "") + "₱" + (abs / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Signed display for a ledger row: "+₱35,000.00" / "−₱19,500.00" (real
  // minus sign U+2212, not a hyphen — it reads as a number, not a dash).
  // F1: the glyph is derived from the RESULTING signed value
  // ((direction === "out" ? -1 : 1) * amountCentavos), not from direction
  // alone — a refund is direction:"in" with a category-owned negative
  // amountCentavos (see CASHBOOK_CATEGORIES' `sign`), so a naive
  // direction-only glyph would show a refund as "+" while it actually
  // decreases revenue.
  function formatSignedCentavos(centavos, direction) {
    const signedValue = (direction === "out" ? -1 : 1) * centavos;
    return (signedValue < 0 ? "−" : "+") + formatCentavos(Math.abs(centavos));
  }
  // Plain decimal pesos, no ₱ symbol and no thousands grouping — for CSV
  // export, where the currency belongs in the column header, not the cell
  // (a "₱35,000.00" string is not a number to a spreadsheet's SUM()).
  // Rounds ONCE (centavos may be a non-integer per-unit ratio, e.g. a cost
  // line's amount/qty) via integer div/mod — never a float divide-then-
  // toFixed, which is exactly the kind of float arithmetic D3 forbids.
  function formatCentavosDecimal(centavos) {
    const rounded = Math.round(centavos);
    const neg = rounded < 0;
    const abs = Math.abs(rounded);
    const pesos = Math.floor(abs / 100);
    const cents = abs % 100;
    return (neg ? "-" : "") + pesos + "." + String(cents).padStart(2, "0");
  }

  /* ---- categories + methods (§8 "Must have") ----
     Config, NOT hardcoded: the real source is GET /cashbook/categories,
     which serves CONFIG#TXN_CATEGORIES and falls back to the seed list in
     backend/lib/cashbook.js's DEFAULT_TXN_CATEGORIES.

     WHY THERE IS STILL A LOCAL LIST HERE. cashbook.html calls
     renderCategories()/renderMethods() SYNCHRONOUSLY on first paint,
     before any await — so getCashbookCategories() has to stay synchronous
     or the chips render empty. The list below is therefore a cache
     PRE-SEEDED WITH THE SERVER'S OWN DEFAULTS (kept byte-identical to
     DEFAULT_TXN_CATEGORIES — same ids, same labels, same `sign: -1` on
     refund), then overwritten by primeCashbookCategories() the moment the
     real response lands. Today no CONFIG#TXN_CATEGORIES item exists, so
     the server serves exactly this list and the first paint is already
     correct; if Settings ever writes a different one, the next render
     picks it up.

     The ids changed in the mock->real swap (merch-order/print-office/
     design-service/walk-in collapsed into `sale`, other-in/other-out into
     `other_income`/`misc`). The SERVER owns this vocabulary — it validates
     every categoryId on write — so the mock's finer split could not be
     kept without inventing a second vocabulary that the backend would
     reject. Nothing in cashbook.html hardcodes an id; it renders whatever
     this returns. */
  const CASHBOOK_CATEGORIES = {
    in: [
      { id: "sale", label: "Sale" },
      { id: "other_income", label: "Other income" },
      // F1: the sign is owned by the category, not by staff typing a
      // minus — staff always type a positive amount. The SERVER re-applies
      // this sign on every write regardless of what the client sends
      // (backend review finding B5), so this flag is a display/UX hint
      // here, never the enforcement point.
      { id: "refund", label: "Refund (negative revenue)", sign: -1 },
    ],
    out: [
      { id: "materials", label: "Materials" },
      { id: "labor", label: "Labor" },
      { id: "service", label: "Outsourced service" },
      { id: "supplies", label: "Shop supplies" },
      { id: "rent", label: "Rent" },
      { id: "utilities", label: "Utilities" },
      { id: "transport", label: "Transport / delivery" },
      { id: "equipment", label: "Equipment" },
      { id: "misc", label: "Miscellaneous" },
    ],
  };
  let CASHBOOK_METHODS = [
    { id: "cash", label: "Cash" },
    { id: "gcash", label: "GCash" },
    { id: "bank", label: "Bank" },
    { id: "card", label: "Card" },
  ];

  // Replaces the cache above from the live config. Fire-and-forget and
  // deliberately silent: a failure here must not break the page, because
  // the pre-seeded list is already the same data the server would return.
  let cashbookCategoriesPrimed = false;
  async function primeCashbookCategories() {
    if (cashbookCategoriesPrimed) return;
    try {
      const res = await apiFetch("/cashbook/categories");
      if (!res || !Array.isArray(res.categories) || !res.categories.length) return;
      const next = { in: [], out: [] };
      res.categories.forEach((c) => {
        if (c.direction !== "in" && c.direction !== "out") return;
        const entry = { id: c.id, label: c.label };
        if (c.sign === -1) entry.sign = -1;
        next[c.direction].push(entry);
      });
      if (next.in.length && next.out.length) {
        CASHBOOK_CATEGORIES.in = next.in;
        CASHBOOK_CATEGORIES.out = next.out;
      }
      if (Array.isArray(res.paymentMethods) && res.paymentMethods.length) {
        const labels = { cash: "Cash", gcash: "GCash", bank: "Bank", card: "Card" };
        CASHBOOK_METHODS = res.paymentMethods.map((id) => ({ id, label: labels[id] || id }));
      }
      cashbookCategoriesPrimed = true;
    } catch { /* keep the pre-seeded defaults — see above */ }
  }

  function getCashbookCategories() {
    return { in: CASHBOOK_CATEGORIES.in.slice(), out: CASHBOOK_CATEGORIES.out.slice() };
  }
  function getCashbookMethods() { return CASHBOOK_METHODS.slice(); }
  // F3: voidCashbookTransaction() writes a reversal that carries the SAME
  // category id but the FLIPPED direction (a reversed expense is an "in"
  // row) — so a lookup scoped to only the reversal's own direction misses
  // every reversed category and falls back to the raw slug ("merch-order"
  // instead of "Merch order"). Fall back to the OTHER direction's list
  // before giving up, so screen and CSV both show the human label.
  function cashbookCategoryLabel(direction, id) {
    const list = CASHBOOK_CATEGORIES[direction] || [];
    let hit = list.find((c) => c.id === id);
    if (!hit) {
      const other = direction === "in" ? "out" : "in";
      hit = (CASHBOOK_CATEGORIES[other] || []).find((c) => c.id === id);
    }
    return hit ? hit.label : id || "Uncategorised";
  }
  function cashbookMethodLabel(id) {
    const hit = CASHBOOK_METHODS.find((m) => m.id === id);
    return hit ? hit.label : id || "—";
  }
  /* ---- reads ---- */
  // Newest-first, matching the plan's mobile list order.
  function sortNewestFirst(list) {
    return list.slice().sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  }

  /* ---- LIVE BACKEND (backend/cashbook/, staging 2026-08-19) ----
     Everything below this point is real fetch(). The seam's function
     names and return shapes are unchanged; only the bodies moved.

     Field-name translation happens HERE and nowhere else, so cashbook.html
     keeps reading `t.category` / `t.method` while the API speaks
     `categoryId` / `paymentMethod`. One adapter, one place to change. */
  function normalizeTxnRow(r) {
    return {
      txnId: r.txnId,
      direction: r.direction,
      // Already integer centavos on the wire — never re-derived from a
      // float anywhere on this path (D3).
      amountCentavos: r.amountCentavos,
      category: r.categoryId,
      method: r.paymentMethod,
      orderId: r.orderId || null,
      // The API has no client entity (plan §7 — no Client/CRM record, no
      // GSI2). Kept on the shape so the page's grouping code still reads.
      clientName: null,
      note: r.note || "",
      occurredAt: r.occurredAt,
      actorName: r.actorName || null,
      source: r.source || "manual",
      voided: !!r.voided,
      voidReason: r.voidReason || null,
      reversesTxnId: r.reversesTxnId || null,
      costId: (r.costRef && r.costRef.costSk) || null,
    };
  }

  async function getCashbookDay(dayKey) {
    const key = dayKey || manilaToday();
    primeCashbookCategories();
    const res = await apiFetch("/cashbook/day/" + encodeURIComponent(key));
    const rows = sortNewestFirst((res.rows || []).map(normalizeTxnRow));
    const roll = res.rollup || {};
    return {
      dayKey: res.day || key,
      dayLabel: manilaDayLabel(key),
      isToday: key === manilaToday(),
      transactions: rows,
      inCentavos: roll.cashInCentavos || 0,
      outCentavos: roll.cashOutCentavos || 0,
      netCentavos: roll.netCentavos || 0,
      txnCount: roll.txnCount || 0,
      // The server re-sums the day's rows on every read and reports
      // whether the stored counter agrees. Surfaced rather than swallowed:
      // a total that silently disagrees with the rows under it is worse
      // than no total. cashbook.html renders a banner when this is false.
      reconciles: res.reconciles !== false,
      computed: res.computed || null,
    };
  }

  // Admin-only on the server. A non-Admin staffer gets `forbidden: true`
  // instead of an exception, so the month strip can render a short
  // explanation and the DAY view (which they are allowed to see) keeps
  // working — the 403 is a legitimate permission boundary, not an error.
  async function getCashbookMonth(monthKey) {
    const key = monthKey || manilaMonthOf(manilaToday());
    let res;
    try {
      res = await apiFetch("/cashbook/month/" + encodeURIComponent(key));
    } catch (err) {
      if (err && err.status === 403) {
        return { monthKey: key, monthLabel: manilaMonthLabel(key), forbidden: true,
          txnCount: 0, inCentavos: 0, outCentavos: 0, netCentavos: 0 };
      }
      throw err;
    }
    const roll = res.rollup || {};
    return {
      monthKey: res.month || key,
      monthLabel: manilaMonthLabel(key),
      txnCount: roll.txnCount || 0,
      inCentavos: roll.cashInCentavos || 0,
      outCentavos: roll.cashOutCentavos || 0,
      netCentavos: roll.netCentavos || 0,
      forbidden: false,
    };
  }

  /* ---- job costing (plan §5) ----
     GET /orders/{orderId}/costing — ADMIN-ONLY on the server (owner's O1
     decision). All the arithmetic now happens server-side in
     backend/lib/cashbook.js's jobCosting(); this only translates field
     names and re-derives the per-unit ratios as EXACT divisions so the
     display rounds once at the end (the API rounds them to whole centavos
     for its own response, which is fine for it and too coarse for a
     "₱76.9333/bag" readout).

     A 403 returns `forbidden: true` rather than throwing, so a Staff-role
     user sees an explanation instead of a broken panel. */
  async function getJobCosting(orderId) {
    let res;
    try {
      res = await apiFetch("/orders/" + encodeURIComponent(orderId) + "/costing");
    } catch (err) {
      if (err && err.status === 403) return { orderId, forbidden: true };
      if (err && err.status === 404) return { orderId, notFound: true };
      throw err;
    }
    const sum = res.summary || {};
    const qty = (sum.perUnit && sum.perUnit.units) || null;
    const revenueCentavos = sum.revenueCentavos || 0;
    const totalCostCentavos = sum.costCentavos || 0;
    const profitCentavos = sum.profitCentavos || 0;
    // The API has no job label and no client name — there is no Client
    // entity (plan §7). Fall back to the order id, and let a cost line's
    // own label carry the human meaning.
    return {
      orderId: res.orderId || orderId,
      forbidden: false,
      jobLabel: orderId,
      clientName: null,
      qty,
      revenueCentavos,
      totalCostCentavos,
      cashCostCentavos: sum.cashCostCentavos || 0,
      profitCentavos,
      netCashCentavos: sum.netCashCentavos || 0,
      // Derived display float. Never stored, never fed back into money math.
      marginPct: revenueCentavos > 0 ? (profitCentavos / revenueCentavos) * 100 : null,
      // Exact ratios, formatted (never accumulated) — same rule as before.
      perUnit: qty ? {
        revenueCentavos: revenueCentavos / qty,
        costCentavos: totalCostCentavos / qty,
        profitCentavos: profitCentavos / qty,
      } : null,
      costLines: (res.costLines || [])
        .filter((c) => !c.voided)
        .sort((a, b) => new Date(a.incurredAt) - new Date(b.incurredAt))
        .map((c) => ({
          costId: c.costId,
          orderId: c.orderId,
          label: c.label,
          category: c.categoryId,
          categoryLabel: c.categoryLabel || cashbookCategoryLabel("out", c.categoryId),
          qty: c.qty,
          unitCostCentavos: c.unitCostCentavos != null ? c.unitCostCentavos
            : (c.qty && c.qty > 0 ? c.amountCentavos / c.qty : null),
          amountCentavos: c.amountCentavos,
          affectsCash: c.affectsCash !== false,
          incurredAt: c.incurredAt,
          actorName: c.actorName || null,
          voided: !!c.voided,
        })),
    };
  }

  /* Every job that has money against it, grouped by client.

     UNAVAILABLE ON THE REAL BACKEND, deliberately, and this is a real gap
     rather than an oversight: answering "every job with money against it"
     needs either a table scan or GSI2, and GSI2 is not provisioned — it is
     the plan's own Phase 4 (§7), costed separately. The mock could do it
     only because it held the entire ledger in one localStorage blob.

     Returns an EMPTY array carrying an `unavailable` flag rather than
     throwing or inventing a partial answer from whichever day happens to
     be loaded — a client total that silently covers one day would be
     read as a client total. cashbook.html renders the explanation. */
  async function getJobCostingList() {
    const out = [];
    out.unavailable = true;
    out.unavailableReason = "Per-client job totals need the GSI2 index (plan §7, Phase 4). Open a job by order ID to see its costing.";
    return out;
  }

  /* ---- writes (append-only) ---- */
  function newCashbookId(prefix) {
    return prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  /* Logs one cash movement, against the real backend.

     TWO ROUTES, chosen by what is being logged — the page's single form
     still calls this one function:
       - an expense tied to an order  -> POST /orders/{orderId}/costs,
         which writes the COST# line AND (when affectsCash) the matching
         TXN# row + rollups in ONE server-side transaction. That is why
         staff never enter the same money twice.
       - anything else                -> POST /cashbook/transactions.

     IDEMPOTENCY. The id is generated HERE, client-side, before the
     request — that is what makes a double-tap or a retry safe. The server
     keys the row on it and refuses a duplicate inside the same
     transaction as the rollup ADDs, so counters can never double-bump.
     A replay comes back 200 with the ORIGINAL row, not an error.

     SIGN IS NOT SET HERE. The mock negated a refund locally; the server
     now owns that (backend review finding B5) and re-applies the
     category's sign to whatever arrives. Staff still type a positive
     amount, and this sends a positive amount.

     pesosToCentavos() remains the ONLY float->int conversion, applied once
     at the input edge. Nothing below adds or multiplies pesos. */
  function newIdempotencyId() {
    // Key-safe charset, 8-64 chars, alphanumeric first — matches the
    // server's IDEMPOTENCY_RE. Crypto-random when available so two
    // devices logging at the same millisecond can't collide.
    let rand;
    try {
      const buf = new Uint8Array(8);
      (global.crypto || {}).getRandomValues(buf);
      rand = Array.from(buf, (b) => b.toString(36)).join("").slice(0, 10);
    } catch { rand = Math.random().toString(36).slice(2, 12); }
    if (!rand) rand = Math.random().toString(36).slice(2, 12);
    return ("t" + Date.now().toString(36) + "." + rand).slice(0, 64);
  }

  async function logCashbookTransaction(input) {
    const direction = input.direction === "out" ? "out" : "in";

    const hasQtyUnit = input.qty != null && input.qty !== "" &&
      input.unitCostPesos != null && input.unitCostPesos !== "";
    let qty = null, unitCostCentavos = null, amountCentavos;
    if (hasQtyUnit) {
      qty = Number(input.qty);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error("Qty must be a whole number greater than zero.");
      }
      unitCostCentavos = pesosToCentavos(input.unitCostPesos);
      if (!Number.isInteger(unitCostCentavos) || unitCostCentavos <= 0) {
        throw new Error("Unit cost must be greater than zero.");
      }
      amountCentavos = qty * unitCostCentavos; // exact by construction — D3/F5
    } else {
      amountCentavos = pesosToCentavos(input.amountPesos);
    }
    if (!Number.isInteger(amountCentavos) || amountCentavos <= 0) {
      throw new Error("Enter an amount greater than zero.");
    }
    if (!input.category) throw new Error("Pick a category.");

    const orderId = (input.orderId || "").trim() || null;
    const note = (input.note || "").trim();
    const affectsCash = input.affectsCash !== false; // T2 — defaults true
    const idempotencyId = newIdempotencyId();

    // An allocation (affectsCash:false) is a JOB COST, not a cash
    // movement, so it only exists against an order. The mock silently
    // wrote nothing at all in this case and handed back a stand-in that
    // looked like a saved row; say so instead.
    if (!affectsCash && !orderId) {
      throw new Error("An allocation that doesn't move cash has to be linked to an order — it's a job cost, not a cash entry.");
    }
    if (affectsCash && !input.method) throw new Error("Pick a payment method.");

    /* ---- expense against a job -> the costs route ---- */
    if (direction === "out" && orderId) {
      const body = {
        idempotencyId,
        label: note || cashbookCategoryLabel("out", input.category),
        categoryId: input.category,
        affectsCash,
        note,
      };
      if (affectsCash) body.paymentMethod = input.method;
      if (hasQtyUnit) { body.qty = qty; body.unitCostCentavos = unitCostCentavos; }
      else { body.amountCentavos = amountCentavos; }

      const res = await apiFetch("/orders/" + encodeURIComponent(orderId) + "/costs", {
        method: "POST", body: JSON.stringify(body),
      });
      const cost = res.cost || {};
      const txn = res.transaction ? normalizeTxnRow(res.transaction) : null;
      // affectsCash:false never creates a txn row — cashbook.html only
      // reads occurredAt/orderId off the return in that case, to jump to
      // the right day.
      return txn || {
        txnId: null, direction: "out", amountCentavos: cost.amountCentavos || amountCentavos,
        occurredAt: cost.incurredAt, orderId, costId: cost.costId || null,
        wroteTransaction: false,
      };
    }

    /* ---- everything else -> the ledger route ---- */
    const res = await apiFetch("/cashbook/transactions", {
      method: "POST",
      body: JSON.stringify({
        idempotencyId,
        categoryId: input.category,
        amountCentavos,          // positive; the server applies the sign
        paymentMethod: input.method,
        orderId,
        note,
      }),
    });
    const txn = normalizeTxnRow(res.transaction || {});
    // Trap 1: the server warns (never rejects) when this order already
    // carries a system-posted payment transaction, so staff can see they
    // may be double-counting.
    if (res.warning) txn.warning = res.warning;
    txn.idempotentReplay = !!res.idempotentReplay;
    return txn;
  }

  /* D2: a correction is a REVERSAL, not an edit — now enforced
     server-side in ONE transaction (flag the original under a double-void
     guard, append the reversing row into the ORIGINAL day's partition,
     negate both rollups, flag any linked COST# line).

     ADMIN-ONLY. A 403 is surfaced as a plain sentence rather than a raw
     "Forbidden", because for a Staff-role user this is a normal
     permission boundary, not a fault. */
  async function voidCashbookTransaction(txnId, reason, actorName) {
    const trimmed = (reason || "").trim();
    if (!trimmed) throw new Error("A void needs a reason — that's the whole audit trail.");
    try {
      return await apiFetch("/cashbook/transactions/" + encodeURIComponent(txnId) + "/void", {
        method: "POST", body: JSON.stringify({ reason: trimmed }),
      });
    } catch (err) {
      if (err && err.status === 403) {
        throw new Error("Only an Admin can void a transaction. Ask one of the founders to reverse this entry.");
      }
      throw err;
    }
  }

  /* ---- day export (plan §8 "Should have" — CSV handoff) ----
     Flattens ONE day into a single row shape cashbook.html can turn
     straight into CSV, so the export logic (which fields exist, how a
     cost line's qty/unit-cost joins onto its cash leg) lives on this side
     of the seam, not in the page. Deliberately covers MORE than
     getCashbookDay()'s `transactions` list:
       - every cash movement for the day (revenue + expense), including
         voided originals AND their reversing entries — D2 append-only
         means neither is ever hidden from a "complete record" export.
       - a cash-affecting expense linked to a job also carries that cost
         line's qty/unit cost, so the export reads like the job table.
       - a job cost line that does NOT move cash (T2, affectsCash:false)
         is included as its own row with no payment method, since it was
         never a cash movement and would otherwise be silently dropped
         from a day that claims to be the "complete record".
     Money stays integer centavos here; cashbook.html does the
     centavos->decimal-string formatting at the display/write edge (D3).

     F4: two columns encode the netting convention so the CSV can be summed
     without double-counting:
       - `countsTowardTotals` (!voided && !isReversal, AND only for rows
         that are an actual cash movement — a voided original is excluded
         because it's voided, its reversal is excluded because excluding
         the pair is the same arithmetic as netting them, and an
         affectsCash:false allocation is excluded because it never moved
         cash at all and would corrupt a cash-net sum).
       - `signedAmountCentavos`: revenue positive, expense negative,
         using the SAME (direction === "out" ? -1 : 1) * amountCentavos
         convention as formatSignedCentavos's glyph — so
         SUM(signedAmountCentavos WHERE countsTowardTotals) equals the
         day's cash net. */
  async function getCashbookDayExport(dayKey) {
    const key = dayKey || manilaToday();
    // Built from the SAME live day response the screen renders, so the
    // export can never disagree with what staff just looked at.
    const day = await getCashbookDay(key);

    const rows = day.transactions.map((t) => {
      const isReversal = !!t.reversesTxnId;
      return {
        occurredAt: t.occurredAt,
        direction: t.direction,
        category: cashbookCategoryLabel(t.direction, t.category),
        label: t.note || cashbookCategoryLabel(t.direction, t.category),
        // Qty/unit cost live on the COST# line, which is in the ORDER
        // partition rather than the day partition — the day API does not
        // carry them. Left blank rather than guessed; the job costing
        // view is where per-unit economics are answered.
        qty: null,
        unitAmountCentavos: null,
        amountCentavos: t.amountCentavos,
        method: cashbookMethodLabel(t.method),
        affectsCash: true,
        orderId: t.orderId,
        clientName: t.clientName,
        actorName: t.actorName,
        note: t.note,
        voided: t.voided,
        voidReason: t.voidReason,
        isReversal,
        // F4: same netting convention the rollup uses, so summing this
        // column reproduces the day's net without double-counting a
        // voided row and its reversal.
        countsTowardTotals: !t.voided && !isReversal,
        signedAmountCentavos: (t.direction === "out" ? -1 : 1) * t.amountCentavos,
      };
    });

    // NOTE: affectsCash:false cost lines are deliberately absent. They
    // never produce a TXN# row (that is the whole point of the flag), and
    // finding them for an arbitrary day would need a scan across every
    // order partition. They belong to a job, not to a day's cash, and the
    // job costing view reports them in full.
    rows.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
    return { dayKey: key, dayLabel: manilaDayLabel(key), rows };
  }

  /* ---- staff idle-screen PIN (server-verified since 2026-08-07) ----
     Gates dashboard-shell.js's SESSION_GUARD idle overlay. The PIN now
     lives ONLY on the backend — backend/staff-api/staff-pin.js stores a
     per-staffer scrypt hash keyed off the JWT's verified `sub` (never a
     sub from a request body) and rate-limits verification attempts
     server-side (exponential lockout after 5 wrong guesses, counted on
     the record so devtools/network replays can't dodge it). NOTHING about
     the PIN is kept in localStorage/sessionStorage any more, in any form —
     the old kcmps_pin_v1:<sub> salt+SHA-256 records were brute-forceable
     offline in under a second, and the type="password" fields that fed
     them taught browser password managers to save the PIN and then
     AUTO-FILL IT INTO THE LOCK SCREEN, unlocking it for anyone walking
     past. Legacy records are scrubbed on load (below).

     Honest threat model (mirror of staff-pin.js's header): this defends
     against a passer-by at an unattended screen and against casual
     devtools bypass of the old client-side check. It is NOT a defence
     against the authenticated staffer themselves — the Cognito session
     is the real boundary, and devtools can still delete the overlay DOM
     and read what the page already loaded. Never oversell it in UI copy.

     hasStaffPin() must stay synchronous (dashboard-shell.js builds the
     overlay markup inline), so the status is prefetched once per page
     load (prefetchStaffPinStatus, called from the shell's mount()) and
     cached in memory. `pinStatusCache`: null = not yet known. */
  let pinStatusCache = null;
  // Scrub the retired client-side PIN records — they hold a weakly-hashed
  // copy of what may still be the staffer's current PIN.
  try {
    Object.keys(localStorage)
      .filter((k) => k.indexOf("kcmps_pin_v1:") === 0)
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }

  function staffPinStatusKnown() { return pinStatusCache !== null; }
  // userKey params below are kept for call-site compatibility but unused:
  // the server keys everything off the verified JWT sub itself.
  function hasStaffPin() { return pinStatusCache === true; }
  async function getStaffPinStatus() {
    const res = await apiFetch("/staff/pin", { method: "GET" });
    pinStatusCache = !!res.pinSet;
    return pinStatusCache;
  }
  // Fire-and-forget wrapper for mount(): never throws (an offline/failed
  // status fetch leaves the cache null, and the guard fails closed on the
  // restored-lock path — see dashboard-shell.js).
  function prefetchStaffPinStatus() {
    return getStaffPinStatus().catch(() => null);
  }
  async function setStaffPin(userKey, pin) {
    if (!/^\d{4,6}$/.test(pin || "")) throw new Error("PIN must be 4-6 digits.");
    await apiFetch("/staff/pin", { method: "PUT", body: JSON.stringify({ pin }) });
    pinStatusCache = true;
    return true;
  }
  /* Returns a structured result, not a bare boolean:
       { ok: true }                                   correct PIN
       { ok: false }                                  wrong PIN
       { ok: false, pinSet: false }                   no PIN on file (treat as unlocked)
       { ok: false, locked: true, retryAfterSeconds } rate-limited (server 429)
       { ok: false, error }                           network/other failure   */
  async function verifyStaffPin(userKey, pin) {
    try {
      const res = await apiFetch("/staff/pin/verify", { method: "POST", body: JSON.stringify({ pin }) });
      if (res.pinSet === false) pinStatusCache = false;
      return res;
    } catch (err) {
      if (err && err.status === 429 && err.body) {
        return { ok: false, locked: true, retryAfterSeconds: err.body.retryAfterSeconds || 30 };
      }
      return { ok: false, error: err && err.message ? err.message : "Couldn't check the PIN — are you online?" };
    }
  }
  async function clearStaffPin() {
    await apiFetch("/staff/pin", { method: "DELETE" });
    pinStatusCache = false;
  }

  global.KCMPS_DASH = {
    STORAGE_KEY, STATIONS, STATION_LABELS,
    assetApiAvailable, getAssets, getAssetApprovalSummary, getAssetUploadUrls, createAsset,
    updateAsset, archiveAsset, restoreAsset, submitAssetForApproval, approveAsset, rejectAsset, publishAssetDirect,
    getMailboxes, getMessages, getMessage, getThread, markMessageRead, sendReply,
    getQueues, getTodayNumbers, getLowStock, getBlockers, addBlocker, resolveBlocker,
    advanceLineItem, sendToRework, setSetupMinutes, verifyPayment, setOnHold,
    getWeekData, getMonthData,
    getStations, getSpoilageReasons, getClients, getInventoryAll, adjustInventory,
    getOrder, getAllOrders, getEventsFor, addCorrespondence,
    getDashboardPrefs, setDashboardPref,
    setOrderTags, getDefaultOrderTags,
    getOrderMessages, sendOrderMessage, getUnreadMessageSummary, markMessagesRead,
    createManualOrder,
    // Cash Book + job costing (mock — see the CASH BOOK section above).
    getCashbookDay, getCashbookMonth, logCashbookTransaction, voidCashbookTransaction,
    getCashbookCategories, getCashbookMethods, cashbookCategoryLabel, cashbookMethodLabel,
    getJobCosting, getJobCostingList, getCashbookDayExport,
    // Manila-date + centavo helpers. Exported so cashbook.html never
    // reimplements either — a second copy of the +8 shift or the
    // float->int conversion is exactly how the two drift apart.
    manilaToday, manilaDayOf, manilaShiftDay, manilaMonthOf,
    manilaDayLabel, manilaTimeLabel, manilaMonthLabel,
    pesosToCentavos, formatCentavos, formatSignedCentavos, formatCentavosDecimal,
    resetSeed,
    hasStaffPin, setStaffPin, verifyStaffPin, clearStaffPin,
    staffPinStatusKnown, getStaffPinStatus, prefetchStaffPinStatus,
  };
})(window);
