# KCMPS — Kaalyados Creatives Merchandise and Printing Services

The marketing site and storefront foundation for KCMPS, a Manila-based print-and-hardware
studio: custom apparel printing (DTF/Subli/Hotmelt), design services, and merchandise, moving
toward digital ordering with authenticated accounts and a cart.

For the full build log (every structural change, mistakes made, and what fixed them) see
[`docs/history.md`](docs/history.md). This file covers current state only: what's where, how
to run it, and how to edit it.

## Repository layout

**`website/` is the only folder that gets deployed** — it's synced directly to the S3 bucket
as-is, no build step, no bundler, so it must contain nothing except what the live site needs.
Everything else (design references, backend infra-as-code, test scripts, planning docs) lives
in its own top-level folder so a `sync website/ → S3` deploy never uploads dev-only material.

```
website/                        ← DEPLOYED — synced directly to S3, nothing else should be
├── index.html                  Deployed storefront (conversion-first layout, Cognito login, cart, catalog)
├── styles.css                  Design-system stylesheet (tokens + components) used by index.html
├── products.js                 Catalog data — single source of truth, shaped like a future API response
├── store.js                    Cart logic, drawer rendering, and checkout
├── login-test.html             Standalone Cognito Hosted UI login proof-of-concept (kept as a reference —
│                                see docs/history.md step 5 for why the auth logic was validated here first)
├── assets/                     Production images referenced by index.html (incl. hero carousel, bg texture)
│   └── leaves/                 One AI-generated representative photo per catalog leaf, used as the
│                                product-thumb fallback (see products.js `leaves.*.image` and store.js `thumbImage()`)
└── dashboard/                  Staff-only ops dashboard (Today/Week/Month/Jobs/Clients/Inventory/Settings) —
                                 see docs/history.md step 8

design-system/                  NOT deployed — design-system reference docs (tokens, component library,
                                 foundations). See its own readme.md.

ops-dashboard/                  NOT deployed — build-time tooling for website/dashboard/:
├── infra/                      AWS architecture + Lambda code to make the dashboard real (see its own
│                                backend-infra-to-deploy.md and logic-inputs/)
└── user-test/                  Manual QA script for the dashboard's design logic

storefront-infra/               NOT deployed — real product-image bucket plan (assets-bucket-structure.md)
                                 and the Lambda that generates the hero carousel's manifest.json

project_knowledge/              NOT deployed — planning/design docs referenced by the build: the
                                 Payment System file (mixed-cart/GCash logic) and the ERP System file
                                 (overarching 9-module architecture / north star)

docs/                            NOT deployed — history.md (full build log), roadmap.md (prioritized
                                 next goals, ERP-framed), and build-prompts/ (per-milestone build tickets)
```

The site is deployed by syncing `website/` directly to an S3 bucket — no build step, no
bundler. Everything is vanilla HTML5, Tailwind via CDN, and ES6. Production bucket:
`arn:aws:s3:::kcmps-online-bucket-est-2026`, uploaded via the `kcmps-claude-priv` AWS CLI
profile (`aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile
kcmps-claude-priv` — see `CLAUDE.md` "Deploying to production").

A password-gated staging mirror is also live at `dev.kcmps.com` (same bucket, `dev-site/`
prefix, separate CloudFront distribution) for checking changes before they hit the live
site — see `CLAUDE.md` "Deploying to the dev/staging domain" and
`storefront-infra/CLAUDE.md` for the full setup.

## Running the storefront locally

Cognito's OAuth redirect needs an `http(s)://` origin — opening `index.html` directly
(`file://`) will not work for the login button.

```bash
cd website
python3 -m http.server 5500
```

Then open `http://localhost:5500/` — this is the full storefront, including the working
"Login / Sign-up" flow. `http://localhost:5500/` must be registered as an allowed callback
URL and sign-out URL on the Cognito app client (see below).

## Running the login proof-of-concept locally

`website/login-test.html` still works standalone, for debugging the auth flow in isolation
without touching the full storefront:

```bash
cd website
python3 -m http.server 5500
```

Then open `http://localhost:5500/login-test.html`. That exact URL must *also* be registered
as an allowed callback URL and sign-out URL on the Cognito app client, alongside the root URL
above.

### Cognito app client requirements

- Public client (no client secret) — this is a browser SPA, no server-side code.
- Authorization Code grant with PKCE.
- OAuth scopes: `email openid profile phone`.
- Callback URLs / sign-out URLs must include the production origin
  (`https://site.kcmps.com/`) and, for local testing, `http://localhost:5500/`.

See [`docs/history.md`](docs/history.md#auth-implementation-notes) for the non-obvious
problems this flow ran into and why it's built the way it is (COOP/popup detection, PKCE,
token storage tradeoffs, etc.) before touching auth code.

## Design system

The visual language (tokens, components, do/don't guidance) lives in
[`design-system/KCMPS Redesign/readme.md`](design-system/KCMPS%20Redesign/readme.md).
Any new page should link `website/styles.css` and build from its existing classes and CSS
variables rather than hard-coding colors, fonts, or spacing.

## Editing the storefront

- **Design tokens or component styles** — edit `website/styles.css` directly, then sync the
  same file to `design-system/KCMPS Redesign/styles.css` so the design-system
  reference docs stay current.
- **Cart/checkout logic** — edit `website/store.js`.
- **Catalog/product data** — edit `website/products.js` (see `docs/history.md` step 6 for
  the shape).
- **Page structure or copy** — edit `website/index.html`. Value-stack amounts and the
  guarantee wording are marked inline as owner-editable.
- **Hero/page category priming copy** — `PAGE_VARIANTS` in `index.html` (one Hormozi-style
  headline/value-stack/how-it-works variant per `print-office` / `design` / `merch`
  category). State/expiry logic lives in the same script, keyed on `kcmps_hero_category`
  — see docs/history.md step 13 before changing the persistence rules.
- **Bulk & custom estimator** — `#estimator` in `index.html`. Pricing is sourced live from
  `products.js` (no hardcoded numbers) — add a priced SKU there and it appears in the
  estimator's product picker automatically. Volume-discount tiers and leaf-specific add-ons
  are defined in the same script block. Products marked `quoteOnRequest: true` (no confirmed
  cost yet) are explicitly skipped rather than showing a fabricated ₱0 — see `docs/history.md`
  step 18.
- **Unpriced / quote-on-request SKUs** — a product with no confirmed cost yet (e.g. a supplier
  quote pending) should ship as `{ quoteOnRequest: true }` in `products.js` with no `price`/
  `variants`, not a guessed number. It renders as a request card (`quoteCard()` in `store.js`)
  that adds to cart at ₱0 under the same pending-approval flow as custom design requests, and
  is excluded from the bulk estimator. See `docs/history.md` step 18.
- **Tiered add-on on an existing SKU card** (e.g. color printing on the B/W print product) —
  add `addon: { label, options: [{ label, price }, ...] }` to the product in `products.js`
  (first option should be the free/base tier); `skuCard()` in `store.js` renders it as its own
  radio group and folds the selected price into the card's total automatically. See
  `docs/history.md` step 18.
- **Carousel timing** — slide duration lives in `styles.css` (`.carousel-track`
  `transition`), the total interval (`AUTO_MS`) in `index.html`.
- **Checkout endpoint** — the `CHECKOUT_ENDPOINT` constant near the top of `website/store.js`.
- **Scroll-position indicator** — the right-edge section rail. Markup is the `<nav
  class="scroll-indicator">` before `.sticky-cta` in `index.html` (one segment per section,
  `data-target` = the section's `id`); styles are the `— scroll position indicator —` block in
  `styles.css`; behavior (IntersectionObserver active-tracking, click-to-scroll, tap-to-flash)
  is the matching script block. To add/remove a section, edit the markup segment and keep its
  `data-target` pointing at a real section `id` — see `docs/history.md` step 18.

All changes are immediate — there's no build step.

## Testing checklist for storefront changes

- Open in a real browser (Chrome, Firefox, Safari) — Cognito login needs an `http(s)://`
  origin, so `file://` won't exercise the auth flow.
- Nav's Login/Sign-up button is intentionally disabled for now (`docs/history.md` entry 26,
  feature under development) — confirm it can't be clicked and hovering the nav auth area
  shows a "Currently under development" tooltip. The underlying auth code is unchanged, so
  this is purely a UI gate, not a regression.
- Hero carousel: confirm the slow drift, arrows, dots, and swipe-on-mobile all work.
- Click through all 8 catalog leaves; confirm each shows product cards (with a real photo, not
  the initials placeholder) plus a custom-request card.
- Add a priced SKU, toggle "press onto shirt", confirm the live price update (target ₱170 for
  the anchor offer).
- Design picker (DTF pre-made designs): pick a design card, confirm the checkmark/border
  highlight and the large thumb stay in sync; for a product with >8 designs (e.g. Street
  Statement Print), hover the picker and confirm the full-list popup opens *in the visible
  viewport* (not thousands of pixels below it — see `docs/history.md` step 18) and scrolling
  the page while it's open keeps it anchored under the trigger. Add to cart and confirm the
  cart line shows the design name and a small thumbnail; click the thumbnail and confirm it
  opens the full-resolution image in the fullscreen lightbox, closable via Esc/click-outside/X
  without losing the cart.
- Add a custom request, open the drawer, confirm it reads "₱0 now / Pending approval".
- Run checkout end-to-end: clicking "Place order" with a valid name/contact should open the
  GCash payment popup (real QR + copyable Contact/Fulfillment/Custom Request Details +
  itemized cart) **over** the still-open cart drawer, not navigate away immediately. From
  there, "Open email app" reaches `mailto:` (or the configured endpoint) with the same content;
  "I'll send it manually" closes the popup *and* the drawer, back to the main page. Leaving
  name/contact empty should still block with the existing alert and never open the popup. See
  `docs/history.md` entry 22.
- Fulfillment toggle (entry 24): selecting "Pick up" shows the 3-business-day forfeiture note
  and hides the courier/address/landmark fields; selecting "Delivery" does the reverse and
  requires an address before "Place order" will proceed. Confirm the generated order
  text/email includes Courier/Delivery Address/Landmark lines only when Delivery is selected.
- Hero priming: in a fresh incognito window, confirm the hero/value-stack/how-it-works copy and
  the pre-selected shop tab all match one of the three categories consistently; reload the same
  tab a few times and confirm it *doesn't* change (that's the point — see docs/history.md step
  13); add anything to cart and confirm the pick survives closing and reopening the tab.
- Bulk estimator (`#estimator`): confirm the product dropdown only lists real priced SKUs, the
  quantity number field and range slider stay in sync in both directions, volume discount lines
  appear at 25/100/250+ units, and "Add to cart" shows up in the cart drawer (not a `mailto:`).
  Spiral/Comb Binding and Custom Bookmarks are priced now (2026-07-28, `docs/history.md` entry
  24) and should appear in the dropdown like any other SKU.
- Print/Office SKUs: confirm all 8 (document printing, photocopying, lamination, binding,
  stamps, bookmarks, business cards, stickers & labels) render under the Printing & Office
  Supplies tab with a real product photo (not the initials placeholder). Toggle the
  color-printing add-on on the Document Printing card and confirm the displayed price updates
  (₱4 B/W vs ₱7 colored). Confirm the Business Cards card's quantity stepper won't decrement
  below 10 in either the product card or the cart line (`minQty`, entry 24).
- Onsite-only gating (entry 25): Photocopying should render with no "Add to cart" button at
  all (an "In-store only" reference-price card). Lamination and Binding should start with
  "Add to cart" disabled and a "Add Document Printing to your cart first" note; adding
  Document Printing to the cart should unlock both live, no reload; removing it again should
  re-lock them. Add Document Printing, remove it, and confirm *its own* "Add to cart" button
  is still clickable afterward (a real regression this pass fixed — it used to stay
  permanently disabled). Confirm the bulk estimator's product dropdown excludes all three
  gated/onsite products.
- Scroll the desktop page: the nav should stay pinned to the top (`position: sticky`) and fade
  from transparent to a solid blurred background + shadow past ~8px of scroll — see
  `docs/history.md` step 12 if it stops sticking (it's tied to `html`/`body` `overflow-x`).
- Scroll-position indicator (right edge): the segment for the section in view should highlight
  in real time as you scroll; hovering a segment on desktop should enlarge it and reveal the
  section name without shifting its neighbours; clicking should smooth-scroll so the section
  lands fully below the nav. On mobile (≤760px) the segments stay collapsed to compact lines
  (no permanent labels), a tap flashes the label briefly, swiping directly on a line shouldn't
  scroll the page, and page content shouldn't run under the rail — see `docs/history.md` step 18.
- Resize to mobile (375px): sticky CTA bar, drawer scroll, no horizontal overflow.
- Mobile hero (≤760px): scroll down, tap the logo, and confirm the hero renders correctly with
  no manual scroll needed (nav shouldn't overlap the hero) — see `docs/history.md` step 17 if it
  regresses. Also confirm the 3:4 hero image's overlaid headline never overlaps the fixed
  Shop/View Cart bar, including on a short viewport (e.g. 375×667) and with the longest category
  headline variant (see step 13's `HERO_VARIANTS`).
- Check the console for JS errors and the Network tab for anything the CSP blocks.

## Known gaps / next steps

The prioritized plan for closing these — framed against the full ERP architecture
(`project_knowledge/ERP_System_Project_Knowledge.md`) — lives in
[`docs/roadmap.md`](docs/roadmap.md). Current focus is **Milestone 1: the simple payment
backend** (real order persistence + GCash verification), which is what turns the storefront
from a brochure into a working store. The individual gaps below are the raw material that
roadmap sequences.

- Cart icon in `index.html` is a stub with a marked integration point (`CART INTEGRATION
  POINT` comment in the auth `<script>`) for a future DynamoDB-backed cart, keyed by the
  logged-in user's `sub` claim.
- The ops dashboard (`website/dashboard/*`) runs entirely on mock/localStorage data — see
  `docs/history.md` step 8 and `ops-dashboard/infra/backend-infra-to-deploy.md`
  for what's needed to wire it to a real backend.
- Sub-categories beyond DTF and print-office pricing (Subli, Hotmelt, 3D Print, Souvenir,
  Network, Storage) currently ship as "coming soon" placeholders — custom-request only, no
  priced SKUs, so they're excluded from the bulk estimator's calculator.
- Checkout is `mailto:`-based with no real payment processing; the cart lives in
  `localStorage` only, so it doesn't survive across devices or browsers.
- Hero category priming is client-side only (`localStorage`/`sessionStorage`) — a logged-in
  customer's primed category doesn't sync across devices. Deferred pending a real backend;
  see docs/history.md step 13.
