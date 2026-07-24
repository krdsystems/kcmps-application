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
└── dashboard/                  Staff-only ops dashboard (Today/Week/Month/Jobs/Clients/Inventory/Settings) —
                                 see docs/history.md step 8

design-system/                  NOT deployed — design-system reference docs (tokens, component library,
                                 foundations). See its own readme.md.

ops-dashboard/                  NOT deployed — build-time tooling for website/dashboard/:
├── infra/                      AWS architecture + Lambda code to make the dashboard real (see its own
│                                backend-infra-to-deploy.md and logic-inputs/)
└── user-test/                  Manual QA script for the dashboard's design logic

project_knowledge/              NOT deployed — planning/design docs referenced by the build (e.g. the
                                 Payment System file the mixed-cart/GCash logic is built against)

docs/                            NOT deployed — history.md (full build log), moved out of this README
```

The site is deployed by syncing `website/` directly to an S3 bucket — no build step, no
bundler. Everything is vanilla HTML5, Tailwind via CDN, and ES6.

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
- **Carousel timing** — slide duration lives in `styles.css` (`.carousel-track`
  `transition`), the total interval (`AUTO_MS`) in `index.html`.
- **Checkout endpoint** — the `CHECKOUT_ENDPOINT` constant near the top of `website/store.js`.

All changes are immediate — there's no build step.

## Testing checklist for storefront changes

- Open in a real browser (Chrome, Firefox, Safari) — Cognito login needs an `http(s)://`
  origin, so `file://` won't exercise the auth flow.
- Hero carousel: confirm the slow drift, arrows, dots, and swipe-on-mobile all work.
- Click through all 9 catalog leaves; confirm each shows product cards plus a custom-request
  card.
- Add a priced SKU, toggle "press onto shirt", confirm the live price update (target ₱170 for
  the anchor offer).
- Add a custom request, open the drawer, confirm it reads "₱0 now / Pending approval".
- Run checkout end-to-end and confirm the order summary reaches `mailto:` (or the configured
  endpoint).
- Resize to mobile (375px): sticky CTA bar, drawer scroll, no horizontal overflow.
- Check the console for JS errors and the Network tab for anything the CSP blocks.

## Known gaps / next steps

- Cart icon in `index.html` is a stub with a marked integration point (`CART INTEGRATION
  POINT` comment in the auth `<script>`) for a future DynamoDB-backed cart, keyed by the
  logged-in user's `sub` claim.
- The ops dashboard (`website/dashboard/*`) runs entirely on mock/localStorage data — see
  `docs/history.md` step 8 and `ops-dashboard/infra/backend-infra-to-deploy.md`
  for what's needed to wire it to a real backend.
- Sub-categories beyond DTF pricing (Subli, Hotmelt, and the rest of the catalog) currently
  ship as "coming soon" placeholders.
- Checkout is `mailto:`-based with no real payment processing; the cart lives in
  `localStorage` only, so it doesn't survive across devices or browsers.
