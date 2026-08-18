/* ============================================================================
   KCMPS R&D — Design subsection wizard, v3

   v3 is the whole real site (this folder's index.html / styles.css are copies
   of website/, free to restyle), with ONE section replaced: the Design
   subsection is now the wizard presentation from the R&D mockups.

   Catalog, pricing, bulk tiers, capacity cap and cart still come from the real
   front-end — products.js and store.js are loaded from website/ unmodified:

     catalog   window.KCMPS_STORE_DATA
     pricing   KCMPS_STORE.bulkTier / bulkUnitPrice
     capacity  KCMPS_STORE.requestQty   (the deployed cap popup)
     cart      KCMPS_STORE.addToCart    (the real drawer)

   WHAT CHANGED FROM v2 — the composite shirt preview is GONE.

   v2 tried to fake a live shirt mockup without transparent artwork: first with
   placeholder art, then by deriving an alpha channel from the catalog photo's
   luminance. The luminance key worked on high-contrast lettering and fell over
   on everything else — photographic designs came out bleached, and dark-on-dark
   artwork collapsed into an opaque rectangle. It was a convincing demo exactly
   until it wasn't, which is the worst property a mockup can have.

   So v3 stops forcing it. The lightbox's left side shows the catalog
   photograph, full stop — the one honest, high-quality asset that exists
   today. Shirt colour, placement and size are still real controls that drive
   real pricing and real cart lines; they're just no longer pretending to
   render a preview they can't. When the designer supplies transparent PNGs
   (see README), a live preview becomes worth building properly.
   ============================================================================ */
(function () {
  "use strict";

  var DATA = window.KCMPS_STORE_DATA;
  var STORE = window.KCMPS_STORE;
  var TEXT = window.KCMPS_TEXT;
  var mount = document.getElementById("design-wizard");
  if (!DATA || !STORE || !mount) return;

  // products.js paths are site-root-relative and this page is not at the site
  // root. The rebased path also travels into the cart line's designRef so the
  // real drawer's thumbnail resolves.
  var SITE = "../../website/";
  var APPAREL_LEAVES = ["dtf", "subli", "hotmelt"];

  var peso = function (n) {
    return DATA.currency + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ---------- design pool, from the real catalog ----------
     Every apparel leaf merged into one list. The shopper never picks a
     process; the design's own leaf decides it. Only products that already opt
     into a picker (Array.isArray(images)) contribute — same test store.js's
     design-manifest merge uses. */
  var POOL = [];
  DATA.products.forEach(function (p) {
    if (APPAREL_LEAVES.indexOf(p.leaf) === -1) return;
    if (!Array.isArray(p.images) || !p.images.length) return;
    p.images.forEach(function (src) {
      POOL.push({ id: p.id + "#" + POOL.length, product: p, src: SITE + src, name: TEXT.titleFromFilename(src) });
    });
  });

  var S = {
    obj: null, design: null,
    withShirt: false, color: null, custom: "#7b1e28",
    placement: "front", sizeIdx: 0, qty: 1
  };

  function colorHex() { return S.color === "black" ? "#141414" : S.color === "white" ? "#f4f4f4" : S.custom; }
  function colorLabel() { return S.color === "black" ? "Black" : S.color === "white" ? "White" : "Custom (" + S.custom.toUpperCase() + ")"; }
  function isDark(hex) {
    var c = hex.replace("#", "");
    var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.62;
  }
  /* Sublimation physically can't print on a dark garment. Only meaningful once
     a shirt is actually being bought AND a colour chosen — a bare transfer has
     no garment to be incompatible with. */
  function designAllowed(d) {
    if (d.product.leaf !== "subli") return true;
    if (!S.withShirt || !S.color) return true;
    return !isDark(colorHex());
  }

  /* ============================================================
     THE DESIGN PANEL  (header + chips + grid)
     ============================================================ */
  var gridEl, countEl, chipsEl;

  function buildPanel() {
    mount.innerHTML = "";

    var head = el("div", "dw-head");
    head.appendChild(el("span", "card-kicker", "Design"));
    head.appendChild(el("h2", "dw-title", "Pick a design, we'll press it"));
    head.appendChild(el("p", "dw-sub",
      "Ready-to-press graphics on the shirt you choose. Bulk pricing kicks in " +
      "automatically at 10+ pcs — the same ladder the shop cards use."));
    mount.appendChild(head);

    var strip = el("div", "dw-strip");
    chipsEl = el("div", "dw-chips");
    countEl = el("span", "tag tag-neutral dw-count");
    strip.appendChild(chipsEl); strip.appendChild(countEl);
    mount.appendChild(strip);

    gridEl = el("div", "dw-grid");
    mount.appendChild(gridEl);

    renderGrid();
  }

  function renderGrid() {
    gridEl.innerHTML = "";
    POOL.forEach(function (d) {
      var ok = designAllowed(d);
      var t = el("button", "dw-tile" + (ok ? "" : " is-unavailable"));
      t.type = "button";

      var wrap = el("div", "dw-tile-img");
      if (!ok) wrap.appendChild(el("span", "dw-tile-flag", "Light shirts only"));
      var img = new Image();
      img.src = d.src; img.alt = d.name; img.loading = "lazy";
      wrap.appendChild(img);

      var meta = el("div", "dw-tile-meta");
      meta.appendChild(el("strong", null, d.name));
      meta.appendChild(el("span", null, "From " + peso(d.product.variants[0].price) + " · " + d.product.name));

      t.appendChild(wrap); t.appendChild(meta);
      t.addEventListener("click", function () {
        if (ok) openLightbox(d);
        else toast("This design is sublimation — it only works on light shirts.");
      });
      gridEl.appendChild(t);
    });

    var avail = POOL.filter(designAllowed).length;
    countEl.textContent = avail === POOL.length
      ? POOL.length + " designs" : avail + " of " + POOL.length + " designs available";
    renderChips();
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    var objChip = el("span", "dw-chip");
    objChip.appendChild(el("span", null, "👕 Apparel"));
    var change = el("button", null, "change");
    change.type = "button";
    change.addEventListener("click", openObj);
    objChip.appendChild(change);
    chipsEl.appendChild(objChip);

    // Only shown once a shirt is actually part of the order — v2 showed a
    // colour chip while the shirt toggle was off, which read as "you have
    // chosen a white shirt" when nothing of the sort had happened.
    if (S.withShirt && S.color) {
      var col = el("span", "dw-chip");
      var sw = el("span", "sw"); sw.style.background = colorHex();
      col.appendChild(sw);
      col.appendChild(document.createTextNode(colorLabel()));
      chipsEl.appendChild(col);
    }
  }

  /* ============================================================
     OBJECT PICKER
     ============================================================ */
  var OBJECTS = [
    { key: "apparel",  icon: "👕", label: "Apparel",  sub: "Shirts, hoodies, jerseys",  live: true },
    { key: "3dprint",  icon: "🧩", label: "3D Print", sub: "Figures, props, parts",     live: false },
    { key: "souvenir", icon: "🎁", label: "Souvenir", sub: "Mugs, tumblers, giveaways", live: false }
  ];
  var objBackdrop;
  function buildObj() {
    objBackdrop = el("div", "dw-backdrop");
    objBackdrop.setAttribute("aria-hidden", "true");
    var sheet = el("div", "dw-sheet card");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.appendChild(el("h2", "card-title", "What are we making?"));
    sheet.appendChild(el("p", "card-body",
      "Pick what you want it printed on — we'll quietly pick the right process for you."));

    var grid = el("div", "dw-obj-grid");
    OBJECTS.forEach(function (o) {
      var b = el("button", "dw-obj"); b.type = "button"; b.disabled = !o.live;
      b.appendChild(el("span", "ico", o.icon));
      b.appendChild(el("strong", null, o.label));
      b.appendChild(el("span", "sub", o.sub));
      if (!o.live) b.appendChild(el("span", "tag tag-neutral dw-soon", "Request a quote"));
      else b.addEventListener("click", function () { S.obj = o.key; closeObj(); });
      grid.appendChild(b);
    });
    sheet.appendChild(grid);

    var browse = el("button", "btn btn-ghost dw-browse", "Just browse everything →");
    browse.type = "button";
    browse.addEventListener("click", function () { S.obj = "apparel"; closeObj(); });
    sheet.appendChild(browse);

    objBackdrop.appendChild(sheet);
    document.body.appendChild(objBackdrop);
    objBackdrop.addEventListener("click", function (e) { if (e.target === objBackdrop) closeObj(); });
  }
  function openObj() { objBackdrop.classList.add("is-open"); objBackdrop.setAttribute("aria-hidden", "false"); }
  function closeObj() { objBackdrop.classList.remove("is-open"); objBackdrop.setAttribute("aria-hidden", "true"); }

  /* ============================================================
     LIGHTBOX — left: the catalog photo. right: the real controls.
     ============================================================ */
  var lb, lbEls = {};
  function buildLightbox() {
    lb = el("div", "dw-backdrop");
    lb.setAttribute("aria-hidden", "true");
    lb.innerHTML =
      '<div class="dw-lb" role="dialog" aria-modal="true">' +
        '<div class="dw-lb-stage">' +
          '<button type="button" class="dw-lb-close" aria-label="Close">&times;</button>' +
          '<img class="dw-lb-photo" alt="" />' +
        '</div>' +
        '<div class="dw-lb-panel">' +
          '<span class="card-kicker dw-kicker"></span>' +
          '<h3 class="dw-lb-title"></h3>' +
          '<p class="dw-lb-blurb"></p>' +
          '<div class="field"><label>Shirt</label><div class="shirt-row dw-shirt"></div></div>' +
          '<div class="field"><label>Placement</label>' +
            '<div class="seg dw-seg dw-place" role="group" aria-label="Placement">' +
              '<button type="button" class="seg-opt is-on" data-place="front">Front</button>' +
              '<button type="button" class="seg-opt" data-place="back">Back</button>' +
              '<button type="button" class="seg-opt" data-place="both">Both</button>' +
            '</div><p class="dw-note dw-place-note" hidden></p></div>' +
          '<div class="field"><label>Print size</label>' +
            '<div class="seg dw-seg dw-sizes" role="group" aria-label="Print size"></div>' +
            '<p class="dw-note dw-size-note" hidden></p></div>' +
          '<div class="field"><label>Quantity</label>' +
            '<div class="qty-stepper dw-qty">' +
              '<button type="button" class="dw-minus" aria-label="Decrease quantity">−</button>' +
              '<input class="qval dw-qval" type="number" min="1" value="1" inputmode="numeric" />' +
              '<button type="button" class="dw-plus" aria-label="Increase quantity">+</button>' +
            '</div><p class="dw-bulk" hidden></p></div>' +
          '<p class="dw-note dw-note-warn dw-guard" hidden></p>' +
          '<div class="dw-lb-foot">' +
            '<div class="dw-price"></div>' +
            '<button type="button" class="btn btn-primary dw-add">Add to cart</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(lb);

    ["photo", "kicker", "title", "blurb", "shirt", "place", "place-note", "sizes",
     "size-note", "qty", "qval", "bulk", "guard", "price", "add"].forEach(function (k) {
      lbEls[k] = lb.querySelector(".dw-lb-" + k) || lb.querySelector(".dw-" + k);
    });

    lb.querySelector(".dw-lb-close").addEventListener("click", closeLightbox);
    lb.addEventListener("click", function (e) { if (e.target === lb) closeLightbox(); });

    lbEls.place.addEventListener("click", onPlacement);
    lb.querySelector(".dw-plus").addEventListener("click", function () { requestQty(S.qty + 1); });
    lb.querySelector(".dw-minus").addEventListener("click", function () { requestQty(S.qty - 1); });
    lbEls.qval.addEventListener("blur", function () { requestQty(parseInt(lbEls.qval.value || "1", 10)); });
    lbEls.qval.addEventListener("keydown", function (e) { if (e.key === "Enter") e.target.blur(); });
    lbEls.add.addEventListener("click", addToCart);
  }

  function openLightbox(d) {
    S.design = d;
    S.placement = "front"; S.sizeIdx = 0; S.qty = 1;

    lbEls.photo.src = d.src; lbEls.photo.alt = d.name;
    lbEls.kicker.textContent = d.product.kicker || "Pre-made";
    lbEls.title.textContent = d.name;
    lbEls.blurb.textContent = d.product.blurb || "";
    lbEls.qval.value = 1;
    lbEls["size-note"].hidden = true;
    lbEls["place-note"].hidden = true;

    buildShirtRow(); buildSizes(); syncPlacement(); syncGuard(); refresh();
    lb.classList.add("is-open"); lb.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() { lb.classList.remove("is-open"); lb.setAttribute("aria-hidden", "true"); }

  /* ---------- shirt toggle + colour picks ----------
     Deployed markup and class names, so it behaves exactly like the shop
     card's block — including the two-step custom pick (the swatch OPENS the
     panel; only "Use this color" commits). */
  var COLOR_CHOICES = [
    { key: "black",  label: "Black",  swatch: "#111111" },
    { key: "white",  label: "White",  swatch: "#ffffff" },
    { key: "custom", label: "Custom", swatch: null }
  ];
  function buildShirtRow() {
    var row = lbEls.shirt;
    row.innerHTML = "";

    var tog = el("label", "shirt-toggle");
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = S.withShirt;
    tog.appendChild(cb); tog.appendChild(el("span", null, DATA.shirtAddon.label));
    row.appendChild(tog);

    var opts = el("div", "shirt-color-opts" + (S.withShirt ? "" : " is-disabled"));
    opts.setAttribute("role", "group");
    opts.setAttribute("aria-label", "Shirt color");

    var panel = el("div", "shirt-color-custom-panel");
    panel.style.display = "none";
    var cin = document.createElement("input");
    cin.type = "color"; cin.className = "shirt-color-custom-input"; cin.value = S.custom;
    cin.setAttribute("aria-label", "Pick custom shirt color");
    var chex = el("span", "shirt-color-custom-hex", S.custom.toUpperCase());
    var confirm = el("button", "btn btn-secondary shirt-color-confirm", "Use this color");
    confirm.type = "button";
    cin.addEventListener("input", function () { S.custom = cin.value; chex.textContent = S.custom.toUpperCase(); });
    confirm.addEventListener("click", function () { S.color = "custom"; afterColorChange(); });
    panel.appendChild(cin); panel.appendChild(chex); panel.appendChild(confirm);

    var disclaimer = el("p", "shirt-color-disclaimer",
      "We'll do our best to match the selected color, subject to availability.");
    disclaimer.style.display = S.withShirt && S.color === "custom" ? "" : "none";

    COLOR_CHOICES.forEach(function (c) {
      // No colour is selected until the shopper picks one. v2 defaulted to
      // black and kept the pick highlighted while the toggle was off, so an
      // unchecked row still showed a selected swatch.
      var selected = S.withShirt && S.color === c.key;
      var b = el("button", "shirt-color-pick" + (selected ? " is-selected" : ""));
      b.type = "button"; b.disabled = !S.withShirt;
      b.setAttribute("aria-pressed", selected ? "true" : "false");

      var sw = el("span", "shirt-color-swatch" + (c.key === "custom" ? " is-custom" : ""));
      if (c.swatch) sw.style.background = c.swatch;
      else if (selected) sw.style.background = S.custom;

      b.appendChild(sw);
      b.appendChild(el("span", "shirt-color-label",
        c.key === "custom" && selected ? "Custom (" + S.custom.toUpperCase() + ")" : c.label));

      b.addEventListener("click", function () {
        if (!S.withShirt) return;
        if (c.key === "custom") { panel.style.display = panel.style.display === "none" ? "" : "none"; return; }
        panel.style.display = "none";
        S.color = c.key; afterColorChange();
      });
      opts.appendChild(b);
    });

    opts.appendChild(disclaimer);
    opts.appendChild(panel);
    row.appendChild(opts);

    cb.addEventListener("change", function () {
      S.withShirt = cb.checked;
      if (!S.withShirt) S.color = null;          // unchecking clears the pick
      else if (!S.color) S.color = "black";      // checking defaults to black
      afterColorChange();
    });
  }
  function afterColorChange() { buildShirtRow(); syncGuard(); refresh(); renderGrid(); }

  function syncGuard() {
    var g = lbEls.guard;
    var blocked = S.design && !designAllowed(S.design);
    lbEls.add.disabled = !!blocked;
    if (!blocked) { g.hidden = true; return; }
    g.hidden = false; g.innerHTML = "";
    g.appendChild(document.createTextNode("This design is sublimation — it can't be printed on a dark shirt. "));
    var fix = el("a", null, "Switch to white"); fix.href = "#";
    fix.addEventListener("click", function (e) { e.preventDefault(); S.color = "white"; afterColorChange(); });
    g.appendChild(fix);
    g.appendChild(document.createTextNode(" or pick another design."));
  }

  function buildSizes() {
    lbEls.sizes.innerHTML = "";
    S.design.product.variants.forEach(function (v, i) {
      var b = el("button", "seg-opt" + (S.sizeIdx === i ? " is-on" : ""), v.label);
      b.type = "button";
      b.addEventListener("click", function () {
        S.sizeIdx = i; buildSizes(); refresh();
        lbEls["size-note"].hidden = true;   // an explicit pick overrides the auto-bump
      });
      lbEls.sizes.appendChild(b);
    });
  }

  function onPlacement(e) {
    var b = e.target.closest("button[data-place]");
    if (!b) return;
    var prev = S.placement;
    S.placement = b.dataset.place;

    var last = S.design.product.variants.length - 1;
    if (S.placement !== "front" && prev === "front" && S.sizeIdx < last) {
      S.sizeIdx = last; buildSizes();
      var n = lbEls["size-note"];
      n.textContent = "Bumped to " + S.design.product.variants[last].label +
        " — a back print any smaller gets lost. Change it if you want.";
      n.hidden = false;
    }
    var pn = lbEls["place-note"];
    if (S.placement === "both") {
      pn.textContent = "Two transfers on one shirt. The shirt is charged once, on the front line.";
      pn.hidden = false;
    } else { pn.hidden = true; }

    syncPlacement(); refresh();
  }
  function syncPlacement() {
    Array.prototype.forEach.call(lbEls.place.querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.dataset.place === S.placement);
    });
  }

  /* ---------- quantity, through the REAL capacity soft-cap ---------- */
  function requestQty(n) {
    n = Math.max(1, isNaN(n) ? 1 : n);
    var p = S.design.product;
    STORE.requestQty(p.softCap, n, function (final) {
      S.qty = final; lbEls.qval.value = final; refresh();
    }, p.id);
  }

  /* ---------- pricing, off the real ladder ---------- */
  function baseUnit() {
    var p = S.design.product;
    return p.variants[S.sizeIdx].price * (S.placement === "both" ? 2 : 1) +
      (S.withShirt ? DATA.shirtAddon.price : 0);
  }
  function refresh() {
    var p = S.design.product;
    var base = baseUnit();
    var unit = STORE.bulkUnitPrice(base, S.qty, p.bulkTiers);
    var tier = STORE.bulkTier(S.qty, p.bulkTiers);

    lbEls.price.innerHTML = "";
    lbEls.price.appendChild(document.createTextNode(peso(unit * S.qty)));
    lbEls.price.appendChild(el("small", null,
      peso(unit) + " each · " + S.qty + " pc" + (S.qty > 1 ? "s" : "") +
      (S.placement === "both" ? (S.withShirt ? " · 2 transfers, 1 shirt" : " · 2 transfers") : "")));

    var b = lbEls.bulk;
    if (tier) {
      b.hidden = false; b.innerHTML = "";
      b.appendChild(document.createTextNode(
        "Bulk price applied — " + tier.discountPct + "% off at " + tier.minQty + "+ pcs · "));
      b.appendChild(el("s", null, peso(base)));
      b.appendChild(document.createTextNode(" → "));
      b.appendChild(el("b", null, peso(unit)));
      b.appendChild(document.createTextNode(" each"));
    } else { b.hidden = true; }
  }

  /* ---------- add to cart ----------
     "Both" = two transfers on ONE shirt: the shirt add-on is charged once, on
     the front line. Two lines rather than one so the presser can't misread it,
     and the dedupe key carries the placement so a front run and a back run
     can't silently merge. */
  function addToCart() {
    var p = S.design.product;
    var v = p.variants[S.sizeIdx];
    var lines = S.placement === "both" ? ["front", "back"] : [S.placement];

    lines.forEach(function (place, idx) {
      var carriesShirt = S.withShirt && idx === 0;
      var base = v.price + (carriesShirt ? DATA.shirtAddon.price : 0);
      var unit = STORE.bulkUnitPrice(base, S.qty, p.bulkTiers);
      var placeLabel = place === "front" ? "Front print" : "Back print";

      STORE.addToCart({
        key: [p.id, v.label, carriesShirt ? "shirt:" + colorLabel() : "plain", S.design.src, place].join("|"),
        id: p.id, name: p.name, leaf: p.leaf, type: "sku",
        variantLabel: v.label + " · " + placeLabel +
          (!carriesShirt && S.placement === "both" ? " · 2nd print on the same shirt" : ""),
        shirt: carriesShirt, shirtColor: carriesShirt ? colorLabel() : null,
        unitPrice: unit, baseUnitPrice: p.bulkTiers ? base : null, qty: S.qty,
        designRef: S.design.src, designName: S.design.name
      });
    });

    closeLightbox();
    STORE.open();
    toast(S.placement === "both" ? "Added as 2 lines — front + back on one shirt." : "Added to cart.");
  }

  /* ---------- toast ---------- */
  var toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) { toastEl = el("div", "dw-toast"); toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-on"); }, 2800);
  }
  window.addEventListener("rnd:blocked-request", function () {
    toast("R&D mockup — outbound API calls are blocked. No order was sent.");
  });

  /* ---------- boot ----------
     The object picker opens on ENTERING the Design subsection, not on page
     load — this is a full site now, and a shopper landing on the hero
     shouldn't be met with a modal about apparel. */
  buildObj();
  buildLightbox();
  buildPanel();

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeLightbox(); closeObj(); }
  });

  var designTab = document.querySelector('[data-tab-target="panel-design"]');
  if (designTab) {
    designTab.addEventListener("click", function () {
      if (!S.obj) setTimeout(openObj, 220);   // let the panel transition land first
    });
  }
})();
