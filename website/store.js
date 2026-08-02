/* ============================================================================
   KCMPS — storefront cart (static, front-end only)
   ----------------------------------------------------------------------------
   Owns: data-driven rendering of product cards into each catalog leaf, the
   cart (localStorage), the slide-in cart drawer + badge, and a two-path
   checkout that CAPTURES the order and hands it to the business by email.

   TWO PAYMENT PATHS (Hormozi "no-brainer" + the owner's model):
     • SKU items  → have a real price, counted in the "Pay now" subtotal.
     • Custom items → added at ₱0, listed under "Pending approval". The customer
                      is billed only AFTER KCMPS approves the request in the
                      internal dashboard (future phase).

   BACKEND MIGRATION POINTS (nothing else changes when these are swapped):
     1. Catalog data — replace `window.KCMPS_STORE_DATA` (products.js) with a
        fetch() to your catalog API returning the same shape, then renderCatalog().
     2. Cart persistence — today localStorage under CART_KEY. Later: an API
        (e.g. API Gateway + Lambda over DynamoDB keyed by the Cognito `sub`),
        called with the access token from the auth script's loadTokens().
     3. Checkout — DONE (2026-07-31, docs/roadmap.md Milestone 1.1/1.2): submitOrder()
        POSTs to CHECKOUT_API_BASE/orders (backend/checkout/create-order.js behind
        kcmps-checkout-api, see backend/infra/README.md) instead of composing a
        mailto:. Guest checkout unchanged — the Bearer token is attached only if
        a Cognito session already exists (idToken() below), never required.
        The post-checkout popup then collects the GCash reference number, claimed
        amount, and a screenshot upload, POSTs to submit-payment-proof.js for a
        pre-signed S3 URL, then PUTs the file straight to S3 — see
        renderPaymentProofStep()/submitPaymentProof() below. An all-custom order
        (nothing to pay yet) skips straight to a plain confirmation instead.

   CSP-safe: same-origin script, no external requests, thumbnails are CSS.
   ============================================================================ */
(function () {
  "use strict";

  // Never run inside the Cognito auth popups (the page is reused as the OAuth
  // landing/return surface — see the auth-popup detection in index.html).
  if (document.documentElement.classList.contains("auth-popup")) return;

  var DATA = window.KCMPS_STORE_DATA;
  if (!DATA) { console.warn("[store] KCMPS_STORE_DATA missing — is products.js loaded?"); return; }

  var CART_KEY = "kcmps_cart";
  // Fallback only now — shown in the payment-proof step for the rare case a
  // customer's upload genuinely fails (e.g. a corporate network blocking S3).
  var ORDER_EMAIL = "order@kcmps.com";
  // backend/checkout/{create-order,submit-payment-proof}.js behind
  // kcmps-checkout-api (HTTP API id 6msg2uho6c, ap-southeast-1) — see
  // backend/infra/README.md. Also present in index.html's CSP connect-src;
  // keep both in sync if this API is ever recreated under a different id.
  var CHECKOUT_API_BASE = "https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com";
  // Same sessionStorage key index.html's auth script writes to
  // (TOKEN_STORAGE_KEY there) — read independently here rather than via a
  // shared export, matching how dashboard-shell.js already does this.
  var AUTH_TOKEN_KEY = "kcmps_tokens";
  // ID token, not access token — the checkout API's JWT verifier requires
  // tokenUse: "id" (needs aud/cognito:groups, only on the ID token). Sending
  // the access token verifies-but-fails silently, leaving customerSub null.
  function idToken() {
    try {
      var raw = sessionStorage.getItem(AUTH_TOKEN_KEY);
      var tokens = raw ? JSON.parse(raw) : null;
      return tokens && tokens.id_token ? tokens.id_token : null;
    } catch (e) { return null; }
  }

  var peso = function (n) {
    return DATA.currency + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  /* ---------- bulk-quantity pricing ----------
     A product opts in with `bulkTiers: [{ minQty, discountPct }, ...]`
     (ascending minQty). Given a line's pre-discount unit price and its
     current qty, returns the discounted unit price at the highest tier the
     qty qualifies for (or the base price if none apply). Used both for the
     live price shown on a product card as the qty stepper changes, and to
     recompute a cart line's unitPrice when its qty changes in the drawer —
     see skuCard()'s unitPrice()/refresh() and setQty(). */
  function activeBulkTier(qty, tiers) {
    if (!tiers || !tiers.length) return null;
    var best = null;
    tiers.forEach(function (t) { if (qty >= t.minQty && (!best || t.minQty > best.minQty)) best = t; });
    return best;
  }
  function bulkUnitPrice(base, qty, tiers) {
    var tier = activeBulkTier(qty, tiers);
    return tier ? Math.round(base * (1 - tier.discountPct / 100) * 100) / 100 : base;
  }

  /* ---------- capacity soft-cap (production-lead-time throttle) ----------
     KCMPS is a 4-person all-in-one team — an order of, say, 10,000 pieces
     typed into a qty field would swamp them. A product opts in with
     `softCap: N` (products.js): the qty above which a real order needs extra
     lead time. It's a THROTTLE, not a hard block — requestQty() is the single
     entry point every qty input (product-card stepper, cart-drawer stepper,
     the index.html bulk estimator) routes through, so they can't disagree on
     when to warn or how far to let a shopper go.

     - Below the cap: no popup, works exactly as before.
     - Above the cap, below the hard ceiling (5x cap): openCapPopup() shows
       the added lead time (2 business days per extra cap-multiple) and lets
       the shopper either "Keep at max" (clamped back to the cap) or
       "I agree" (their requested qty is honored).
     - Above the ceiling: too large to self-serve online at all — the popup
       instead points them at a manual quote (mirrors the existing
       "Message us for a custom production plan" copy in the bulk estimator)
       and clamps to the ceiling.

     capAcknowledgedByKey is a plain in-memory object, deliberately NOT
     sessionStorage/localStorage — the ask was for the override to reset on
     a page refresh, which rules out both Web Storage APIs (they'd survive
     it). It's keyed per product/line (see each requestQty() call site for
     what it passes as `key`) rather than one flag for the whole page:
     agreeing to a big order on one product shouldn't silently wave a
     different product's overflow through too — each card/line re-asks once. */
  var CAP_CEILING_MULT = 5;
  var CAP_EXTRA_DAYS_PER_STEP = 2;
  var capAcknowledgedByKey = {};

  function capInfo(qty, cap) {
    if (!cap || qty <= cap) return null;
    var ceilingQty = cap * CAP_CEILING_MULT;
    var steps = Math.ceil(qty / cap) - 1;
    return { cap: cap, ceilingQty: ceilingQty, blocked: qty > ceilingQty, extraDays: steps * CAP_EXTRA_DAYS_PER_STEP };
  }

  var capPopup, capPopupTitleEl, capPopupBodyEl, capPopupActionsEl;

  function buildCapPopup() {
    var backdrop = document.createElement("div");
    backdrop.className = "cap-popup-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.innerHTML =
      '<div class="cap-popup" role="dialog" aria-modal="true" aria-labelledby="cap-popup-title">' +
        '<h3 class="dialog-title" id="cap-popup-title"></h3>' +
        '<p class="dialog-body" id="cap-popup-body"></p>' +
        '<div class="dialog-actions" id="cap-popup-actions"></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    capPopup = backdrop;
    capPopupTitleEl = backdrop.querySelector("#cap-popup-title");
    capPopupBodyEl = backdrop.querySelector("#cap-popup-body");
    capPopupActionsEl = backdrop.querySelector("#cap-popup-actions");
  }

  function closeCapPopup() {
    if (!capPopup) return;
    capPopup.classList.remove("is-open");
    capPopup.setAttribute("aria-hidden", "true");
  }

  // Shows the popup for the given capInfo() result and calls back(agreed)
  // once the shopper picks an action. In the blocked (over-ceiling) case
  // there's only one button and it always resolves false (clamp to ceiling)
  // — there's no "agree" option once an order is too large to self-serve.
  // `key` (see requestQty below) is only used to record acknowledgment for
  // that one product/line, not to change anything shown in the popup itself.
  function openCapPopup(info, key, back) {
    if (!capPopup) buildCapPopup();
    if (info.blocked) {
      capPopupTitleEl.textContent = "That's beyond what we can confirm online";
      capPopupBodyEl.textContent = "Orders above " + info.ceilingQty + " need a hands-on production plan from " +
        "our small team. Message us at " + ORDER_EMAIL + ", or add a custom request from the shop above, and " +
        "we'll work out a realistic delivery date with you. We've kept your quantity at " + info.ceilingQty + " for now.";
      capPopupActionsEl.innerHTML = '<button type="button" class="btn btn-primary" id="cap-popup-ok">Got it</button>';
      capPopupActionsEl.querySelector("#cap-popup-ok").addEventListener("click", function () { closeCapPopup(); back(false); });
    } else {
      capPopupTitleEl.textContent = "That's a big order";
      capPopupBodyEl.textContent = "Orders above " + info.cap + " take extra time from our team — expect about " +
        info.extraDays + " additional business day" + (info.extraDays === 1 ? "" : "s") + " beyond our standard " +
        "turnaround. Agree to continue at your requested quantity, or keep it at " + info.cap + " for our normal turnaround.";
      capPopupActionsEl.innerHTML =
        '<button type="button" class="btn btn-secondary" id="cap-popup-keep">Keep at max</button>' +
        '<button type="button" class="btn btn-primary" id="cap-popup-agree">I agree</button>';
      capPopupActionsEl.querySelector("#cap-popup-keep").addEventListener("click", function () { closeCapPopup(); back(false); });
      capPopupActionsEl.querySelector("#cap-popup-agree").addEventListener("click", function () {
        capAcknowledgedByKey[key] = true; closeCapPopup(); back(true);
      });
    }
    capPopup.classList.add("is-open");
    capPopup.setAttribute("aria-hidden", "false");
  }

  // The one entry point every qty input routes a requested value through.
  // `key` scopes the "I agree" override to one product/line (a product id
  // for the shop cards and the bulk estimator, a cart-line key for the cart
  // drawer — see each call site) so agreeing on one big order doesn't
  // silently wave every other field's overflow through too; omit it (or
  // reuse `cap` as a fallback key) for one-off callers that don't need that
  // distinction. `back(finalQty)` fires synchronously if no popup is needed,
  // or once the shopper answers it otherwise — callers don't need to know
  // which happened.
  //
  // The over-ceiling (blocked) branch is checked and clamped on EVERY call,
  // acknowledged or not — capAcknowledgedByKey only ever skips the "extra
  // lead time, agree or keep at cap" popup for a product that already had it
  // once, never the ceiling itself. Without this split, a single "I agree"
  // on a product would permanently disable all validation for that product's
  // qty field, letting later input (a fat-fingered or adversarial huge
  // number) sail past the "hard ceiling, no agree path" straight into the
  // cart with no further check — see docs/history.md for the incident.
  function requestQty(cap, requestedQty, back, key) {
    key = key == null ? cap : key;
    if (!cap || requestedQty <= cap) { back(requestedQty); return; }
    var info = capInfo(requestedQty, cap);
    if (info.blocked) { openCapPopup(info, key, function () { back(info.ceilingQty); }); return; }
    if (capAcknowledgedByKey[key]) { back(requestedQty); return; }
    openCapPopup(info, key, function (agreed) { back(agreed ? requestedQty : info.cap); });
  }

  /* ---------- cart state ---------- */
  function loadCart() {
    try { var v = JSON.parse(localStorage.getItem(CART_KEY)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  // Fires on every cart mutation (add/qty-change/remove) — used by
  // skuCard()'s requiresCartProduct gate (e.g. Lamination/Binding unlocking
  // once a Document Printing line exists) to re-check its condition without
  // a full catalog re-render.
  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    document.dispatchEvent(new CustomEvent("kcmps:cart-change"));
  }
  var cart = loadCart();

  function itemCount() { return cart.reduce(function (s, i) { return s + i.qty; }, 0); }
  function payNowTotal() { return cart.reduce(function (s, i) { return s + (i.type === "sku" ? i.unitPrice * i.qty : 0); }, 0); }
  function pendingCount() { return cart.reduce(function (s, i) { return s + (i.type === "custom" ? i.qty : 0); }, 0); }
  // Used by skuCard()'s requiresCartProduct gate (Lamination/Binding unlock
  // once a Document Printing line is already in the cart).
  function cartHasProduct(id) { return cart.some(function (i) { return i.id === id; }); }

  function addToCart(item) {
    var existing = cart.find(function (i) { return i.key === item.key; });
    if (existing) {
      existing.qty += item.qty;
      if (existing.baseUnitPrice != null) {
        var p = DATA.products.find(function (pp) { return pp.id === existing.id; });
        existing.unitPrice = bulkUnitPrice(existing.baseUnitPrice, existing.qty, p && p.bulkTiers);
      }
    } else cart.push(item);
    saveCart(cart); syncUI();
    // Covers both instant-buy (sku) and the site's quote flow (custom items
    // ARE the quote/custom-request action here — see hero-priming script).
    document.dispatchEvent(new CustomEvent("kcmps:cart-add", { detail: { leaf: item.leaf, type: item.type } }));
  }
  function setQty(key, qty) {
    var it = cart.find(function (i) { return i.key === key; });
    if (!it) return;
    it.qty = qty;
    // Bulk-tier lines carry the pre-discount baseUnitPrice (see addToCart) so
    // the per-unit price can be re-struck at the new qty rather than staying
    // frozen at whatever tier applied when the line was first added.
    if (it.baseUnitPrice != null) {
      var p = DATA.products.find(function (pp) { return pp.id === it.id; });
      it.unitPrice = bulkUnitPrice(it.baseUnitPrice, it.qty, p && p.bulkTiers);
    }
    if (it.qty <= 0) cart = cart.filter(function (i) { return i.key !== key; });
    saveCart(cart); syncUI();
  }
  function removeItem(key) { cart = cart.filter(function (i) { return i.key !== key; }); saveCart(cart); syncUI(); }
  function clearCart() { cart = []; saveCart(cart); syncUI(); }

  /* ---------- badge (reuses the auth-era nav elements) ---------- */
  var lastBadgeCount = null;
  function updateBadge() {
    var badge = document.getElementById("cart-badge");
    if (!badge) return;
    var n = itemCount();
    if (n > 0) { badge.textContent = n; badge.classList.remove("is-hidden"); }
    else { badge.classList.add("is-hidden"); }
    if (lastBadgeCount !== null && n > lastBadgeCount) {
      badge.classList.remove("is-pulsing");
      void badge.offsetWidth; // restart the transition if it's already mid-pulse
      badge.classList.add("is-pulsing");
      setTimeout(function () { badge.classList.remove("is-pulsing"); }, 160);
    }
    lastBadgeCount = n;
  }

  /* ---------- catalog rendering ---------- */
  var CART_ICON = '<svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M222.14,58.87A8,8,0,0,0,216,56H54.68L49.79,29.14A16,16,0,0,0,34.05,16H16a8,8,0,0,0,0,16h18l25.16,138.28A24,24,0,0,0,82.76,190H197.2a24,24,0,0,0,23.6-19.71l12.16-66.86A8,8,0,0,0,222.14,58.87ZM96,224a16,16,0,1,1-16-16A16,16,0,0,1,96,224Zm104,0a16,16,0,1,1-16-16A16,16,0,0,1,200,224Z"/></svg>';

  function initials(name) {
    return name.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join("").toUpperCase();
  }

  // A product's own `image` wins; otherwise fall back to its leaf's representative
  // photo (products.js DATA.leaves[leaf].image); no image at all → initials placeholder.
  function thumbImage(p) {
    var leafCfg = DATA.leaves[p.leaf];
    return p.image || (leafCfg && leafCfg.image) || null;
  }

  function buildThumb(imageSrc, alt) {
    var thumb = document.createElement("div");
    thumb.className = "product-thumb";
    if (imageSrc) {
      var img = document.createElement("img");
      img.src = imageSrc; img.alt = alt; img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<span class="mono">' + initials(alt) + '</span>';
    }
    return thumb;
  }

  /* ---------- multi-image gallery thumb + lightbox ----------
     Any product with a real `images` array (products.js) gets left/right arrows
     over its thumb to browse designs in-card, and clicking the image opens the
     shared lightbox (enlarged on desktop, true fullscreen on mobile — see
     buildLightbox()). Generic by design — it only reads p.images/p.name, so any
     future leaf can opt in just by adding the array; today only the 3 DTF SKUs
     (see products.js) have one, sourced from website/assets/design/apparel/dtf/. */
  var lightboxOverlay, lightboxImg, lightboxCounter, lightboxPrevBtn, lightboxNextBtn, lightboxSelectBtn;
  var lightboxControlsPanel, lightboxSizeSeg, lightboxQtyVal, lightboxQtyMinusBtn, lightboxQtyPlusBtn, lightboxAddBtn;
  var lightboxImages = [], lightboxIndex = 0, lightboxOnSelect = null, lightboxControls = null;

  function buildLightbox() {
    lightboxOverlay = document.createElement("div");
    lightboxOverlay.className = "lightbox-overlay";
    lightboxOverlay.setAttribute("aria-hidden", "true");
    lightboxOverlay.innerHTML =
      '<button type="button" class="lightbox-close" aria-label="Close full-size view">' +
        '<span class="lightbox-close-icon" aria-hidden="true">&times;</span>' +
        '<span class="lightbox-close-text">Exit Fullscreen view</span>' +
      '</button>' +
      '<button type="button" class="lightbox-arrow prev" aria-label="Previous design">' +
        '<svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z"/></svg>' +
      '</button>' +
      '<div class="lightbox-stage"><img alt="" /></div>' +
      '<button type="button" class="lightbox-arrow next" aria-label="Next design">' +
        '<svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>' +
      '</button>' +
      '<div class="lightbox-counter"></div>' +
      '<div class="lightbox-controls">' +
        '<div class="lightbox-size-seg" role="radiogroup" aria-label="Size"></div>' +
        '<div class="lightbox-qty">' +
          '<button type="button" class="lightbox-qty-minus" aria-label="Decrease quantity">−</button>' +
          '<input type="number" inputmode="numeric" class="lightbox-qty-val" aria-label="Quantity" value="1" />' +
          '<button type="button" class="lightbox-qty-plus" aria-label="Increase quantity">+</button>' +
        '</div>' +
        '<div class="lightbox-actions">' +
          '<button type="button" class="lightbox-select">Select this design</button>' +
          '<button type="button" class="btn btn-primary lightbox-add">' + CART_ICON + ' Add to cart</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(lightboxOverlay);

    lightboxImg = lightboxOverlay.querySelector(".lightbox-stage img");
    lightboxCounter = lightboxOverlay.querySelector(".lightbox-counter");
    lightboxPrevBtn = lightboxOverlay.querySelector(".lightbox-arrow.prev");
    lightboxNextBtn = lightboxOverlay.querySelector(".lightbox-arrow.next");
    lightboxSelectBtn = lightboxOverlay.querySelector(".lightbox-select");
    lightboxControlsPanel = lightboxOverlay.querySelector(".lightbox-controls");
    lightboxSizeSeg = lightboxOverlay.querySelector(".lightbox-size-seg");
    lightboxQtyVal = lightboxOverlay.querySelector(".lightbox-qty-val");
    lightboxQtyMinusBtn = lightboxOverlay.querySelector(".lightbox-qty-minus");
    lightboxQtyPlusBtn = lightboxOverlay.querySelector(".lightbox-qty-plus");
    lightboxAddBtn = lightboxOverlay.querySelector(".lightbox-add");

    lightboxOverlay.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
    lightboxOverlay.addEventListener("click", function (e) { if (e.target === lightboxOverlay) closeLightbox(); });
    lightboxPrevBtn.addEventListener("click", function () { stepLightbox(-1); });
    lightboxNextBtn.addEventListener("click", function () { stepLightbox(1); });
    lightboxSelectBtn.addEventListener("click", function () {
      if (lightboxOnSelect) lightboxOnSelect(lightboxIndex);
      closeLightbox();
    });
    // Typed entry, mirroring the product card's qty input (commitQval):
    // commit on blur/Enter, not every keystroke, so re-tiering doesn't fight
    // mid-type; invalid/empty input reverts to the last valid qty. Also
    // called defensively before the +/-/add-to-cart buttons act, since a
    // click on one of them can reach its handler before the input's own
    // blur has committed a value the user just typed. setQty() (and so this)
    // is async when the capacity soft-cap popup is involved, so onDone
    // (optional) only fires once the qty has actually settled — callers that
    // need the final value (Add to cart) must wait for it rather than acting
    // on the pre-commit qty.
    function commitLightboxQty(onDone) {
      if (!lightboxControls) { if (onDone) onDone(); return; }
      var n = parseInt(lightboxQtyVal.value, 10);
      if (!isFinite(n) || isNaN(n)) { lightboxQtyVal.value = lightboxControls.getQty(); if (onDone) onDone(); return; }
      lightboxControls.setQty(n, onDone);
    }
    lightboxQtyMinusBtn.addEventListener("click", function () {
      if (!lightboxControls) return;
      commitLightboxQty(function () {
        lightboxControls.setQty(lightboxControls.getQty() - 1);
        renderLightboxControls();
      });
    });
    lightboxQtyPlusBtn.addEventListener("click", function () {
      if (!lightboxControls) return;
      commitLightboxQty(function () {
        lightboxControls.setQty(lightboxControls.getQty() + 1);
        renderLightboxControls();
      });
    });
    lightboxQtyVal.addEventListener("blur", function () {
      commitLightboxQty(renderLightboxControls);
    });
    lightboxQtyVal.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); lightboxQtyVal.blur(); }
    });
    // Waits for any pending typed qty to fully settle (including a cap-popup
    // decision) before adding to cart and closing — otherwise a qty typed
    // above the cap would add to the cart at the old qty immediately and
    // close the lightbox on top of the popup the shopper hadn't answered.
    lightboxAddBtn.addEventListener("click", function () {
      if (!lightboxControls) return;
      var current = lightboxControls;
      commitLightboxQty(function () {
        if (lightboxControls !== current) return; // lightbox closed/reopened while the popup was up
        // Commit the design being viewed right now, exactly like clicking
        // "Select this design" would — otherwise Add to cart reads whatever
        // design the card's thumb last had selected (e.g. the default) and
        // silently attaches a different design than the one on screen.
        if (lightboxOnSelect) lightboxOnSelect(lightboxIndex);
        current.onAddToCart();
        closeLightbox();
      });
    });
    document.addEventListener("keydown", function (e) {
      if (!lightboxOverlay.classList.contains("is-open")) return;
      if (e.target === lightboxQtyVal) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") stepLightbox(-1);
      else if (e.key === "ArrowRight") stepLightbox(1);
    });
  }

  function renderLightbox() {
    var item = lightboxImages[lightboxIndex];
    lightboxImg.src = item.src;
    lightboxImg.alt = item.alt;
    var multi = lightboxImages.length > 1;
    lightboxCounter.style.display = multi ? "" : "none";
    lightboxPrevBtn.style.display = multi ? "" : "none";
    lightboxNextBtn.style.display = multi ? "" : "none";
    lightboxCounter.textContent = (lightboxIndex + 1) + " / " + lightboxImages.length;
    lightboxSelectBtn.style.display = lightboxOnSelect ? "" : "none";
  }

  // Renders the size/qty/add-to-cart bar from the `controls` object passed
  // to openLightbox() (see skuCard's buildLightboxControls()) — independent
  // of which design image is currently shown, so it's built once per open
  // rather than on every stepLightbox().
  function renderLightboxControls() {
    var show = !!(lightboxControls || lightboxOnSelect);
    lightboxControlsPanel.style.display = show ? "" : "none";
    if (!lightboxControls) {
      lightboxSizeSeg.style.display = "none";
      lightboxOverlay.querySelector(".lightbox-qty").style.display = "none";
      lightboxAddBtn.style.display = "none";
      return;
    }
    var sizes = lightboxControls.sizes || [];
    lightboxSizeSeg.style.display = sizes.length > 1 ? "" : "none";
    lightboxSizeSeg.innerHTML = "";
    sizes.forEach(function (s) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lightbox-size-opt" + (s.index === lightboxControls.selectedIndex ? " is-selected" : "");
      btn.textContent = s.label;
      btn.setAttribute("aria-pressed", s.index === lightboxControls.selectedIndex ? "true" : "false");
      btn.addEventListener("click", function () {
        lightboxControls.onSelectSize(s.index);
        lightboxControls.selectedIndex = s.index;
        renderLightboxControls();
      });
      lightboxSizeSeg.appendChild(btn);
    });
    lightboxOverlay.querySelector(".lightbox-qty").style.display = "";
    lightboxQtyVal.min = String(lightboxControls.minQty || 1);
    if (document.activeElement !== lightboxQtyVal) lightboxQtyVal.value = lightboxControls.getQty();
    lightboxAddBtn.style.display = "";
  }

  function stepLightbox(delta) {
    lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
    renderLightbox();
  }

  // onSelect (optional): when passed, the lightbox shows a "Select this
  // design" button that calls onSelect(currentIndex) then closes — used by
  // the design picker/subcatalog so picking a design still works after
  // browsing it fullscreen. controls (optional): { sizes, selectedIndex,
  // onSelectSize, getQty, setQty, onAddToCart } — when passed, the lightbox
  // also shows a size selector, quantity stepper, and "Add to cart" button
  // (see skuCard's buildLightboxControls()). Both omitted for plain
  // gallery/cart-thumb viewing.
  function openLightbox(images, startIndex, onSelect, controls) {
    if (!lightboxOverlay) buildLightbox();
    lightboxImages = images;
    lightboxIndex = startIndex || 0;
    lightboxOnSelect = onSelect || null;
    lightboxControls = controls || null;
    renderLightbox();
    renderLightboxControls();
    lightboxOverlay.classList.add("is-open");
    lightboxOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    if (!lightboxOverlay) return;
    lightboxOverlay.classList.remove("is-open");
    lightboxOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    lightboxOnSelect = null;
    lightboxControls = null;
  }

  // titleFromFilename lives in products.js (window.KCMPS_TEXT) so the hero
  // carousel, catalog design cards, and cart thumbnails all format names the
  // same way; fall back to the raw filename if it's ever missing.
  function designTitle(src) {
    return window.KCMPS_TEXT ? window.KCMPS_TEXT.titleFromFilename(src) : src;
  }

  // Returns { el, setIndex, getIndex } instead of a bare node so callers
  // (skuCard's design picker grid) can drive which design the thumb shows and
  // stay notified when browsing the in-thumb arrows changes it, keeping the
  // large preview and the picker grid's selection in sync. onImageClick(idx)
  // (optional): when passed, clicking the thumb image calls this instead of
  // opening a plain lightbox — skuCard wires it to openDesignLightbox() so
  // the fullscreen view also gets the select/size/qty/add-to-cart controls.
  function buildGalleryThumb(p, onIndexChange, onImageClick) {
    var images = p.images && p.images.length ? p.images : null;
    if (!images) {
      var single = buildThumb(thumbImage(p), p.name);
      return { el: single, setIndex: function () {}, getIndex: function () { return 0; } };
    }

    var idx = 0;
    var thumb = document.createElement("div");
    thumb.className = "product-thumb product-gallery";

    var img = document.createElement("img");
    img.loading = "lazy";
    thumb.appendChild(img);

    var counter = document.createElement("span");
    counter.className = "gallery-counter";
    thumb.appendChild(counter);

    function render() {
      img.src = images[idx];
      img.alt = p.name + " — " + designTitle(images[idx]);
      counter.textContent = (idx + 1) + " / " + images.length;
    }
    render();

    function setIndex(i) {
      idx = ((i % images.length) + images.length) % images.length;
      render();
    }

    img.addEventListener("click", function () {
      if (onImageClick) { onImageClick(idx); return; }
      openLightbox(images.map(function (src) { return { src: src, alt: p.name + " — " + designTitle(src) }; }), idx);
    });

    if (images.length > 1) {
      var prev = document.createElement("button");
      prev.type = "button"; prev.className = "gallery-arrow prev"; prev.setAttribute("aria-label", "Previous design");
      prev.innerHTML = '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z"/></svg>';
      var next = document.createElement("button");
      next.type = "button"; next.className = "gallery-arrow next"; next.setAttribute("aria-label", "Next design");
      next.innerHTML = '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>';
      prev.addEventListener("click", function (e) { e.stopPropagation(); setIndex(idx - 1); if (onIndexChange) onIndexChange(idx); });
      next.addEventListener("click", function (e) { e.stopPropagation(); setIndex(idx + 1); if (onIndexChange) onIndexChange(idx); });
      thumb.appendChild(prev); thumb.appendChild(next);
    } else {
      counter.style.display = "none";
    }

    return { el: thumb, setIndex: setIndex, getIndex: function () { return idx; } };
  }

  var CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>';

  var DESIGN_GRID_MAX = 8;

  // Grid of selectable design cards (one per p.images entry) shown under a
  // SKU's main thumb — lets a customer pick exactly which pre-made design
  // they want printed, distinct from just browsing the main thumb's arrows.
  // Selecting a card here also updates the main thumb (via gallery.setIndex)
  // so both stay in sync, and titles come from designTitle() (filename
  // convention shared with the hero carousel and cart thumbnails).
  //
  // Capped to DESIGN_GRID_MAX tiles so every card's grid takes the same
  // bounded space regardless of how many designs a product has (a 20-design
  // product no longer pushes its price/add-to-cart row far below a
  // 4-design product's) — the rest of the card stays top-aligned and
  // consistent across the row. When a product has more designs than that,
  // the last tile becomes a "+N more" trigger: hovering the picker (or
  // tapping/focusing the tile, for touch/keyboard) opens a full-page-width
  // popup with the complete, scrollable list.
  function buildDesignGrid(p, gallery, selectedIdx, openImage) {
    var images = p.images;
    if (!images || images.length < 2) return null;

    var collapsed = images.length > DESIGN_GRID_MAX;
    var visibleCount = collapsed ? DESIGN_GRID_MAX - 1 : images.length;

    var allPicks = []; // { el, index } across both the inline grid and (if built) the popup

    function makePick(src, i) {
      var title = designTitle(src);
      var pick = document.createElement("button");
      pick.type = "button";
      pick.className = "design-pick";
      pick.setAttribute("aria-pressed", i === selectedIdx ? "true" : "false");
      pick.setAttribute("aria-label", "Select design: " + title);

      var pimg = document.createElement("img");
      pimg.src = src; pimg.alt = ""; pimg.loading = "lazy";
      pick.appendChild(pimg);

      var check = document.createElement("span");
      check.className = "design-pick-check";
      check.innerHTML = CHECK_ICON;
      pick.appendChild(check);

      var label = document.createElement("span");
      label.className = "design-pick-label";
      label.textContent = title;
      pick.appendChild(label);

      // Clicking a design tile (inline grid or the "+N more" popup) opens the
      // shared fullscreen lightbox rather than selecting instantly — the
      // lightbox's "Select this design" button (wired below via openImage)
      // finishes the gallery.setIndex()+sync() selection.
      pick.addEventListener("click", function () {
        hidePopup();
        openImage(i);
      });

      allPicks.push({ el: pick, index: i });
      return pick;
    }

    var wrap = document.createElement("div");
    wrap.className = "design-picker";

    var grid = document.createElement("div");
    grid.className = "design-grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Choose a design");
    for (var i = 0; i < visibleCount; i++) grid.appendChild(makePick(images[i], i));

    var moreTile = null;
    if (collapsed) {
      moreTile = document.createElement("button");
      moreTile.type = "button";
      moreTile.className = "design-pick design-pick-more";
      moreTile.setAttribute("aria-label", "Show all " + images.length + " designs");
      moreTile.innerHTML =
        '<span class="design-pick-more-count">+' + (images.length - visibleCount) + '</span>' +
        '<span class="design-pick-more-label">More designs</span>';
      grid.appendChild(moreTile);
    }
    wrap.appendChild(grid);

    // Full-list popup — built lazily on first hover/focus, appended to <body>
    // (not `wrap`) since it needs to span the full page width regardless of
    // how narrow the product card is. Desktop-only (see isHoverCapable below);
    // touch devices get the full-screen subcatalog sheet instead.
    var popup = null, hideTimer = null;

    function buildPopup() {
      popup = document.createElement("div");
      popup.className = "design-popup";
      var inner = document.createElement("div");
      inner.className = "design-grid design-grid-full";
      images.forEach(function (src, i) { inner.appendChild(makePick(src, i)); });
      popup.appendChild(inner);
      document.body.appendChild(popup);
      popup.addEventListener("mouseenter", cancelHide);
      popup.addEventListener("mouseleave", scheduleHide);
    }
    function positionPopup() {
      // popup is `position: fixed`, so its offset is viewport-relative —
      // do NOT add window.scrollY here (that's only correct for `absolute`).
      var r = wrap.getBoundingClientRect();
      popup.style.top = Math.round(r.bottom + 8) + "px";
    }
    function showPopup() {
      if (!collapsed) return;
      if (!popup) buildPopup();
      positionPopup();
      popup.classList.add("is-open");
      sync();
    }
    function hidePopup() { if (popup) popup.classList.remove("is-open"); }
    function scheduleHide() { hideTimer = setTimeout(hidePopup, 180); }
    function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }

    // Same media query gate used by the scroll-indicator's desktop-only hover
    // reveal (see CLAUDE.md). No-hover/touch devices get a single-tap
    // full-screen subcatalog of ALL designs instead of the small flyout —
    // tapping a design there opens it via the shared openLightbox() (fullscreen),
    // and the lightbox's "Select this design" button (wired with onSelect)
    // completes the same gallery.setIndex()+sync() selection the popup does.
    function isHoverCapable() {
      return window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    }

    var subcatalog = null;

    function buildSubcatalog() {
      subcatalog = document.createElement("div");
      subcatalog.className = "design-subcatalog";
      subcatalog.setAttribute("aria-hidden", "true");

      var header = document.createElement("div");
      header.className = "design-subcatalog-header";
      var title = document.createElement("span");
      title.className = "design-subcatalog-title";
      title.textContent = "All designs";
      header.appendChild(title);
      var close = document.createElement("button");
      close.type = "button";
      close.className = "design-subcatalog-close";
      close.setAttribute("aria-label", "Close all designs");
      close.innerHTML = "&times;";
      header.appendChild(close);
      subcatalog.appendChild(header);

      var grid = document.createElement("div");
      grid.className = "design-grid design-grid-full";
      images.forEach(function (src, i) {
        var tile = document.createElement("button");
        tile.type = "button";
        tile.className = "design-pick";
        var title2 = designTitle(src);
        tile.setAttribute("aria-label", "View design: " + title2);
        var timg = document.createElement("img");
        timg.src = src; timg.alt = ""; timg.loading = "lazy";
        tile.appendChild(timg);
        var label = document.createElement("span");
        label.className = "design-pick-label";
        label.textContent = title2;
        tile.appendChild(label);
        tile.addEventListener("click", function () {
          hideSubcatalog();
          openImage(i);
        });
        grid.appendChild(tile);
      });
      subcatalog.appendChild(grid);
      document.body.appendChild(subcatalog);

      close.addEventListener("click", hideSubcatalog);
      subcatalog.addEventListener("click", function (e) { if (e.target === subcatalog) hideSubcatalog(); });
    }
    function showSubcatalog() {
      if (!subcatalog) buildSubcatalog();
      subcatalog.classList.add("is-open");
      subcatalog.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    }
    function hideSubcatalog() {
      if (!subcatalog) return;
      subcatalog.classList.remove("is-open");
      subcatalog.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }

    if (collapsed) {
      wrap.addEventListener("mouseenter", function () { cancelHide(); showPopup(); });
      wrap.addEventListener("mouseleave", scheduleHide);
      // Desktop (hover-capable): tapping/focusing the "more" tile toggles the
      // small flyout, same as before. Touch/no-hover: single tap opens the
      // full-screen subcatalog instead — no double-tap needed.
      moreTile.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!isHoverCapable()) { showSubcatalog(); return; }
        if (popup && popup.classList.contains("is-open")) hidePopup(); else showPopup();
      });
      moreTile.addEventListener("focus", function () {
        if (isHoverCapable()) showPopup();
      });
      // Keep the popup anchored under its trigger if the page scrolls while open.
      window.addEventListener("scroll", function () {
        if (popup && popup.classList.contains("is-open")) positionPopup();
      }, { passive: true });
    }

    function sync() {
      var current = gallery.getIndex();
      allPicks.forEach(function (c) {
        var isSel = c.index === current;
        c.el.classList.toggle("is-selected", isSel);
        c.el.setAttribute("aria-pressed", isSel ? "true" : "false");
      });
    }
    sync();

    return { el: wrap, sync: sync };
  }

  function skuCard(p) {
    var card = document.createElement("div");
    card.className = "card offer product";

    var variants = p.variants || [{ label: "", price: p.price || 0 }];
    var sel = 0;              // selected variant index
    var withShirt = false;    // shirt add-on
    // One selected option-index per entry in p.addons (each its own radio
    // group, e.g. Color + Finishing on Document Printing), 0 = none/base.
    var addonGroups = p.addons || [];
    var addonSel = addonGroups.map(function () { return 0; });
    var minQty = p.minQty || 1;
    var qty = minQty;

    function addonsTotal() {
      return addonGroups.reduce(function (sum, g, i) { return sum + g.options[addonSel[i]].price; }, 0);
    }

    function baseUnitPrice() {
      return variants[sel].price + (withShirt && p.shirtAddon ? DATA.shirtAddon.price : 0) + addonsTotal();
    }
    function unitPrice() {
      return bulkUnitPrice(baseUnitPrice(), qty, p.bulkTiers);
    }

    // thumb
    var gallery = buildGalleryThumb(p, function () { if (designPicker) designPicker.sync(); }, function (idx) { openDesignLightbox(idx); });
    card.appendChild(gallery.el);

    var kick = document.createElement("span"); kick.className = "card-kicker"; kick.textContent = p.kicker || ""; card.appendChild(kick);
    var h = document.createElement("h3"); h.className = "card-title"; h.textContent = p.name; card.appendChild(h);
    var body = document.createElement("p"); body.className = "card-body"; body.textContent = p.blurb || ""; card.appendChild(body);

    // design picker — selectable grid of pre-made designs (products.js
    // `images[]`); the currently selected design travels with the cart line
    // as designRef/designName so the cart can show a recognizable thumbnail.
    var designPicker = buildDesignGrid(p, gallery, gallery.getIndex(), openDesignLightbox);
    if (designPicker) card.appendChild(designPicker.el);

    // Clicking the main thumb image or any design-pick tile (inline grid,
    // "+N more" popup, or the mobile subcatalog sheet) all route here — the
    // fullscreen lightbox always gets a "Select this design" button plus the
    // size/qty/add-to-cart controls (buildLightboxControls below), so a
    // customer can finish the whole purchase from the fullscreen view.
    function openDesignLightbox(startIndex) {
      var images = p.images;
      openLightbox(
        images.map(function (src) { return { src: src, alt: p.name + " — " + designTitle(src) }; }),
        startIndex,
        function (selIndex) { gallery.setIndex(selIndex); if (designPicker) designPicker.sync(); },
        buildLightboxControls()
      );
    }

    function buildLightboxControls() {
      // `controlsRef` lets setQty (below) detect whether *this* lightbox
      // open is still the active one once requestQty()'s (async, may wait on
      // the capacity-cap popup) callback fires, before re-rendering.
      var controlsRef = {
        sizes: variants.map(function (v, i) { return { label: v.label || ("Option " + (i + 1)), index: i }; }),
        selectedIndex: sel,
        onSelectSize: function (i) {
          sel = i;
          if (sizeRadios[i]) sizeRadios[i].checked = true;
          refresh();
        },
        getQty: function () { return qty; },
        // Routes through the same capacity soft-cap gate as the card's own
        // stepper (setQtyChecked below) — otherwise a shopper could dodge the
        // extra-lead-time confirmation just by typing the quantity into the
        // lightbox instead of the card. requestQty() is async (it may wait on
        // the cap popup) — onDone (optional) only fires once the qty has
        // actually settled, so callers that need to act on the final value
        // (onAddToCart below) don't fire early on a still-pending value.
        setQty: function (n, onDone) {
          setQtyChecked(n, function () {
            if (lightboxControls === controlsRef) renderLightboxControls();
            if (onDone) onDone();
          });
        },
        onAddToCart: function () { addBtn.click(); }
      };
      return controlsRef;
    }

    // size selector
    var sizeRadios = [];
    if (p.variants && p.variants.length > 1) {
      var seg = document.createElement("div"); seg.className = "seg"; seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", "Size");
      variants.forEach(function (v, i) {
        var lab = document.createElement("label"); lab.className = "seg-opt";
        var r = document.createElement("input"); r.type = "radio"; r.name = p.id + "-size"; if (i === 0) r.checked = true;
        var sp = document.createElement("span"); sp.textContent = v.label;
        r.addEventListener("change", function () { sel = i; refresh(); });
        lab.appendChild(r); lab.appendChild(sp); seg.appendChild(lab);
        sizeRadios.push(r);
      });
      card.appendChild(seg);
    }

    // shirt toggle + color choice (black / white / custom) — the color picks
    // are only interactive once "Press onto a shirt" is checked; picking
    // "Custom" opens a native color input and shows an availability caveat.
    var shirtColor = null;       // "black" | "white" | "custom" | null
    var shirtCustomColor = "#000000";
    function shirtColorLabel() {
      if (!withShirt || !shirtColor) return null;
      if (shirtColor === "black") return "Black";
      if (shirtColor === "white") return "White";
      return "Custom (" + shirtCustomColor + ")";
    }
    if (p.shirtAddon) {
      var shirtRow = document.createElement("div"); shirtRow.className = "shirt-row";

      var tog = document.createElement("label"); tog.className = "shirt-toggle";
      var cb = document.createElement("input"); cb.type = "checkbox";
      var txt = document.createElement("span"); txt.textContent = DATA.shirtAddon.label;
      tog.appendChild(cb); tog.appendChild(txt); shirtRow.appendChild(tog);

      var colorOpts = document.createElement("div"); colorOpts.className = "shirt-color-opts";
      colorOpts.setAttribute("role", "group"); colorOpts.setAttribute("aria-label", "Shirt color");
      var COLOR_CHOICES = [
        { key: "black", label: "Black", swatch: "#111111" },
        { key: "white", label: "White", swatch: "#ffffff" },
        { key: "custom", label: "Custom", swatch: null }
      ];
      var colorBtns = {};

      var disclaimer = document.createElement("p"); disclaimer.className = "shirt-color-disclaimer";
      disclaimer.textContent = "We'll do our best to match the selected color, subject to availability.";
      disclaimer.style.display = "none";

      // Custom color is a two-step pick: clicking the "Custom" swatch opens
      // this panel (native color input + live hex readout); the color only
      // becomes the selection once "Use this color" is clicked — an earlier
      // version applied the pick on the swatch's own click, but the native
      // <input type="color"> was layered on top of it and swallowed that
      // click (stopPropagation), so nothing ever registered as selected.
      var customPanel = document.createElement("div"); customPanel.className = "shirt-color-custom-panel";
      customPanel.style.display = "none";
      var customColorInput = document.createElement("input");
      customColorInput.type = "color"; customColorInput.className = "shirt-color-custom-input";
      customColorInput.value = shirtCustomColor;
      customColorInput.setAttribute("aria-label", "Pick custom shirt color");
      var customHex = document.createElement("span"); customHex.className = "shirt-color-custom-hex";
      customHex.textContent = shirtCustomColor.toUpperCase();
      var customConfirm = document.createElement("button");
      customConfirm.type = "button"; customConfirm.className = "btn btn-secondary shirt-color-confirm";
      customConfirm.textContent = "Use this color";
      customColorInput.addEventListener("input", function () {
        shirtCustomColor = customColorInput.value;
        customHex.textContent = shirtCustomColor.toUpperCase();
      });
      customConfirm.addEventListener("click", function () {
        selectShirtColor("custom");
        customPanel.style.display = "none";
      });
      customPanel.appendChild(customColorInput);
      customPanel.appendChild(customHex);
      customPanel.appendChild(customConfirm);

      function selectShirtColor(key) {
        if (!withShirt) return;
        shirtColor = key;
        Object.keys(colorBtns).forEach(function (k) {
          var isSel = k === key;
          colorBtns[k].classList.toggle("is-selected", isSel);
          colorBtns[k].setAttribute("aria-pressed", isSel ? "true" : "false");
        });
        colorBtns.custom.querySelector(".shirt-color-label").textContent =
          key === "custom" ? "Custom (" + shirtCustomColor.toUpperCase() + ")" : "Custom";
        colorBtns.custom.querySelector(".shirt-color-swatch").style.background =
          key === "custom" ? shirtCustomColor : "";
        disclaimer.style.display = key === "custom" ? "" : "none";
        refresh();
      }

      COLOR_CHOICES.forEach(function (c) {
        var pick = document.createElement("button");
        pick.type = "button"; pick.className = "shirt-color-pick";
        pick.setAttribute("aria-pressed", "false");
        pick.setAttribute("aria-label", c.label + " shirt color");
        var sw = document.createElement("span");
        sw.className = "shirt-color-swatch" + (c.key === "custom" ? " is-custom" : "");
        if (c.swatch) sw.style.background = c.swatch;
        pick.appendChild(sw);
        var lbl = document.createElement("span"); lbl.className = "shirt-color-label"; lbl.textContent = c.label;
        pick.appendChild(lbl);
        pick.addEventListener("click", function () {
          if (!withShirt) return;
          if (c.key === "custom") {
            customPanel.style.display = customPanel.style.display === "none" ? "" : "none";
            return;
          }
          customPanel.style.display = "none";
          selectShirtColor(c.key);
        });
        colorOpts.appendChild(pick);
        colorBtns[c.key] = pick;
      });
      shirtRow.appendChild(colorOpts);
      shirtRow.appendChild(customPanel);
      shirtRow.appendChild(disclaimer);
      card.appendChild(shirtRow);

      function syncShirtColorState() {
        Object.keys(colorBtns).forEach(function (k) { colorBtns[k].disabled = !withShirt; });
        colorOpts.classList.toggle("is-disabled", !withShirt);
        if (!withShirt) customPanel.style.display = "none";
        disclaimer.style.display = (withShirt && shirtColor === "custom") ? "" : "none";
      }
      syncShirtColorState();

      cb.addEventListener("change", function () {
        withShirt = cb.checked;
        syncShirtColorState();
        refresh();
      });
    }

    // generic tiered add-ons (e.g. the color-printing and finishing options on
    // Document Printing) — each group renders as its own radio group,
    // additive on top of the base/variant price. A product can carry more
    // than one independent group (p.addons is an array).
    addonGroups.forEach(function (group, gi) {
      if (!group.options || !group.options.length) return;
      if (group.label) {
        var addonLbl = document.createElement("div"); addonLbl.className = "addon-label"; addonLbl.textContent = group.label;
        card.appendChild(addonLbl);
      }
      var addonSeg = document.createElement("div"); addonSeg.className = "seg"; addonSeg.setAttribute("role", "radiogroup"); addonSeg.setAttribute("aria-label", group.label || "Add-on");
      group.options.forEach(function (opt, i) {
        var lab = document.createElement("label"); lab.className = "seg-opt";
        var r = document.createElement("input"); r.type = "radio"; r.name = p.id + "-addon-" + (group.key || gi); if (i === 0) r.checked = true;
        var sp = document.createElement("span"); sp.textContent = opt.label;
        r.addEventListener("change", function () { addonSel[gi] = i; refresh(); });
        lab.appendChild(r); lab.appendChild(sp); addonSeg.appendChild(lab);
      });
      card.appendChild(addonSeg);
    });

    // buy row: price + qty
    var buy = document.createElement("div"); buy.className = "product-buy";
    var priceEl = document.createElement("span"); priceEl.className = "product-price";
    var stepper = document.createElement("div"); stepper.className = "qty-stepper";
    var minus = document.createElement("button"); minus.type = "button"; minus.textContent = "−"; minus.setAttribute("aria-label", "Decrease quantity");
    var qval = document.createElement("input"); qval.type = "number"; qval.className = "qval"; qval.inputMode = "numeric"; qval.min = String(minQty); qval.value = qty; qval.setAttribute("aria-label", "Quantity");
    var plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+"; plus.setAttribute("aria-label", "Increase quantity");
    // Every requested qty (stepper or typed) routes through requestQty() so
    // the capacity soft-cap (products.js `softCap`) can intercept it and pop
    // the extra-lead-time confirmation before the field actually holds a
    // value past the cap — see the capacity soft-cap section above.
    function setQtyChecked(n, afterApply) {
      requestQty(p.softCap, Math.max(minQty, n), function (finalQty) {
        qty = finalQty; qval.value = qty; refresh();
        if (afterApply) afterApply();
      }, p.id);
    }
    minus.addEventListener("click", function () { qty = Math.max(minQty, qty - 1); qval.value = qty; refresh(); });
    plus.addEventListener("click", function () { setQtyChecked(qty + 1); });
    // Commit on blur/Enter only (not every keystroke) so re-tiering doesn't
    // fight the user mid-type; invalid/empty input reverts to the last valid qty.
    function commitQval() {
      var n = parseInt(qval.value, 10);
      if (!isFinite(n) || isNaN(n)) { qval.value = qty; return; }
      if (Math.max(minQty, n) === qty) { qval.value = qty; return; }
      setQtyChecked(n);
    }
    qval.addEventListener("blur", commitQval);
    qval.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); qval.blur(); } });
    stepper.appendChild(minus); stepper.appendChild(qval); stepper.appendChild(plus);
    buy.appendChild(priceEl); buy.appendChild(stepper); card.appendChild(buy);

    // bulk-tier note — advertises the discount ladder up front so customers
    // know it's worth sizing an order up, and highlights the tier the
    // current qty has actually reached.
    var bulkNote = null;
    if (p.bulkTiers && p.bulkTiers.length) {
      bulkNote = document.createElement("p"); bulkNote.className = "addon-label bulk-note";
      card.insertBefore(bulkNote, buy);
    }

    // gate note — shown only while p.requiresCartProduct isn't satisfied
    // (e.g. Lamination/Binding before a Document Printing line exists).
    var gateNote = null;
    if (p.requiresCartProduct) {
      gateNote = document.createElement("p"); gateNote.className = "addon-label gate-note";
      gateNote.textContent = "Add Document Printing to your cart first to unlock this.";
      card.appendChild(gateNote);
    }

    // add button
    var addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn btn-primary btn-block";
    addBtn.innerHTML = CART_ICON + " Add to cart";
    addBtn.addEventListener("click", function () {
      var vLabel = variants[sel].label;
      var designRef = p.images && p.images.length ? p.images[gallery.getIndex()] : null;
      var designName = designRef ? designTitle(designRef) : null;
      var addonLabels = addonGroups
        .map(function (g, i) { return addonSel[i] > 0 ? g.options[addonSel[i]].label : ""; })
        .filter(Boolean);
      var lineLabel = [vLabel].concat(addonLabels).filter(Boolean).join(" + ");
      var colorLabel = shirtColorLabel();
      addToCart({
        key: p.id + "|" + vLabel + "|" + (withShirt ? "shirt:" + (colorLabel || "") : "plain") + "|" + (designRef || "") + "|" + addonLabels.join("|"),
        id: p.id, name: p.name, leaf: p.leaf, type: "sku",
        variantLabel: lineLabel, shirt: withShirt, shirtColor: colorLabel,
        unitPrice: unitPrice(), baseUnitPrice: p.bulkTiers ? baseUnitPrice() : null, qty: qty,
        designRef: designRef, designName: designName
      });
      var orig = addBtn.innerHTML; addBtn.innerHTML = "Added ✓"; addBtn.disabled = true;
      setTimeout(function () {
        addBtn.innerHTML = orig;
        if (p.requiresCartProduct) { syncGate(); } else { addBtn.disabled = false; }
      }, 1100);
      qty = minQty; qval.value = qty;
      openDrawer();
    });
    card.appendChild(addBtn);

    // Re-checked on every cart mutation (kcmps:cart-change, see saveCart())
    // rather than only at build time, so e.g. adding Document Printing after
    // Lamination is already on-screen unlocks it live, no reload needed.
    function syncGate() {
      if (!p.requiresCartProduct) return;
      var unlocked = cartHasProduct(p.requiresCartProduct);
      addBtn.disabled = !unlocked;
      if (gateNote) gateNote.style.display = unlocked ? "none" : "";
    }
    if (p.requiresCartProduct) {
      syncGate();
      document.addEventListener("kcmps:cart-change", syncGate);
    }

    function refresh() {
      var base = baseUnitPrice();
      var tier = activeBulkTier(qty, p.bulkTiers);
      var shown = tier ? bulkUnitPrice(base, qty, p.bulkTiers) : base;
      var notes = [];
      if (withShirt && p.shirtAddon) notes.push("incl. shirt" + (shirtColorLabel() ? " (" + shirtColorLabel() + ")" : ""));
      addonGroups.forEach(function (g, i) { if (addonSel[i] > 0) notes.push("incl. " + g.options[addonSel[i]].label); });
      if (!notes.length && p.variants && p.variants.length > 1) notes.push("/ " + variants[sel].label);
      if (tier) notes.push(tier.discountPct + "% bulk price");
      priceEl.innerHTML = peso(shown) + (notes.length ? ' <small>' + notes.join(", ") + '</small>' : '');
      if (bulkNote) {
        bulkNote.textContent = "Bulk pricing: " + p.bulkTiers.map(function (t) {
          return t.minQty + "+ → " + t.discountPct + "% off";
        }).join(" · ");
      }
    }
    refresh();
    return card;
  }

  // Products with no confirmed cost yet (e.g. binding, bookmarks) render as a
  // request card instead of a buy card — never ship a guessed price. Adds to
  // cart at ₱0 under the same "pending approval" quote flow as custom items.
  function quoteCard(p) {
    var card = document.createElement("div");
    card.className = "card offer product product-custom";
    card.appendChild(buildThumb(thumbImage(p), p.name));
    var kick = document.createElement("span"); kick.className = "card-kicker"; kick.textContent = "Quote on request"; card.appendChild(kick);
    var h = document.createElement("h3"); h.className = "card-title"; h.textContent = p.name; card.appendChild(h);
    var body = document.createElement("p"); body.className = "card-body"; body.textContent = p.blurb || ""; card.appendChild(body);
    var addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn btn-secondary btn-block";
    addBtn.textContent = "Add as request";
    addBtn.addEventListener("click", function () {
      addToCart({
        key: "quote|" + p.id, id: p.id, name: p.name,
        leaf: p.leaf, type: "custom", variantLabel: "", shirt: false, unitPrice: 0, qty: 1
      });
      var orig = addBtn.textContent; addBtn.textContent = "Added ✓"; addBtn.disabled = true;
      setTimeout(function () { addBtn.textContent = orig; addBtn.disabled = false; }, 1100);
      openDrawer();
    });
    card.appendChild(addBtn);
    return card;
  }

  // Products with no online path at all (products.js `noOnlineOrder`, e.g.
  // Photocopying — there's no file to duplicate a physical original from).
  // Shows the reference price for transparency but never touches the cart:
  // no "Add to cart" button, no ₱0 pending-approval line either — this
  // isn't a quote-on-request flow, it's a walk-in-only service.
  function inStoreInfoCard(p) {
    var card = document.createElement("div");
    card.className = "card offer product product-custom";
    card.appendChild(buildThumb(thumbImage(p), p.name));
    var kick = document.createElement("span"); kick.className = "card-kicker"; kick.textContent = "In-store only"; card.appendChild(kick);
    var h = document.createElement("h3"); h.className = "card-title"; h.textContent = p.name; card.appendChild(h);
    var body = document.createElement("p"); body.className = "card-body"; body.textContent = p.blurb || ""; card.appendChild(body);
    var priceEl = document.createElement("p"); priceEl.className = "product-price"; priceEl.textContent = peso(p.price || 0) + " (reference price)";
    card.appendChild(priceEl);
    var note = document.createElement("p"); note.className = "addon-label"; note.textContent = "No online booking — walk in anytime during studio hours.";
    card.appendChild(note);
    return card;
  }

  function customCard(leafKey, cfg) {
    var card = document.createElement("div");
    card.className = "card offer product product-custom";
    card.appendChild(buildThumb(cfg.image || null, cfg.customLabel || leafKey));
    var kick = document.createElement("span"); kick.className = "card-kicker"; kick.textContent = "Custom · pay after approval"; card.appendChild(kick);
    var h = document.createElement("h3"); h.className = "card-title"; h.textContent = cfg.customLabel || "Custom design request"; card.appendChild(h);
    var body = document.createElement("p"); body.className = "card-body"; body.textContent = cfg.customBlurb || "Send us your idea — we'll review, quote, and only bill you once you approve."; card.appendChild(body);
    var addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn btn-secondary btn-block";
    addBtn.textContent = "Add as request";
    addBtn.addEventListener("click", function () {
      addToCart({
        key: "custom|" + leafKey, id: "custom-" + leafKey, name: cfg.customLabel || "Custom design request",
        leaf: leafKey, type: "custom", variantLabel: "", shirt: false, unitPrice: 0, qty: 1
      });
      var orig = addBtn.textContent; addBtn.textContent = "Added ✓"; addBtn.disabled = true;
      setTimeout(function () { addBtn.textContent = orig; addBtn.disabled = false; }, 1100);
      openDrawer();
    });
    card.appendChild(addBtn);
    return card;
  }

  function renderCatalog() {
    Object.keys(DATA.leaves).forEach(function (leafKey) {
      var container = document.querySelector('[data-products-leaf="' + leafKey + '"]');
      if (!container) return;
      var cfg = DATA.leaves[leafKey];
      container.innerHTML = "";

      if (cfg.comingSoon) {
        var note = document.createElement("p"); note.className = "leaf-note";
        note.textContent = "Pre-made designs are coming soon here — start a custom request now and we'll bring your idea to life.";
        container.appendChild(note);
      }

      var grid = document.createElement("div"); grid.className = "offer-grid";
      var leafProducts = DATA.products.filter(function (p) { return p.leaf === leafKey; });
      // Onsite-only cards (noOnlineOrder) render after every purchasable card,
      // right next to the custom-request card — grouping "can't buy this
      // online" cards together instead of interleaving them with Add-to-cart
      // cards looks less awkward (see the removeItem/re-lock bug fix above).
      leafProducts.filter(function (p) { return !p.noOnlineOrder; }).forEach(function (p) {
        grid.appendChild(p.quoteOnRequest ? quoteCard(p) : skuCard(p));
      });
      leafProducts.filter(function (p) { return p.noOnlineOrder; }).forEach(function (p) {
        grid.appendChild(inStoreInfoCard(p));
      });
      grid.appendChild(customCard(leafKey, cfg)); // every leaf always gets the custom-request card
      container.appendChild(grid);
    });
  }

  /* ---------- cart drawer (self-injected) ---------- */
  var overlay, drawer, bodyView, footEl;

  function buildDrawer() {
    overlay = document.createElement("div"); overlay.className = "cart-overlay"; overlay.id = "cart-overlay";
    drawer = document.createElement("aside"); drawer.className = "cart-drawer"; drawer.id = "cart-drawer";
    drawer.setAttribute("aria-label", "Your cart"); drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML =
      '<div class="cart-head"><h3>Your cart</h3>' +
        '<button type="button" class="cart-close" aria-label="Close cart">&times;</button></div>' +
      '<div class="cart-body">' +
        '<div class="cart-view" id="cart-view"></div>' +
        '<div class="checkout-view" id="checkout-view">' +
          '<button type="button" class="checkout-back">&larr; Back to cart</button>' +
          '<div class="field"><label for="co-name">Your name</label><input class="input" id="co-name" autocomplete="name" required /></div>' +
          '<div class="field"><label for="co-contact">Email / phone / Messenger</label><input class="input" id="co-contact" required placeholder="how we reach you" /></div>' +
          '<div class="field"><label>Fulfillment</label>' +
            '<div class="seg" role="radiogroup" aria-label="Fulfillment" style="width:100%">' +
              '<label class="seg-opt" style="flex:1;justify-content:center"><input type="radio" name="co-fulfill" value="Pickup" checked /><span>Pick up</span></label>' +
              '<label class="seg-opt" style="flex:1;justify-content:center"><input type="radio" name="co-fulfill" value="Delivery" /><span>Delivery</span></label>' +
            '</div></div>' +
          '<p class="f-note" id="co-pickup-note">Pickup orders not collected within 3 business days will be cancelled, with no refund.</p>' +
          '<div class="field co-delivery-fields" id="co-delivery-fields">' +
            '<label>Preferred courier</label>' +
            '<div class="seg" role="radiogroup" aria-label="Courier" style="width:100%">' +
              '<label class="seg-opt" style="flex:1;justify-content:center"><input type="radio" name="co-courier" value="Grab" checked /><span>Grab</span></label>' +
              '<label class="seg-opt" style="flex:1;justify-content:center"><input type="radio" name="co-courier" value="Lalamove" /><span>Lalamove</span></label>' +
            '</div>' +
            '<div class="field"><label for="co-address">Exact address</label><input class="input" id="co-address" autocomplete="street-address" placeholder="Full delivery address" /></div>' +
            '<div class="field"><label for="co-landmark">Landmark</label><input class="input" id="co-landmark" placeholder="Nearby landmark to help the rider find you" /></div>' +
          '</div>' +
          '<div class="field"><label for="co-notes">Custom request details / design links</label><textarea class="input" id="co-notes" placeholder="For custom items: describe your design, sizes, quantities, or paste file links."></textarea></div>' +
          '<p class="f-note">You\'ll get an email confirmation, with delivery (if selected) arriving within 1–2 business days.</p>' +
        '</div>' +
      '</div>' +
      '<div class="cart-foot" id="cart-foot"></div>';

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    overlay.addEventListener("click", closeDrawer);
    drawer.querySelector(".cart-close").addEventListener("click", closeDrawer);
    drawer.querySelector(".checkout-back").addEventListener("click", function () { drawer.classList.remove("checkout-mode"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawer.classList.contains("is-open")) closeDrawer(); });

    // Courier + shipping-address fields only make sense for Delivery; the
    // 3-day forfeiture note only makes sense for Pickup. Toggle between them
    // on fulfillment change instead of showing both at once.
    var deliveryFields = drawer.querySelector("#co-delivery-fields");
    var pickupNote = drawer.querySelector("#co-pickup-note");
    function syncFulfillFields() {
      var checked = drawer.querySelector('input[name="co-fulfill"]:checked');
      var isDelivery = checked && checked.value === "Delivery";
      deliveryFields.style.display = isDelivery ? "" : "none";
      pickupNote.style.display = isDelivery ? "none" : "";
    }
    Array.prototype.forEach.call(drawer.querySelectorAll('input[name="co-fulfill"]'), function (r) {
      r.addEventListener("change", syncFulfillFields);
    });
    syncFulfillFields();

    bodyView = drawer.querySelector("#cart-view");
    footEl = drawer.querySelector("#cart-foot");
  }

  // True when the cart holds a sku line whose catalog product is flagged
  // fulfillmentInput:"file" (products.js) — i.e. it needs the customer's own
  // document/artwork/logo to actually run the job.
  function cartNeedsFile() {
    return cart.some(function (i) {
      if (i.type !== "sku") return false;
      var p = DATA.products.find(function (pp) { return pp.id === i.id; });
      return p && p.fulfillmentInput === "file";
    });
  }

  function renderCart() {
    // Prompt the customer for a file link only when the cart actually needs
    // one (products.js fulfillmentInput:"file") — keeps the default copy
    // (paste design links) for carts that don't need it.
    var notesEl = document.getElementById("co-notes");
    if (notesEl) {
      notesEl.placeholder = cartNeedsFile()
        ? "Paste a Google Drive/Dropbox link to your file(s) for printing, or describe your design, sizes, and quantities."
        : "For custom items: describe your design, sizes, quantities, or paste file links.";
    }

    // lines
    if (!cart.length) {
      bodyView.innerHTML = '<div class="cart-empty">Your cart is empty.<br>Pick a design or start a custom request above.</div>';
    } else {
      bodyView.innerHTML = "";
      cart.forEach(function (i) {
        var line = document.createElement("div"); line.className = "cart-line" + (i.designRef ? " has-thumb" : "");

        if (i.designRef) {
          var thumbBtn = document.createElement("button");
          thumbBtn.type = "button"; thumbBtn.className = "c-thumb";
          thumbBtn.setAttribute("aria-label", "View full-size design: " + (i.designName || i.name));
          var thumbImg = document.createElement("img");
          thumbImg.src = i.designRef; thumbImg.alt = ""; thumbImg.loading = "lazy";
          thumbBtn.appendChild(thumbImg);
          thumbBtn.addEventListener("click", function () {
            openLightbox([{ src: i.designRef, alt: i.designName || i.name }], 0);
          });
          line.appendChild(thumbBtn);
        }

        var text = document.createElement("div"); text.className = "c-text";
        var meta = [];
        if (i.variantLabel) meta.push(i.variantLabel);
        if (i.shirt) meta.push("with shirt" + (i.shirtColor ? " — " + i.shirtColor : ""));
        var nameHtml = '<div class="c-name">' + escapeHtml(i.name) +
          (i.designName ? ' <span class="c-design">— ' + escapeHtml(i.designName) + '</span>' : '') +
          (i.type === "custom" ? '<span class="cart-tag">Pending approval</span>' : '') + '</div>';
        var metaHtml = meta.length ? '<div class="c-meta">' + escapeHtml(meta.join(" · ")) + '</div>' : '';
        text.innerHTML = nameHtml + metaHtml;
        line.appendChild(text);

        var priceHtml = i.type === "sku"
          ? '<div class="c-price">' + peso(i.unitPrice * i.qty) + '</div>'
          : '<div class="c-price pending">₱0 now</div>';
        var priceEl = document.createElement("div");
        priceEl.innerHTML = priceHtml;
        line.appendChild(priceEl.firstChild);

        var controls = document.createElement("div"); controls.className = "c-controls";
        var stepper = document.createElement("div"); stepper.className = "qty-stepper";
        var minus = document.createElement("button"); minus.type = "button"; minus.textContent = "−";
        var qv = document.createElement("input"); qv.type = "number"; qv.className = "qval"; qv.inputMode = "numeric"; qv.value = i.qty; qv.setAttribute("aria-label", "Quantity");
        var plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+";
        function lineFloor() {
          var p = DATA.products.find(function (pp) { return pp.id === i.id; });
          return (p && p.minQty) || 1;
        }
        function lineCap() {
          var p = DATA.products.find(function (pp) { return pp.id === i.id; });
          return p && p.softCap;
        }
        // Same capacity-cap gate as the product cards (requestQty()), so
        // bumping a line's qty in the cart drawer can't bypass the popup by
        // just adding to cart at the cap then editing it up here. Keyed by
        // `i.id` (the product, matching the shop card's own key) rather than
        // `i.key` (which also encodes variant/shirt/design) — agreeing to a
        // big order for a product should carry over between its card and its
        // cart line, just not to a different product.
        function setQtyChecked(n) {
          requestQty(lineCap(), Math.max(lineFloor(), n), function (finalQty) { setQty(i.key, finalQty); }, i.id);
        }
        qv.min = String(lineFloor());
        minus.addEventListener("click", function () {
          // Respect a product's minQty (e.g. business cards' 10-pc minimum) —
          // stepping below it isn't allowed, use "Remove" to drop the line instead.
          if (i.qty <= lineFloor()) return;
          setQty(i.key, i.qty - 1);
        });
        plus.addEventListener("click", function () { setQtyChecked(i.qty + 1); });
        // Commit on blur/Enter only, matching the product-card stepper, so
        // re-tiering (bulkUnitPrice via setQty) fires once per typed value
        // instead of fighting the user mid-keystroke.
        function commitQv() {
          var n = parseInt(qv.value, 10);
          if (!isFinite(n) || isNaN(n)) { qv.value = i.qty; return; }
          var clamped = Math.max(lineFloor(), n);
          if (clamped === i.qty) { qv.value = clamped; return; }
          setQtyChecked(clamped);
        }
        qv.addEventListener("blur", commitQv);
        qv.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); qv.blur(); } });
        stepper.appendChild(minus); stepper.appendChild(qv); stepper.appendChild(plus);
        var rm = document.createElement("button"); rm.className = "c-remove"; rm.type = "button"; rm.textContent = "Remove";
        rm.addEventListener("click", function () { removeItem(i.key); });
        controls.appendChild(stepper); controls.appendChild(rm);
        line.appendChild(controls);
        bodyView.appendChild(line);
      });
    }

    // foot
    var pend = pendingCount();
    if (!cart.length) {
      footEl.innerHTML = "";
    } else if (drawer.classList.contains("checkout-mode")) {
      footEl.innerHTML =
        '<div class="f-total"><span>Pay now</span><span class="amt">' + peso(payNowTotal()) + '</span></div>' +
        (pend ? '<p class="f-note">' + pend + ' custom item(s) will be quoted and billed after we approve your design.</p>' : '') +
        '<button type="button" class="btn btn-primary btn-block" id="place-order">Place order</button>';
      footEl.querySelector("#place-order").addEventListener("click", submitOrder);
    } else {
      footEl.innerHTML =
        '<div class="f-line"><span>Pay-now subtotal</span><span>' + peso(payNowTotal()) + '</span></div>' +
        (pend ? '<div class="f-line"><span>Pending approval</span><span>' + pend + ' item(s)</span></div>' : '') +
        '<div class="f-total"><span>Due now</span><span class="amt">' + peso(payNowTotal()) + '</span></div>' +
        '<p class="f-note">Custom items are ₱0 now — billed only after we approve your design.</p>' +
        '<button type="button" class="btn btn-primary btn-block" id="go-checkout">Checkout</button>';
      footEl.querySelector("#go-checkout").addEventListener("click", function () {
        drawer.classList.add("checkout-mode"); renderCart();
      });
    }
  }

  /* ---------- post-checkout popup: GCash payment proof upload ----------
     Two states, chosen by whether the order has anything to pay NOW
     (payNowTotal > 0 means it has sku lines; an all-custom order has
     nothing to pay until staff quotes it):
       - renderPaymentProofStep(): QR + ref-number/amount/screenshot form,
         wired to the real submitPaymentProof.js via submitPaymentProof()
         below (docs/roadmap.md Milestone 1.2 — this is the piece that
         replaced the old copy-to-clipboard/mailto: interim from history.md
         entry 22, now that createOrder/submitPaymentProof are both live).
       - renderCustomOnlyConfirmation(): just tells the customer their
         request is in for a quote — no payment step to show.
     The shell (backdrop/title/body/actions) is built once and reused;
     each open re-renders #order-popup-body/#order-popup-actions fresh so
     stale listeners from the previous order's render never linger (a
     plain innerHTML replace drops them for free). ---------- */
  var orderPopup, orderPopupBody, orderPopupActions;

  function ensureOrderPopupShell() {
    if (orderPopup) return;
    var backdrop = document.createElement("div");
    backdrop.className = "order-popup-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.innerHTML =
      '<div class="order-popup" role="dialog" aria-modal="true" aria-labelledby="order-popup-title">' +
        '<h3 class="dialog-title" id="order-popup-title">Thank you for placing an order with us!</h3>' +
        '<div class="dialog-body" id="order-popup-body"></div>' +
        '<div class="dialog-actions" id="order-popup-actions"></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    // Clicking the backdrop only dismisses the popup — the cart isn't
    // cleared, since (unlike the old flow) the order already exists for
    // real regardless of whether the customer finishes this step; they can
    // reopen the drawer and pick up the payment-proof step again later via
    // their own records of the order ID, or contact support.
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeOrderPopup(); });
    orderPopup = backdrop;
    orderPopupBody = backdrop.querySelector("#order-popup-body");
    orderPopupActions = backdrop.querySelector("#order-popup-actions");
  }

  function openOrderPopup(state) {
    ensureOrderPopupShell();
    if (state.payNowTotal > 0) renderPaymentProofStep(state);
    else renderCustomOnlyConfirmation(state);
    orderPopup.classList.add("is-open");
    orderPopup.setAttribute("aria-hidden", "false");
  }

  function closeOrderPopup() {
    if (!orderPopup) return;
    orderPopup.classList.remove("is-open");
    orderPopup.setAttribute("aria-hidden", "true");
  }

  function finishAndClose() {
    clearCart();
    closeOrderPopup();
    closeDrawer();
  }

  function renderCustomOnlyConfirmation(state) {
    orderPopupBody.innerHTML =
      '<p>Order <strong>' + escapeHtml(state.orderId) + '</strong> is in. Since it\'s a custom request, ' +
      'there\'s nothing to pay yet — we\'ll review it and send you a quote, usually within 24 hours.</p>';
    orderPopupActions.innerHTML = '<button type="button" class="btn btn-primary" id="order-popup-done">Done</button>';
    orderPopupActions.querySelector("#order-popup-done").addEventListener("click", finishAndClose);
  }

  function renderPaymentProofStep(state) {
    orderPopupBody.innerHTML =
      '<p>Order <strong>' + escapeHtml(state.orderId) + '</strong> — scan to pay <strong>' + peso(state.payNowTotal) + '</strong> ' +
      'via GCash, then tell us the reference number and attach your payment screenshot below.</p>' +
      '<img class="order-popup-qr" src="assets/gcash-qr.jpg" alt="KCMPS GCash QR code — scan to pay" width="200" height="384" />' +
      '<div class="field"><label for="pp-ref">GCash reference number</label><input class="input" id="pp-ref" placeholder="e.g. 8017 442 99331" /></div>' +
      '<div class="field"><label for="pp-amount">Amount you sent (₱)</label><input class="input" id="pp-amount" type="number" min="0" step="0.01" value="' + state.payNowTotal + '" /></div>' +
      '<div class="field"><label for="pp-file">Payment screenshot</label><input class="input" id="pp-file" type="file" accept="image/png,image/jpeg,image/webp" /></div>' +
      '<p class="order-popup-error" id="pp-error" style="display:none;color:#c0392b;font-size:13px;margin:4px 0 0"></p>' +
      '<p style="font-size:12.5px;opacity:0.75;margin-top:var(--space-2)">Trouble uploading? Message us at ' +
      '<a href="mailto:' + ORDER_EMAIL + '?subject=' + encodeURIComponent("Order " + state.orderId + " — payment proof") + '">' + escapeHtml(ORDER_EMAIL) + '</a> ' +
      'with your order ID and screenshot instead.</p>';
    orderPopupActions.innerHTML =
      '<button type="button" class="btn btn-secondary" id="order-popup-later">I\'ll send it later</button>' +
      '<button type="button" class="btn btn-primary" id="order-popup-submit-proof">Submit payment proof</button>';
    orderPopupActions.querySelector("#order-popup-later").addEventListener("click", finishAndClose);
    orderPopupActions.querySelector("#order-popup-submit-proof").addEventListener("click", function () {
      submitPaymentProof(state);
    });
  }

  function renderProofSubmittedConfirmation(state) {
    orderPopupBody.innerHTML =
      '<p>Payment proof received for order <strong>' + escapeHtml(state.orderId) + '</strong> — ' +
      'we\'ll verify it and confirm your order, usually within 48 hours.</p>';
    orderPopupActions.innerHTML = '<button type="button" class="btn btn-primary" id="order-popup-done">Done</button>';
    orderPopupActions.querySelector("#order-popup-done").addEventListener("click", finishAndClose);
  }

  // Two-step per submitPaymentProof.js: (1) POST ref/amount/contentType,
  // get back a pre-signed S3 PUT URL; (2) PUT the actual file bytes
  // straight to S3 (never through the Lambda — presigned URLs exist so the
  // API doesn't have to proxy the upload).
  function submitPaymentProof(state) {
    var refEl = document.getElementById("pp-ref");
    var amountEl = document.getElementById("pp-amount");
    var fileEl = document.getElementById("pp-file");
    var errorEl = document.getElementById("pp-error");
    var ref = (refEl.value || "").trim();
    var amount = parseFloat(amountEl.value);
    var file = fileEl.files && fileEl.files[0];

    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = ""; }
    errorEl.style.display = "none";

    if (!ref) { showError("Please enter the GCash reference number."); return; }
    if (!(amount > 0)) { showError("Please enter the amount you sent."); return; }
    if (!file) { showError("Please attach a screenshot of your payment."); return; }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { showError("Screenshot must be a JPG, PNG, or WEBP image."); return; }

    var submitBtn = document.getElementById("order-popup-submit-proof");
    var origText = submitBtn.textContent;
    submitBtn.disabled = true; submitBtn.textContent = "Submitting…";

    var headers = { "Content-Type": "application/json" };
    var token = idToken();
    if (token) headers["Authorization"] = "Bearer " + token;

    fetch(CHECKOUT_API_BASE + "/orders/" + encodeURIComponent(state.orderId) + "/payment-proof", {
      method: "POST", headers: headers,
      body: JSON.stringify({ gcashRefNumber: ref, claimedAmount: amount, contentType: file.type }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : "Could not submit payment proof (" + res.status + ")");
        return data;
      });
    }).then(function (data) {
      return fetch(data.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then(function (uploadRes) {
        if (!uploadRes.ok) throw new Error("Screenshot upload failed — please try again.");
      });
    }).then(function () {
      renderProofSubmittedConfirmation(state);
    }).catch(function (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
    });
  }

  // Cart -> the shape create-order.js's Lambda expects. `id` is the
  // catalog/product id (skuCard()/quoteCard() set it via addToCart's `id`
  // field) — the Lambda's own field name for it is `sku`, so it's renamed
  // here at the one boundary that needs to know both names.
  function cartForCheckout() {
    return cart.map(function (i) {
      return {
        type: i.type, sku: i.id, name: i.name, qty: i.qty, unitPrice: i.unitPrice,
        variantLabel: i.variantLabel || null, shirt: !!i.shirt, shirtColor: i.shirtColor || null,
        designRef: i.designRef || null, designName: i.designName || null,
      };
    });
  }

  function submitOrder() {
    var name = (document.getElementById("co-name").value || "").trim();
    var contact = (document.getElementById("co-contact").value || "").trim();
    if (!name || !contact) { alert("Please add your name and a way to reach you."); return; }
    var fulfillEl = document.querySelector('input[name="co-fulfill"]:checked');
    var fulfill = fulfillEl ? fulfillEl.value : "Pickup";
    var notes = (document.getElementById("co-notes").value || "").trim();

    var shipping = null;
    if (fulfill === "Delivery") {
      var courierEl = document.querySelector('input[name="co-courier"]:checked');
      var address = (document.getElementById("co-address").value || "").trim();
      var landmark = (document.getElementById("co-landmark").value || "").trim();
      if (!address) { alert("Please add your delivery address."); return; }
      shipping = { courier: courierEl ? courierEl.value : "Grab", address: address, landmark: landmark };
    }

    var placeBtn = document.getElementById("place-order");
    var placeBtnOrigText = placeBtn ? placeBtn.textContent : "";
    if (placeBtn) { placeBtn.disabled = true; placeBtn.textContent = "Placing order…"; }

    var headers = { "Content-Type": "application/json" };
    var token = idToken();
    if (token) headers["Authorization"] = "Bearer " + token;

    fetch(CHECKOUT_API_BASE + "/orders", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        customerName: name, customerContact: contact, fulfillment: fulfill,
        shipping: shipping, notes: notes, cart: cartForCheckout(),
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : "Order failed (" + res.status + ")");
        return data;
      });
    }).then(function (data) {
      openOrderPopup({ orderId: data.orderId, payNowTotal: data.payNowTotal });
    }).catch(function (err) {
      alert("We couldn't place your order right now (" + err.message + "). Please try again in a moment, or message us directly at " + ORDER_EMAIL + ".");
    }).then(function () {
      if (placeBtn) { placeBtn.disabled = false; placeBtn.textContent = placeBtnOrigText; }
    });
  }

  function openDrawer() {
    if (!drawer) return;
    drawer.classList.remove("checkout-mode");
    renderCart();
    overlay.classList.add("is-open");
    drawer.classList.add("is-open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function closeDrawer() {
    overlay.classList.remove("is-open");
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  /* ---------- shared UI sync ---------- */
  function syncUI() {
    updateBadge();
    if (drawer && drawer.classList.contains("is-open")) renderCart();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- init ---------- */
  renderCatalog();
  buildDrawer();
  updateBadge();

  // The nav cart button was stubbed by the auth script (initCartStub); take it
  // over so it opens the real drawer. We add our own listener; the auth stub's
  // alert binding is removed in index.html.
  var cartBtn = document.getElementById("cart-btn");
  if (cartBtn) cartBtn.addEventListener("click", openDrawer);

  // Persistent mobile buy bar (hidden on desktop, hidden in auth popups by
  // the existing auth-popup CSS rule).
  var stickyCart = document.getElementById("sticky-cart");
  if (stickyCart) stickyCart.addEventListener("click", openDrawer);

  // Public hooks for the auth script (login/logout/session-restore) to refresh
  // the badge and open the drawer without knowing cart internals.
  // bulkTier/bulkUnitPrice exposed so the "Bulk & custom" estimator
  // (index.html, near the bottom script block) prices off the exact same
  // per-product discount ladder as the catalog cards above, instead of
  // maintaining its own separate schedule that can drift out of sync.
  // requestQty exposed so the "Bulk & custom" estimator (index.html) gates
  // its quantity field through the exact same capacity soft-cap popup as the
  // shop cards and cart drawer — see the capacity soft-cap section above.
  window.KCMPS_STORE = {
    open: openDrawer, close: closeDrawer, refreshBadge: updateBadge, addToCart: addToCart,
    bulkTier: activeBulkTier, bulkUnitPrice: bulkUnitPrice, requestQty: requestQty,
  };
})();
