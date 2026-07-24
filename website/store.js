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
  var ORDER_EMAIL = "ken.rodulfo.dungca+kcmps@gmail.com";

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

  function skuCard(p) {
    var card = document.createElement("div");
    card.className = "card offer product";

    var variants = p.variants || [{ label: "", price: p.price || 0 }];
    var sel = 0;              // selected variant index
    var withShirt = false;    // shirt add-on
    var qty = 1;

    function unitPrice() { return variants[sel].price + (withShirt && p.shirtAddon ? DATA.shirtAddon.price : 0); }

    // thumb
    card.appendChild(buildThumb(thumbImage(p), p.name));

    var kick = document.createElement("span"); kick.className = "card-kicker"; kick.textContent = p.kicker || ""; card.appendChild(kick);
    var h = document.createElement("h3"); h.className = "card-title"; h.textContent = p.name; card.appendChild(h);
    var body = document.createElement("p"); body.className = "card-body"; body.textContent = p.blurb || ""; card.appendChild(body);

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
      addToCart({
        key: p.id + "|" + vLabel + "|" + (withShirt ? "shirt" : "plain"),
        id: p.id, name: p.name, leaf: p.leaf, type: "sku",
        variantLabel: vLabel, shirt: withShirt, unitPrice: unitPrice(), qty: qty
      });
      var orig = addBtn.innerHTML; addBtn.innerHTML = "Added ✓"; addBtn.disabled = true;
      setTimeout(function () { addBtn.innerHTML = orig; addBtn.disabled = false; }, 1100);
      qty = 1; qval.textContent = qty;
      openDrawer();
    });
    card.appendChild(addBtn);

    function refresh() {
      var base = variants[sel].price;
      var extra = withShirt && p.shirtAddon ? DATA.shirtAddon.price : 0;
      priceEl.innerHTML = peso(base + extra) + (extra ? ' <small>incl. shirt</small>' : (p.variants && p.variants.length > 1 ? ' <small>/ ' + variants[sel].label + '</small>' : ''));
    }
    refresh();
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
      DATA.products.filter(function (p) { return p.leaf === leafKey; }).forEach(function (p) { grid.appendChild(skuCard(p)); });
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
        var line = document.createElement("div"); line.className = "cart-line";
        var meta = [];
        if (i.variantLabel) meta.push(i.variantLabel);
        if (i.shirt) meta.push("with shirt");
        var nameHtml = '<div class="c-name">' + escapeHtml(i.name) +
          (i.type === "custom" ? '<span class="cart-tag">Pending approval</span>' : '') + '</div>';
        var metaHtml = meta.length ? '<div class="c-meta">' + escapeHtml(meta.join(" · ")) + '</div>' : '';
        var priceHtml = i.type === "sku"
          ? '<div class="c-price">' + peso(i.unitPrice * i.qty) + '</div>'
          : '<div class="c-price pending">₱0 now</div>';
        line.innerHTML = nameHtml + priceHtml + metaHtml;

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

  function submitOrder() {
    var name = (document.getElementById("co-name").value || "").trim();
    var contact = (document.getElementById("co-contact").value || "").trim();
    if (!name || !contact) { alert("Please add your name and a way to reach you."); return; }
    var fulfillEl = document.querySelector('input[name="co-fulfill"]:checked');
    var fulfill = fulfillEl ? fulfillEl.value : "Pickup";
    var notes = (document.getElementById("co-notes").value || "").trim();

    var lines = ["KCMPS ORDER REQUEST", "==================", "", "Customer: " + name, "Contact: " + contact, "Fulfillment: " + fulfill, ""];
    var payNow = cart.filter(function (i) { return i.type === "sku"; });
    var pending = cart.filter(function (i) { return i.type === "custom"; });
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

    var subject = "KCMPS order request — " + name + " (" + peso(payNowTotal()) + " now)";
    var href = "mailto:" + ORDER_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
    window.location.href = href;
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
