# KCMPS — Kaalyados Creatives Merchandise and Printing Services

The marketing site and storefront foundation for KCMPS, a Manila-based print-and-hardware
studio: custom apparel printing (DTF/Subli/Hotmelt), design services, and merchandise, moving
toward digital ordering with authenticated accounts and a cart.

This README doubles as a build log — it tracks the project from its first commit through
every structural change, including the mistakes made along the way and what fixed them, so
future work (and future contributors) don't have to reconstruct that history from `git log`.

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
│                                see "Development history" for why the auth logic was validated here first)
├── assets/                     Production images referenced by index.html (incl. hero carousel, bg texture)
└── dashboard/                  Staff-only ops dashboard (Today/Week/Month/Jobs/Clients/Inventory/Settings) —
                                 see "Ops dashboard frontend..." in Development history below

design-system/                  NOT deployed — design-system reference docs (tokens, component library,
                                 foundations). See its own readme.md. Was nested inside website/ until it
                                 got separated out so an S3 sync of website/ can't accidentally upload it.

ops-dashboard/                  NOT deployed — build-time tooling for website/dashboard/, kept out of the
                                 synced folder for the same reason:
├── infra/                      AWS architecture + Lambda code to make the dashboard real (see its own
│                                backend-infra-to-deploy.md and logic-inputs/)
└── user-test/                  Manual QA script for the dashboard's design logic

project_knowledge/              NOT deployed — planning/design docs referenced by the build (e.g. the
                                 Payment System file the mixed-cart/GCash logic is built against)
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
for the full system reference (moved to `design-system/` in step 9 below — this link
describes the layout as it was at the time).

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

### 7. Mobile layout optimization (2026-07-23)

Three responsive issues were fixed via CSS-only changes to ensure the site works seamlessly
on narrow viewports without any horizontal scrolling or element overlap:

1. **Navbar overlap on mobile** — The nav was forcing all items (CTA button, Dashboard link,
   cart button, auth area) onto a single line with `flex-wrap: nowrap` even on narrow screens.
   On mobile, this caused nav elements to overlap and overflow the viewport.

   **Fix:** At `@media (max-width: 760px)`, hid the redundant "Start your order" CTA button
   (which is already available in the sticky bottom bar) and the Dashboard button (only shown
   for staff anyway). Reduced nav gaps and added `max-width: 80px` with ellipsis truncation
   to the user's display name so long names won't trigger overflow.

2. **Post-login horizontal bleed** — After login, the auth area swaps from a button to the
   user's name + logout button. If the name was long, it wouldn't wrap due to `white-space:
   nowrap`, causing the entire page to scroll horizontally.

   **Fix:** Added global `overflow-x: hidden` to `html, body` to prevent any element from
   causing a rightward page scroll, regardless of width. This caps all overflow at the viewport
   edge.

3. **Cart drawer on very small screens** — The cart drawer used `width: min(420px, 100%)`,
   which should work but sometimes left room for scrolling on extremely narrow phones due to
   mobile browser chrome not being accounted for.

   **Fix:** Added `@media (max-width: 480px) { .cart-drawer { width: 100vw; } }` to force the
   drawer to the full viewport width on phones under 480px.

All changes were CSS-only; no JavaScript logic or cart behavior was affected. The site now
passes a mobile-viewport smoke test without horizontal scrolling.

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
[`design-system/KCMPS Redesign/readme.md`](design-system/KCMPS%20Redesign/readme.md).
Any new page should link `website/styles.css` and build from its existing classes and CSS
variables rather than hard-coding colors, fonts, or spacing.

## Editing the storefront

- **Design tokens or component styles** — edit `website/styles.css` directly, then sync the
  same file to `design-system/KCMPS Redesign/styles.css` so the design-system
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

### 8. Ops dashboard frontend, mock-data layer, and backend deployment plan (2026-07-24)

Built out `website/dashboard/*` from the Operations Dashboard Project Knowledge file: the
`Staff`-only internal dashboard, deployable at the same S3 root as the storefront
(`website/dashboard/today.html` etc.). The `Dashboard` nav link in `index.html` now navigates
there for real instead of showing a placeholder alert.

**Pages** (all share `dashboard.css` + `dashboard-shell.js` for the sidebar/topbar/auth gate):
`today.html` (daily action queues, today's numbers, blockers board, low-stock alerts),
`week.html` (station capacity/utilization/WIP triplet, batching suggestions, quote
conversion), `month.html` (12-metric-capped KPIs, margin by pillar, quiet-client detection),
`jobs.html` + `job-detail.html` (ticket list and the state-machine-driven ticket itself —
advance/QC-pass/QC-fail-with-spoilage/setup-minutes actions), `clients.html`, `inventory.html`,
`settings.html` (SLA reference table + a "reset demo data" control).

**No backend exists yet**, so `dashboard-data.js` is a mock data layer: it seeds a realistic
shop's worth of orders/events/metrics/blockers/inventory/clients into `localStorage` and
exposes functions (`getQueues`, `advanceLineItem`, `getWeekData`, etc.) whose *return shapes
already match the future API*. Every `.html` page only ever calls `window.KCMPS_DASH.*`, never
`localStorage` directly — the same "one seam" pattern `store.js`/`KCMPS_STORE` already
established for the cart, so swapping mock for real `fetch()` calls later is a body-only change
per function (see `ops-dashboard/infra/backend-infra-to-deploy.md` §6). Auth reuses the
exact Cognito config and `sessionStorage` token key already validated in `index.html`'s auth
script, so a logged-in Staff session carries straight over with no second login.

**New directories:**

- `ops-dashboard/infra/backend-infra-to-deploy.md` — the AWS architecture (DynamoDB
  single-table schema + GSI1 sparse status index, Lambda functions, API Gateway routes,
  EventBridge cron, SES digest, IAM, cost impact, phased deployment checklist) needed to make
  the dashboard real. No new AWS services — layers on the existing S3 + CloudFront + Cognito +
  API Gateway + Lambda + DynamoDB + SES stack, per the Project Knowledge file's Part 8.
- `ops-dashboard/infra/logic-inputs/` — the actual Lambda code to deploy:
  `streams-handler.js` (DynamoDB Streams → derives `orderStatus`, maintains the GSI1 index,
  rolls up METRIC# counters), `expire-pending-orders.js` (48h verification / 7-day quote
  expiry sweep), `daily-digest.js` (SES digest, twice daily), `api-get-orders.js` /
  `api-advance-line-item.js` (role-filtered reads and state-machine-validated writes, JWT
  verified server-side — never trust the client-decoded claims per the existing auth doc).
- `ops-dashboard/user-test/README.md` — a 13-step manual test script for a non-technical
  user to verify the dashboard's *design logic* (not just that it renders): SLA aging order,
  required owner/due-date on blockers, recurring-blocker promotion to the weekly view, OTIF
  measured against the original (never revised) promise date, illegal state transitions being
  blocked, spoilage reason-code capture on QC fail, the >85%-capacity rush-surcharge note, and
  the monthly view's hard 12-metric cap.

### 9. Local test-staff bypass, and reconciling the mixed-cart/GCash payment logic (2026-07-24)

**Bug fix — auth redirect loop:** `dashboard/index.html` was blindly redirecting to
`today.html`, which then found no Cognito session and immediately bounced back to the
storefront — two instant redirects on every load, visible as a flickering URL bar. Fixed by
making `dashboard/index.html` decide once and stop: on `localhost` (never on the real domain —
gated by `KCMPS_DASH_SHELL.isLocalHost()`), it now offers a **"Continue as test Staff user
(local only)"** button that seeds a fake, unsigned session token, letting the dashboard be
tested without a real AWS/Cognito Staff account. `user-test/README.md`'s Test 1 was rewritten
around this bypass instead of assuming a real Cognito account.

**Payment logic reconciliation:** brought in `project_knowledge/Payment_System_Project_Knowledge.md`
(mixed-cart checkout + manual GCash bridge design, previously not cross-referenced) and revised
the dashboard to match it exactly rather than the looser shape it shipped with:

- `dashboard-data.js` orders now carry an order-level `payment` object (`method`,
  `claimedAmount`, `gcashRefNumber`, `screenshotRef`, `submittedAt`, `verifiedBy`, `verifiedAt`,
  `rejectionReason`) — copied verbatim from the Payment System file's data model, since one
  GCash transaction covers every `sku` line item on an order together, not one proof per line.
  New `verifyPayment()`/`rejectPayment()` functions act at the order level accordingly (reject
  requires a reason, matching the file's customer-resubmission flow).
- Seed data gained a **mixed-cart example order** (a paid-and-delivered `sku` item plus an
  in-progress `custom` item, same order ID) — the exact worked example from the Payment System
  file's "Core Design: One Cart, Two Item Types" section, proving `orderStatus` correctly
  derives to `Partially Fulfilled`.
- `today.html`'s Pending Payment Verification queue and `job-detail.html`'s ticket view now
  surface the GCash reference number, claimed amount, screenshot ref, and verify/reject audit
  trail inline, per the Payment System file's staff-dashboard spec.
- `infra/backend-infra-to-deploy.md` now cites both source files explicitly, documents the
  `payment` sub-object's exact shape, and explains why line items are separate DynamoDB items
  (for the GSI1 sparse index) rather than the array the Payment System file's schema sketch
  uses. Added `infra/logic-inputs/api-verify-payment.js` (the real Lambda for order-level
  verify/reject) and a note that `submitPaymentProof`/`payCustomItem` are storefront/checkout
  Lambdas, out of scope for this dashboard build.
- `user-test/README.md` gained Test 7a (verify/reject) and Test 7b (mixed-cart rollup), and
  Test 2 now checks that the reference number/claimed amount show inline in the queue.

### 10. Repo cleanup: only deployable files live under `website/` (2026-07-24)

**Problem:** the deploy process syncs `website/` straight to S3 with no filtering, but the
folder had accumulated non-deployed material alongside the real site — `website/Claude
Design/` (design-system reference docs, already flagged "not deployed" since step 2) and, as
of step 8 above, `website/dashboard/infra/` and `website/dashboard/user-test/` (AWS
architecture docs, Lambda source, and a manual QA script — none of it meant to be served to
browsers). Every one of those would have been silently uploaded to the production bucket on
the next sync.

**Fix:** moved all three out to their own top-level folders, sibling to `website/`, matching
the pattern `project_knowledge/` already used:
- `website/Claude Design/` → `design-system/`
- `website/dashboard/infra/` → `ops-dashboard/infra/`
- `website/dashboard/user-test/` → `ops-dashboard/user-test/`

`website/dashboard/*.html` + `dashboard.css`/`dashboard-data.js`/`dashboard-shell.js` stay put —
those *are* deployed, staff-only pages. Every relative path in the moved files, plus every
mention in `dashboard-data.js`, `dashboard-shell.js`, `settings.html`, and this README, was
recomputed and updated to match (see the "Repository layout" section at the top of this file
for the resulting tree). No functional code changed — this was a pure file-location fix, and
`website/` now contains nothing that isn't meant to go live.

## Known gaps / next steps

- Cart icon in `index.html` is a stub with a marked integration point (`CART INTEGRATION
  POINT` comment in the auth `<script>`) for a future DynamoDB-backed cart, keyed by the
  logged-in user's `sub` claim.
- The ops dashboard (`website/dashboard/*`) runs entirely on mock/localStorage data — see
  "Ops dashboard frontend..." above and `ops-dashboard/infra/backend-infra-to-deploy.md`
  for what's needed to wire it to a real backend.
- Sub-categories beyond DTF pricing (Subli, Hotmelt, and the rest of the catalog) currently
  ship as "coming soon" placeholders.
- Checkout is `mailto:`-based with no real payment processing; the cart lives in
  `localStorage` only, so it doesn't survive across devices or browsers.
