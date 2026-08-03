/* KCMPS — customer order-tracking seam (window.KCMPS_ORDERS)
   The ONLY thing orders.html/order-detail.html touch for session, fetch,
   status, and formatting logic — mirrors window.KCMPS_STORE (store.js) and
   window.KCMPS_DASH (dashboard-data.js). When a backend change lands (e.g.
   Phase 2's server-side redaction), only this file's function bodies change.

   Load order on both pages: products.js, store.js, THIS FILE, then the
   page's own inline script. store.js is loaded (not just this file) so
   reorder can call the real window.KCMPS_STORE.addToCart/requestQty and
   payment-proof resubmission can call window.KCMPS_STORE.submitPaymentProof
   — reusing the exact checkout logic instead of forking a second copy of a
   two-step presigned S3 upload. */
(function () {
  "use strict";

  var DATA = window.KCMPS_STORE_DATA || { products: [], leaves: {}, currency: "₱" };

  var COGNITO_CONFIG = {
    domain: "https://ap-southeast-1idvaeumnp.auth.ap-southeast-1.amazoncognito.com",
    clientId: "95rrk0mflffentqdiomg1fipc",
    redirectUri: window.location.origin + "/",
  };
  var TOKEN_STORAGE_KEY = "kcmps_tokens";
  // backend/staff-api/get-orders.js behind kcmps-checkout-api (HTTP API id
  // 6msg2uho6c, ap-southeast-1) — same API store.js's CHECKOUT_API_BASE
  // points at. Keep all three copies (here, store.js, orders.html/
  // order-detail.html's CSP connect-src) in sync if this API is recreated.
  var API_BASE = "https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com";
  var ORDER_EMAIL = "order@kcmps.com";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtPeso(n) {
    return (DATA.currency || "₱") + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }); }
    catch (e) { return iso; }
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (e) { return iso; }
  }

  /* ---------- session ---------- */
  function loadTokens() {
    try { var raw = sessionStorage.getItem(TOKEN_STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function clearTokens() { sessionStorage.removeItem(TOKEN_STORAGE_KEY); }
  function decodeClaims(idJwt) {
    try { return JSON.parse(atob(idJwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); }
    catch (e) { return {}; }
  }
  function getSession() {
    var tokens = loadTokens();
    if (!tokens || !tokens.id_token) return null;
    return { idToken: tokens.id_token, claims: decodeClaims(tokens.id_token) };
  }
  function requireSession() {
    var session = getSession();
    if (!session) { window.location.replace("index.html?login=required"); return null; }
    return session;
  }
  function logout() {
    clearTokens();
    window.location.href = COGNITO_CONFIG.domain + "/logout?" + new URLSearchParams({
      client_id: COGNITO_CONFIG.clientId, logout_uri: COGNITO_CONFIG.redirectUri,
    }).toString();
  }

  /* ---------- status model ----------
     Two backend vocabularies feed this one table: line-item STATUS
     (backend/lib/constants.js) and the order-level rollup (deriveOrderStatus
     in backend/lib/order-status.js), which has extra values (Awaiting Quote,
     Awaiting Payment, Partially Fulfilled, Unknown) that STATUS does not.
     orders.html used to key its stage map on the line-item vocabulary while
     feeding it the rollup — every rollup-only value fell through to stage 0
     "Order Placed", so a part-delivered order visually regressed to
     not-started and a priced quote gave no hint payment was owed. This map
     covers BOTH vocabularies so that bug can't recur. */
  var STAGES = ["Order Placed", "Payment Verification", "Confirmed", "In Production", "Quality Check", "Delivered"];
  var BUCKETS = {
    action: { order: 0, label: "Action needed" },
    progress: { order: 1, label: "In progress" },
    completed: { order: 2, label: "Completed" },
    cancelled: { order: 3, label: "Cancelled" },
  };

  function readyLabel(ctx) { return ctx && ctx.fulfillment === "Delivery" ? "Ready to ship" : "Ready for pickup"; }
  function dispatchedLabel(ctx) {
    var courier = ctx && ctx.shipping && ctx.shipping.courier;
    return courier ? "On the way via " + courier : "On the way";
  }
  function deliveredLabel(ctx) { return ctx && ctx.fulfillment === "Delivery" ? "Delivered" : "Collected"; }

  var STATUS_TABLE = {
    // Placed but no GCash proof submitted yet — before submitPaymentProof.js
    // ever runs, a sku line item sits here, not in Pending Payment
    // Verification (see backend/checkout/create-order.js's header).
    "Order Placed": { bucket: "action", stage: 0, label: "Payment needed", next: "Scan the GCash QR and submit your reference number to move this order along.", tone: "warn" },
    "Quoted": { bucket: "progress", stage: 0, label: "Quote in progress", next: "We're pricing your custom item — usually within 24 hours.", tone: "neutral" },
    "Awaiting Quote": { bucket: "progress", stage: 0, label: "Quote in progress", next: "We're pricing your custom item — usually within 24 hours.", tone: "neutral" },
    "Priced": { bucket: "action", stage: 0, label: "Quote ready — payment needed", next: "Your quote is ready. Settle it to start production.", tone: "warn" },
    "Awaiting Payment": { bucket: "action", stage: 0, label: "Quote ready — payment needed", next: "Your quote is ready. Settle it to start production.", tone: "warn" },
    "Pending Payment Verification": { bucket: "progress", stage: 1, label: "Checking your payment", next: "We're verifying your GCash proof — usually within 48 hours.", tone: "neutral" },
    "Payment Rejected": { bucket: "action", stage: 1, label: "Payment needs attention", next: "Resubmit your GCash proof, or contact us if you need help.", tone: "bad" },
    "Confirmed": { bucket: "progress", stage: 2, label: "Payment confirmed", next: "Payment confirmed — we're scheduling your job.", tone: "good" },
    "Scheduled": { bucket: "progress", stage: 2, label: "Scheduled for production", next: "Booked into the production queue.", tone: "good" },
    "In Production": { bucket: "progress", stage: 3, label: "Being made", next: "Your order is on the press.", tone: "good" },
    "Rework": { bucket: "progress", stage: 3, label: "Being remade", next: "We found an issue at quality check and are redoing it — quality first.", tone: "warn" },
    "QC": { bucket: "progress", stage: 4, label: "Quality check", next: "We check every piece before it goes out.", tone: "good" },
    // Delivery branch (§6): QC -> Ready for Dispatch -> Dispatched -> Delivered.
    "Ready for Dispatch": { bucket: "progress", stage: 5, label: null, next: null, tone: "good", dynamicLabel: readyLabel },
    "Dispatched": { bucket: "progress", stage: 5, label: null, next: null, tone: "good", dynamicLabel: dispatchedLabel },
    "Delivered": { bucket: "completed", stage: 5, label: null, next: null, tone: "good", dynamicLabel: deliveredLabel },
    // Pickup branch (§6): QC -> Ready for Pickup -> Picked Up. Picked Up is
    // this branch's Delivered-equivalent terminal state (see
    // deriveOrderStatus() — treated as "fulfilled" for rollup).
    "Ready for Pickup": { bucket: "action", stage: 5, label: "Ready for pickup", next: "Your order is ready — swing by to collect it.", tone: "good" },
    "Picked Up": { bucket: "completed", stage: 5, label: "Picked up", next: null, tone: "good" },
    "Partially Fulfilled": { bucket: "progress", stage: 5, label: "Partly delivered", next: "Some items are with you, the rest are still in progress.", tone: "neutral" },
    "Cancelled": { bucket: "cancelled", stage: null, label: "Cancelled", next: null, tone: "bad" },
    "Auto-Cancelled": { bucket: "cancelled", stage: null, label: "Cancelled — payment window expired", next: "The 48-hour verification window passed. You can reorder anytime.", tone: "bad" },
    "Quote Expired": { bucket: "cancelled", stage: null, label: "Quote expired", next: "This quote expired after 7 days. Reorder for a fresh one.", tone: "bad" },
  };
  var UNKNOWN_MODEL = { bucket: "progress", stageIndex: 0, label: "Order placed", next: null, tone: "neutral" };

  function statusModel(status, ctx) {
    var row = STATUS_TABLE[status];
    if (!row) {
      // A status the table doesn't know about — fail loud in the console
      // (so a future backend status shows up in testing) but render as a
      // safe, generic "in progress" rather than silently mis-rendering.
      if (status) console.warn("[orders-data] unmapped status, falling back to Unknown:", status);
      return Object.assign({ raw: status || "Unknown" }, UNKNOWN_MODEL);
    }
    return {
      raw: status,
      bucket: row.bucket,
      stageIndex: row.stage,
      label: row.dynamicLabel ? row.dynamicLabel(ctx) : row.label,
      next: row.next,
      tone: row.tone,
    };
  }

  /* ---------- normalization ---------- */
  function lineTotal(li) { return Number(li.amount || 0); }
  function orderTotal(order) {
    return (order.lineItems || []).reduce(function (s, li) { return s + lineTotal(li); }, 0);
  }
  function orderPaid(order) {
    var p = order.payment;
    if (!p || !p.verifiedAt) return 0;
    return orderTotal(order); // sku items are pay-now; a verified order's sku total is what was paid
  }
  function orderId(order) { return (order.PK || "").replace("ORDER#", "") || order.orderId || ""; }

  // Product image lookup — mirrors store.js's thumbImage(): a line's own
  // designRef (a real image chosen at checkout) wins, else the matching
  // catalog product's image, else its leaf's image.
  var productBySku = {};
  (DATA.products || []).forEach(function (p) { productBySku[p.id] = p; });
  function lineImage(li) {
    if (li.designRef) return li.designRef;
    var p = li.sku ? productBySku[li.sku] : null;
    if (p && p.image) return p.image;
    var leaf = p ? DATA.leaves[p.leaf] : null;
    return (leaf && leaf.image) || null;
  }

  /* ---------- plain-language timeline ----------
     order.events already includes staff-internal fields (actorSub,
     actorName, station, meta) — real redaction belongs server-side
     (Phase 2 of the My Orders plan), but until that ships this is the one
     place a customer-facing rendering is built, so it only ever surfaces
     `to`/`at` plus the customer-relevant part of `meta` (a rejection
     reason), never actorName/station/meta.via. */
  function timelineFor(order) {
    var events = (order.events || []).slice().sort(function (a, b) { return (a.at || "").localeCompare(b.at || ""); });
    return events.map(function (ev) {
      var model = statusModel(ev.to, order);
      var detail = null;
      if (ev.to === "Payment Rejected" && ev.meta && ev.meta.rejectionReason) detail = ev.meta.rejectionReason;
      return { at: ev.at, label: model.label || ev.to, detail: detail, tone: model.tone };
    });
  }

  /* ---------- actions ----------
     CANCELLABLE_STATUSES mirrors backend/checkout/cancel-order.js's own
     CANCELLABLE_STATUSES exactly — this copy is UI-only (whether to show
     the button at all); the backend re-checks authoritatively and 409s
     with a clear message if a line item advanced past this set between
     page load and the click (e.g. staff just started production). */
  var CANCELLABLE_STATUSES = { "Order Placed": 1, "Quoted": 1, "Priced": 1, "Pending Payment Verification": 1, "Payment Rejected": 1 };
  function actionsFor(order) {
    var overall = statusModel(order.orderStatus, order);
    var anyRejected = (order.lineItems || []).some(function (li) { return li.status === "Payment Rejected"; });
    var allCancellable = (order.lineItems || []).length > 0 &&
      (order.lineItems || []).every(function (li) { return CANCELLABLE_STATUSES[li.status]; });
    return {
      resubmitProof: overall.raw === "Payment Rejected" || anyRejected,
      reorder: (order.lineItems || []).length > 0,
      cancel: allCancellable,
      contact: true,
    };
  }

  function normalizeOrder(raw) {
    var lineItems = (raw.lineItems || []).map(function (li) {
      return Object.assign({}, li, {
        name: li.description || li.name || "Item",
        image: lineImage(li),
        status: statusModel(li.status, raw),
      });
    });
    var order = Object.assign({}, raw, {
      orderId: orderId(raw),
      lineItems: lineItems,
    });
    order.total = orderTotal(order);
    order.paidTotal = orderPaid(order);
    order.amountDue = order.total - order.paidTotal;
    order.itemCount = lineItems.reduce(function (s, li) { return s + (li.qty || 1); }, 0);
    order.status = statusModel(raw.orderStatus, raw);
    order.bucket = order.status.bucket;
    order.actions = actionsFor(raw);
    return order;
  }

  /* ---------- fetch + cache ----------
     GET /orders is a full-table Scan on the backend (getOrdersForSub), so
     this deliberately does NOT poll. Cache for 30s; visibilitychange forces
     a refresh so switching back to the tab after a while picks up staff
     actions without a manual reload. */
  var cache = null; // { at, orders }
  var CACHE_MS = 30000;
  var inflight = null;

  function fetchOrders(session) {
    return fetch(API_BASE + "/orders", { headers: { Authorization: "Bearer " + session.idToken } })
      .then(function (res) {
        if (res.status === 401) { clearTokens(); window.location.replace("index.html?login=required"); return null; }
        if (!res.ok) throw new Error("Couldn't load your orders right now (" + res.status + ").");
        return res.json();
      })
      .then(function (body) {
        if (!body) return [];
        var orders = (body.orders || []).map(normalizeOrder);
        orders.sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); });
        cache = { at: Date.now(), orders: orders };
        return orders;
      });
  }

  function list(opts) {
    var force = opts && opts.force;
    var session = requireSession();
    if (!session) return Promise.resolve([]);
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.orders);
    if (inflight) return inflight;
    inflight = fetchOrders(session).then(function (orders) { inflight = null; return orders; }, function (err) { inflight = null; throw err; });
    return inflight;
  }
  function refresh() { return list({ force: true }); }
  function get(id) {
    return list().then(function (orders) { return orders.find(function (o) { return o.orderId === id; }) || null; });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && cache && Date.now() - cache.at > CACHE_MS) refresh();
  });

  /* ---------- reorder (zero backend) ----------
     Re-adds each line via the real window.KCMPS_STORE.addToCart — never
     trusts the order's stored priceEach, always re-derives from the live
     catalog (prices/products change). Three cases are reported explicitly
     rather than failing silently: a delisted SKU, a price that no longer
     matches what was charged, and a custom line (which has no fixed
     variant/price to re-add — it's re-filed as a fresh request instead). */
  function findVariant(p, variantLabel) {
    var variants = p.variants || [{ label: "", price: p.price || 0 }];
    if (!variantLabel) return variants[0];
    var wanted = String(variantLabel).split(" + ")[0];
    return variants.find(function (v) { return v.label === wanted; }) || null;
  }

  function reorderLine(li, added, skipped, priceChanged) {
    var store = window.KCMPS_STORE;
    if (li.type === "custom") {
      // No fixed price/variant to replay — re-file as a fresh custom
      // request, same shape customCard()/quoteCard() build in store.js.
      var p = li.sku ? productBySku[li.sku] : null;
      var leaf = p ? p.leaf : String(li.sku || "").replace(/^custom-/, "") || "print";
      store.addToCart({
        key: "custom|" + leaf + "|" + Date.now(),
        id: li.sku || ("custom-" + leaf), name: li.name || "Custom design request",
        leaf: leaf, type: "custom", variantLabel: "", shirt: false, unitPrice: 0, qty: 1,
      });
      added.push({ name: li.name, note: "Re-filed as a new custom request — please describe it again at checkout." });
      return;
    }
    var product = li.sku ? productBySku[li.sku] : null;
    if (!product) { skipped.push({ name: li.name, reason: "no longer available" }); return; }
    // A product with addon groups but no real named variants (today: only
    // Document Printing's B/W vs Colored) folds a non-default addon into
    // the SAME variantLabel string skuCard() builds ("Colored (₱7/page)",
    // with no variant prefix, since there's no real variant to prefix it
    // with — see the addToCart() call in skuCard()). A non-empty
    // variantLabel here is therefore an addon label, not a variant, and
    // findVariant() below has no reliable way to reconstruct which addon
    // was chosen. Skip rather than risk silently re-pricing at the base
    // rate. An empty/default variantLabel (no addon selected) has no such
    // ambiguity and reorders normally below.
    var hasNamedVariants = product.variants && product.variants.length > 0;
    if (product.addons && product.addons.length && !hasNamedVariants && li.variantLabel) {
      skipped.push({ name: li.name, reason: "has options that need to be re-selected — please re-add it manually" }); return;
    }
    var variant = findVariant(product, li.variantLabel);
    if (!variant) { skipped.push({ name: li.name, reason: "that option isn't offered anymore — please re-add it manually" }); return; }
    var baseUnitPrice = variant.price + (li.shirt && product.shirtAddon ? (DATA.shirtAddon && DATA.shirtAddon.price || 0) : 0);
    if (li.priceEach != null && Math.abs(baseUnitPrice - li.priceEach) > 0.01) priceChanged.push(li.name);
    store.requestQty(product.softCap, li.qty || 1, function (finalQty) {
      var unitPrice = store.bulkUnitPrice(baseUnitPrice, finalQty, product.bulkTiers);
      store.addToCart({
        key: product.id + "|reorder|" + (li.variantLabel || "") + "|" + (li.shirtColor || "") + "|" + (li.designRef || "") + "|" + Date.now(),
        id: product.id, name: product.name, leaf: product.leaf, type: "sku",
        variantLabel: li.variantLabel || variant.label, shirt: !!li.shirt, shirtColor: li.shirtColor || null,
        unitPrice: unitPrice, baseUnitPrice: product.bulkTiers ? baseUnitPrice : null, qty: finalQty,
        designRef: li.designRef || null, designName: li.designName || null,
      });
      added.push({ name: li.name });
    }, product.id + ":reorder");
  }

  function reorder(order) {
    var store = window.KCMPS_STORE;
    if (!store) return Promise.reject(new Error("Cart isn't available on this page."));
    var added = [], skipped = [], priceChanged = [];
    (order.lineItems || []).forEach(function (li) { reorderLine(li, added, skipped, priceChanged); });
    return Promise.resolve({ added: added, skipped: skipped, priceChanged: priceChanged });
  }

  /* ---------- resubmit payment proof ----------
     Delegates to window.KCMPS_STORE.submitPaymentProof (DOM-independent —
     see store.js) so this doesn't fork a second copy of the two-step (POST
     for a presigned URL, then PUT the file to S3) upload logic. */
  function submitProof(orderId, ref, amount, file, callback) {
    var store = window.KCMPS_STORE;
    if (!store || !store.submitPaymentProof) { callback(new Error("Payment form isn't available on this page.")); return; }
    store.submitPaymentProof(orderId, ref, amount, file, callback);
  }

  /* ---------- cancel (backend/checkout/cancel-order.js) ----------
     Every caller of this page already has a session (requireSession()
     redirected otherwise), so this always authorizes via the Bearer ID
     token — the contact-match fallback that same endpoint offers guests
     is for a future guest-facing lookup/cancel surface, not this one. */
  function cancel(orderId, reason) {
    var session = getSession();
    if (!session) return Promise.reject(new Error("Please sign in again to cancel this order."));
    return fetch(API_BASE + "/orders/" + encodeURIComponent(orderId) + "/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.idToken },
      body: JSON.stringify({ reason: reason || "" }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : "Could not cancel this order (" + res.status + ")");
        return data;
      });
    });
  }

  window.KCMPS_ORDERS = {
    getSession: getSession, requireSession: requireSession, logout: logout,
    list: list, get: get, refresh: refresh,
    STAGES: STAGES, BUCKETS: BUCKETS, statusModel: statusModel, timelineFor: timelineFor,
    actionsFor: actionsFor, reorder: reorder, submitProof: submitProof, cancel: cancel,
    fmtPeso: fmtPeso, fmtDate: fmtDate, fmtDateTime: fmtDateTime, escapeHtml: escapeHtml,
    ORDER_EMAIL: ORDER_EMAIL,
  };
})();
