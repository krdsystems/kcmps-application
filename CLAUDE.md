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
| Order-quantity capacity soft-cap | Product opts in via `softCap: N` in `products.js` (the qty above which KCMPS's 4-person team needs extra lead time). `store.js`'s `requestQty()` (exposed on `window.KCMPS_STORE`) is the single gate every qty input — `skuCard()`'s stepper, cart-drawer line stepper, and the `#estimator` qty field — routes a requested value through, passing a per-product `key` (`p.id`/`i.id`/`opt.id`); it pops the `.cap-popup-backdrop` confirmation (extra-lead-time copy, or a hard-ceiling "message us" notice at 5x the cap) and only commits the higher value once the shopper clicks "I agree" — which only unlocks that one product's cap, not every product's. See the "Capacity soft-cap" gotcha below before touching this. |
| Bulk-quote Step 01 product picker | `index.html` `#estimator` inline `<script>` — tabbed thumbnail/name/price cards (`.est-product-tabs`/`.est-product-grid`/`.est-product-pick`) built from the same `options` list sourced off `window.KCMPS_STORE_DATA.products`; one tab per catalog leaf, reusing the page's generic `[data-tabs]` click-handler. The original `<select id="est-product">` stays in the DOM (`display:none`) as the single source of truth — clicking a card just sets its value and fires `change`, so `currentOption()`/pricing/cart-add are untouched. See the "Bulk-quote product picker" gotcha below before changing this. |
| GCash payment popup (post-"Place order", pre-mailto) | `store.js` `buildOrderEmail()` (builds `{subject, body, format}` from the checkout form + cart — `format` is the full copyable message, header fields + itemized breakdown, including a per-line `Design: <name>` when the line carries a `designRef`/`designName`, and `with shirt (<color>)` when it carries `shirtColor`) and `openOrderPopup()`/`closeOrderPopup()` (lazy-built `.order-popup-backdrop`, overlays the still-open cart drawer, z-index 160); QR asset `website/assets/gcash-qr.jpg` (real, owner's GCash — portrait aspect ratio, `.order-popup-qr` CSS sizes it `width: 200px; height: auto`, don't force it square) |
| Catalog / product data        | `website/products.js` — `window.KCMPS_STORE_DATA = { currency, shirtAddon, leaves, products }`; each leaf has an `image` (AI-generated, `website/assets/leaves/<leaf>.jpg`) used as the product-thumb fallback in `store.js`'s `thumbImage()` |
| Filename → display-title convention | `window.KCMPS_TEXT.titleFromFilename()` in `products.js` — shared by the hero carousel, the design picker grid, and cart thumbnails so naming never drifts between views |
| Design picker (pre-made design selection) | `store.js` `buildDesignGrid()` — selectable design cards under a SKU's gallery thumb, capped at `DESIGN_GRID_MAX` (8) tiles with a hover/tap "+N more" popup for the rest; clicking any tile (inline, popup, or the mobile subcatalog) opens the shared fullscreen lightbox rather than selecting instantly — see "Fullscreen design lightbox" below; selection travels into the cart line as `designRef`/`designName` (see `addToCart` call in `skuCard()`) |
| Fullscreen design lightbox (purchasable) | `store.js` `openLightbox()`/`buildLightbox()` — the shared overlay always shows "Select this design" plus a size seg, quantity input, and "Add to cart" whenever opened with the optional `onSelect`/`controls` params; every design-subsection trigger (gallery thumb image, inline/popup design tiles, mobile subcatalog) routes through `skuCard()`'s `openDesignLightbox()`, which builds those `controls` via `buildLightboxControls()` and delegates the actual add to the card's own `addBtn.click()` (never duplicates cart-line construction, so bulk tiers/shirt-addon/design-ref can't drift between the card and the lightbox) |
| Shirt color choice (Black/White/Custom) | `store.js` `skuCard()`'s `.shirt-row` block, next to the `p.shirtAddon` checkbox — the three picks are `disabled`/dimmed until that checkbox is checked; "Custom" is a two-step pick (opens a panel with a native color input + live hex readout, only "Use this color" commits — don't apply on the swatch's own click, see the gotcha below) and the result travels as `shirtColor` on the cart line into the drawer meta and `buildOrderEmail()` |
| Page structure / copy         | `website/index.html` — value-stack amounts & guarantee wording marked inline as owner-editable |
| Hero→shop card-deck reveal    | `index.html` — `.hero-deck`/`.hero-stage` CSS + the `--deck-out`/`--deck-in` `:root` rules in the inline `<style>`, driven by the deck-scroll IIFE (grep `--deck-progress`). See the "Card-deck reveal" gotcha below before touching any of it |
| Auth (Cognito login/logout)   | `website/index.html` `<script>` block; isolated reference/debug copy at `website/login-test.html` |
| Design tokens / components    | `website/styles.css` (deployed copy) — mirror any change into `design-system/KCMPS Redesign/styles.css` |
| Carousel timing               | `.carousel-track transition` in `styles.css`; `AUTO_MS` in `index.html` |
| Scroll-position indicator     | `<nav class="scroll-indicator">` before `.sticky-cta` in `index.html` + its behavior script; `— scroll position indicator —` block in `styles.css`. Each segment's `data-target` = a section `id`; active-tracking via `IntersectionObserver` (filtered to skip `.hero-deck.is-passed` descendants), click-to-scroll via native `scrollIntoView` + the sections' `scroll-margin-top` |
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
| dev/staging domain (`dev.kcmps.com`) infra | `storefront-infra/dev-domain.cfn.yaml` — CloudFormation for the second CloudFront distribution + basic-auth Function + response-headers policy, applied via `aws cloudformation deploy` with `kcmps-claude-priv` (needs its own IAM policy grant — see `storefront-infra/CLAUDE.md`) |
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
- **Bulk-quote product picker** (`index.html` `#estimator`, replaced a plain `<select>` — owner
  found it too hard to use): the hidden `<select id="est-product">` is still the only thing
  `currentOption()`/pricing/`addToCart()` read from. `selectOption(id)` is the single place that
  writes to it (sets `.value`, syncs `.is-selected` on cards, fires `change`) — any new way of
  picking a product must go through it, not set `productSel.value` directly. Tabs reuse the
  site's existing generic `[data-tabs]` click-handler script (same `<script>` tag, runs right
  after this IIFE) instead of custom JS — don't duplicate that logic here. The primed-category
  read (`readPrimedCategory()`/`CATEGORY_TO_LEAF`) runs *before* the tab markup is built so the
  matching leaf's tab can render `is-active` from the start; moving it after would default to
  the first tab regardless of priming. `.est-product-grid` caps `max-height` with internal
  vertical scroll per tab (same bounded-grid idea as `buildDesignGrid()`'s `DESIGN_GRID_MAX`) so
  a category with many variants doesn't push Step 02 down the page.
- **Capacity soft-cap** (`store.js`, `requestQty()`/`capAcknowledgedByKey`): the "I agree"
  override is a plain in-memory object, deliberately *not* `sessionStorage`/`localStorage` — the
  requirement was that it resets on page refresh, which rules out both Web Storage APIs (they'd
  survive a refresh; only closing the tab/losing the JS context clears a module variable). It's
  keyed **per product** (`requestQty`'s 4th `key` arg — `p.id` from `skuCard()`, `i.id` from the
  cart-drawer line, `opt.id` from the `#estimator`), not one flag for the whole page: agreeing to
  a big order on one product doesn't silently wave a different product's overflow through, but a
  given product's card and cart line share the same key so agreeing in one place carries to the
  other. Cap-check calls are on *commit* only (blur/Enter on typed fields, `change` not `input`
  on the estimator's range slider, the product-card stepper's `+` button) — never on every
  keystroke/drag tick, or the popup would interrupt the shopper mid-input. The hard ceiling (5x
  the product's `softCap`) has no "I agree" path at all — it's genuinely too large to self-serve
  online and always clamps to the ceiling, pointing the shopper at a manual quote instead.
- **Card-deck reveal** (`.hero-deck`/`.hero-stage`, `index.html`): the hero is a `position:
  sticky` card pinned inside a taller wrapper while `#storefront` is pulled up underneath by a
  negative margin. Every number derives from ONE measured input, `H = stage.offsetHeight` —
  sticky top `T = min(navH, V - ctaH - H)` (`--deck-top`) and shop lift `M = -(H + T - navH)`
  (`--deck-margin`). Never hardcode either, and never tune one without the other: `top: 0`
  silently assumes the hero fits the viewport (true on desktop, false on mobile where it's
  ~1.25–2x), and an independently-tuned lift disagrees with the pin on some screen, producing
  either a multi-scroll dead gap or an unreachable hero. Negative `T` is correct and load-
  bearing — it bottom-anchors a too-tall hero so all its content stays scrollable-to.
  Three more traps, each of which shipped as a bug once: (1) `.hero-deck` needs
  `pointer-events: none` (with `auto` restored on `.hero-stage`) — it's a tall box painting
  nothing at `z-index: 4` that the shop is pulled up *inside*, so it hit-tests above the
  shop's `z-index: 1` and eats clicks on the category tabs. (2) `.is-passed` must fire at
  `progress >= 0.5`, where the hero's opacity actually reaches 0 — waiting for ~1 leaves an
  invisible card blocking the shop. (3) The hero and shop cross-fade *sequentially* via
  `--deck-out`/`--deck-in`, not simultaneously; overlapping ramps double-expose the two
  headlines. `measure()` runs inside the scroll frame (guarded so it only writes on real
  change) because `fonts.ready` + `ResizeObserver` alone still went ~68px stale. See
  `docs/history.md` step 34.
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
  `docs/history.md` step 17).
- **Mobile hero (`≤760px`) does NOT overlay text on the photo.** The photo runs full-bleed
  (negative `margin-inline` cancelling `.wrap`'s padding) at `4/3`, and `.hero-copy` + CTA +
  checklist + trust chips live in a light card (`.hero > div:first-child`, `margin-top: -28px`,
  rounded top) that overlaps its bottom edge — so copy contrast is inherited from the page
  surface and is independent of whatever photo the carousel pool serves. Don't "simplify" this
  back to copy-over-image with a scrim: the pool contains both near-black and blown-out-white
  shots, and the only scrim alpha that carried white text over *both* (~0.6 navy) greyed out
  every photo and still clipped the sub-line on narrow phones. The card re-sequences its
  children with flex `order` (CTA above checklist), never by reordering the DOM, so desktop is
  untouched.
- **Scroll-position indicator** (`.scroll-indicator`, `z-index: 25`): sits deliberately between
  the sticky nav (`z-index: 20`) and the cart drawer/overlay (`101`/`100`), and auto-hides while
  the drawer is open. Its drawer watcher is a `MutationObserver` on `document.body` (not on
  `.cart-drawer`) because `store.js` injects the drawer lazily — don't "optimize" it to observe
  the node directly. Desktop hover-reveal is gated to `@media (hover: hover) and (pointer:
  fine)`; the mobile (≤760px) block additionally *resets* `:hover`/`:focus` back to collapsed so
  DevTools touch-emulation can't leave labels stuck open (only `.is-tapped` flashes them).
  Segments use `pointer-events: none` on the container + `auto` on items (desktop/base) so
  swipes in the gaps still scroll the page. See `docs/history.md` step 18 before changing any
  of this. Mobile (≤760px) also narrows the *real* tap target one level further: the
  item's flex box reserves its label's full width even while the label sits at `opacity: 0`
  (not `display: none`), so without this the reserved-but-invisible zone would still swallow
  taps meant for whatever card button sits behind it. The mobile block overrides
  `.scroll-indicator-item` to `pointer-events: none` (and moves `touch-action: none` onto
  `.scroll-indicator-line`, which gets `pointer-events: auto`) so only the 12–18px visible
  line is actually tappable — `pointer-events` is inherited, so the label needs no separate
  override. The click listener still fires via bubbling since it reads `item.dataset.target`
  through closure, not `event.target`. See `docs/history.md` step 28.
- **`.offer-grid` (shop product grid, `index.html` inline `<style>`)** has `min-width: 0` on
  its direct children — grid items default to `min-width: auto`, so a card with enough content
  (e.g. print-office's bulk-tier pricing UI) can blow out past its `1fr` track on mobile
  instead of shrinking to it, visually bleeding under the scroll-indicator rail. Applies to
  every shop leaf (print/design/merch) since they share this one grid class — don't scope a
  fix to a single leaf's cards. See `docs/history.md` step 32.
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
- **`.design-popup` is desktop-only** (`buildDesignGrid()`'s `isHoverCapable()` check, gated
  on the same `(hover: hover) and (pointer: fine)` query as the scroll-indicator). No-hover/
  touch devices get a single-tap full-screen `.design-subcatalog` sheet instead (all designs,
  not just the `DESIGN_GRID_MAX`-capped overflow) — the old touch fallback toggled the tiny
  flyout on tap, which needed a second tap to actually use.
- **Every design-tile click opens the fullscreen lightbox — none of them select instantly
  anymore.** The gallery thumb image, inline design-grid tiles, `.design-popup` tiles, and
  `.design-subcatalog` tiles all call `skuCard()`'s `openDesignLightbox(i)`, which opens
  `openLightbox()` with an `onSelect` (finishes `gallery.setIndex()` + `designPicker.sync()`)
  and a `controls` object (size seg + qty + Add-to-cart, from `buildLightboxControls()`) —
  both always passed together from this codebase's only caller of that pair. Don't reintroduce
  a second "select on click" path on any tile; route new pickers through `openDesignLightbox`/
  `openImage` so the lightbox stays the single confirm step.
- **An invisible full-bleed `<input>` layered over a button is a click sink, not a
  decoration.** The shirt-color "Custom" swatch originally had a `<input type="color">`
  positioned `inset: 0` over the whole button so clicking it opened the native color dialog;
  the input's own click handler called `stopPropagation()` to stop the click reaching the
  button underneath, which meant the button's *own* selection handler (`selectShirtColor`)
  never ran — no highlight, no confirm, and the color never reached the cart, because
  `shirtColor` was never actually set. Black/White worked since they had no overlay. Fixed by
  making Custom a real two-step flow: the swatch opens a `.shirt-color-custom-panel` (visible
  native color input, live hex text) and only its own "Use this color" button calls
  `selectShirtColor("custom")`. See `docs/history.md` step 35.
- **Lightbox quantity commits defensively, not just on blur.** `.lightbox-qty-val` is a real
  `<input type="number">` (commit-on-blur/Enter, mirroring the product card's `qval`), but the
  +/−/Add-to-cart buttons each call `commitLightboxQty()` themselves before acting — a click on
  one of them can reach its own handler before the still-focused input's `blur` fires,
  otherwise silently dropping a freshly-typed quantity back to 1. The overlay's global
  `keydown` (Escape/arrow-step) also early-returns when `e.target` is that input, so typing
  digits doesn't step the design carousel underneath.

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

## Deploying to the dev/staging domain

`dev.kcmps.com` is a second CloudFront distribution (stack `kcmps-dev-domain`, defined in
`storefront-infra/dev-domain.cfn.yaml`) sitting in front of the **same** S3 bucket as
production, reading from a `dev-site/` prefix instead of the root — so it never overlaps
with or overwrites the live site. Same `CachingDisabled` behavior as prod, so a sync shows
up immediately with no invalidation step.

```bash
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ --profile kcmps-claude-priv
```

`dev.kcmps.com` is gated behind CloudFront-Function basic auth (credentials aren't in this
repo — ask whoever set up the stack, or check the password manager entry). See
`storefront-infra/CLAUDE.md` for the stack's architecture, IAM policy requirements, and
rollback notes before touching it.

## Where to look next

- What to build next / prioritized goals → `docs/roadmap.md`; the ERP architecture it serves → `project_knowledge/ERP_System_Project_Knowledge.md`
- Current-state overview, layout diagram, local dev, testing checklist → `README.md`
- Full build log / design rationale / auth implementation notes → `docs/history.md`
- Design-system-specific, ops-dashboard-specific, storefront-infra-specific, and
  backend-specific notes → their own `CLAUDE.md` files
