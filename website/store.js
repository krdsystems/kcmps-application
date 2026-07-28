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
     3. Checkout — today composes a mailto: (the site's CSP `connect-src` only
        allows Cognito, so no third-party fetch). Later: POST the order to your
        API / open a hosted payment link. Swap ORDER_EMAIL/submitOrder() only.

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
  // OWNER: swap this for a real order endpoint / Messenger link when a backend
  // exists (also add its origin to the CSP connect-src if you use fetch()).
  var ORDER_EMAIL = "order@kcmps.com";

  var peso = function (n) {
    return DATA.currency + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  /* ---------- cart state ---------- */
  function loadCart() {
    try { var v = JSON.parse(localStorage.getItem(CART_KEY)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function saveCart(cart) { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
  var cart = loadCart();

  function itemCount() { return cart.reduce(function (s, i) { return s + i.qty; }, 0); }
  function payNowTotal() { return cart.reduce(function (s, i) { return s + (i.type === "sku" ? i.unitPrice * i.qty : 0); }, 0); }
  function pendingCount() { return cart.reduce(function (s, i) { return s + (i.type === "custom" ? i.qty : 0); }, 0); }

  function addToCart(item) {
    var existing = cart.find(function (i) { return i.key === item.key; });
    if (existing) existing.qty += item.qty; else cart.push(item);
    saveCart(cart); syncUI();
    // Covers both instant-buy (sku) and the site's quote flow (custom items
    // ARE the quote/custom-request action here — see hero-priming script).
    document.dispatchEvent(new CustomEvent("kcmps:cart-add", { detail: { leaf: item.leaf, type: item.type } }));
  }
  function setQty(key, qty) {
    var it = cart.find(function (i) { return i.key === key; });
    if (!it) return;
    it.qty = qty;
    if (it.qty <= 0) cart = cart.filter(function (i) { return i.key !== key; });
    saveCart(cart); syncUI();
  }
  function removeItem(key) { cart = cart.filter(function (i) { return i.key !== key; }); saveCart(cart); syncUI(); }

  /* ---------- badge (reuses the auth-era nav elements) ---------- */
  function updateBadge() {
    var badge = document.getElementById("cart-badge");
    if (!badge) return;
    var n = itemCount();
    if (n > 0) { badge.textContent = n; badge.classList.remove("is-hidden"); }
    else { badge.classList.add("is-hidden"); }
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
  var lightboxOverlay, lightboxImg, lightboxCounter, lightboxPrevBtn, lightboxNextBtn;
  var lightboxImages = [], lightboxIndex = 0;

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
      '<div class="lightbox-counter"></div>';
    document.body.appendChild(lightboxOverlay);

    lightboxImg = lightboxOverlay.querySelector(".lightbox-stage img");
    lightboxCounter = lightboxOverlay.querySelector(".lightbox-counter");
    lightboxPrevBtn = lightboxOverlay.querySelector(".lightbox-arrow.prev");
    lightboxNextBtn = lightboxOverlay.querySelector(".lightbox-arrow.next");

    lightboxOverlay.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
    lightboxOverlay.addEventListener("click", function (e) { if (e.target === lightboxOverlay) closeLightbox(); });
    lightboxPrevBtn.addEventListener("click", function () { stepLightbox(-1); });
    lightboxNextBtn.addEventListener("click", function () { stepLightbox(1); });
    document.addEventListener("keydown", function (e) {
      if (!lightboxOverlay.classList.contains("is-open")) return;
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
  }

  function stepLightbox(delta) {
    lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
    renderLightbox();
  }

  function openLightbox(images, startIndex) {
    if (!lightboxOverlay) buildLightbox();
    lightboxImages = images;
    lightboxIndex = startIndex || 0;
    renderLightbox();
    lightboxOverlay.classList.add("is-open");
    lightboxOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    if (!lightboxOverlay) return;
    lightboxOverlay.classList.remove("is-open");
    lightboxOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
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
  // large preview and the picker grid's selection in sync.
  function buildGalleryThumb(p, onIndexChange) {
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
  // Used by the order popup's copy-to-clipboard button (store.js openOrderPopup).
  var COPY_ICON = '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';

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
  function buildDesignGrid(p, gallery, selectedIdx) {
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

      pick.addEventListener("click", function () {
        gallery.setIndex(i);
        sync();
        hidePopup();
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
    // how narrow the product card is.
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

    if (collapsed) {
      wrap.addEventListener("mouseenter", function () { cancelHide(); showPopup(); });
      wrap.addEventListener("mouseleave", scheduleHide);
      // Hover doesn't exist on touch — tapping/focusing the "more" tile toggles the popup instead.
      moreTile.addEventListener("click", function (e) {
        e.stopPropagation();
        if (popup && popup.classList.contains("is-open")) hidePopup(); else showPopup();
      });
      moreTile.addEventListener("focus", showPopup);
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
    var addonSel = 0;         // selected tiered add-on index (p.addon.options), 0 = none/base
    var qty = 1;

    function unitPrice() {
      var addonPrice = (p.addon && p.addon.options) ? p.addon.options[addonSel].price : 0;
      return variants[sel].price + (withShirt && p.shirtAddon ? DATA.shirtAddon.price : 0) + addonPrice;
    }

    // thumb
    var gallery = buildGalleryThumb(p, function () { if (designPicker) designPicker.sync(); });
    card.appendChild(gallery.el);

    var kick = document.createElement("span"); kick.className = "card-kicker"; kick.textContent = p.kicker || ""; card.appendChild(kick);
    var h = document.createElement("h3"); h.className = "card-title"; h.textContent = p.name; card.appendChild(h);
    var body = document.createElement("p"); body.className = "card-body"; body.textContent = p.blurb || ""; card.appendChild(body);

    // design picker — selectable grid of pre-made designs (products.js
    // `images[]`); the currently selected design travels with the cart line
    // as designRef/designName so the cart can show a recognizable thumbnail.
    var designPicker = buildDesignGrid(p, gallery, gallery.getIndex());
    if (designPicker) card.appendChild(designPicker.el);

    // size selector
    if (p.variants && p.variants.length > 1) {
      var seg = document.createElement("div"); seg.className = "seg"; seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", "Size");
      variants.forEach(function (v, i) {
        var lab = document.createElement("label"); lab.className = "seg-opt";
        var r = document.createElement("input"); r.type = "radio"; r.name = p.id + "-size"; if (i === 0) r.checked = true;
        var sp = document.createElement("span"); sp.textContent = v.label;
        r.addEventListener("change", function () { sel = i; refresh(); });
        lab.appendChild(r); lab.appendChild(sp); seg.appendChild(lab);
      });
      card.appendChild(seg);
    }

    // shirt toggle
    if (p.shirtAddon) {
      var tog = document.createElement("label"); tog.className = "shirt-toggle";
      var cb = document.createElement("input"); cb.type = "checkbox";
      var txt = document.createElement("span"); txt.textContent = DATA.shirtAddon.label;
      cb.addEventListener("change", function () { withShirt = cb.checked; refresh(); });
      tog.appendChild(cb); tog.appendChild(txt); card.appendChild(tog);
    }

    // generic tiered add-on (e.g. the color-printing option on a B/W print SKU) —
    // renders as its own radio group, additive on top of the base/variant price.
    if (p.addon && p.addon.options && p.addon.options.length) {
      if (p.addon.label) {
        var addonLbl = document.createElement("div"); addonLbl.className = "addon-label"; addonLbl.textContent = p.addon.label;
        card.appendChild(addonLbl);
      }
      var addonSeg = document.createElement("div"); addonSeg.className = "seg"; addonSeg.setAttribute("role", "radiogroup"); addonSeg.setAttribute("aria-label", p.addon.label || "Add-on");
      p.addon.options.forEach(function (opt, i) {
        var lab = document.createElement("label"); lab.className = "seg-opt";
        var r = document.createElement("input"); r.type = "radio"; r.name = p.id + "-addon"; if (i === 0) r.checked = true;
        var sp = document.createElement("span"); sp.textContent = opt.label;
        r.addEventListener("change", function () { addonSel = i; refresh(); });
        lab.appendChild(r); lab.appendChild(sp); addonSeg.appendChild(lab);
      });
      card.appendChild(addonSeg);
    }

    // buy row: price + qty
    var buy = document.createElement("div"); buy.className = "product-buy";
    var priceEl = document.createElement("span"); priceEl.className = "product-price";
    var stepper = document.createElement("div"); stepper.className = "qty-stepper";
    var minus = document.createElement("button"); minus.type = "button"; minus.textContent = "−"; minus.setAttribute("aria-label", "Decrease quantity");
    var qval = document.createElement("span"); qval.className = "qval"; qval.textContent = qty;
    var plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+"; plus.setAttribute("aria-label", "Increase quantity");
    minus.addEventListener("click", function () { qty = Math.max(1, qty - 1); qval.textContent = qty; });
    plus.addEventListener("click", function () { qty += 1; qval.textContent = qty; });
    stepper.appendChild(minus); stepper.appendChild(qval); stepper.appendChild(plus);
    buy.appendChild(priceEl); buy.appendChild(stepper); card.appendChild(buy);

    // add button
    var addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn btn-primary btn-block";
    addBtn.innerHTML = CART_ICON + " Add to cart";
    addBtn.addEventListener("click", function () {
      var vLabel = variants[sel].label;
      var designRef = p.images && p.images.length ? p.images[gallery.getIndex()] : null;
      var designName = designRef ? designTitle(designRef) : null;
      var addonLabel = (p.addon && p.addon.options && addonSel > 0) ? p.addon.options[addonSel].label : "";
      var lineLabel = [vLabel, addonLabel].filter(Boolean).join(" + ");
      addToCart({
        key: p.id + "|" + vLabel + "|" + (withShirt ? "shirt" : "plain") + "|" + (designRef || "") + "|" + addonLabel,
        id: p.id, name: p.name, leaf: p.leaf, type: "sku",
        variantLabel: lineLabel, shirt: withShirt, unitPrice: unitPrice(), qty: qty,
        designRef: designRef, designName: designName
      });
      var orig = addBtn.innerHTML; addBtn.innerHTML = "Added ✓"; addBtn.disabled = true;
      setTimeout(function () { addBtn.innerHTML = orig; addBtn.disabled = false; }, 1100);
      qty = 1; qval.textContent = qty;
      openDrawer();
    });
    card.appendChild(addBtn);

    function refresh() {
      var base = variants[sel].price;
      var shirtExtra = withShirt && p.shirtAddon ? DATA.shirtAddon.price : 0;
      var addonExtra = (p.addon && p.addon.options) ? p.addon.options[addonSel].price : 0;
      var extra = shirtExtra + addonExtra;
      var notes = [];
      if (shirtExtra) notes.push("incl. shirt");
      if (addonExtra) notes.push("incl. " + p.addon.options[addonSel].label);
      if (!notes.length && p.variants && p.variants.length > 1) notes.push("/ " + variants[sel].label);
      priceEl.innerHTML = peso(base + extra) + (notes.length ? ' <small>' + notes.join(", ") + '</small>' : '');
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
      DATA.products.filter(function (p) { return p.leaf === leafKey; }).forEach(function (p) { grid.appendChild(p.quoteOnRequest ? quoteCard(p) : skuCard(p)); });
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
          '<div class="field"><label for="co-notes">Custom request details / design links</label><textarea class="input" id="co-notes" placeholder="For custom items: describe your design, sizes, quantities, or paste file links."></textarea></div>' +
        '</div>' +
      '</div>' +
      '<div class="cart-foot" id="cart-foot"></div>';

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    overlay.addEventListener("click", closeDrawer);
    drawer.querySelector(".cart-close").addEventListener("click", closeDrawer);
    drawer.querySelector(".checkout-back").addEventListener("click", function () { drawer.classList.remove("checkout-mode"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawer.classList.contains("is-open")) closeDrawer(); });

    bodyView = drawer.querySelector("#cart-view");
    footEl = drawer.querySelector("#cart-foot");
  }

  function renderCart() {
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
        if (i.shirt) meta.push("with shirt");
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
        var qv = document.createElement("span"); qv.className = "qval"; qv.textContent = i.qty;
        var plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+";
        minus.addEventListener("click", function () { setQty(i.key, i.qty - 1); });
        plus.addEventListener("click", function () { setQty(i.key, i.qty + 1); });
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

  // Builds the pre-filled email { subject, body, format } from the checkout
  // form + cart, but doesn't navigate anywhere — submitOrder() opens the
  // GCash payment popup first, and the popup's "Open email app" button uses
  // this. `format` is the full plain-text message (Subject/Contact/
  // Fulfillment/Custom Request Details header, filled in with the
  // customer's actual answers, followed by the same itemized cart
  // breakdown as `body`) shown — and copyable in one piece — in the popup,
  // so pasting it manually into an email carries every item, not just the
  // header fields.
  function buildOrderEmail(name, contact, fulfill, notes) {
    var payNow = cart.filter(function (i) { return i.type === "sku"; });
    var pending = cart.filter(function (i) { return i.type === "custom"; });
    var subject = "Order for " + name;

    var lines = ["Contact: " + contact, "Fulfillment: " + fulfill];
    if (pending.length) lines.push("Custom Request Details: " + (notes || "(none provided)"));
    lines.push("", "KCMPS ORDER REQUEST", "==================", "");
    if (payNow.length) {
      lines.push("PAY NOW:");
      payNow.forEach(function (i) {
        var d = [i.name]; if (i.variantLabel) d.push(i.variantLabel); if (i.shirt) d.push("with shirt");
        lines.push("  - " + d.join(" / ") + " x" + i.qty + "  =  " + peso(i.unitPrice * i.qty));
      });
      lines.push("  Subtotal (pay now): " + peso(payNowTotal()), "");
    }
    if (pending.length) {
      lines.push("PENDING APPROVAL (billed after we approve the design):");
      pending.forEach(function (i) { lines.push("  - " + i.name + " x" + i.qty); });
      lines.push("");
    }
    if (notes) lines.push("NOTES / DESIGN DETAILS:", notes, "");
    lines.push("(Sent from the KCMPS website cart.)");

    var body = lines.join("\n");
    return { subject: subject, body: body, format: "Subject: " + subject + "\n" + body };
  }

  var orderPopup, orderPopupEmailBtn, orderPopupFormatEl, orderPopupCopyBtn;
  var pendingOrderEmail = null;

  function buildOrderPopup() {
    var backdrop = document.createElement("div");
    backdrop.className = "order-popup-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.innerHTML =
      '<div class="order-popup" role="dialog" aria-modal="true" aria-labelledby="order-popup-title">' +
        '<h3 class="dialog-title" id="order-popup-title">Thank you for placing an order with us!</h3>' +
        '<div class="dialog-body">' +
          '<p>Our payment system is on the way. We currently accept GCASH payments in fulfilling your order.</p>' +
          '<img class="order-popup-qr" src="assets/gcash-qr.jpg" alt="KCMPS GCash QR code — scan to pay" width="200" height="384" />' +
          '<p>After payment, kindly send us a screenshot of your payment proof to <strong>' + escapeHtml(ORDER_EMAIL) + '</strong> with:</p>' +
          '<div class="order-popup-format-wrap">' +
            '<button type="button" class="btn-icon-copy" id="order-popup-copy" aria-label="Copy this text">' + COPY_ICON + '</button>' +
            '<p class="order-popup-format mono" id="order-popup-format"></p>' +
          '</div>' +
        '</div>' +
        '<div class="dialog-actions">' +
          '<button type="button" class="btn btn-secondary" id="order-popup-close">I\'ll send it manually</button>' +
          '<button type="button" class="btn btn-primary" id="order-popup-email">Open email app</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(backdrop);

    orderPopup = backdrop;
    orderPopupEmailBtn = backdrop.querySelector("#order-popup-email");
    orderPopupFormatEl = backdrop.querySelector("#order-popup-format");
    orderPopupCopyBtn = backdrop.querySelector("#order-popup-copy");

    // "I'll send it manually" fully backs out of checkout (popup + drawer
    // both close) — clicking outside the popup (backdrop) only dismisses
    // the popup itself, leaving the drawer/cart untouched underneath.
    backdrop.querySelector("#order-popup-close").addEventListener("click", function () {
      closeOrderPopup();
      closeDrawer();
    });
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeOrderPopup(); });
    orderPopupEmailBtn.addEventListener("click", function () {
      if (!pendingOrderEmail) return;
      window.location.href = "mailto:" + ORDER_EMAIL +
        "?subject=" + encodeURIComponent(pendingOrderEmail.subject) +
        "&body=" + encodeURIComponent(pendingOrderEmail.body);
    });
    orderPopupCopyBtn.addEventListener("click", function () {
      if (!pendingOrderEmail) return;
      navigator.clipboard.writeText(pendingOrderEmail.format).then(function () {
        orderPopupCopyBtn.classList.add("is-copied");
        orderPopupCopyBtn.setAttribute("aria-label", "Copied");
        setTimeout(function () {
          orderPopupCopyBtn.classList.remove("is-copied");
          orderPopupCopyBtn.setAttribute("aria-label", "Copy this text");
        }, 1500);
      });
    });
  }

  function openOrderPopup(orderEmail) {
    pendingOrderEmail = orderEmail;
    if (!orderPopup) buildOrderPopup();
    orderPopupFormatEl.innerHTML = escapeHtml(orderEmail.format).replace(/\n/g, "<br>");
    orderPopup.classList.add("is-open");
    orderPopup.setAttribute("aria-hidden", "false");
  }

  function closeOrderPopup() {
    if (!orderPopup) return;
    orderPopup.classList.remove("is-open");
    orderPopup.setAttribute("aria-hidden", "true");
  }

  function submitOrder() {
    var name = (document.getElementById("co-name").value || "").trim();
    var contact = (document.getElementById("co-contact").value || "").trim();
    if (!name || !contact) { alert("Please add your name and a way to reach you."); return; }
    var fulfillEl = document.querySelector('input[name="co-fulfill"]:checked');
    var fulfill = fulfillEl ? fulfillEl.value : "Pickup";
    var notes = (document.getElementById("co-notes").value || "").trim();

    openOrderPopup(buildOrderEmail(name, contact, fulfill, notes));
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
  window.KCMPS_STORE = { open: openDrawer, close: closeDrawer, refreshBadge: updateBadge, addToCart: addToCart };
})();
