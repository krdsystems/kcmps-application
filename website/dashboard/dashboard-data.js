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
    if (!res.ok) throw new Error(body.error || res.statusText);
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
      seededAt: nowIso(),
    };
  }

  // Delivered (courier) and Picked Up (pickup fulfillment) are equivalent
  // terminal states for rollup purposes — §6's two fulfillment branches.
  function isFulfilled(s) { return s === "Delivered" || s === "Picked Up"; }

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
      sat: { open: "09:00", close: "14:00" },
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

  // No dedicated thread endpoint on the real API — get-mail-messages.js's
  // envelopes already carry threadId, so this pages through INBOX + SENT
  // (a thread can span both) and filters/sorts client-side, same shape the
  // mock returned (ascending by date, envelope fields only — email.html's
  // thread rows only ever read t.date/t.snippet/t.messageId, never
  // t.bodyText, so envelopes are sufficient here).
  async function getThread(mailboxId, threadId) {
    if (!threadId) return [];
    const [inbox, sent] = await Promise.all([
      getMessages(mailboxId, { folder: "INBOX", limit: 200 }),
      getMessages(mailboxId, { folder: "SENT", limit: 200 }),
    ]);
    return [...(inbox.messages || []), ...(sent.messages || [])]
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
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
    return apiFetch(mailPath(mailboxId, "/messages/" + encodeURIComponent(messageId) + "/reply"), {
      method: "POST",
      body: JSON.stringify({ bodyText: p.bodyText, cc: p.cc }),
    });
  }

  /* ---- Design Asset Library (live — Milestone: Design Asset Library) ----
     Behind the same KCMPS_DASH seam as getAllOrders/verifyPayment/etc — live-only,
     no localStorage fallback, matching how those functions work. Backend is
     backend/design-library/*.js (get-upload-url.js/publish-design.js/list-designs.js/
     patch-design.js), deployed on kcmps-backend-staging. See root CLAUDE.md's
     "Design asset library" row. */
  async function getDesigns() {
    const { designs } = await apiFetch("/designs", { method: "GET" });
    return designs || [];
  }

  // Step 1 of 2 — presigned PUT URLs for the original + web-ready files.
  // meta: { category, original: {filename, contentType, size}, web: {filename, contentType, size} }
  async function getDesignUploadUrls(meta) {
    return apiFetch("/designs/upload-url", { method: "POST", body: JSON.stringify(meta) });
  }

  // Step 2 of 2 — called after both presigned PUTs succeed. meta: { name,
  // description, category, tags, status, s3KeyOriginal, s3KeyWeb }. May
  // 409 with { stillScanning: true } if GuardDuty hasn't verdicted either
  // file yet — callers should treat that as a retry-able state, not an error.
  async function publishDesign(meta) {
    return apiFetch("/designs", { method: "POST", body: JSON.stringify(meta) });
  }

  async function updateDesign(id, patch) {
    return apiFetch("/designs/" + encodeURIComponent(id), {
      method: "PATCH", body: JSON.stringify({ action: "update", ...patch }),
    });
  }

  async function archiveDesign(id) {
    return apiFetch("/designs/" + encodeURIComponent(id), {
      method: "PATCH", body: JSON.stringify({ action: "archive" }),
    });
  }

  async function restoreDesign(id) {
    return apiFetch("/designs/" + encodeURIComponent(id), {
      method: "PATCH", body: JSON.stringify({ action: "restore" }),
    });
  }

  // draft -> published promotion, same fail-closed scan gate as publishDesign().
  async function promoteDesign(id) {
    return apiFetch("/designs/" + encodeURIComponent(id), {
      method: "PATCH", body: JSON.stringify({ action: "publish" }),
    });
  }

  global.KCMPS_DASH = {
    STORAGE_KEY, STATIONS, STATION_LABELS,
    getDesigns, getDesignUploadUrls, publishDesign, updateDesign, archiveDesign, restoreDesign, promoteDesign,
    getMailboxes, getMessages, getMessage, getThread, markMessageRead, sendReply,
    getQueues, getTodayNumbers, getLowStock, getBlockers, addBlocker, resolveBlocker,
    advanceLineItem, sendToRework, setSetupMinutes, verifyPayment, setOnHold,
    getWeekData, getMonthData,
    getStations, getSpoilageReasons, getClients, getInventoryAll, adjustInventory,
    getOrder, getAllOrders, getEventsFor, addCorrespondence,
    getOrderMessages, sendOrderMessage, getUnreadMessageSummary, markMessagesRead,
    createManualOrder,
    resetSeed,
  };
})(window);
