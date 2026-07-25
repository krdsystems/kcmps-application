/* ============================================================================
   KCMPS — catalog data (single source of truth for the storefront)
   ----------------------------------------------------------------------------
   This is intentionally a plain data literal on `window` so the static site
   needs no build step. It is shaped exactly like a future API response, so the
   migration to a real backend is a one-line swap and NOTHING in store.js /
   index.html changes:

       // today (static):
       window.KCMPS_STORE_DATA = { ...this file... }
       // later (backend): serve the same JSON and replace the literal with —
       fetch('/api/catalog').then(r => r.json()).then(d => { window.KCMPS_STORE_DATA = d; renderCatalog(); })

   PRODUCT TYPES
     - type:'sku'    → fixed, priced, buy now. Renders a buy-card with an
                       optional size selector (`variants`) and an optional
                       "press onto a shirt" add-on. Adds to cart with a real price.
     - custom        → NOT listed as products here. Every catalog leaf ALWAYS
                       gets one "Custom design request" card appended by
                       store.js (see `leaves` below). Custom items add to cart at
                       ₱0 and are billed only AFTER the KCMPS team approves the
                       request in the internal dashboard (future phase).

   OWNER: to add a real priced product, copy an entry in `products` and give it
   a unique `id`, the correct `leaf`, and either a single `price` or `variants`.
   To turn a "coming soon" leaf into a shop, add priced products for that leaf.
   ============================================================================ */

/* Shared filename → display-title convention, used anywhere a design/product
   name is derived from an asset filename (hero carousel, catalog design
   picker cards, cart thumbnails) so the formatting never drifts between
   views. Strips a leading "01-" ordering prefix, the extension, and turns
   kebab/snake/SHOUTY case into Title Case.
   e.g. "01-BLACK PINK SHIRT.jpg" -> "Black Pink Shirt" */
window.KCMPS_TEXT = {
  titleFromFilename: function (path) {
    var base = String(path).split("/").pop().replace(/\.[^./]+$/, "");
    base = base.replace(/^\d+[-_.\s]+/, "");
    base = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return base.replace(/\S+/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  },
};

window.KCMPS_STORE_DATA = {
  currency: "₱",

  // The optional add-on offered on apparel/DTF designs: have the transfer
  // heat-pressed onto a shirt for you. Real KCMPS price.
  shirtAddon: { id: "shirt", label: "Press onto a shirt (+₱120)", price: 120 },

  /* Every terminal catalog category ("leaf") that should show a
     "Custom design request" card. `comingSoon:true` adds a small note that
     pre-made designs aren't listed yet (only the custom-request card shows).
     The leaf keys match the tab-panel ids in index.html (panel-<leaf>).
     `image` is a representative photo for the leaf (shown on its custom-
     request card, and as the fallback thumb for any priced product in this
     leaf that doesn't set its own `image`) — see assets/leaves/. */
  leaves: {
    "print-office": {
      customLabel: "Custom print request",
      customBlurb: "Send your file or specs (catalogs, packaging, documents) and we'll quote it. Add to cart now — you only pay once we confirm.",
      image: "assets/leaves/print-office.jpg",
    },
    "dtf":   { customLabel: "Custom design request", customBlurb: "Have your own artwork? Upload it at checkout. We'll review, quote, and only bill you after you approve.", image: "assets/leaves/dtf.jpg" },
    "subli": { comingSoon: true, customLabel: "Custom design request", customBlurb: "Full-color sublimation on light/poly fabrics. Send your design — approved and billed before we print.", image: "assets/leaves/subli.jpg" },
    "hotmelt": { comingSoon: true, customLabel: "Custom design request", customBlurb: "Durable heat-applied vinyl lettering and designs. Tell us what you need and we'll quote it.", image: "assets/leaves/hotmelt.jpg" },
    "3dprint": { comingSoon: true, customLabel: "Custom 3D print request", customBlurb: "PLA/PETG prints for products and mockups. Share your model or idea for a quote.", image: "assets/leaves/3dprint.jpg" },
    "souvenir": { comingSoon: true, customLabel: "Custom souvenir request", customBlurb: "Keepsakes and giveaways for events and milestones. Describe your event and quantity.", image: "assets/leaves/souvenir.jpg" },
    "network": { comingSoon: true, customLabel: "Request networking gear", customBlurb: "Routers, cables and accessories. Tell us your setup and we'll source and quote it.", image: "assets/leaves/network.jpg" },
    "storage": { comingSoon: true, customLabel: "Request custom storage", customBlurb: "Flash drives and SSDs in the capacity you need. Request a quote.", image: "assets/leaves/storage.jpg" },
  },

  /* Priced, buy-now products. Today only DTF pre-made transfers carry fixed
     prices (the real DTF size pricing). `variants` = size choices; `shirtAddon`
     opts the card into the "+ shirt" toggle. `image:null` → CSS placeholder. */
  products: [
    {
      id: "print-catalogs-booklets",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Catalogs & booklets",
      name: "Catalogs & Booklets",
      blurb: "Saddle-stitch or perfect-bound, laminated or matte. Priced per copy.",
      image: null,
      price: 180,
    },
    {
      id: "print-custom-packaging",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Custom packaging",
      name: "Custom Packaging",
      blurb: "Die-cut boxes and sleeves, brand-ready finishes. Priced per unit.",
      image: null,
      price: 65,
    },
    {
      id: "dtf-street-statement",
      leaf: "dtf",
      type: "sku",
      kicker: "Pre-made · DTF",
      name: "Street Statement Print",
      blurb: "Ready-to-press bold graphic transfer. Pick a size — add a shirt and we'll press it for you.",
      image: null,
      // 20 real designs from the studio's DTF archive — bold character/franchise
      // graphics. See store.js buildGallery()/openLightbox() for how these render.
      images: [
        "assets/design/apparel/dtf/street-statment/01-BLACK PINK SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/02-BRAWLSTAR SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/03-BTS SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/04-BTS SHIRT 1.jpg",
        "assets/design/apparel/dtf/street-statment/05-DISHENYO MOBA ASSASSIN.jpg",
        "assets/design/apparel/dtf/street-statment/06-FEITAN SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/07-GUSION SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/08-MIKU.jpg",
        "assets/design/apparel/dtf/street-statment/09-MIYA SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/10-MOBILE LEGENDS SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/11-native gold shirt.jpg",
        "assets/design/apparel/dtf/street-statment/12-NINGGUANG SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/13-ONE PIECE LUFFY SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/14-ONE PIECE ZORO SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/15-RAIDEN SHOGUN SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/16-RUBIX CUBEZ SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/17-run mario run.jpg",
        "assets/design/apparel/dtf/street-statment/18-SUKUNA ITADORI.jpg",
        "assets/design/apparel/dtf/street-statment/19-TWICE SHIRT 2.jpg",
        "assets/design/apparel/dtf/street-statment/20-WITCH SHIRT.jpg",
      ],
      variants: [
        { label: "2×3 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 120 },
      ],
      shirtAddon: true,
    },
    {
      id: "dtf-logo-transfer",
      leaf: "dtf",
      type: "sku",
      kicker: "Pre-made · DTF",
      name: "Clean Logo Transfer",
      blurb: "Crisp single-logo transfer, great for team shirts and merch. Choose your size.",
      image: null,
      images: [
        "assets/design/apparel/dtf/clean-logo-transfer/01-DETHROSE LORAL.jpg",
        "assets/design/apparel/dtf/clean-logo-transfer/02-dishenyo logo.jpg",
        "assets/design/apparel/dtf/clean-logo-transfer/03-EUGENE SHIRT.jpg",
        "assets/design/apparel/dtf/clean-logo-transfer/04-LEGENDS SHIRT.jpg",
      ],
      variants: [
        { label: "2×3 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 120 },
      ],
      shirtAddon: true,
    },
    {
      id: "dtf-typographic",
      leaf: "dtf",
      type: "sku",
      kicker: "Pre-made · DTF",
      name: "Typographic Quote Print",
      blurb: "Trendy lettered design, ready to press. Add a shirt for a finished, wearable piece.",
      image: null,
      images: [
        "assets/design/apparel/dtf/typographic-quoteprint/01-baybayin BABAERO shirt.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/02-baybayin MAHAL KITA shirt.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/03-baybayin MAHARLIKA shirt.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/04-COUPLE LOVE YOU FOREVER SHIRT.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/05-ELF SHIRT FAFMILY.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/06-kindness.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/07-NEVER STOP HUSTLE.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/08-THE MORE YOU LEARN SHIRT.jpg",
        "assets/design/apparel/dtf/typographic-quoteprint/09-Winner Shirt.jpg",
      ],
      variants: [
        { label: "2×3 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 120 },
      ],
      shirtAddon: true,
    },
  ],
};
