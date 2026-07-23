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

window.KCMPS_STORE_DATA = {
  currency: "₱",

  // The optional add-on offered on apparel/DTF designs: have the transfer
  // heat-pressed onto a shirt for you. Real KCMPS price.
  shirtAddon: { id: "shirt", label: "Press onto a shirt (+₱120)", price: 120 },

  /* Every terminal catalog category ("leaf") that should show a
     "Custom design request" card. `comingSoon:true` adds a small note that
     pre-made designs aren't listed yet (only the custom-request card shows).
     The leaf keys match the tab-panel ids in index.html (panel-<leaf>). */
  leaves: {
    "print-office": {
      customLabel: "Custom print request",
      customBlurb: "Send your file or specs (catalogs, packaging, documents) and we'll quote it. Add to cart now — you only pay once we confirm.",
    },
    "dtf":   { customLabel: "Custom design request", customBlurb: "Have your own artwork? Upload it at checkout. We'll review, quote, and only bill you after you approve." },
    "subli": { comingSoon: true, customLabel: "Custom design request", customBlurb: "Full-color sublimation on light/poly fabrics. Send your design — approved and billed before we print." },
    "hotmelt": { comingSoon: true, customLabel: "Custom design request", customBlurb: "Durable heat-applied vinyl lettering and designs. Tell us what you need and we'll quote it." },
    "3dprint": { comingSoon: true, customLabel: "Custom 3D print request", customBlurb: "PLA/PETG prints for products and mockups. Share your model or idea for a quote." },
    "souvenir": { comingSoon: true, customLabel: "Custom souvenir request", customBlurb: "Keepsakes and giveaways for events and milestones. Describe your event and quantity." },
    "network": { comingSoon: true, customLabel: "Request networking gear", customBlurb: "Routers, cables and accessories. Tell us your setup and we'll source and quote it." },
    "storage": { comingSoon: true, customLabel: "Request custom storage", customBlurb: "Custom-bodied flash drives and SSDs with laser-etched branding. Request a quote." },
    "entertainment": { comingSoon: true, customLabel: "Request a gadget", customBlurb: "Audio, gaming and everyday tech. Tell us what you're after for a quote." },
  },

  /* Priced, buy-now products. Today only DTF pre-made transfers carry fixed
     prices (the real DTF size pricing). `variants` = size choices; `shirtAddon`
     opts the card into the "+ shirt" toggle. `image:null` → CSS placeholder. */
  products: [
    {
      id: "dtf-street-statement",
      leaf: "dtf",
      type: "sku",
      kicker: "Pre-made · DTF",
      name: "Street Statement Print",
      blurb: "Ready-to-press bold graphic transfer. Pick a size — add a shirt and we'll press it for you.",
      image: null,
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
      variants: [
        { label: "2×3 in", price: 50 },
        { label: "A4", price: 80 },
        { label: "A3", price: 120 },
      ],
      shirtAddon: true,
    },
  ],
};
