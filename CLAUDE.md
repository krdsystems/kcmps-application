# CLAUDE.md — KCMPS

Root orientation for Claude Code sessions in this repo. Keep this file short — it's read on
every session start. Deep history and rationale live in `docs/history.md`; don't load that
file unless you specifically need "why was it built this way."

## What this is

KCMPS: a Manila print/merch shop's marketing site + storefront (custom apparel printing,
design services) with a staff-only ops dashboard. Static site, no backend yet — Cognito auth
and a localStorage-backed cart/dashboard are built to swap to a real API later with minimal
code changes (see "Migration seams" below).

## Hard constraint: what's deployed

**Only `website/` is deployed** — synced verbatim to an S3 bucket, no build step, no
bundler. Never add dev-only files (docs, test scripts, infra code) inside `website/`; they'd
go live. Everything non-deployed has its own top-level sibling folder:
`design-system/`, `ops-dashboard/`, `storefront-infra/`, `backend/`, `project_knowledge/`, `docs/`.

Stack: vanilla HTML5, ES6, Tailwind via CDN (storefront) / hand-written `styles.css` (design
system tokens + components, no utility framework). No `package.json`, no npm install, no
build — edits are live on refresh.

## Key files — feature → location

| Need to touch...              | Go to |
|---|---|
| Cart logic, checkout          | `website/store.js` — `addToCart`, `setQty`, `removeItem`, `payNowTotal`, `submitOrder`, public API `window.KCMPS_STORE` |
| Bulk quantity-discount pricing | Product opts in via `bulkTiers: [{minQty, discountPct}]` in `products.js`; `store.js`'s `activeBulkTier()`/`bulkUnitPrice()` (exposed on `window.KCMPS_STORE`) apply it in `skuCard()`'s live price/qty-stepper, cart-line `setQty()`/`addToCart()` re-tiering, and the `index.html` `#estimator` bulk-quote widget — all three read the same tiers so they can't quote different prices |
| GCash payment popup (post-"Place order", pre-mailto) | `store.js` `buildOrderEmail()` (builds `{subject, body, format}` from the checkout form + cart — `format` is the full copyable message, header fields + itemized breakdown) and `openOrderPopup()`/`closeOrderPopup()` (lazy-built `.order-popup-backdrop`, overlays the still-open cart drawer, z-index 160); QR asset `website/assets/gcash-qr.jpg` (real, owner's GCash — portrait aspect ratio, `.order-popup-qr` CSS sizes it `width: 200px; height: auto`, don't force it square) |
| Catalog / product data        | `website/products.js` — `window.KCMPS_STORE_DATA = { currency, shirtAddon, leaves, products }`; each leaf has an `image` (AI-generated, `website/assets/leaves/<leaf>.jpg`) used as the product-thumb fallback in `store.js`'s `thumbImage()` |
| Filename → display-title convention | `window.KCMPS_TEXT.titleFromFilename()` in `products.js` — shared by the hero carousel, the design picker grid, and cart thumbnails so naming never drifts between views |
| Design picker (pre-made design selection) | `store.js` `buildDesignGrid()` — selectable design cards under a SKU's gallery thumb, capped at `DESIGN_GRID_MAX` (8) tiles with a hover/tap "+N more" popup for the rest; selection travels into the cart line as `designRef`/`designName` (see `addToCart` call in `skuCard()`) |
| Page structure / copy         | `website/index.html` — value-stack amounts & guarantee wording marked inline as owner-editable |
| Auth (Cognito login/logout)   | `website/index.html` `<script>` block; isolated reference/debug copy at `website/login-test.html` |
| Design tokens / components    | `website/styles.css` (deployed copy) — mirror any change into `design-system/KCMPS Redesign/styles.css` |
| Carousel timing               | `.carousel-track transition` in `styles.css`; `AUTO_MS` in `index.html` |
| Scroll-position indicator     | `<nav class="scroll-indicator">` before `.sticky-cta` in `index.html` + its behavior script; `— scroll position indicator —` block in `styles.css`. Each segment's `data-target` = a section `id`; active-tracking via `IntersectionObserver` |
| Hero carousel image pool      | `HERO_MANIFEST_URL` + shuffle logic in `index.html`; sourced from `website/assets/manifest.json` (local sample) — real bucket plan in `storefront-infra/assets-bucket-structure.md` |
| Hero category priming (headline/CTA copy) | `PAGE_VARIANTS` (3-way pool: `print-office` / `design` / `merch`) + state machine in `index.html` (key: `kcmps_hero_category`, sessionStorage pre-cart → localStorage 7-day sticky after any cart-add, promoted via the `kcmps:cart-add` event dispatched from `store.js`'s `addToCart`) |
| Checkout endpoint             | `ORDER_EMAIL` constant near top of `website/store.js` — order-intake address the checkout `mailto:` is addressed to (`order@kcmps.com`) |
| General/contact email         | Footer "Contact channels" block in `website/index.html` (`info@kcmps.com`) |
| Ops dashboard pages           | `website/dashboard/*.html` + shared `dashboard.css`/`dashboard-shell.js` |
| Ops dashboard mock data/API   | `website/dashboard/dashboard-data.js` — `window.KCMPS_DASH.*`; never touch `localStorage` directly outside this file |
| AWS infra plan (not deployed) | `ops-dashboard/infra/backend-infra-to-deploy.md` + `ops-dashboard/infra/logic-inputs/*.js` (Lambda source) |
| Shared backend conventions (not deployed) | `backend/lib/` — `constants.js`/`money.js`/`keys.js`/`item.js`/`events.js`/`auth.js`/`gsi.js`, the single module every future Lambda imports for status vocabulary, centavo money, PK/SK strings, and role checks (see its own `CLAUDE.md`); test with `node --test backend/lib/` |
| Milestone 1.0 foundation (CloudFormation, owner-applied) | `backend/infra/foundation.cfn.yaml` — single DynamoDB table + GSI1 + Streams/PITR/deletion-protection, and the 5 Cognito groups added to the *existing* user pool; apply/rollback steps in `backend/infra/README.md` |
| Product-image bucket plan (not deployed) | `storefront-infra/assets-bucket-structure.md` + `storefront-infra/logic-inputs/generate-asset-manifest.js` |
| Payment/GCash logic spec      | `project_knowledge/Payment_System_Project_Knowledge.md` |
| ERP architecture (north star) | `project_knowledge/ERP_System_Project_Knowledge.md` — 9-module map, 3-stage scale path, build-vs-integrate (Finance), launch-blocking data conventions |
| Roadmap / next goals          | `docs/roadmap.md` — current-state → prioritized milestones; current focus is Milestone 1, the simple payment backend |
| Design system full reference  | `design-system/KCMPS Redesign/readme.md` (see also its own `CLAUDE.md`) |

Prefer this table + `Grep`/`Glob` over reading whole files or the README for orientation.
Line numbers drift; the function/constant names above are stable anchors — grep for them.

## Conventions and gotchas (learned the hard way — don't regress)

- **Migration seams**: both `store.js` (`window.KCMPS_STORE`) and `dashboard-data.js`
  (`window.KCMPS_DASH`) are the *only* things callers touch — no page reads `localStorage`
  directly. When a backend exists, only these two files' function bodies change to `fetch()`.
  Keep new features behind this same seam.
- **Auth tokens** live in `sessionStorage`, not `localStorage` (deliberate XSS-exposure
  tradeoff — see `docs/history.md#auth-implementation-notes` before changing this).
- **Client-decoded JWT claims are UI-only**, never trust them server-side once a backend
  exists — any future Lambda must re-verify against Cognito's JWKS.
- **Mobile**: `overflow-x: hidden` on `html` only (not `body` — see
  `docs/history.md` step 12, promoting both axes to a scroll container breaks `position:
  sticky`) and the `@media (max-width: 760px)` / `(max-width: 480px)` rules in `styles.css` fix
  specific overlap bugs (nav, cart drawer). Don't remove them without re-testing at 375px.
- **Mobile hero nav-brand click** (`index.html`, near the `.nav` script): logo tap does a
  manual `window.scrollTo({top:0, behavior:'auto'})` + synchronous `is-scrolled` recompute
  instead of a plain `#top` anchor jump — the native smooth-scroll anchor jump transiently pins
  the sticky nav over the hero. Don't revert to a plain anchor link without re-testing (see
  `docs/history.md` step 17). The mobile hero's overlaid headline zone
  (`.hero-overlay-content`, ≤760px) is height-capped by a JS-measured `--hero-overlay-max` CSS
  var, not a hardcoded pixel value — keep it that way so it survives viewport-height and
  headline-copy changes without re-overlapping the fixed Shop/View Cart bar.
- **Scroll-position indicator** (`.scroll-indicator`, `z-index: 25`): sits deliberately between
  the sticky nav (`z-index: 20`) and the cart drawer/overlay (`101`/`100`), and auto-hides while
  the drawer is open. Its drawer watcher is a `MutationObserver` on `document.body` (not on
  `.cart-drawer`) because `store.js` injects the drawer lazily — don't "optimize" it to observe
  the node directly. Desktop hover-reveal is gated to `@media (hover: hover) and (pointer:
  fine)`; the mobile (≤760px) block additionally *resets* `:hover`/`:focus` back to collapsed so
  DevTools touch-emulation can't leave labels stuck open (only `.is-tapped` flashes them).
  Segments use `pointer-events: none` on the container + `auto` on items so swipes in the gaps
  still scroll the page. See `docs/history.md` step 18 before changing any of this. Mobile
  (≤760px) also renders a full-viewport-height `.scroll-indicator::before` dead-zone border,
  anchored to the rail's real left edge via `--indicator-left` (measured in JS in `index.html`,
  same IIFE as `--nav-h`/`--stickycta-h`) — the rail's flex item reserves its label's width even
  while collapsed/invisible, so card buttons on the right edge can sit under that invisible
  box; the border is purely visual (`pointer-events` inherits `none`) and doesn't touch the hit
  area. See `docs/history.md` step 28.
- **Brand system**: navy-dominant, one orange accent reserved for a single CTA per screen,
  rounded/friendly geometry. Build from `styles.css` classes/CSS variables, don't hardcode
  colors — see `design-system/`.
- Editing `website/styles.css`? Also update `design-system/KCMPS Redesign/styles.css` so the
  reference docs don't drift from the live site.
- **`.design-popup` (store.js, the design picker's "+N more" flyout) is `position: fixed`** —
  its `top` must be plain `rect.bottom`, never `window.scrollY + rect.bottom` (that math is
  only correct for `position: absolute`). Adding `scrollY` renders the popup thousands of
  pixels below the viewport on any page scrolled past the top — it looked like "hover does
  nothing" rather than a visible bug (see `docs/history.md` step 18).

## Git / worktree workflow

- Feature work happens on `claude/<slug>` branches, often in a git worktree under
  `.claude/worktrees/<slug>` for parallel sessions.
- **After a worktree's branch is merged into `main`, remove it**: `git worktree remove
  .claude/worktrees/<slug>`. Stale merged worktrees are full repo copies (100+ files, several
  MB each) that inflate every subsequent glob/grep across the repo — prune them as part of
  finishing a task, don't leave it for later.
- Check `git worktree list` and `git branch --merged main` at the start of a session if
  `.claude/worktrees/` looks stale.

## Local dev

```bash
cd website && python3 -m http.server 5500
```

Cognito needs `http(s)://`, not `file://`. Full setup and testing checklist: `README.md`.

## Deploying to production

`website/` syncs verbatim to S3 bucket `arn:aws:s3:::kcmps-online-bucket-est-2026` (no build
step). Use the `kcmps-claude-priv` AWS CLI profile:

```bash
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile kcmps-claude-priv
```

Deliberately **no `--delete`** — this only uploads new/changed files, it never removes
anything from the bucket that isn't in `website/` locally (the bucket has pre-existing
content outside this repo's management, e.g. a root `README.md` and an `Assets/` folder,
distinct from `website/assets/`). Run a `--dryrun` first if unsure what a sync will touch.

## Where to look next

- What to build next / prioritized goals → `docs/roadmap.md`; the ERP architecture it serves → `project_knowledge/ERP_System_Project_Knowledge.md`
- Current-state overview, layout diagram, local dev, testing checklist → `README.md`
- Full build log / design rationale / auth implementation notes → `docs/history.md`
- Design-system-specific, ops-dashboard-specific, storefront-infra-specific, and
  backend-specific notes → their own `CLAUDE.md` files
