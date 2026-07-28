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
  shirtAddon: { id: "shirt", label: "Press onto a shirt (+₱110)", price: 110 },

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
    "subli": { customLabel: "Custom design request", customBlurb: "Full-color sublimation on light/poly fabrics. Send your design — approved and billed before we print.", image: "assets/leaves/subli.jpg" },
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
      id: "print-custom-packaging",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Custom packaging",
      name: "Custom Packaging",
      blurb: "Die-cut boxes and sleeves, brand-ready finishes. Priced per unit.",
      image: "assets/products/print-custom-packaging.jpg",
      price: 65,
      fulfillmentInput: "file",
    },
    /* --- Print/Office SKU set (2026-07 competitive pricing pass) ---
       Real, priced entries for the 8 most common print/office products,
       researched against Metro Manila small-shop rates and positioned
       slightly above market (not premium) per the founders' call.
       2026-07-28: owner confirmed real prices for binding, stamps, and
       bookmarks (previously quoteOnRequest placeholders) — see
       docs/braindump-2026-07-28-pricing-catalog.md for the source notes.
       `fulfillmentInput` classifies how the job's content/original reaches
       KCMPS: "file" = customer supplies digital content (design/text/logo)
       at or after checkout; "in-person" = the customer must bring/deliver a
       physical original (this cannot be fulfilled from a digital file
       alone); "none" = nothing further needed beyond the SKU itself. See
       store.js's checkout notes placeholder, which reacts to "file". */
    {
      id: "print-bw-document-printing",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Documents",
      name: "Document Printing",
      blurb: "Short bond paper, priced per page — choose black-and-white or full color, both are standard options.",
      image: "assets/products/print-bw-document-printing.jpg",
      price: 4,
      addon: {
        label: "Color",
        options: [
          { label: "B/W (₱4/page)", price: 0 },
          { label: "Colored (₱7/page)", price: 3 },
        ],
      },
      fulfillmentInput: "file",
    },
    {
      id: "print-photocopying",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Photocopying",
      name: "Photocopying (Xerox)",
      blurb: "Black-and-white copies, any size, priced per page.",
      image: "assets/products/print-photocopying.jpg",
      price: 3,
      fulfillmentInput: "in-person",
    },
    {
      id: "print-lamination",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Lamination",
      name: "Lamination",
      blurb: "Glossy lamination, priced by size.",
      image: "assets/products/print-lamination.jpg",
      variants: [
        { label: "ID-size", price: 25 },
        { label: "A4 document", price: 70 },
        { label: "4R photo (class-picture size)", price: 40 },
      ],
      fulfillmentInput: "in-person",
    },
    {
      id: "print-binding",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Binding",
      name: "Spiral / Comb Binding",
      blurb: "Bind-only pricing (does not include printing the pages) — spiral or comb, A5 size, per 90 leaves.",
      image: "assets/products/print-binding.jpg",
      variants: [
        { label: "Bind (per 90 leaves, A5, spiral or comb)", price: 50 },
      ],
      fulfillmentInput: "in-person",
    },
    {
      id: "print-self-inking-stamps",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Stamps",
      name: "Custom Self-Inking Stamps",
      blurb: "Personalized stamps for signatures, dates, and logos. Priced by stamp size.",
      image: "assets/products/print-self-inking-stamps.jpg",
      variants: [
        { label: "33×13mm (up to 3 lines)", price: 100 },
        { label: "32×12mm", price: 130 },
        { label: "10×27mm", price: 120 },
      ],
      fulfillmentInput: "file",
    },
    {
      id: "print-bookmarks",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Bookmarks",
      name: "Custom Bookmarks",
      blurb: "Printed bookmarks for events, giveaways, or personal use.",
      image: "assets/products/print-bookmarks.jpg",
      variants: [
        { label: "Custom bookmark (2 pcs)", price: 35 },
        { label: "Hymnal bookmark (6 pcs)", price: 70 },
      ],
      fulfillmentInput: "file",
    },
    {
      id: "print-business-cards",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Business Cards",
      name: "Business Cards",
      blurb: "Full-color, priced per piece — minimum order of 10 pcs.",
      image: "assets/products/print-business-cards.jpg",
      variants: [
        { label: "Front only (per pc, min. 10 pcs)", price: 7 },
        { label: "Back-to-back / double-sided (per pc, min. 10 pcs)", price: 15 },
      ],
      minQty: 10,
      fulfillmentInput: "file",
    },
    {
      id: "print-stickers-labels",
      leaf: "print-office",
      type: "sku",
      kicker: "Print · Stickers & Labels",
      name: "Stickers & Labels",
      blurb: "Priced per A4 sheet, except decal stickers which are priced per inch.",
      image: "assets/products/print-stickers-labels.jpg",
      variants: [
        { label: "Premium printable vinyl (per A4 sheet)", price: 100 },
        { label: "Paper stickers (per A4 sheet)", price: 45 },
        { label: "Transparent (per A4 sheet)", price: 60 },
        { label: "Decal stickers (per inch)", price: 5 },
      ],
      fulfillmentInput: "file",
    },
    {
      id: "dtf-street-statement",
      leaf: "dtf",
      type: "sku",
      kicker: "Pre-made · DTF",
      name: "Street Statement Print",
      blurb: "Ready-to-press bold graphic transfer. Pick a size — add a shirt and we'll press it for you.",
      image: null,
      // 15 of the studio's original 20 street-statement designs — the ones on
      // dark-fabric mockups, suited to DTF's any-color-garment strength. The
      // other 5 (light-fabric mockups) moved to the subli-street-statement
      // SKU below; see docs/history.md for the DTF/Sublimation reclassification.
      images: [
        "assets/design/apparel/dtf/street-statment/01-BLACK PINK SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/02-BRAWLSTAR SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/03-DISHENYO MOBA ASSASSIN.jpg",
        "assets/design/apparel/dtf/street-statment/04-FEITAN SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/05-GUSION SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/06-MIKU.jpg",
        "assets/design/apparel/dtf/street-statment/07-MIYA SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/08-MOBILE LEGENDS SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/09-native gold shirt.jpg",
        "assets/design/apparel/dtf/street-statment/10-NINGGUANG SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/11-RAIDEN SHOGUN SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/12-RUBIX CUBEZ SHIRT.jpg",
        "assets/design/apparel/dtf/street-statment/13-run mario run.jpg",
        "assets/design/apparel/dtf/street-statment/14-SUKUNA ITADORI.jpg",
        "assets/design/apparel/dtf/street-statment/15-WITCH SHIRT.jpg",
      ],
      variants: [
        { label: "3×5 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 150 },
      ],
      shirtAddon: true,
      fulfillmentInput: "none",
    },
    {
      id: "subli-street-statement",
      leaf: "subli",
      type: "sku",
      kicker: "Pre-made · Sublimation",
      name: "Street Statement Print",
      blurb: "Full-color sublimation print for light-fabric shirts — vivid, photo-real detail with no texture or peel edge.",
      image: null,
      // 5 of the studio's original 20 street-statement designs — the ones on
      // light-fabric mockups, matching sublimation's light/white-garment
      // requirement. 2 of these (both simple text-only layouts) were flagged
      // as genuinely ambiguous during reclassification: light fabric fits
      // sublimation, but the design itself doesn't need sublimation's
      // full-bleed/photographic strength and could equally run as DTF —
      // confirm with production before treating this as final. See
      // docs/history.md for the full split writeup.
      images: [
        "assets/design/apparel/sublimation/street-statment/01-BTS SHIRT.jpg",
        "assets/design/apparel/sublimation/street-statment/02-BTS SHIRT 1.jpg",
        "assets/design/apparel/sublimation/street-statment/03-ONE PIECE LUFFY SHIRT.jpg",
        "assets/design/apparel/sublimation/street-statment/04-ONE PIECE ZORO SHIRT.jpg",
        "assets/design/apparel/sublimation/street-statment/05-TWICE SHIRT 2.jpg",
      ],
      variants: [
        { label: "3×5 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 150 },
      ],
      shirtAddon: true,
      fulfillmentInput: "none",
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
        { label: "3×5 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 150 },
      ],
      shirtAddon: true,
      fulfillmentInput: "none",
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
        { label: "3×5 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 150 },
      ],
      shirtAddon: true,
      fulfillmentInput: "none",
    },
  ],
};
