/* ============================================================================
   KCMPS R&D — Design subsection wizard, v2

   v1 (../design-wizard) was a self-contained mockup with its own fake catalog,
   its own pricing constants and its own cart. v2 keeps v1's LAYOUT and flow but
   throws all three away and drives the same presentation off the real
   front-end:

     catalog   window.KCMPS_STORE_DATA        (website/products.js, verbatim)
     pricing   KCMPS_STORE.bulkTier / bulkUnitPrice
     capacity  KCMPS_STORE.requestQty          (real soft-cap + ceiling popup)
     cart      KCMPS_STORE.addToCart / open    (real self-injected drawer)
     styling   website/styles.css              (real tokens and components)

   Nothing here reimplements a number that products.js already states. If the
   owner edits a price, a bulk tier or a softCap, this mockup moves with it.

   THE ONE THING THAT IS STILL FAKE — and why:
   the composite shirt preview. It needs transparent transfer art on a blank to
   recolour and re-place a print. The real catalog images are PHOTOGRAPHS of
   finished shirts on a wood background, which cannot be recoloured. So the
   composite reuses v1's placeholder transfers and says so on screen, and the
   default preview is the real catalog photo. Do not quietly drop that caption.
   ============================================================================ */
(function () {
  "use strict";

  var DATA = window.KCMPS_STORE_DATA;
  var STORE = window.KCMPS_STORE;
  var TEXT = window.KCMPS_TEXT;
  if (!DATA || !STORE) { alert("R&D mockup: products.js / store.js failed to load."); return; }

  /* products.js paths are site-root-relative ("assets/design/..."), and this
     page is not at the site root — every catalog image has to be re-based.
     This also travels into the cart line's designRef so the REAL drawer's
     thumbnail resolves too. */
  var SITE = "../../website/";
  var V1 = "../design-wizard/assets/";        // placeholder shirt blanks + transfers

  var APPAREL_LEAVES = ["dtf", "subli", "hotmelt"];
  var PLACEHOLDER_COUNT = 8;
  var PRINT_AREA = {                           // % of the shirt box
    front: { left: 32, top: 31, width: 36, height: 26 },
    back:  { left: 25, top: 26, width: 50, height: 38 }
  };
  var SIZE_SCALE = [0.62, 0.82, 1];            // print scale per variant index

  var $ = function (id) { return document.getElementById(id); };
  var peso = function (n) {
    return DATA.currency + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  /* ---------- design pool, built from the real catalog ----------
     One entry per image on every apparel product that opts into a picker
     (Array.isArray(p.images)) — the same opt-in test store.js's design-manifest
     merge uses, so a product with no design concept can't grow one here. */
  var POOL = [];
  DATA.products.forEach(function (p) {
    if (APPAREL_LEAVES.indexOf(p.leaf) === -1) return;
    if (!Array.isArray(p.images) || !p.images.length) return;
    p.images.forEach(function (src, i) {
      POOL.push({
        id: p.id + "#" + i,
        product: p,
        src: SITE + src,
        name: TEXT.titleFromFilename(src),
        placeholder: V1 + "design-0" + ((POOL.length % PLACEHOLDER_COUNT) + 1) + ".png"
      });
    });
  });

  /* ---------- state ---------- */
  var S = {
    obj: null, design: null,
    withShirt: true, color: "black", custom: "#7b1e28",
    placement: "front", sizeIdx: 0, qty: 1,
    view: "front", preview: "photo"
  };

  /* ---------- colour helpers ---------- */
  function colorHex() { return S.color === "black" ? "#141414" : S.color === "white" ? "#f4f4f4" : S.custom; }
  function colorLabel() { return S.color === "black" ? "Black" : S.color === "white" ? "White" : "Custom (" + S.custom.toUpperCase() + ")"; }
  function isDark(hex) {
    var c = hex.replace("#", "");
    var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.62;
  }
  /* THE GUARD, carried over from v1: sublimation physically cannot print on a
     dark garment. Reads the real `leaf`, not a hand-kept process list. */
  function designAllowed(d) {
    if (d.product.leaf !== "subli") return true;
    return !S.withShirt || !isDark(colorHex());
  }

  /* ---------- toast ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $("wiz-toast");
    t.textContent = msg; t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 2800);
  }
  window.addEventListener("rnd:blocked-request", function () {
    toast("R&D mockup — outbound API calls are blocked. No order was sent.");
  });

  /* ============================================================
     GRID
     ============================================================ */
  function renderGrid() {
    var g = $("wiz-grid");
    g.innerHTML = "";
    POOL.forEach(function (d) {
      var ok = designAllowed(d);
      var t = document.createElement("button");
      t.type = "button";
      t.className = "wiz-tile" + (ok ? "" : " is-unavailable");

      var wrap = document.createElement("div"); wrap.className = "wiz-tile-img";
      if (!ok) {
        var flag = document.createElement("span");
        flag.className = "wiz-tile-flag"; flag.textContent = "Light shirts only";
        wrap.appendChild(flag);
      }
      var img = document.createElement("img");
      img.src = d.src; img.alt = d.name; img.loading = "lazy";
      wrap.appendChild(img);

      var meta = document.createElement("div"); meta.className = "wiz-tile-meta";
      var nm = document.createElement("strong"); nm.textContent = d.name;
      var sub = document.createElement("span");
      sub.textContent = "From " + peso(d.product.variants[0].price) + " · " + d.product.name;
      meta.appendChild(nm); meta.appendChild(sub);

      t.appendChild(wrap); t.appendChild(meta);
      t.addEventListener("click", function () {
        if (ok) openLightbox(d);
        else toast("This design is sublimation — it only works on light shirts.");
      });
      g.appendChild(t);
    });

    var avail = POOL.filter(designAllowed).length;
    $("wiz-count").textContent = avail === POOL.length
      ? POOL.length + " designs"
      : avail + " of " + POOL.length + " designs available";
    renderChips();
  }

  function renderChips() {
    var c = $("wiz-chips");
    c.innerHTML = "";
    if (!S.obj) return;

    var objChip = document.createElement("span");
    objChip.className = "wiz-chip";
    objChip.innerHTML = "<span>👕 Apparel</span> ";
    var change = document.createElement("button");
    change.type = "button"; change.textContent = "change";
    change.addEventListener("click", openObj);
    objChip.appendChild(change);
    c.appendChild(objChip);

    if (S.withShirt) {
      var col = document.createElement("span");
      col.className = "wiz-chip";
      var sw = document.createElement("span");
      sw.className = "sw"; sw.style.background = colorHex();
      col.appendChild(sw);
      col.appendChild(document.createTextNode(colorLabel()));
      c.appendChild(col);
    }
  }

  /* ============================================================
     OBJECT PICKER
     ============================================================ */
  var OBJECTS = [
    { key: "apparel",  icon: "👕", label: "Apparel",  sub: "Shirts, hoodies, jerseys", live: true },
    { key: "3dprint",  icon: "🧩", label: "3D Print", sub: "Figures, props, parts",    live: false },
    { key: "souvenir", icon: "🎁", label: "Souvenir", sub: "Mugs, tumblers, giveaways", live: false }
  ];
  function buildObjects() {
    var g = $("obj-grid");
    g.innerHTML = "";
    OBJECTS.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "obj"; b.disabled = !o.live;
      b.innerHTML = '<span class="ico">' + o.icon + "</span><strong></strong><span class=\"sub\"></span>";
      b.querySelector("strong").textContent = o.label;
      b.querySelector(".sub").textContent = o.sub;
      if (!o.live) {
        // The catalog already marks these leaves comingSoon — reuse that fact
        // rather than restating "soon" as a wizard-local constant.
        var tag = document.createElement("span");
        tag.className = "tag tag-neutral"; tag.style.marginTop = "9px";
        tag.textContent = "Request a quote";
        b.appendChild(tag);
      } else {
        b.addEventListener("click", function () {
          S.obj = o.key; closeObj(); renderGrid();
          toast("Showing apparel designs — DTF, sublimation and hotmelt, merged.");
        });
      }
      g.appendChild(b);
    });
  }
  function openObj() { $("obj-backdrop").classList.add("is-open"); $("obj-backdrop").setAttribute("aria-hidden", "false"); }
  function closeObj() { $("obj-backdrop").classList.remove("is-open"); $("obj-backdrop").setAttribute("aria-hidden", "true"); }
  $("obj-browse").addEventListener("click", function () { S.obj = "apparel"; closeObj(); renderGrid(); });

  /* ============================================================
     LIGHTBOX
     ============================================================ */
  function openLightbox(d) {
    S.design = d;
    S.placement = "front"; S.sizeIdx = 0; S.qty = 1; S.view = "front"; S.preview = "photo";

    $("lb-name").textContent = d.name;
    $("lb-kicker").textContent = d.product.kicker || "Pre-made";
    $("lb-blurb").textContent = d.product.blurb || "";
    $("lb-photo-img").src = d.src;
    $("lb-photo-img").alt = d.name;
    $("lb-qty").value = 1;
    $("lb-size-note").hidden = true;
    $("lb-place-note").hidden = true;

    buildShirtRow(); buildSizes(); syncPlacement(); syncPreview(); syncShirt(); syncGuard(); refresh();
    $("lb-backdrop").classList.add("is-open");
    $("lb-backdrop").setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    $("lb-backdrop").classList.remove("is-open");
    $("lb-backdrop").setAttribute("aria-hidden", "true");
  }
  $("lb-close").addEventListener("click", closeLightbox);
  $("lb-backdrop").addEventListener("click", function (e) { if (e.target.id === "lb-backdrop") closeLightbox(); });

  /* ---------- shirt toggle + colour picks ----------
     Rebuilt with the deployed markup and class names (.shirt-row /
     .shirt-toggle / .shirt-color-opts / .shirt-color-pick / the two-step
     .shirt-color-custom-panel), so this behaves and looks exactly like the
     shop card's block — including the trap its comment warns about: the custom
     swatch OPENS the panel, and only "Use this color" commits. */
  var COLOR_CHOICES = [
    { key: "black",  label: "Black",  swatch: "#111111" },
    { key: "white",  label: "White",  swatch: "#ffffff" },
    { key: "custom", label: "Custom", swatch: null }
  ];
  function buildShirtRow() {
    var row = $("lb-shirt-row");
    row.innerHTML = "";

    var tog = document.createElement("label"); tog.className = "shirt-toggle";
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = S.withShirt;
    var txt = document.createElement("span"); txt.textContent = DATA.shirtAddon.label;
    tog.appendChild(cb); tog.appendChild(txt); row.appendChild(tog);

    var opts = document.createElement("div");
    opts.className = "shirt-color-opts" + (S.withShirt ? "" : " is-disabled");
    opts.setAttribute("role", "group"); opts.setAttribute("aria-label", "Shirt color");

    var panel = document.createElement("div");
    panel.className = "shirt-color-custom-panel"; panel.style.display = "none";
    var cin = document.createElement("input");
    cin.type = "color"; cin.className = "shirt-color-custom-input"; cin.value = S.custom;
    cin.setAttribute("aria-label", "Pick custom shirt color");
    var chex = document.createElement("span");
    chex.className = "shirt-color-custom-hex"; chex.textContent = S.custom.toUpperCase();
    var confirm = document.createElement("button");
    confirm.type = "button"; confirm.className = "btn btn-secondary shirt-color-confirm";
    confirm.textContent = "Use this color";
    cin.addEventListener("input", function () { S.custom = cin.value; chex.textContent = S.custom.toUpperCase(); });
    confirm.addEventListener("click", function () { S.color = "custom"; panel.style.display = "none"; afterColorChange(); });
    panel.appendChild(cin); panel.appendChild(chex); panel.appendChild(confirm);

    var disclaimer = document.createElement("p");
    disclaimer.className = "shirt-color-disclaimer";
    disclaimer.textContent = "We'll do our best to match the selected color, subject to availability.";
    disclaimer.style.display = S.color === "custom" && S.withShirt ? "" : "none";

    COLOR_CHOICES.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "shirt-color-pick" + (S.color === c.key ? " is-selected" : "");
      b.disabled = !S.withShirt;
      b.setAttribute("aria-pressed", S.color === c.key ? "true" : "false");

      var sw = document.createElement("span");
      sw.className = "shirt-color-swatch" + (c.key === "custom" ? " is-custom" : "");
      if (c.swatch) sw.style.background = c.swatch;
      else if (S.color === "custom") sw.style.background = S.custom;

      var lbl = document.createElement("span");
      lbl.className = "shirt-color-label";
      lbl.textContent = c.key === "custom" && S.color === "custom"
        ? "Custom (" + S.custom.toUpperCase() + ")" : c.label;

      b.appendChild(sw); b.appendChild(lbl);
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
      buildShirtRow(); syncShirt(); syncGuard(); refresh(); renderGrid();
    });
  }
  function afterColorChange() {
    buildShirtRow(); syncShirt(); syncGuard(); refresh(); renderGrid();
  }

  /* The sublimation-on-dark guard, in the lightbox. Blocks the add rather than
     silently pricing something production can't make. */
  function syncGuard() {
    var g = $("lb-guard");
    var blocked = S.design && !designAllowed(S.design);
    $("lb-add").disabled = !!blocked;
    if (!blocked) { g.hidden = true; return; }
    g.hidden = false;
    g.innerHTML = "";
    g.appendChild(document.createTextNode("This design is sublimation — it can't be printed on a dark shirt. "));
    var fix = document.createElement("a");
    fix.href = "#"; fix.textContent = "Switch to white";
    fix.addEventListener("click", function (e) { e.preventDefault(); S.color = "white"; afterColorChange(); });
    g.appendChild(fix);
    g.appendChild(document.createTextNode(" or pick another design."));
  }

  /* ---------- sizes (real variants) ---------- */
  function buildSizes() {
    var wrap = $("lb-sizes");
    wrap.innerHTML = "";
    S.design.product.variants.forEach(function (v, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "seg-opt" + (S.sizeIdx === i ? " is-on" : "");
      b.textContent = v.label;
      b.addEventListener("click", function () {
        S.sizeIdx = i; buildSizes(); syncShirt(); refresh();
        $("lb-size-note").hidden = true;   // an explicit pick overrides the A3 bump
      });
      wrap.appendChild(b);
    });
  }

  /* ---------- placement ---------- */
  $("lb-placement").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-place]");
    if (!b) return;
    var prev = S.placement;
    S.placement = b.dataset.place;

    // Back prints default to the largest size — stated in the UI, not done
    // silently, and overridable by picking a size afterwards.
    var last = S.design.product.variants.length - 1;
    if (S.placement !== "front" && prev === "front" && S.sizeIdx < last) {
      S.sizeIdx = last; buildSizes();
      var n = $("lb-size-note");
      n.textContent = "Bumped to " + S.design.product.variants[last].label +
        " — a back print any smaller gets lost. Change it if you want.";
      n.hidden = false;
    }
    var note = $("lb-place-note");
    if (S.placement === "both") {
      note.textContent = "Two transfers on one shirt. The shirt is charged once, on the front line.";
      note.hidden = false;
    } else { note.hidden = true; }

    S.view = S.placement === "back" ? "back" : "front";
    syncPlacement(); syncShirt(); refresh();
  });
  function syncPlacement() {
    Array.prototype.forEach.call($("lb-placement").querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.dataset.place === S.placement);
    });
    var vs = $("lb-view-seg");
    vs.hidden = !(S.preview === "composite" && S.placement === "both");
    Array.prototype.forEach.call(vs.querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.dataset.view === S.view);
    });
  }
  $("lb-view-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-view]");
    if (!b) return;
    S.view = b.dataset.view; syncPlacement(); syncShirt();
  });

  /* ---------- preview toggle (photo ⇄ composite) ---------- */
  $("lb-preview-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-preview]");
    if (!b) return;
    S.preview = b.dataset.preview;
    syncPreview(); syncPlacement(); syncShirt();
  });
  function syncPreview() {
    Array.prototype.forEach.call($("lb-preview-seg").querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.dataset.preview === S.preview);
    });
    $("lb-photo").hidden = S.preview !== "photo";
    $("lb-composite").hidden = S.preview !== "composite";
  }

  /* ---------- deriving a transfer from a catalog photo ----------
     There is no transparent transfer artwork (see README, "THE ASSET GAP"), so
     the composite builds one from the photo we do have.

     A blend mode alone doesn't work: `screen` knocks the dark garment out but
     also makes white ink vanish on a white shirt, and `multiply` keeps the
     garment as an opaque rectangle. So instead we synthesise a real ALPHA
     channel in a canvas — alpha = the pixel's luminance, contrast-crushed so
     the fabric goes fully transparent and the ink stays fully opaque. The
     result is an actual cut-out that composites correctly onto ANY shirt
     colour, which is what the wizard needs.

     Inverted for `subli`, whose photos are dark ink on light fabric: there the
     DARK pixels are the artwork.

     Honest about what this is: it's a luminance key, so it cannot recover
     mid-tone or photographic artwork, and it softens edges on busy designs.
     Real transparent PNGs from the designer replace it and this whole function
     goes away. Verified offline against the real catalog before shipping. */
  var CONTRAST = 2.5;
  var knockoutCache = {};

  function knockoutSrc(design, back) {
    var src = design.src;
    if (knockoutCache[src]) { back({ forSrc: src, data: knockoutCache[src] }); return; }

    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);

      var invert = design.product.leaf === "subli";
      var d;
      try { d = ctx.getImageData(0, 0, c.width, c.height); }
      catch (e) { back({ forSrc: src, data: src }); return; }   // tainted canvas — fall back to the raw photo

      var px = d.data;
      for (var i = 0; i < px.length; i += 4) {
        var lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        if (invert) lum = 255 - lum;
        var a = (lum - 127.5) * CONTRAST + 127.5;
        px[i + 3] = a < 0 ? 0 : a > 255 ? 255 : a;
      }
      ctx.putImageData(d, 0, 0);

      var url = c.toDataURL("image/png");
      knockoutCache[src] = url;
      back({ forSrc: src, data: url });
    };
    img.onerror = function () { back({ forSrc: src, data: src }); };
    img.src = src;
  }

  function syncShirt() {
    if (S.preview !== "composite" || !S.design) return;
    var back = S.view === "back";
    var mask = V1 + (back ? "shirt-back-mask.png" : "shirt-front-mask.png");

    var el = $("shirt-color");
    // Shirt unchecked = transfer only; show a neutral blank so the stage still
    // communicates placement without implying a garment is included.
    el.style.background = S.withShirt ? colorHex() : "#c9ced8";
    el.style.webkitMaskImage = "url(" + mask + ")"; el.style.maskImage = "url(" + mask + ")";
    el.style.webkitMaskSize = "100% 100%"; el.style.maskSize = "100% 100%";
    $("shirt-shade").src = V1 + (back ? "shirt-back.png" : "shirt-front.png");

    var a = PRINT_AREA[back ? "back" : "front"];
    var scale = SIZE_SCALE[Math.min(S.sizeIdx, SIZE_SCALE.length - 1)];
    var w = a.width * scale, h = a.height * scale;
    var p = $("shirt-print");
    p.style.left = (a.left + (a.width - w) / 2) + "%";
    p.style.top = (a.top + (a.height - h) / 2) + "%";
    p.style.width = w + "%"; p.style.height = h + "%";

    var g = $("print-guide");
    g.style.left = a.left + "%"; g.style.top = a.top + "%";
    g.style.width = a.width + "%"; g.style.height = a.height + "%";

    // The print is the REAL catalog image, background knocked out — see
    // knockoutSrc(). CSS crops into it (object-fit:cover + --print-zoom).
    var pi = $("print-img");
    knockoutSrc(S.design, function (url) {
      // The design may have changed while the image decoded — don't stamp a
      // stale knockout over whatever is on screen now.
      if (S.design && S.design.src === url.forSrc) pi.src = url.data;
    });
  }

  /* ---------- quantity, through the REAL capacity soft-cap ----------
     KCMPS_STORE.requestQty pops the deployed .cap-popup (extra-lead-time copy,
     hard ceiling at 5x) and only calls back with the committed value. Keyed on
     the product id, matching the shop card, so an "I agree" carries between
     them exactly as it does on the live site. Commit-on-blur/Enter only —
     never per keystroke. */
  function requestQty(n) {
    n = Math.max(1, isNaN(n) ? 1 : n);
    var p = S.design.product;
    STORE.requestQty(p.softCap, n, function (final) {
      S.qty = final; $("lb-qty").value = final; refresh();
    }, p.id);
  }
  $("lb-plus").addEventListener("click", function () { requestQty(S.qty + 1); });
  $("lb-minus").addEventListener("click", function () { requestQty(S.qty - 1); });
  $("lb-qty").addEventListener("blur", function () { requestQty(parseInt($("lb-qty").value || "1", 10)); });
  $("lb-qty").addEventListener("keydown", function (e) { if (e.key === "Enter") e.target.blur(); });

  /* ---------- pricing, off the real ladder ---------- */
  function transfers() { return S.placement === "both" ? 2 : 1; }
  function baseUnit() {
    var p = S.design.product;
    return p.variants[S.sizeIdx].price * transfers() + (S.withShirt ? DATA.shirtAddon.price : 0);
  }
  function refresh() {
    var p = S.design.product;
    var base = baseUnit();
    var unit = STORE.bulkUnitPrice(base, S.qty, p.bulkTiers);
    var tier = STORE.bulkTier(S.qty, p.bulkTiers);

    var price = $("lb-price");
    price.innerHTML = "";
    price.appendChild(document.createTextNode(peso(unit * S.qty)));
    var small = document.createElement("small");
    small.textContent = peso(unit) + " each · " + S.qty + " pc" + (S.qty > 1 ? "s" : "") +
      (S.placement === "both" ? " · 2 transfers, 1 shirt" : "");
    price.appendChild(small);

    var b = $("lb-bulk");
    if (tier) {
      b.hidden = false;
      b.innerHTML = "";
      b.appendChild(document.createTextNode(
        "Bulk price applied — " + tier.discountPct + "% off at " + tier.minQty + "+ pcs · "));
      var was = document.createElement("s"); was.textContent = peso(base);
      var now = document.createElement("b"); now.textContent = peso(unit);
      b.appendChild(was); b.appendChild(document.createTextNode(" → ")); b.appendChild(now);
      b.appendChild(document.createTextNode(" each"));
    } else { b.hidden = true; }
  }

  /* ---------- add to cart, through the REAL cart ----------
     "Both" = two transfers on ONE shirt: the shirt add-on is charged once, on
     the front line, and the back line says what it is. Two lines rather than
     one so the presser can't misread it.

     The dedupe key includes the placement — without it a front run and a back
     run collapse into a single line and the wrong side gets printed. This is
     the same key shape store.js's skuCard() builds, plus that placement
     segment, so both paths dedupe consistently. */
  $("lb-add").addEventListener("click", function () {
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
          (carriesShirt ? "" : (S.placement === "both" ? " · 2nd print on the same shirt" : "")),
        shirt: carriesShirt, shirtColor: carriesShirt ? colorLabel() : null,
        unitPrice: unit, baseUnitPrice: p.bulkTiers ? base : null, qty: S.qty,
        designRef: S.design.src, designName: S.design.name
      });
    });

    closeLightbox();
    STORE.open();
    toast(S.placement === "both"
      ? "Added as 2 lines — front + back on one shirt."
      : "Added to cart.");
  });

  /* ---------- misc ---------- */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    closeLightbox(); closeObj();
  });
  $("demo-replay").addEventListener("click", function () {
    S.obj = null; S.color = "black"; S.withShirt = true;
    renderGrid(); openObj();
  });
  $("demo-clear").addEventListener("click", function () {
    // The real cart is real localStorage, shared with the site on this origin.
    try { localStorage.removeItem("kcmps_cart"); } catch (err) { /* ignore */ }
    location.reload();
  });

  /* ---------- boot ---------- */
  buildObjects();
  renderGrid();
  openObj();
})();
