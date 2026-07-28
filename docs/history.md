# KCMPS — Project History

Full build log, moved out of `README.md` so a fresh session doesn't have to load it by
default. Read this file only when you need the *why* behind a decision — for current-state
facts (file locations, how to run things, editing pointers) see `README.md` and the root
`CLAUDE.md` instead.

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
[`design-system/KCMPS Redesign/readme.md`](../design-system/KCMPS%20Redesign/readme.md)
for the full system reference (moved to `design-system/` in step 10 below — this link
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
browser quirk (see "Auth implementation notes" below).

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
   edge. (Later scoped to `html` only — see entry 12 — because pairing it with `body` broke
   `position: sticky` on the nav.)

3. **Cart drawer on very small screens** — The cart drawer used `width: min(420px, 100%)`,
   which should work but sometimes left room for scrolling on extremely narrow phones due to
   mobile browser chrome not being accounted for.

   **Fix:** Added `@media (max-width: 480px) { .cart-drawer { width: 100vw; } }` to force the
   drawer to the full viewport width on phones under 480px.

All changes were CSS-only; no JavaScript logic or cart behavior was affected. The site now
passes a mobile-viewport smoke test without horizontal scrolling.

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
  verified server-side — never trust the client-decoded claims per the auth notes below).
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
recomputed and updated to match. No functional code changed — this was a pure file-location
fix, and `website/` now contains nothing that isn't meant to go live.

### 11. Repo structure pass for Claude Code token efficiency (2026-07-24)

Added a root `CLAUDE.md` plus scoped `CLAUDE.md` files in `design-system/` and
`ops-dashboard/` so new Claude Code sessions get oriented without re-reading this whole
history file. Split this file out of `README.md`, which had grown to ~30KB by doubling as
both onboarding doc and build log. Pruned four stale `.claude/worktrees/` copies that were
already merged into `main` (`kcmps-login-frontend-d718f1`, `comprehensive-readme-docs-61df52`,
`kcmps-storefront-redesign`, `security-vulnerabilities-audit-75a87f`) — each was a full
checked-out copy of the repo (~100+ files, several MB) left behind after merge instead of
being removed with `git worktree remove`.

### 12. Sticky nav scroll-state, and an `overflow-x` bug that silently broke `position: sticky` (2026-07-25)

The nav bar had been `position: sticky; top: 0` since entry 6, but it didn't actually stick —
it scrolled away with the page. Root cause: entry 7's `html, body { overflow-x: hidden; }` fix
for the post-login horizontal-bleed bug. Per the CSS Overflow spec, when one axis is `hidden`
and the other is left at its default `visible`, the `visible` axis's *used value* is silently
promoted to `auto`. So `body`'s `overflow-y` computed to `auto`, turning `body` into its own
scroll container — even though `html` (`document.scrollingElement`) is what actually scrolls.
`position: sticky` anchors to the nearest ancestor scroll container, which resolved to that
inert `body` context instead of the real viewport, so the offset never applied.

**Fix:** scoped `overflow-x: hidden` to `html` only (`website/index.html`) — `html` is already
the document's real scrolling element, so it still clips horizontal overflow without turning
`body` into a second, non-scrolling scroll container. Verified no regression in the mobile
horizontal-overflow fix at 375px, or in the cart drawer, after the change.

Also added scroll-state styling to the nav: it starts fully transparent (no background, no
blur, no shadow) at scroll position 0 so it doesn't visually clash with the hero behind it, then
a `.nav.is-scrolled` class (toggled by a small `scroll` listener in `index.html`) fades in a
solid `color-mix` background, `backdrop-filter: blur`, and a drop shadow once the page scrolls
past an 8px threshold.

### 13. Hero category priming, catalog cleanup, generated leaf images, and a bulk estimator rewrite (2026-07-25)

**Hero/page category priming.** Rather than one fixed hero pitch, the whole page (hero
headline/subhead/CTA, the "Everything you get" value stack, "How it works" steps, and which
shop tab is pre-selected) now has one Hormozi-style "no-brainer offer" copy variant per
top-level category — `print-office` / `design` / `merch` — defined in `PAGE_VARIANTS` in
`index.html`. On first visit one is picked uniformly at random and kept consistent so the
visitor isn't shown three different pitches in one session (this is a priming/consistency
mechanic, not personalization — the pick has nothing to do with who the visitor is).

State lives under one `localStorage`/`sessionStorage` key, `kcmps_hero_category`, read in
priority order: a non-expired `localStorage` "sticky" entry (written the moment the visitor
adds anything to cart — `store.js`'s `addToCart` dispatches a `kcmps:cart-add` DOM event for
this, since custom-request items already are the site's quote flow) beats a same-tab
`sessionStorage` entry (keeps the pick stable across reloads *within one tab* — a genuinely new
tab/session, or sticky expiry after 7 days, rolls fresh) beats rolling a fresh random pick.
Cross-device sync (a returning logged-in customer seeing their primed category on a different
device) was explicitly deferred — no `CUSTOMER#<sub>` backend attribute exists yet, and per
this project's manual-first approach it's not worth building until there's usage data to
justify it. Analytics is a stubbed `kcmps:hero-metric` DOM event (no backend exists to receive
it yet) shaped to map onto the ops dashboard's existing `METRIC#DAY#` / `PILLAR#` rollup
pattern for a later one-line swap.

**Catalog fixes.** Pulled two real print products (Catalogs & Booklets, Custom Packaging) out
of an early prototype draft into `products.js` under the `print-office` leaf, which previously
only ever showed the generic custom-request card. Removed the `entertainment` merch sub-leaf
entirely (KCMPS doesn't sell audio/gaming gadgets) and corrected the `storage` leaf's copy,
which had claimed "laser-etched branding" — a service KCMPS doesn't offer.

**Generated leaf images.** Every catalog leaf's product cards showed only CSS-initials
placeholders (`p.image` was never actually rendered). Generated one representative photo per
leaf with `nano-banana-pro`, downsized to ~80-110KB JPGs in `website/assets/leaves/`, and wired
them into `store.js` via `thumbImage()`/`buildThumb()` — a product's own `image` wins, falling
back to its leaf's photo, falling back to the original initials placeholder only if neither
exists.

**Hero carousel photo pool cleanup.** The hero carousel's 4-photo pool (`assets/manifest.json`
+ the static `<figure>` fallback slides in `index.html`) was a mismatched grab-bag left over
from early prototyping: two generic stock photos (`photo.jpg`, `photo-color.jpg`), two
externally-hosted images on the base44 CDN, and — worse — the manifest had the DTF heat-press
photos filed under the `merch` category instead of `design`. Replaced the whole pool with 4 of
the leaf photos above (print-office, dtf, 3dprint, storage), one per business pillar, correctly
categorized, all served locally instead of from an external CDN. Deleted the now-unused stock
images (`hero-2.png`, `hero-3.png`, `hero-4.png`, `photo.jpg`, `photo-color.jpg`) after
confirming nothing else referenced them.

**Bulk & custom estimator rewrite.** The old estimator (`#estimator`) had drifted badly from
the real catalog: hardcoded prices (₱180/₱90/₱450) that didn't match `products.js`, a "3D
print" category priced as if ₱90 were a per-unit price when it was actually copied from a
₱90/hour rate in the prototype draft, zero volume discount despite the value-stack copy above
it promising one, finish add-ons (lamination, foil/emboss) applied identically to categories
they don't make sense for, and a `mailto:` submit path completely disconnected from the cart —
so using it never touched the cart badge, checkout, or the category-priming sticky state above.
Rebuilt it to flatten every priced SKU+variant directly out of `products.js` into the product
picker (so it can't drift from the real catalog again), added real tiered volume discounts
(5%/10%/15% at 25/100/250+ units), made add-ons leaf-aware, added a type-in quantity field
alongside the range slider (typing was the only way to hit precise bulk quantities; dragging a
1–1000 range slider one unit at a time was impractical), and pointed "Add to cart" at the same
`window.KCMPS_STORE.addToCart()` the shop cards use — now exposed publicly for this — instead
of a separate mailto, so it participates in checkout and the priming sticky state like any other
purchase. Leaves with no priced SKUs yet (network, storage) are excluded from the calculator
entirely rather than showing a fabricated number, with a note pointing at the existing
custom-request flow instead. The estimator also defaults its product picker to match whichever
category is currently primed for that visitor, read directly from `kcmps_hero_category`.

### 14. Hero carousel photo pool fix, and organizing 33 DTF design files into the bucket convention (2026-07-25)

**Hero carousel photo pool.** The pool in `assets/manifest.json` (and the static `<figure>`
fallback slides in `index.html`) was a mismatched leftover from prototyping: two generic
stock photos, two externally-hosted images on the base44 CDN, and — worse — the manifest had
the DTF heat-press photos filed under the `merch` category instead of `design`. Replaced with
4 of the leaf photos from entry 13 (print-office, dtf, 3dprint, storage) — one per business
pillar, correctly categorized, served locally. Deleted the now fully-unused stock images.
Confirmed the underlying rotation mechanism this sits on top of (`HERO_MANIFEST_URL` fetch,
Fisher-Yates shuffle with no repeats until the pool is exhausted, `sessionStorage`-persisted
shuffle order, featured-image preference, preload-next-2) was untouched — that system, and
the `storefront-infra/assets-bucket-structure.md` + `logic-inputs/generate-asset-manifest.js`
S3 bucket/manifest plan it's written against, were both already built in an earlier session;
only the manifest's *content* needed fixing.

**Organizing the DTF design archive.** 33 real DTF design files (character/franchise fan art,
Baybayin/Filipino heritage designs, motivational quotes, K-pop/gaming references — the studio's
actual print-ready archive) landed loose in `website/assets/design-dtf/` at full print
resolution (300 DPI, up to 14MB each, ~143MB total). Moved each into its own slug folder under
`website/assets/design/<slug>/` per the bucket convention from entry (13)'s infra doc, named
`01-main-<original filename>.<ext>` — the `01-main` prefix so the manifest generator's
primary-image detection still finds it, the original filename kept as a suffix (rather than
discarded) specifically so it stays traceable back to the source art file. Slugs were derived
from filenames programmatically (strip the redundant word "shirt", slugify the rest) — all 33
produced unique slugs, no manual collision resolution needed. Compressed each from print
resolution down to ~900px/JPEG-82 (2 files were CMYK-encoded and needed an explicit
`-colorspace sRGB` pass — ImageMagick's default resize doesn't shrink CMYK file size the way
it does sRGB, so those two stayed at ~2MB until converted) — 143MB down to ~4.3MB total.
Indexed all 33 into `manifest.json` under `design` with `featured: false`, so they're part of
the catalog's asset index (satisfying the "every uploaded image becomes eligible with zero
frontend changes" plan from entry 13) without flooding the hero carousel's curated featured
pool or the storefront's product cards — `products.js` still lists exactly the same 3 DTF SKUs
+ 1 custom-request card as before; these are a browsable asset pool, not new checkout items.
Also fixed `assets-bucket-structure.md`'s pillar mapping table, which had wrongly assigned the
`dtf`/`subli`/`hotmelt`/`3dprint`/`souvenir` leaves to the `printing-office-supplies` prefix
instead of `design` (predates the taxonomy actually built in entry 13), and still listed the
already-removed `entertainment` leaf. Updated `generate-asset-manifest.js`'s primary-image
regex (`PRIMARY_RE`) from an exact `01-main.<ext>` match to a `01-main` *prefix* match so the
reference Lambda logic stays consistent with the new naming convention.

### 15. DTF design gallery: classify 33 designs, in-card carousel, click-to-enlarge lightbox (2026-07-25)

**Reclassifying the 33 designs.** Entry 14's flat `website/assets/design/<slug>/` layout was
restructured to `website/assets/design/apparel/dtf/<subcategory>/` with images grouped and
renumbered under the 3 real DTF product identities, matching each design's actual content
against the 3 SKUs' own descriptions (bold graphic vs. clean single logo vs. lettered quote):
- `street-statment/` (20) — character/franchise fan art (anime, K-pop, mobile games)
- `clean-logo-transfer/` (4) — wordmark-style/brand-name/personalized designs
- `typographic-quoteprint/` (9) — quote/phrase/lettering-forward pieces, incl. Baybayin script

Files were renumbered `01-`, `02-`, ... within each subcategory, keeping the original
filename as a suffix (per the standing "keep it traceable" requirement from entry 14) —
e.g. `01-BLACK PINK SHIRT.jpg`. `manifest.json`'s design-category entries were regenerated
from the new paths (the 2 curated featured pillar photos from entry 13 untouched).

**In-card gallery + lightbox.** `products.js`'s 3 DTF SKUs each got an `images[]` array
pointing at their subcategory folder. `store.js` gained a generic (leaf-agnostic — reads
only `p.images`/`p.name`, works for any future product that sets the array) gallery/lightbox
system:
- `buildGalleryThumb()` — replaces the plain thumb for any product with `images.length`: shows
  the current image with small left/right arrow buttons overlaid (only rendered when there's
  more than one image) to browse in place on the card, plus a "3 / 20"-style counter badge.
- `openLightbox()`/`buildLightbox()`/`closeLightbox()` — one shared lightbox instance appended
  to `<body>` (same self-injected-singleton pattern as the cart drawer, including the same
  `document.body.style.overflow = "hidden"` scroll-lock while open). Clicking the thumb image
  opens it at the currently-browsed index. Desktop: centered enlarged image over a dimmed
  backdrop with a small icon-only close button and left/right arrows to keep browsing the same
  design set. Mobile (≤760px): the image fills the viewport edge-to-edge against a fully
  opaque backdrop, and the close control switches from the icon to an explicit, clearly
  legible text button — "Exit Fullscreen view" — pinned top-right with a 44px tap target,
  since there's no leftover chrome once the image covers the whole screen to hint how to
  leave. Escape/←/→ keys work while open; clicking the backdrop also closes it.

Verified end-to-end in a real browser: in-card arrows cycle correctly (counter and image both
update), clicking the image opens the lightbox at the right index, lightbox arrows/keyboard/
backdrop-click/close-button all work, scroll un-locks on close, and the mobile/desktop close
button swap (icon vs. text, and the tap-target-size fix) behaves exactly as specified at both
viewport sizes — confirmed via `getComputedStyle`/`getBoundingClientRect`, not just visually
assumed.

### 16. Hero carousel now sources real studio designs instead of stock/leaf photos (2026-07-25)

The hero's featured-image pool (`website/assets/manifest.json`, read by
`buildPoolFromManifest()` in `index.html`) previously featured 4 generic per-pillar leaf
photos (`print-office`, `dtf`, `3dprint`, `storage`). Per request, swapped 3 of the 4 for real
designs out of entry 15's `website/assets/design/apparel/dtf/` catalog — one per subcategory,
picked at random for even coverage of the 3 DTF product lines — keeping the 4th slot on a
leaf photo, also picked at random (landed on `subli`, sublimation). Un-featured the 4 old
leaf entries (`print-office-production`, `dtf-heat-press-transfer`, `3d-printing-prototype`,
`custom-storage-devices`) and added/flagged the new 4:
`street-statment-bts-shirt-1`, `clean-logo-transfer-legends-shirt`,
`typographic-quoteprint-baybayin-maharlika-shirt`, `sublimation-printing`
(new manifest entry → `assets/leaves/subli.jpg`, mirroring how `dtf`/`3dprint` were already
represented as leaf-photo entries under the `design` category).

`index.html`'s static `<figure>` fallback slides (used only if the manifest fetch fails)
were updated to the same 4 images so the no-JS/no-manifest path matches what most visitors
actually see. The existing shuffle/no-repeat/session-persistence carousel mechanism
(entry 13) needed no changes — it already treats the featured pool as opaque data.

Verified via `fetch('assets/manifest.json')` in-browser (exactly the intended 4 entries
`featured:true`) and by reading `#hero-carousel img[src]` after `init()` ran (all 4 designed/
leaf paths present, shuffled), plus a network-request check confirming every image resolves
`200 OK`.

### 17. Mobile hero/nav: logo-tap overlap fix, and a full-bleed 3:4 overlay hero (2026-07-25)

Two related mobile-only bugs, both in `website/index.html`.

**Logo tap left the nav overlapping the hero.** The nav-brand link was a plain `<a
href="#top">`; clicking it let the browser run its native anchor-scroll (smooth, because of
`html { scroll-behavior: smooth }`). `.nav` is `position: sticky` (entry 12), so mid-animation,
whenever the scroll position transiently equals the nav's own height, the nav — which sits
right before `#top` in the DOM — gets pinned back to `top: 0` and paints over the top of the
hero for a frame. Scrolling to the true top afterward "fixed" it because at `scrollY === 0`
there's no pinning offset to fight. **Fix:** the nav-brand click handler now calls
`preventDefault()`, does an instant `window.scrollTo({top:0, behavior:'auto'})`, and
synchronously re-runs the `is-scrolled` toggle so the nav's transparency state can't be stale
either.

**3:4 hero didn't exist yet, and needed a home for the headline.** The bug report described a
mobile hero pattern — full-bleed 3:4 portrait image with the headline overlaid on top — that
hadn't actually been built; the mobile hero was still the same stacked image-then-text layout
as desktop (just narrower breakpoints). Built it at `@media (max-width: 760px)`: `.hero-figure`
and a new `.hero-overlay-content` wrapper (kicker/h1/price-anchor/sub only — CTA, checklist,
and trust chips stay in normal flow below the image) both occupy CSS Grid row 1/column 1, so
the image acts as a background layer under the text. `.hero-overlay-content` is capped by
`max-height: var(--hero-overlay-max)`, which a small script sets from the *measured*
`.nav`/`.sticky-cta` heights and `visualViewport.height` (not a hardcoded pixel guess), so the
headline zone can never grow into the fixed Shop/View Cart bar regardless of viewport height or
which category's headline (`HERO_VARIANTS`, entry 13) is showing. The `.sub` paragraph is also
`-webkit-line-clamp: 3` so on very short viewports it truncates gracefully with an ellipsis
instead of getting silently cut off mid-sentence by the overlay's `overflow: hidden`.
`hero-overlay-content` is a plain wrapper div with no rules outside the 760px query, so desktop
layout/order is untouched — verified at 1280px that the DOM order and two-column grid are
unchanged.

Verified via DOM geometry checks (not screenshots — the sandbox's screenshot/scroll tools were
non-functional this session): 24px of clearance between the overlay and the sticky bar held
across all three `HERO_VARIANTS` headlines at a compact 375×667 viewport, and spying on
`window.scrollTo` confirmed the logo-tap handler fires exactly once with `{top:0, left:0,
behavior:'auto'}` and clears `is-scrolled` synchronously.

### 18. Design catalog: selectable design cards, cart thumbnails, and a collapsed picker with a hover popup (2026-07-25)

Extends the DTF design galleries (entry 15) from "browse in a carousel" to "pick exactly one
design, and see it in the cart." All in `website/products.js` / `website/store.js` /
`website/styles.css` (mirrored into `design-system/KCMPS Redesign/styles.css`).

**Naming convention, shared everywhere a name comes from a filename.** Added
`window.KCMPS_TEXT.titleFromFilename()` in `products.js` (strips a leading `01-` ordering
prefix and the extension, then title-cases kebab/snake/SHOUTY text —
`"01-BLACK PINK SHIRT.jpg"` → `"Black Pink Shirt"`). Applied in three places so formatting
can't drift between them: the hero carousel's alt text (`index.html`), the design picker's
card labels, and the cart line's design name — all three now read from the same function.

**Design as a cart-line attribute, not a separate line item.** Decision point: does picking a
pre-made design add its own purchasable line, or attach as an attribute on the SKU (size/shirt)
line already being configured? Went with the latter — a `designRef`/`designName` pair folded
into the existing `addToCart()` call in `skuCard()`, included in the cart item `key` so two
different designs of the same product/variant are separate cart lines. This reuses the
size/shirt-variant architecture that already existed rather than inventing a parallel product
type; the `designRef` is just the same manifest image path the catalog card displayed, no
duplicate asset upload.

**Selectable grid, capped and collapsible.** `buildGalleryThumb()` was refactored to return
`{el, setIndex, getIndex}` instead of a bare node, so a new `buildDesignGrid()` can drive which
design the large thumb shows and stay notified when the thumb's own prev/next arrows change it
— both stay in sync regardless of which one triggered the change. The grid itself is capped at
`DESIGN_GRID_MAX` (8) tiles: products with more designs than that (Street Statement Print has
20) show 7 real picks plus a dashed "+N more" tile instead of dumping the whole list inline.
Before the cap, cards with wildly different design counts (4 vs 20) left the price/add-to-cart
row starting at very different heights across the same row of cards — capping the grid height
fixed that (verified: all three DTF cards' `.product-buy` rows now sit at an identical
`getBoundingClientRect().top` after render).

**Full list via hover popup, not pagination.** Hovering the picker (or tapping/focusing the
"+N more" tile, for touch/keyboard) opens `.design-popup` — built lazily, appended to
`document.body` rather than the card, so it can span the full page width regardless of how
narrow the product card is. It reuses the same `makePick()` factory as the collapsed grid (one
source of truth for tile markup/selection state), scrolls internally once its wider grid still
overflows, and closes on mouseleave (with a short `hideTimer` so moving the pointer from the
trigger into the popup itself doesn't flicker it shut).

**Bug: `position: fixed` popup positioned with `absolute` math.** First pass computed
`popup.style.top = window.scrollY + rect.bottom` — correct for `position: absolute`, wrong for
`position: fixed` (whose offsets are already viewport-relative). On a page scrolled down to the
DTF cards, this placed the popup thousands of pixels below the visible viewport: it rendered,
had the right content, everything worked in isolation — it just couldn't be seen, which read as
"hovering does nothing." Fixed by dropping the `scrollY` term, plus a `window.addEventListener
('scroll', …)` that repositions the popup if the page scrolls while it's open.

**Cart line now names the design.** `renderCart()` prepends a `<button class="c-thumb">`
(48–64px, using the same `designRef` path) before the item text when present, and the item
name line grows a `<span class="c-design">— {designName}</span>` suffix so the design is
readable without opening the thumbnail. Clicking the thumbnail opens the same shared lightbox
used by the catalog gallery (entry 15) at the full-resolution image — no separate fetch, no
duplicate asset — closable by the existing Esc/click-outside/X handling, which does not touch
cart state.

Verified via `read_page`/`javascript_tool` DOM assertions (the sandbox's screenshot tool was
hanging this session): design selection from both the collapsed grid and the popup correctly
updates the main thumb and the cart's `designRef`/`designName`; the `.design-popup` visibility
bug was reproduced and confirmed fixed against an isolated local server before landing.

### 19. Floating scroll-position indicator (right-edge section rail) (2026-07-25)

A persistent, translucent right-edge rail — a vertical stack of six short line segments, one
per major homepage section (**Hero, How it works, Shop, FAQ, Bulk quote, Contact**) — that
tracks scroll position and jumps to a section on click/tap. Markup is a `<nav
class="scroll-indicator">` before the `.sticky-cta` bar in `index.html`; styles live under
the `— scroll position indicator —` block in `styles.css` (mirrored to `design-system/`); the
behavior script sits with the other end-of-body scripts.

**Section tracking uses `IntersectionObserver`, not scroll math.** Each section node is
observed with `rootMargin: '-35% 0px -55% 0px'`; the callback picks the intersecting entry
closest to the top of that band and toggles `.is-active` on the matching segment (longer +
accent-orange line). This is cheaper and more accurate than recomputing offsets on every
scroll event.

**Click scrolls with a nav-height offset.** `scrollIntoView` can't account for the sticky
nav, so the handler computes `target.top + scrollY − navHeight − 12` from the *live* measured
nav height and calls `window.scrollTo({behavior:'smooth'})`, so the section lands fully below
the nav instead of tucked under it.

**Desktop hover reveal is gated to pointer devices.** The "enlarge + show label" affordance
(`transform: scaleY(1.6) scaleX(1.15)` + label fade-in, transform/opacity only so neighbours
don't reflow) lives inside `@media (hover: hover) and (pointer: fine)`. On real touch devices
that query is false, so labels never appear on hover.

**Mobile was the whole tail of this work — four separate follow-up fixes:**
- *Labels stuck open after tap.* Under desktop DevTools touch-emulation (and some Android
  WebViews) `(hover: hover) and (pointer: fine)` still matches, so a tap-and-hold-slide left a
  sticky `:hover`/`:focus` that pinned the label open. Fixed by explicitly resetting
  `:hover`/`:focus`/`:focus-visible` back to the collapsed state inside the `@media (max-width:
  760px)` block; only `.is-tapped` (a class the click handler adds for ~0.9s, declared last so
  it wins the cascade) flashes the label, since touch has no hover to reveal it with.
- *Segments spread across the whole band.* First mobile pass used `justify-content:
  space-between` over the full nav→cart-bar height, so the lines were spaced far apart. Changed
  to `justify-content: center; gap: 8px` — the rail still stays clipped to the band (via
  JS-measured `--nav-h`/`--stickycta-h`, the same measurement that already feeds
  `--hero-overlay-max`, see step 17) so it never overlaps the nav or the fixed Shop/View Cart
  bar, but the segments now pack as a compact centered stack.
- *Content ran under the rail.* Added a right-edge gutter — `.wrap { padding-right:
  calc(var(--edge) + 20px) }` at ≤760px — reserving room so page content clears the rail
  (verified ~14px gap instead of ~6px overlap). Desktop is untouched: the content sits well
  inside the 1240px max-width so the rail already clears it.
- *Swiping the rail scrolled the page.* Set `pointer-events: none` on the rail container and
  `pointer-events: auto` + `touch-action: none` on each segment, so a swipe that starts on a
  line is absorbed (won't drag the page) while swipes in the gaps between lines fall through to
  the page — no dead scroll-strip on the right edge.

**Positioning.** `z-index: 25`, deliberately between the sticky nav (`z-index: 20`, entry 12)
and the cart drawer/overlay (`z-index: 101`/`100`, entry 6). The rail also auto-hides
(`.is-hidden`) while the cart drawer is open, since both dock on the right edge. Because
`store.js` injects `.cart-drawer` into `<body>` lazily (it doesn't exist at page load), the
watcher is a `MutationObserver` on `document.body` that re-queries `.cart-drawer` on each
mutation rather than observing a node captured at startup — an earlier version observed a
never-present node and silently no-opped.

Verified via DOM/computed-style inspection rather than screenshots (the sandbox's
screenshot/scroll tools were non-functional this session, and the preview tab stayed
backgrounded which froze CSS transitions — so hover/active states were read with transitions
temporarily disabled): `.is-active` follows the in-view section, click math lands sections
below the nav, mobile labels stay collapsed under hover+focus and flash only on `.is-tapped`,
segments pack at 8px gaps, and content clears the rail.

### 20. Print/Office SKU pricing pass, real prices instead of prototype placeholders (2026-07-25)

Before this pass, `print-office` had only two priced SKUs (Catalogs & Booklets ₱180, Custom
Packaging ₱65) left over from the early prototype draft (entry 13) — every other common
print-shop product (document printing, photocopying, lamination, binding, stamps, bookmarks,
business cards, stickers/labels) had no SKU at all. Since quick-buy prices here are live prices
a real customer pays, not display copy, they can't be filled in with placeholders — each of the
8 needed either a real researched number or an explicit "not priced yet" state.

**Pricing basis.** Gathered Metro Manila small-shop competitive ranges for all 8 products
(tarpaulin/large-format excluded per the founders' call — not part of this set). Two products —
spiral/comb binding and bookmarks — had no confirmed local supplier cost, so per the founders'
decision they ship as `quoteOnRequest: true` in `products.js` instead of a guessed price: no
`price`/`variants` field at all, rendered by a new `quoteCard()` in `store.js` (added to cart at
₱0 as a `type: "custom"` pending-approval item, reusing the same quote flow as custom design
requests) rather than a buy card. The other 6 are priced with the founders' chosen position —
slightly above the researched market range's midpoint per product, not premium — e.g. B/W
printing ₱4/page (range ₱3–5), photocopying ₱3/page (range ₱2–3), lamination tiered by size
(₱20 ID / ₱65 A4 / ₱95 8R), stamps tiered by size (₱380/₱480/₱600), business cards ₱450 per
box of 100 (≈₱4.50/pc against a ₱2.50–5.80/pc range), stickers & labels ₱3.50 paper / ₱16
die-cut vinyl.

**Color printing as a same-card add-on, not a separate SKU.** The research treats color as a
per-page surcharge on top of B/W, scaling hugely with ink coverage (₱7–35/page) — modeling it
as a separate flat-priced product would either overcharge light jobs or undercharge
photo-heavy ones. Added a generic tiered add-on mechanism to `skuCard()` in `store.js`
(`p.addon = { label, options: [{label, price}, ...] }`, first option is the free/base tier) —
renders as its own radio group under the size selector, additive into `unitPrice()`/`refresh()`
alongside the existing shirt-toggle add-on. Only the B/W print SKU uses it today (None/Light
+₱10/Medium +₱20/Heavy +₱32 per page), but it's reusable — any future SKU can opt in by adding
the same `addon` shape.

**Estimator bug caught during verification.** The bulk estimator (entry 13) flattens every
catalog SKU into its product picker via `p.variants || [{label:'', price: p.price || 0}]` —
which silently synthesizes a fabricated ₱0.00 line for any product with neither `price` nor
`variants`, exactly the two new `quoteOnRequest` SKUs. Added an explicit skip for
`p.quoteOnRequest` products in that flattening loop (`index.html`) so an unconfirmed price can
never reach the estimator's live quote calculation either — verified via DOM inspection (see
entry 17's note: screenshot capture is unreliable in this sandbox) that both binding and
bookmarks are present as shop-card requests but absent from the estimator dropdown after the
fix, while the other 6 new SKUs and the color add-on's price math verified correct
(₱4 + ₱32 heavy-color tier = ₱36).

### 21. Street-statement designs split into DTF vs. Sublimation subcategories (2026-07-25)

Entry 15's 20-image `street-statment/` set was entirely filed under `dtf` — the `subli` leaf
existed as a tab (per entry 13's taxonomy) but had zero pre-made designs, just the
`comingSoon` custom-request card. Went through each of the 20 mockups and judged DTF vs.
Sublimation suitability by garment color in the photo (DTF prints on any color including
dark; sublimation needs a light/white garment) plus whether the design itself needed
sublimation's full-bleed/photographic strength:
- **Stayed `dtf` (15)** — dark-garment mockups: `BLACK PINK`, `BRAWLSTAR`, `DISHENYO MOBA
  ASSASSIN`, `FEITAN`, `GUSION`, `MIKU`, `MIYA`, `MOBILE LEGENDS`, `native gold`,
  `NINGGUANG`, `RAIDEN SHOGUN`, `RUBIX CUBEZ`, `run mario run`, `SUKUNA ITADORI`, `WITCH`.
  Renumbered `01`–`15` in place.
- **Moved to new `sublimation` subcategory (5)** — light-garment mockups: `BTS SHIRT`
  (photographic group photo), `ONE PIECE LUFFY`/`ONE PIECE ZORO` (full-bleed manga-panel
  prints), plus `BTS SHIRT 1` and `TWICE SHIRT 2` — both simple single-color text-only
  layouts on a light shirt. Those last 2 are flagged as genuinely ambiguous: the fabric
  points to sublimation, but the design content doesn't need sublimation's photographic
  strength and could run as DTF just as easily — needs a production call, not guessed.
  New folder `website/assets/design/apparel/sublimation/street-statment/`, renumbered `01`–`05`.

`products.js`'s `dtf-street-statement` SKU trimmed to the 15 remaining images; a new
`subli-street-statement` SKU (same variant/pricing structure as its DTF counterpart — sizing
carried over as a placeholder, not a confirmed sublimation price sheet) lists the 5 moved
images under the `subli` leaf, which also lost its `comingSoon` flag since it now has a real
priced product. `manifest.json`'s `design` category entries were regenerated to match (new
`sublimation-street-statment-*` skus), preserving the `featured:true` flag on `BTS SHIRT 1`
(one of the 4 hero-carousel picks from entry 16) at its new path. `index.html`'s static
hero fallback slide for that image was updated to the new path/alt text.

Verified in-browser: `KCMPS_STORE_DATA.products` shows `dtf-street-statement` at 15 images
and `subli-street-statement` at 5; clicking Design → Apparel → Subli renders a populated
gallery card (in-card arrows, "1 / 5" counter) instead of the old "coming soon" note; the
new sublimation image path resolves `200 OK` over the network.

### 22. GCash payment confirmation popup before the checkout `mailto:` fires (2026-07-28)

`submitOrder()` used to validate name/contact and immediately navigate to a `mailto:` link —
no confirmation, no payment instructions, no chance to attach a screenshot. The shop accepts
GCash payments manually (see [Payment System file](../project_knowledge/Payment_System_Project_Knowledge.md)
"Bridge Payment Method"), but the storefront gave the customer no instructions on how/where to
pay. This adds a confirmation popup shown right after "Place order," before the mailto fires.

`submitOrder()`'s body (validation + itemized-breakdown construction) moved into a new
`buildOrderEmail(name, contact, fulfill, notes)` returning `{ subject, body, format }` —
`subject`/`body` feed the `mailto:` exactly as before (Contact/Fulfillment/Custom Request
Details header, only including the Custom Request Details line if the cart has a
`type: "custom"` item, followed by the unchanged PAY NOW / PENDING APPROVAL breakdown);
`format` is `"Subject: " + subject + "\n" + body` — the single block of text the popup's copy
button copies, so pasting it manually into an email carries every cart item, not just the
header fields. `submitOrder()` itself now only validates, then calls `openOrderPopup()`
instead of setting `window.location.href` directly — the popup's own "Open email app" button
does that mailto navigation using the stashed `{ subject, body }`.

The popup (`buildOrderPopup()`/`openOrderPopup()`/`closeOrderPopup()`) follows the same
lazy-build-once-then-toggle-`.is-open` pattern as `buildLightbox()` — one `.order-popup-backdrop`
appended to `<body>`, never rebuilt on repeat opens (verified no duplicate nodes accumulate).
It **overlays the still-open cart drawer** rather than replacing it (`.cart-drawer` is
z-index 101; the popup sits at 160, between `.design-popup` 150 and `.lightbox-overlay` 200).
Shows a placeholder QR (`website/assets/gcash-qr-placeholder.svg` — a plain bordered SVG with
"Sample GCash QR — replace with real QR code," so the owner swaps one file later with no code
change), the `ORDER_EMAIL` address, and the copyable format block with a small copy-to-clipboard
icon button (`.btn-icon-copy`, positioned top-right of the block via `.order-popup-format-wrap
{ position: relative }`) that briefly turns green on success.

Two actions: "Open email app" (primary) fires the mailto as described above; "I'll send it
manually" (secondary) closes **both** the popup and the cart drawer — a full exit back to the
main page, not just a dismiss — while clicking the backdrop itself only dismisses the popup,
leaving the drawer/cart untouched (that path is an accidental-click safety net, not an
intentional "I'm done").

One easy-to-miss trap avoided: the popup's `.order-popup` is a scroll container
(`max-height: 90vh; overflow-y: auto`) since the format block can grow long with a big cart,
and a stock full-width scrollbar looked out of place against the rounded card — added
`scrollbar-width: thin` + `scrollbar-color` (Firefox) and `::-webkit-scrollbar*` rules
(Chrome/Safari/Edge) for a slim, low-contrast thumb instead, mirrored into
`design-system/KCMPS Redesign/styles.css` per convention.

Verified in-browser via `window.KCMPS_STORE.addToCart(...)` + DOM/JS assertions (the
in-sandbox screenshot tool was unreliable this session — see entry 17's note, same class of
issue): popup opens over the open drawer on valid submit; empty name/contact still blocks with
the pre-existing `alert()` and never opens the popup; the format block renders the customer's
actual typed values (not placeholder text) plus the full itemized cart; Custom Request Details
line is present only when a custom-type item is in the cart; "I'll send it manually" leaves
`drawerOpen: false, overlayOpen: false`; only one `.order-popup-backdrop` node exists in the
DOM after repeated opens; content overflow at a short viewport height confirmed
`scrollHeight (945) > clientHeight` with the thin-scrollbar CSS applied. This is a front-end-only
interim step — no backend order creation, GCash reference-number field, or S3 screenshot
upload yet; those remain Milestone 1 roadmap items (see
[roadmap.md](roadmap.md#12--gcash-payment-proof-capture-the-missing-customer-facing-half)).

### 23. Swapped the placeholder QR for the owner's real GCash QR (2026-07-28)

Entry 22 shipped a self-contained SVG placeholder (`gcash-qr-placeholder.svg`, a bordered
square labeled "Sample GCash QR — replace with real QR code") specifically so this swap would
later be a one-file drop-in with no code change. Replaced it with the owner's actual GCash
payment QR (`website/assets/gcash-qr.jpg`, a screenshot of the GCash app's InstaPay QR
screen — masked name/mobile/user ID are GCash's own privacy masking, not something this repo
adds or needs to add) and deleted the placeholder SVG.

The one thing that *did* need a code change, contrary to the "no code change needed" claim in
entry 22: the placeholder was a square SVG (180×180 CSS box), but the real screenshot is
portrait (667×1280 intrinsic, GCash's app-screen aspect ratio) — forcing it into a square box
would have stretched/cropped the QR. Updated `.order-popup-qr` (`store.js`'s injected markup,
`styles.css`, and its `design-system/` mirror) to `width: 200px; height: auto` instead of a
fixed square, and the `<img>`'s `width`/`height` attributes to `200`/`384` (200 scaled to the
source's real aspect ratio) so the browser reserves the correct portrait space instead of a
stale square one. Alt text changed from "Placeholder GCash QR code — owner to replace with
the real QR" to "KCMPS GCash QR code — scan to pay" — placeholder language would be
misleading now that it's live.

Deployed straight to the production S3 bucket (`arn:aws:s3:::kcmps-online-bucket-est-2026`,
`kcmps-claude-priv` profile — see `CLAUDE.md` "Deploying to production") after merging to
`main`, per the same `aws s3 sync website/ ...` command as entry 22's deploy, dry-run checked
first.

### 24. Print/office repricing pass, checkout shipping fields, and product photos (2026-07-28)

The owner sent a raw braindump of pricing corrections and two new checkout asks. Cleaned it
into four grouped dev prompts first (`docs/braindump-2026-07-28-pricing-catalog.md`) rather
than working straight off the notes, since several items were genuinely ambiguous (the
2×3/3×5 apparel size note, the pickup non-collection consequence, whether the business-card
minimum needed real enforcement) — those were confirmed with the owner via explicit
decisions before implementing, all recorded in that file.

**`print-office` pricing corrected** (`products.js`): removed Catalogs & Booklets (owner no
longer sells it); Document Printing collapsed from a 4-tier color-density add-on (entry 20)
to a flat two-option B/W ₱4 / Colored ₱7, and renamed off "(B/W)" since color is a first-class
option now, not an afterthought; Lamination re-priced (ID 20→25, A4 65→70) and its 8R variant
swapped for 4R (class-picture size, ₱40 — a swap, not an addition, per the owner's exact
wording); Spiral/Comb Binding and Custom Bookmarks converted from entry 20's `quoteOnRequest`
placeholders to real prices now that the owner has confirmed costs (₱50/90 leaves A5 bind-only;
₱35/2pcs and ₱70/6pcs respectively) — `quoteCard()` still exists in `store.js` for any future
unpriced product, these two just no longer need it; Self-Inking Stamps re-modeled from a
line-count axis (entry 20's Small/Medium/Large ₱380–600) to a size-in-mm axis matching the
owner's real supplier pricing (33×13mm/32×12mm/10×27mm, ₱100–130); Business Cards switched
from a flat ₱450/box-of-100 to per-piece pricing (Front ₱7 / Back-to-back ₱15) with a
genuine minimum-order floor; Stickers & Labels switched from per-piece to per-A4-sheet
pricing for three materials plus a per-inch decal option.

**Business-card minimum is enforced, not just stated.** The owner confirmed (via the
decision flow above) that the 10-pc minimum needed real enforcement, not blurb copy alone —
a copy-only minimum is trivially ignorable. Added an opt-in `minQty` field read by both
`skuCard()`'s add-to-cart stepper (starts at `minQty`, floor clamps there) and the cart-line
stepper in `renderCart()` (looks up the line's product by `id` to find its `minQty` before
allowing a decrement — removing the line entirely via "Remove" still works). No other
product sets `minQty`, so this doesn't change behavior anywhere else.

**Apparel transfer pricing** (`dtf-street-statement`, `subli-street-statement`,
`dtf-logo-transfer`, `dtf-typographic`): A3 raised 120→150 on all four; the shared
`shirtAddon.price` lowered 120→110; the "2×3 in" variant relabeled "3×5 in" (confirmed a
rename, not a second size tier, since the owner's note used the same `-->` "old becomes new"
notation as the A3 change).

**`fulfillmentInput` classification added**, not just pricing. Every `print-office` product
(plus the DTF/Sublimation pre-made transfers) now carries `fulfillmentInput: "file" |
"in-person" | "none"` — "file" for jobs needing the customer's own document/artwork/logo
(document printing, stamps, bookmarks, business cards, stickers, custom packaging),
"in-person" for jobs needing a physical original in-store (photocopying, lamination,
binding — these can't be fulfilled from a digital file alone), "none" for the pre-made
apparel transfers (design comes from the in-card picker, not an upload). `store.js`'s
`cartNeedsFile()` reads this to swap the checkout notes textarea's placeholder to a
file-link prompt only when the cart actually needs one. Deliberately did **not** build a
real upload widget: `mailto:` links cannot carry file attachments (a browser/mail-client
limitation, not a bug in this codebase), so a genuine upload needs the S3 presigned-upload
pattern already planned for Milestone 1.2's `submitPaymentProof` Lambda — this pass stays
scoped to classification + checkout copy.

**Checkout gained courier/shipping fields and two policy statements.** When "Delivery" is
selected, the checkout form now shows a Grab/Lalamove courier choice and address/landmark
fields (toggled via a `syncFulfillFields()` helper in `buildDrawer()`, mirrored by
`buildOrderEmail()`'s new `shipping` parameter so the generated order text includes them);
selecting "Pickup" instead shows a fixed policy line — orders not collected within 3 business
days are cancelled with no refund, confirmed with the owner as the intended consequence
rather than assumed. A separate line states the 1–2 business day confirmation SLA regardless
of fulfillment choice. None of this touches `buildOrderPopup()`/`openOrderPopup()` — the
GCash popup (QR, copy-to-clipboard, mailto composition) is unchanged; only the order text it
displays gained the new fields.

**Product photos generated for the 9 `print-office` SKUs that had none** (all previously
`image: null`, rendering as initials-placeholder thumbs). Used the Pixa image-generation MCP
connector — not a direct Google/Gemini integration, despite one of the two models used
(`imagen4`) being Google's — first attempting `imagen4` (12 credits/image) but hitting the
account's Pixa credit ceiling after the first image (Custom Packaging); the remaining 8 used
`flux-2-klein-4b` (1 credit/image) to fit the 8 credits left, so the 9 images are not from a
uniform model. Saved to `website/assets/products/<id>.jpg` (the one PNG response from
`imagen4` was re-encoded to JPEG for consistency) and wired into each product's `image`
field. Verified via DOM inspection that all 9 load correctly (forcing `loading="lazy"` to
`"eager"` confirmed `complete: true` + correct `naturalWidth` for each) — direct screenshot
capture was unreliable in this sandbox (consistent with entry 17's note on the same issue).

### 25. Onsite-only print-office services gated instead of sold online (2026-07-28)

The owner flagged that not every `print-office` line can actually be fulfilled from an
online order: Photocopying always needs the customer's physical original in-store, and
Lamination/Binding are only realistic online if they're finishing a Document Printing job
placed here (the shop can't laminate/bind a document it never printed). Two designs were
tried before landing on the shipped one — worth recording since the first was fully built
before the owner reversed it.

**First attempt (built, then reverted):** a "Finishing" add-on group on the Document
Printing card itself, letting a customer opt into lamination/binding as a line item on that
same card. The owner's follow-up ("lamination card add to cart button only enables if user
opts for docu print... same logic for binding") made clear they wanted Lamination/Binding to
stay as their own cards, just gated — not folded into Document Printing. Confirmed via
`AskUserQuestion` before reverting: replace the add-on with gating (not layer both), and the
unlock condition is simply "any Document Printing line in the cart" (not a matching
finishing selection).

**Shipped design** (`products.js`): removed Custom Packaging entirely (owner no longer
offers it — the product entry and its `image` reference were deleted; the still-generated
`assets/products/print-custom-packaging.jpg` was left on disk, unreferenced, rather than
deleted). Photocopying gained `noOnlineOrder: true` — `store.js` routes any product with
this flag to a new `inStoreInfoCard()` instead of `skuCard()`/`quoteCard()`: a reference-price
card with an "In-store only" kicker and no Add-to-cart button at all, since there's genuinely
nothing to add. Lamination and Binding gained `requiresCartProduct:
"print-bw-document-printing"` — `skuCard()` reads this to disable "Add to cart" and show a
"Add Document Printing to your cart first to unlock this" note until that product id is
present in the cart, re-checked live via a new `kcmps:cart-change` event (dispatched from
`saveCart()` on every add/qty-change/remove) so unlocking/re-locking never needs a page
reload — added Document Printing while Lamination is already on-screen and it unlocks
immediately; remove it again and Lamination re-locks.

**Bug caught and fixed in the same pass:** the bulk estimator (`index.html`) builds its own
product dropdown and calls `KCMPS_STORE.addToCart` directly, bypassing `skuCard()`'s gate UI
entirely — it could add Lamination/Binding to the cart with zero Document Printing present,
or "sell" Photocopying online despite the new in-store-only card. Fixed by excluding both
`noOnlineOrder` and `requiresCartProduct` products from the estimator's flattened list.

**A second, more serious bug surfaced after this shipped its first pass and the owner
tested it live**: adding Document Printing to the cart, then removing it, left Document
Printing's own "Add to cart" button permanently disabled — not just Lamination/Binding's.
Root cause: the add-button click handler always sets `addBtn.disabled = true` for the
"Added ✓" animation, then a `setTimeout` was supposed to restore it via `syncGate()` — but
`syncGate()` early-returns `if (!p.requiresCartProduct)`, so for every *ungated* product
(including Document Printing itself) the button's `disabled` flag was never reset back to
`false`. One click permanently disabled any ungated product's own button. Fixed by having
the `setTimeout` callback call `syncGate()` only for gated products and reset
`addBtn.disabled = false` directly otherwise.

**Card ordering also got a pass**: `renderCatalog()` used to render products in their
`products.js` array order, which put Photocopying's `noOnlineOrder` card in the middle of
the purchasable Document Printing/Lamination/Binding run — it read as visually broken rather
than intentionally different. Reordered so every leaf's grid now renders all purchasable
cards first, then its `noOnlineOrder` cards, then the leaf's custom-request card last —
grouping "can't buy this online" cards next to the "request something custom" card instead
of interleaving them with Add-to-cart cards.

**Unrelated fixes bundled into the same round:** the bulk estimator's quantity input/slider
was capped at 100 (was 1000) — production genuinely can't fulfill runs larger than that, so
the copy now reads "capped at 100 units per order — for a larger run, message us directly."
A browser-tab favicon was also added (`assets/favicon.ico`/`favicon.png`/
`apple-touch-icon.png`, generated from the existing `assets/logo-mark.png`) since the site
previously had none.

### 26. Login/Sign-up button disabled pending real auth rollout (2026-07-28)

The owner asked to disable the nav's Login/Sign-up button (feature under development) without
removing the underlying Cognito auth code — mirroring the same disabled-with-explanation
pattern used for the gated Lamination/Binding cards in entry 25. Added `disabled` to the
button in both its initial markup (`index.html`'s `#auth-area`) and `renderLoggedOut()`
(the function that re-renders it after logout), so it stays disabled across every render
path, not just first paint.

The "Currently under development" explanation is a native `title` tooltip placed on the
wrapping `#auth-area` span, not the `<button>` itself — disabled elements don't reliably
fire hover/mouseover events in Firefox, so a `title` on a disabled button can silently never
show there. A non-disabled wrapper always receives the hover regardless of the button's
state.

No auth logic changed: `startLogin()`, `openLoginPopup()`, `renderLoggedIn()`, token
exchange/storage, and the Staff-group dashboard-link branching are all untouched — the
click listener is even still attached (disabled buttons don't fire `click`, so it's inert
rather than removed). Re-enabling later is just deleting the `disabled` attribute/line and
the two `title` lines.

## Auth implementation notes

Building `login-test.html` surfaced several non-obvious problems specific to doing OAuth from
a static, serverless SPA. These are documented here (and in comments in the file itself) so
they aren't rediscovered the hard way when auth gets touched again.

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
