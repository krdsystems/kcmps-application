# KCMPS — Kaalyados Creatives Merchandise and Printing Services

The marketing site and storefront foundation for KCMPS, a Manila-based print-and-hardware
studio: custom apparel printing (DTF/Subli/Hotmelt), design services, and merchandise, moving
toward digital ordering with authenticated accounts and a cart.

This README doubles as a build log — it tracks the project from its first commit through
every structural change, including the mistakes made along the way and what fixed them, so
future work (and future contributors) don't have to reconstruct that history from `git log`.

## Repository layout

```
website/
├── index.html                  Deployed storefront (conversion-first layout, Cognito login, cart, catalog)
├── styles.css                  Design-system stylesheet (tokens + components) used by index.html
├── products.js                 Catalog data — single source of truth, shaped like a future API response
├── store.js                    Cart logic, drawer rendering, and checkout
├── login-test.html             Standalone Cognito Hosted UI login proof-of-concept (kept as a reference —
│                                see "Development history" for why the auth logic was validated here first)
├── assets/                     Production images referenced by index.html (incl. hero carousel, bg texture)
└── Claude Design/              Design-system reference docs (not deployed) — see its own readme.md
```

The site is deployed by syncing `website/` directly to an S3 bucket — no build step, no
bundler. Everything is vanilla HTML5, Tailwind via CDN, and ES6.

## Development history

### 1. First commit (2026-07-21)

Repo initialized with a placeholder `README.md`. No site yet.

### 2. Design system generation — "redesign of layout" (2026-07-21)

A full design system was generated (via the Claude design tool) into
`Claude Design/KCMPS Redesign/`: design tokens (`theme.json`), a component library
(buttons, cards, forms, navigation, tables, dialogs), foundation references (color, type,
icons, layout, imagery), and a starting storefront template nested at
`Claude Design/KCMPS Redesign/templates/landing/`.

This established the visual language still in use: navy as the dominant brand color, one
orange accent reserved for a single call-to-action per screen, rounded/friendly geometry
over "industrial" styling. See
[`website/Claude Design/KCMPS Redesign/readme.md`](website/Claude%20Design/KCMPS%20Redesign/readme.md)
for the full system reference.

### 3. Building the real site, and the first structural mistake (2026-07-21)

The landing template was fleshed out into the actual storefront: the full brand name in the
nav (`KCMPS | Kaalyados Creatives Merchandise and Printing Services`, collapsing to `KCMPS`
on narrow screens), a Vision & Mission section, and a nested tab system for the catalog
(Printing & Office Supplies / Design / Merch, with live DTF pricing under
Design → Apparel, other sub-categories stubbed as "coming soon").

**Problem:** the deployable site was still sitting at
`Claude Design/KCMPS Redesign/templates/landing/`, four directories deep. Syncing that path
straight to the S3 bucket would have meant either mirroring the nested structure in the
bucket or writing sync logic to cherry-pick one subfolder out of a design-tool export.

**Fix:** `index.html`, `styles.css`, and `assets/` were moved out to the repo root, so the
bucket could sync from root with no path translation. The design-system reference docs kept
their own copy of `styles.css` so they still render standalone, independent of the deployed
site's copy.

### 4. Two branches diverge (2026-07-22)

Work split into two parallel tracks after step 3:

- **`main`** — reorganized the repo again (commit `e4481ee`, "fix logic"): the design-system
  reference docs and the deployed site both moved one level down, into `website/`, so the
  repo root would hold only project-level files (this README, `.claude/` config) and not mix
  them with deployable site assets.
- **A feature branch** (`claude/kcmps-login-frontend-d718f1`) — added `login-test.html`, a
  standalone proof-of-concept for AWS Cognito Hosted UI login, built and validated against
  the real Cognito app client *before* wiring auth into the actual storefront. This let the
  auth flow (see below) get debugged in isolation, without every fix requiring a redeploy of
  the full site.

**Problem:** the login branch was cut from the repo layout *before* `main`'s `website/`
move landed, so `login-test.html` was built at the repo root and its README pointed at
root-relative paths. Merging as-is would have put the test file at the wrong level and left
its docs describing a layout that no longer existed.

**Fix:** before merging, `login-test.html` (and its README section) was moved into
`website/` to match, and the paths in its instructions were corrected (commit `dd18252`).
The merge (`b9ec0bd`) then combined both tracks cleanly: `main`'s repo reorg and the
feature branch's login POC, both already speaking the same directory layout.

### 5. Wiring the validated login flow into the real storefront (2026-07-22)

With the auth flow manually verified end-to-end in `login-test.html` (see the errors and
fixes documented below), the same OAuth logic was ported into `website/index.html` — deliberately
copied as-is rather than rewritten, since it had already been debugged against the real
Cognito app client and every fix along the way addressed a genuine, hard-to-reproduce
browser quirk (see next section).

The only changes made during the port were to the UI-rendering functions: `login-test.html`
was styled with Tailwind (loaded via CDN) as a fast way to build the isolated test page, but
the real site has its own design system (`styles.css` — CSS custom properties + component
classes, no utility framework). `renderLoggedIn`/`renderLoggedOut`, the cart badge, and the
popup status screen were rewritten against that system so the logged-in nav (user name,
Logout, the Staff-only `Dashboard` link, cart badge) looks native to the site rather than
visibly bolted on.

`website/index.html` now has a real, working "Login / Sign-up" flow, group-based `Dashboard`
visibility, session restore on reload, and logout that also ends the Cognito Hosted UI
session. `website/login-test.html` is kept in the repo as the original isolated reference —
useful if the auth flow ever needs debugging again without redeploying the full site.

### 6. Conversion-first redesign, cart system, and hero carousel (2026-07-23)

The storefront was rebuilt around Alex Hormozi's "no-brainer offer" principles: visitors now
land on an optimized persuasion funnel (offer hero, itemized value stack, guarantee band,
3-step "how it works", then the catalog) before browsing. A frontend-only cart system was
added, migration-ready so a future backend swap is a one-line change. The auth flow itself
(980 lines) was left untouched.

**Page structure**, top to bottom:

1. **Offer Hero** — "Your design, printed on a premium shirt — from ₱170" (price anchor tied
   to real DTF pricing: ₱50 transfer + ₱120 shirt press), a 3-item value checklist, and trust
   chips.
2. **Value Stack** — itemized inclusions with peso values (free file check & prep ₱150, free
   layout assistance ₱200, reprint-free guarantee), struck-through total vs. actual price paid.
3. **Guarantee Band** — "Love it, or we reprint it — free" (owner-editable), dark navy with a
   translucent/glassy overlay.
4. **How It Works** — pick or upload a design → produced in-house → pickup or delivery.
5. **Storefront** — 9 catalog leaves with real product cards plus a "Custom design request"
   card per leaf (₱0 now, billed after approval); size selector, shirt-press toggle, qty
   stepper, live price updates.
6. **Cart** — slide-in drawer with two checkout paths: priced SKU items show a subtotal,
   custom requests show "₱0 now / Pending approval — billed after design review". Checkout
   captures name, contact, fulfillment (pickup/delivery), and notes, then composes an order
   summary and sends it to a configurable endpoint (default `mailto:`).
7. **FAQ** — objection handling (file formats, turnaround, payment timing, approval process,
   pickup vs. delivery).
8. **Estimator** — repositioned as a "Bulk & custom" helper for larger runs.
9. **Mission/Vision & Contact** — brand story and location, below the store.

**New files:**

- `website/products.js` — single source of truth for catalog data, shaped exactly like a
  future API response (`window.KCMPS_STORE_DATA = { currency, shirtAddon, leaves, products }`).
  To add a priced product, copy an existing entry, give it a unique `id`, assign the right
  `leaf`, and set `variants` or a single `price`. To enable a "coming soon" leaf, add priced
  `products` entries for it — the custom-request card is appended automatically.
- `website/store.js` — cart logic, rendering, and checkout: `addToCart(item)`, `setQty(key,
  qty)`, `removeItem(key)`, `payNowTotal()`, `pendingCount()`, `renderCatalog()`,
  `renderCart()`, `submitOrder()`, and a public API (`window.KCMPS_STORE = { open, close,
  refreshBadge }`) for the auth flow to call into. Cart state persists in `localStorage`
  under the key `kcmps_cart`. It exits early when
  `document.documentElement.classList.contains("auth-popup")`, so storefront JS never runs
  during the OAuth popup flow. Checkout target is a configurable `CHECKOUT_ENDPOINT` constant
  (default a `mailto:` to the business owner with the order summary — swap for a real
  endpoint and use `fetch()` in `submitOrder()` once a backend exists).
- `website/assets/bg-texture.png` — light watercolor-wash page background (cream/white, navy
  ink-wash vignette matching `#1d3f72`), applied `fixed` for a parallax effect. Cards, the
  guarantee band, and CSS surface tokens were given translucency + `backdrop-filter: blur()`
  so the texture reads through without hurting legibility; form inputs and the cart drawer
  stay solid where readability is critical.

**Hero carousel:** 4 images (the original studio photo plus three AI-generated shots — heat
press applying a DTF transfer, a customer holding a finished print, a designer's desk with
DTF film/laptop/folded shirts) auto-advance right-to-left with a slow drift: 4s slide
transition, 1.5s pause, 5.5s total interval. Left/right arrows and dot indicators allow manual
navigation, touch swipe is supported, autoplay pauses on hover/focus, and is disabled entirely
under `prefers-reduced-motion` (manual controls still work).

**Migration path to a real backend**, once one exists:

1. Replace the `products.js` literal with `fetch('/api/catalog')` and reassign
   `window.KCMPS_STORE_DATA` before calling `renderCatalog()`.
2. Replace the `submitOrder()` mailto with a real `fetch()` call to `CHECKOUT_ENDPOINT`.
3. Add a backend dashboard for approving custom requests and processing SKU payments.

No other code changes are expected to be needed — the data shape, cart logic, and UI were
built against this swap from the start.

## Errors encountered during the Cognito login POC, and what fixed them

Building `login-test.html` surfaced several non-obvious problems specific to doing OAuth from
a static, serverless SPA. These are documented here (and in comments in the file itself) so
they aren't rediscovered the hard way when auth gets wired into the real storefront.

### Popup detection broke under Cross-Origin-Opener-Policy

**Problem:** the natural way to detect "the login popup finished" is to poll
`popup.closed` or hold a `window.opener` reference back to the main window. Cognito's
Hosted UI sends a `Cross-Origin-Opener-Policy` header, which severs `window.opener` the
moment the login form renders in the popup — and can also make `popup.closed` checks from
the main window unreliable.

**Fix:** the main window instead listens for a `storage` event fired when the popup writes
its result to `localStorage` (with a slow poll kept only as a backup). This is COOP-safe
because it doesn't depend on either window holding a live reference to the other — it's a
same-origin message bus, not a direct handle.

### Public SPA client can't use a client secret

**Problem:** a classic OAuth Authorization Code flow expects a client secret exchanged
server-side. This is a pure static site with no backend to hold one.

**Fix:** the Cognito app client is configured as public (no secret), using Authorization
Code with PKCE instead — the `code_verifier`/`code_challenge` pair proves the token-exchange
request came from the same browser that started the flow, without any secret ever existing.

### Missing `profile` scope silently broke the nav

**Problem:** early testing requested only `email openid`. Login succeeded, but the nav had
no name to display after login — the ID token simply didn't carry a `name` claim.

**Fix:** added `profile` to the requested OAuth scopes (`email openid profile phone`).
That claim is what the nav's "swap the login button for the user's name" behavior depends
on.

### Token storage: tradeoffs, not a fix

Not a bug, but a decision worth recording so it isn't re-litigated as one: ID/access/refresh
tokens are kept in `sessionStorage` rather than `localStorage`. Both are equally readable by
an injected script if the page ever has an XSS bug, but `sessionStorage` is cleared when the
tab closes, capping the exposure window — `localStorage` would persist the tokens
indefinitely across browser restarts. The strictly more secure option (an httpOnly cookie
holding the refresh token via a Backend-for-Frontend) isn't available yet because this is a
static site with no server; worth revisiting once API Gateway/Lambda exist.
`localStorage` *is* still used, briefly, purely as the same-origin message bus described
above — each value is written and deleted within seconds.

### Client-side JWT decoding is for display only

The ID token is decoded in the browser to read `name` and `cognito:groups` for UI purposes
(nav name, showing the Staff `Dashboard` link) — it is never verified client-side. This is a
constraint to carry forward: any backend that later receives a token from this app must
independently verify its signature against Cognito's JWKS. Client-decoded claims must never
be trusted server-side just because the UI already displayed them.

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

## Design system

The visual language (tokens, components, do/don't guidance) lives in
[`website/Claude Design/KCMPS Redesign/readme.md`](website/Claude%20Design/KCMPS%20Redesign/readme.md).
Any new page should link `website/styles.css` and build from its existing classes and CSS
variables rather than hard-coding colors, fonts, or spacing.

## Editing the storefront

- **Design tokens or component styles** — edit `website/styles.css` directly, then sync the
  same file to `website/Claude Design/KCMPS Redesign/styles.css` so the design-system
  reference docs stay current.
- **Cart/checkout logic** — edit `website/store.js`.
- **Catalog/product data** — edit `website/products.js` (see "Conversion-first redesign"
  above for the shape).
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
- The `Dashboard` nav link (shown to `Staff`-group users) currently just logs to the console
  and shows an alert — the real `/dashboard/*` route doesn't exist yet.
- Sub-categories beyond DTF pricing (Subli, Hotmelt, and the rest of the catalog) currently
  ship as "coming soon" placeholders.
- Checkout is `mailto:`-based with no real payment processing; the cart lives in
  `localStorage` only, so it doesn't survive across devices or browsers.
