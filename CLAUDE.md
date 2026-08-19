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

Stack: vanilla HTML5, ES6, hand-written `styles.css` (design system tokens + components, no
utility framework — there is **no Tailwind anywhere in `website/`**, despite what this line
used to claim; verified by grep 2026-08-06, don't reintroduce the belief or chase it as a
performance suspect). No `package.json`, no npm install, no build — edits are live on refresh.

## Cost governance

Target AWS spend is a **soft cap for review, not a hard stop**: ₱500/mo (~US$9) pre-revenue,
rising once revenue flows to `max(₱500/mo, 3% of trailing-30-day gross revenue)`. Staying under
it needs no extra justification; going over it is fine as long as any change pushing spend past
the line states what it costs and why it's worth it, rather than shipping silently. Full
formula, current spend baseline, and a decision log of past cost calls →
[docs/cost-governance.md](docs/cost-governance.md).

## Key files — feature → location

| Need to touch...              | Go to |
|---|---|
| Cart logic, checkout          | `website/store.js` — `addToCart`, `setQty`, `removeItem`, `payNowTotal`, `submitOrder`, public API `window.KCMPS_STORE` |
| Bulk quantity-discount pricing | Product opts in via `bulkTiers: [{minQty, discountPct}]` in `products.js`; `store.js`'s `activeBulkTier()`/`bulkUnitPrice()` (exposed on `window.KCMPS_STORE`) apply it in `skuCard()`'s live price/qty-stepper, cart-line `setQty()`/`addToCart()` re-tiering, and the `index.html` `#estimator` bulk-quote widget — all three read the same tiers so they can't quote different prices |
| Order-quantity capacity soft-cap | Product opts in via `softCap: N` in `products.js` (the qty above which KCMPS's 4-person team needs extra lead time). `store.js`'s `requestQty()` (exposed on `window.KCMPS_STORE`) is the single gate every qty input — `skuCard()`'s stepper, cart-drawer line stepper, and the `#estimator` qty field — routes a requested value through, passing a per-product `key` (`p.id`/`i.id`/`opt.id`); it pops the `.cap-popup-backdrop` confirmation (extra-lead-time copy, or a hard-ceiling "message us" notice at 5x the cap) and only commits the higher value once the shopper clicks "I agree" — which only unlocks that one product's cap, not every product's. See the "Capacity soft-cap" gotcha below before touching this. |
| Bulk-quote Step 01 product picker | `index.html` `#estimator` inline `<script>` — tabbed thumbnail/name/price cards (`.est-product-tabs`/`.est-product-grid`/`.est-product-pick`) built from the same `options` list sourced off `window.KCMPS_STORE_DATA.products`; one tab per catalog leaf, reusing the page's generic `[data-tabs]` click-handler. The original `<select id="est-product">` stays in the DOM (`display:none`) as the single source of truth — clicking a card just sets its value and fires `change`, so `currentOption()`/pricing/cart-add are untouched. See the "Bulk-quote product picker" gotcha below before changing this. |
| Checkout → GCash payment proof popup (post-"Place order") | `store.js` `submitOrder()` POSTs the cart to the real checkout API (`CHECKOUT_API_BASE/orders` → `backend/checkout/create-order.js`) — no more `mailto:`. On success, `openOrderPopup({orderId, payNowTotal})` picks one of two states: `renderPaymentProofStep()` (has `sku` items — QR + GCash ref/amount/screenshot form, wired via `submitPaymentProof()` to `backend/checkout/submit-payment-proof.js` for a pre-signed S3 URL, then a direct browser→S3 `PUT`) or `renderCustomOnlyConfirmation()` (all-`custom` order, nothing to pay yet). Lazy-built `.order-popup-backdrop` (`ensureOrderPopupShell()`/`closeOrderPopup()`), overlays the still-open cart drawer, z-index 160; QR asset `website/assets/gcash-qr.jpg` (real, owner's GCash — portrait aspect ratio, `.order-popup-qr` CSS sizes it `width: 200px; height: auto`, don't force it square) |
| Customer design-file upload (checkout drag & drop) | `website/store.js`'s `wireDesignUpload()`/`startDesignUpload()` + the `.upload-drop` zone rendered next to `#co-notes` (the design-links textarea **stays** — a link is still the right answer for a big multi-file job, and archives aren't an accepted upload type). Two-step presigned PUT straight to S3, same pattern as `submitPaymentProof()` — no bytes through a Lambda. Backend: `backend/checkout/upload-design-file.js` + the allowlist in `backend/lib/upload-types.js` (**zip/rar excluded on purpose. SVG is ALLOWED as of 2026-08-06 — the designer needs it — but it is ATTACHMENT-ONLY and `image/svg+xml` must NEVER be added to `INLINE_VIEWABLE_TYPES`**, because an SVG is a script container and inline rendering is what makes it an XSS vector; a regression test pins this. Server re-validates Content-Type *and* extension, so the client list is UX only). Refs persist on `order.designFiles` via `create-order.js`; staff download them from `job-detail.html` via a presigned GET forced to `Content-Disposition: attachment`. Files are malware-scanned by GuardDuty and a failed/pending scan means **no download link at all** — see the Lambda's header for the full threat model and `docs/cost-governance.md` for the ~₱75/mo scanning cost |
| Uploaded-file malware scanning + quarantine | GuardDuty Malware Protection for S3 covers **all four** upload prefixes on `kcmps-payment-uploads-est-2026` (`design-uploads/`, `payments/`, `messages/`, `correspondence/`). `backend/jobs/handle-scan-result.js` (EventBridge-triggered) deletes every version of an infected object and persists the verdict + a plain-English explanation (`backend/lib/threat-descriptions.js`) onto the referencing record, so the dashboard still shows *what arrived, what it was, and that it was destroyed*. Read paths (`staff-api/get-orders.js`, `staff-api/get-messages.js`) hand out a download URL **only** for `NO_THREATS_FOUND`, and force `Content-Disposition: attachment` so nothing renders inline. No verdict yet = blocked (fail closed). Cost is ~₱0–10/mo — see `docs/cost-governance.md` |
| Catalog / product data        | `website/products.js` — `window.KCMPS_STORE_DATA = { currency, shirtAddon, leaves, products }`; each leaf has an `image` (AI-generated, `website/assets/leaves/<leaf>.jpg`) used as the product-thumb fallback in `store.js`'s `thumbImage()` |
| Filename → display-title convention | `window.KCMPS_TEXT.titleFromFilename()` in `products.js` — shared by the hero carousel, the design picker grid, and cart thumbnails so naming never drifts between views |
| Design picker (pre-made design selection) | `store.js` `buildDesignGrid()` — selectable design cards under a SKU's gallery thumb, capped at `DESIGN_GRID_MAX` (8) tiles with a hover/tap "+N more" popup for the rest; clicking any tile (inline, popup, or the mobile subcatalog) opens the shared fullscreen lightbox rather than selecting instantly — see "Fullscreen design lightbox" below; selection travels into the cart line as `designRef`/`designName` (see `addToCart` call in `skuCard()`). The tile list is `products.js`'s static `images[]` **plus** any published Asset Library items merged in from `design-manifest.json` — see the row below |
| Published Asset Library → storefront picker (manifest merge) | `store.js`'s `DESIGN_MANIFEST_URL` / `mergeDesignManifest()` / `loadDesignManifest()`, mirroring the hero carousel's `HERO_MANIFEST_URL` pattern. Fetched once per page load from `assets/designs/design-manifest.json` (written by `backend/asset-library/manifest.js`; the contract is documented in full in `backend/asset-library/publish-design.js`'s header — **one contract, two ends, change both or neither**). Entries are appended to each product's `images[]` by catalog leaf (manifest `category` === product `leaf`), deduped by src, so publishing a design needs no code deploy or S3 sync. Staff-authored `name` wins over `titleFromFilename()`; `designTitle()` consults the `manifestNames` map. See the "Design manifest merge" gotcha below before touching any of it. (Folder renamed `design-library/` → `asset-library/` and routes `/designs*` → `/assets*` on 2026-08-07 — see `docs/asset-library-rebuild-plan-2026-08-06.md` §5; DynamoDB `DESIGN#` prefix and S3 `designs/` object prefix deliberately kept their old names, not a migration worth doing) |
| Fullscreen design lightbox (purchasable) | `store.js` `openLightbox()`/`buildLightbox()` — the shared overlay always shows "Select this design" plus a size seg, quantity input, and "Add to cart" whenever opened with the optional `onSelect`/`controls` params; every design-subsection trigger (gallery thumb image, inline/popup design tiles, mobile subcatalog) routes through `skuCard()`'s `openDesignLightbox()`, which builds those `controls` via `buildLightboxControls()` and delegates the actual add to the card's own `addBtn.click()` (never duplicates cart-line construction, so bulk tiers/shirt-addon/design-ref can't drift between the card and the lightbox) |
| Shirt color choice (Black/White/Custom) | `store.js` `skuCard()`'s `.shirt-row` block, next to the `p.shirtAddon` checkbox — the three picks are `disabled`/dimmed until that checkbox is checked; "Custom" is a two-step pick (opens a panel with a native color input + live hex readout, only "Use this color" commits — don't apply on the swatch's own click, see the gotcha below) and the result travels as `shirtColor` on the cart line into the drawer meta and `buildOrderEmail()` |
| Page structure / copy         | `website/index.html` — value-stack amounts & guarantee wording marked inline as owner-editable |
| Hero→shop card-deck reveal    | `index.html` — `.hero-deck`/`.hero-stage` CSS + the `--deck-out`/`--deck-in` `:root` rules in the inline `<style>`, driven by the deck-scroll IIFE (grep `--deck-progress`). See the "Card-deck reveal" gotcha below before touching any of it |
| Auth — login (Cognito Hosted UI) | `website/index.html` `<script>` block, `startLogin()`/`openLoginPopup()`. `login-test.html` (the original standalone proof-of-concept) was removed 2026-08-05 — no longer needed once the flow was ported into `index.html`, and it had drifted onto the retired Cognito pool's dead Hosted UI domain, same as the rest of the site (see `docs/history.md` entry 68) |
| Auth — sign-up (custom form, not Hosted UI) | `website/index.html`'s `openAuthModal()` — a "Log in or create an account" choice modal fronts the nav button; "Log in" hands off unchanged to `startLogin()`, "Create account" runs a custom first/last-name + username + email + password + code flow calling Cognito's public IdP API (`SignUp`/`ConfirmSignUp`/`ResendConfirmationCode`) directly. Every field it asks for is one the pool actually requires — it originally existed to *avoid* the old pool's junk attributes, and is now kept because it's on-brand and in-page. See `docs/history.md` entry 70 |
| Cognito user pool (v2) — the deployed pool | `backend/infra/user-pool-v2.cfn.yaml`, stack `kcmps-user-pool-v2` → pool `ap-southeast-1_LHJsFdCgo`, client `2rsbhkjooja4h5e0ijpl4siuug`, domain `kcmps-auth.auth.ap-southeast-1.amazoncognito.com`. Replaced the original pool (deleted 2026-08-05, cutover confirmed working end-to-end first — see `backend/infra/README.md` "User pool v2") to drop 3 required attributes that can never be removed in place. **Read that README section before changing anything here** — several of its choices are create-only and cost a full rebuild to undo. Google federation is live and verified. `backend/infra/foundation.cfn.yaml`'s deployed stack still references the deleted pool ID as a stale parameter — do not redeploy it against the new pool, see its header. The same pool backs `kcmps-backend-staging` (staging reuses it rather than creating a second pool) |
| New-signup group assignment   | `backend/auth/post-confirmation.js` — Cognito `PostConfirmation` Lambda trigger (`kcmps-post-confirmation`), wired via the user pool's `LambdaConfig`, not an API route. Auto-adds every self-signup (both the Hosted UI and the custom form above route through the same trigger) to the `Customer` group. Nothing today actually requires that membership (`backend/lib/auth.js`'s `isStaff()` check means "not staff" already reads as customer everywhere) — this exists so the group isn't permanently empty. See `docs/history.md` entry 62 |
| Design tokens / components    | `website/styles.css` (deployed copy) — mirror any change into `design-system/KCMPS Redesign/styles.css` |
| Logo / favicon / social preview image | `website/assets/logo-mark.png` (nav + footer, graphic-only — no baked-in wordmark, it sits next to its own text span), `favicon.ico`/`favicon.png`/`apple-touch-icon.png`, and `og-image.jpg` (1200x630, referenced by the `og:image`/`twitter:image` tags in `index.html`'s `<head>`) — all four generated from the graphics-only crop at `design-system/assets/kcmps-icon-only.png` (not deployed; regenerate icons from this file, don't re-crop the raw source). See `docs/history.md` step 42 before touching any of these — covers the icon/wordmark mixup, the `favicon.ico` multi-size gotcha, and Facebook's OG cache behavior |
| Carousel timing               | `.carousel-track transition` in `styles.css`; `AUTO_MS` in `index.html` |
| Scroll-position indicator     | `<nav class="scroll-indicator">` before `.sticky-cta` in `index.html` + its behavior script; `— scroll position indicator —` block in `styles.css`. Each segment's `data-target` = a section `id`; active-tracking via `IntersectionObserver` (filtered to skip `.hero-deck.is-passed` descendants), click-to-scroll via native `scrollIntoView` + the sections' `scroll-margin-top` |
| Hero carousel image pool      | `HERO_MANIFEST_URL` + shuffle logic in `index.html`; sourced from `website/assets/manifest.json` (local sample) — real bucket plan in `storefront-infra/assets-bucket-structure.md` |
| Hero category priming (headline/CTA copy) | `PAGE_VARIANTS` (3-way pool: `print-office` / `design` / `merch`) + state machine in `index.html` (key: `kcmps_hero_category`, sessionStorage pre-cart → localStorage 7-day sticky after any cart-add, promoted via the `kcmps:cart-add` event dispatched from `store.js`'s `addToCart`) |
| Checkout endpoint             | `ORDER_EMAIL` constant near top of `website/store.js` — order-intake address the checkout `mailto:` is addressed to (`order@kcmps.com`) |
| General/contact email         | Footer "Contact channels" block in `website/index.html` (`info@kcmps.com`) |
| Ops dashboard pages           | `website/dashboard/*.html` + shared `dashboard.css`/`dashboard-shell.js` |
| Ops dashboard mock data/API   | `website/dashboard/dashboard-data.js` — `window.KCMPS_DASH.*`; never touch `localStorage` directly outside this file. **`getAllOrders`/`getOrder`/`verifyPayment`/`setOnHold`/`advanceLineItem`/`addCorrespondence`/mail (see the Staff Email row)/manual-order entry (see the Manual orders row)/order tags/dashboard prefs/staff PIN/cash book + job costing (see its own row) are all live.** Everything else (metrics, inventory, clients, rework/spoilage) is still mock/localStorage-only |
| Manual orders (staff-entered, walk-in/phone) | `jobs.html`'s "+ New manual order" form → `dashboard-data.js`'s `createManualOrder()` → `backend/staff-api/create-manual-order.js` (`POST /orders/manual`, promoted to production 2026-08-08). Real `TransactWriteItems` order, same ID space and status vocabulary as a checkout order (`source: "manual"` is the only marker) — **cross-device visible**, replacing a prior localStorage-only version that was invisible outside the browser that created it (owner-reported bug, see `docs/history.md`). The client-name dropdown/"+ New client" flow in `jobs.html` stays a local autocomplete convenience only — there is no real Client/CRM entity |
| Cash book + job costing (live, staging + production) | `website/dashboard/cashbook.html` → `dashboard-data.js`'s `getCashbookDay`/`getCashbookMonth`/`logCashbookTransaction`/`voidCashbookTransaction`/`relinkCashbookTransaction`/`findCashbookTransaction`/`getJobCosting`/`getCashbookCategories` → `backend/cashbook/` (9 Lambdas) + `backend/lib/cashbook.js` (pure, `node --test backend/lib/cashbook.test.js`). Records money **as it moves** (cash-basis) so walk-in/storefront cash has a home, plus per-job profit. **Append-only: a mistake is voided, never edited** — the void writes a reversing entry and both halves are excluded from every total. Integer centavos, Manila dates (`business-hours.js`), rollups `ADD`-ed inside the same `TransactWriteItems` as the row so a total can't drift from its rows; `GET /cashbook/day` returns `rollup`+`computed`+`reconciles` and the page shouts if they disagree. Promoted to production 2026-08-19 (CLI-managed Lambdas like the rest of prod; staging is CloudFormation) with 14 CloudWatch alarms; **production started empty, no staging data migrated**. Design + decisions → `docs/cashbook-job-costing-plan-2026-08-18.md` |
| Re-link a logged transaction to a job (the ONE in-place edit) | `cashbook.html`'s per-row "Link job"/"Change job" button → `dashboard-data.js`'s `relinkCashbookTransaction()` → `backend/cashbook/relink-transaction.js` (`PATCH /cashbook/transactions/{txnId}/link`, `isStaff()`, staging 2026-08-20). Exists because staff log money the moment it moves — on a phone, usually before anyone has the order id — so an unlinked row is the normal state of a fresh entry, not a mistake. **`orderId` is the only field it can change, and that is load-bearing**: every other field (amount/direction/kind/category/method/`occurredAt`/day) feeds `rollupDelta()`, so changing one needs a void's reversing entry, not a mutation — this does NOT make the ledger editable, and adding a money field to it would silently desync every `METRIC#DAY`/`MONTH` counter. Works on **any** past day, which is the point. Refuses voided rows, reversing entries and `source: "system"` rows. Re-pointing **soft-deletes** the stale `TXN_POINTER` on the old order rather than removing it — partly the repo's soft-delete-only rule, partly because the staff-api Lambda role has no `dynamodb:DeleteItem` (a hard delete 500s; do NOT widen that shared role). Both readers filter it: `get-job-costing.js`'s `txnRows` and `lib/cashbook.js`'s `jobCosting()`. The picker is the SAME combobox as the entry form (recent-jobs-first), never a `prompt()` — an order id is 14 base36 characters nobody retypes correctly on a phone |
| Cash book ledger search + transaction IDs | Each ledger row shows its `txnId` as a click-to-copy `.cb-txid` button, which is what makes a transaction referable in a chat message or a note. `#cb-search` filters the CURRENT day locally across every field a row carries (id, note, category, order, staffer, method, account, and BOTH the raw centavos and the formatted peso string, so "1,690"/"1690"/"169000" all hit) — terms are ANDed, so adding words narrows. Local filtering re-renders from `lastDay`, never re-fetching: `renderDay(cached)` exists precisely so a keystroke isn't an API call. The one thing local search can't do is find a row from ANOTHER day, so when nothing matches locally the term is tried as an exact id against `backend/cashbook/find-transaction.js` (`GET /cashbook/transactions/{txnId}`) and the page jumps to that transaction's day. **That lookup is a GetItem, never a Scan** — it resolves through the `IDEMPOTENCY#<txnId>` guard record, which stores the row's `txnPk`/`txnSk`/`day`, so cost is flat forever. If a future writer skips writing that guard its rows become unfindable here; the fix is to write the guard, not to add a Scan |
| Cash book History (year → month → day → transactions) | `website/dashboard/cashbook-history.html`, reached from the Ledger/History sub-tabs on `cashbook.html` (**no sidebar nav entry on purpose** — it's a sub-view of Cash book, not a third destination). → `dashboard-data.js`'s `getCashbookHistory`/`getCashbookHistoryMonth` → `backend/cashbook/get-history.js` (`GET /cashbook/history`, optional `?month=YYYY-MM`). **Admin-only**, matching `get-month.js` — this IS month totals served a year at a time, so a looser gate would be a back door around O1 (owner re-confirmed 2026-08-20). Reads ONLY `METRIC#MONTH`/`METRIC#DAY` rollups, never transactions, so a whole multi-year history is ≤60 GetItems and a month ≤31; year totals are summed server-side so a year row can't disagree with its own months. A period with no rollup item is a real zero (every writer bumps the rollup in the same `TransactWriteItems` as the row) and is **omitted**, not rendered as an empty row. Day-level transactions come from the existing `getCashbookDay()` — one implementation of "what happened on this day", and only that one returns `reconciles`. Every level renders the same three money columns (revenue/expenses/net) so they line up down the page; that alignment is the point, don't give one level a different column set |
| Cash book gotchas (read before touching the money math) | **A job-linked expense writes TWO items sharing one id** — a `TXN#` row (cash leaving) and a `COST#` line (the charge against the job). Anything listing "revenue" must filter `kind === "revenue"` or the same amount prints twice (production bug, 2026-08-19, `ORD-290E09747F`). **A refund is a Revenue-side category stored NEGATIVE**, sign owned by the category config, never by staff typing a minus — summing gross instead of signed reports what was rung up, not what arrived. **`affectsCash: false`** (materials drawn from stock already owned) hits job profit but writes **no** `TXN#` at all, so it never touches the drawer or month totals. Every subtotal — day rollup, CSV `Counts toward totals`, the ledger's filter subtotal, `jobCosting()` — must apply the same voided/reversal exclusion or the four disagree. **Payment methods are TWO lists, never one** (2026-08-19): `PAYMENT_METHODS` is what a NEW row may be written with (`card` retired, absent), `PAYMENT_METHOD_LABELS` is every id ever written (`card` present) so a historical row still prints "Card" and not a raw slug — the client mirrors both off `GET /cashbook/categories`, which is authoritative. **`gcash`/`bank` require a `paymentAccount`** (the GCash number/owner or bank name/owner — deliberately NOT "reference", which already means the customer's payment-proof transaction ref), enforced in `validateTransactionInput()`/`validateCostInput()`; the client check is UX only. **Nothing was migrated**: rows predating the field have no `paymentAccount` and render "—" everywhere (ledger, CSV column, job money card); absent is never invalid on read | 
| Job money card (per-job profit on a ticket) | `job-detail.html`'s "Job money" card (sits after Event timeline; **Tags stays last**) → `dashboard-data.js`'s `getJobCosting()` → `GET /orders/{orderId}/costing`, **Admin-only** per the cash book's permission split, so a non-Admin gets a one-line note rather than a broken card. Shows revenue rows, cost lines with qty × unit, and profit / margin % / per-unit. `affectsCash:false` lines get an "allocation" badge and a Net cash figure that appears **only** when it diverges from profit. Revenue list filters `kind === "revenue"` — see the gotchas row above for why |
| Jobs table column widths + order | `jobs.html`'s `COLUMN_DEFS`/`DEFAULT_COLUMN_ORDER`/`gridTemplate()` + the `--jobcol-*` custom properties in `dashboard.css`. **The widths live in CSS, not JS, and that is load-bearing**: `gridTemplate()` writes an INLINE `grid-template-columns` on `#job-list-head` and every `.job-row`, and an inline style outranks any stylesheet rule — so a plain `@media` override could never narrow them. It emits `var(--jobcol-<key>, <minWidth>px)` instead, with `COLUMN_DEFS`' `minWidth` as the fallback so an undefined var degrades to desktop widths rather than collapsing a column. Desktop totals 1180px; the ≤760px block narrows the first three so Job/Status/Order ID fit a 375px screen without scrolling. Default order leads with those three; **a staffer's saved column order still wins** (dashboard prefs), so a reorder here only affects accounts that have never dragged a column |
| Order tags (AWS-style resource tagging) | `job-detail.html`'s "Tags" card (rendered last on the page, after Event timeline — reordered 2026-08-08 per owner request) → `dashboard-data.js`'s `setOrderTags()`/`getDefaultOrderTags()` → `backend/staff-api/set-order-tags.js` (`POST /orders/{orderId}/tags`, staff-gated, promoted to production 2026-08-08) + `backend/lib/tags.js` (pure validation/diff, unit-tested). Tags are `{key, value}` pairs for filtering/reporting; `jobs.html`'s Tags column reads the same field |
| Dashboard preferences (per-staffer, cross-device) | `jobs.html`'s draggable/filterable column order → `dashboard-data.js`'s `getDashboardPrefs()`/`setDashboardPrefs()` → `backend/staff-api/dashboard-prefs.js` (`GET`/`PATCH /staff/prefs`, promoted to production 2026-08-08). Generic shallow-merge key-value blob keyed on the JWT `sub` — UI-preference storage only, not a security boundary, no key allowlist. **No allowlist means a new preference needs zero backend change** — `settings.html`'s two Navigation toggles (`autoOpenNavOnMobile`, `goToDashboardOnLogin`, both default-ON, added 2026-08-19) are just new keys on this same blob. Note `index.html` reads `goToDashboardOnLogin` over the API directly rather than through `KCMPS_DASH`, because `dashboard-data.js` isn't loaded on the storefront |
| Session lifetime / Cognito refresh tokens | `website/auth-refresh.js` (`window.KCMPS_AUTH`, loaded by every page with scripts) — single-flight refresh, proactive renewal ~5 min before `exp`, 401-retry-once, revoke-on-logout, **fail closed**. Built 2026-08-19 because the 5-day `refresh_token` was being discarded and every session died at 60 min. **Cognito does not return a new refresh token on refresh — `saveTokens()` must carry the existing one forward** or sessions silently die at 60 min anyway, only for users who lasted long enough to refresh once. Tokens stay in `sessionStorage`, deliberately not `localStorage` (a 5-day refresh token is a far bigger XSS prize than a 1-hour id token). `SESSION_GUARD` in `dashboard-shell.js`: `LOCK_MS` 30 min (PIN privacy screen), `SESSION_MS` 4 h (a real idle timeout now, no longer a proxy for token expiry). **Any page that refreshes needs the Cognito origin in its `connect-src`** — it was missing on all 12 dashboard pages and a blocked refresh looks exactly like a dead feature |
| Production stations (editable in Settings, Admin-only) | `settings.html`'s Stations section → `dashboard-data.js`'s `getStations`/`getAllStations`/`stationLabel`/`loadStations`/`saveStations` → `backend/staff-api/stations.js` (`GET`/`PUT /stations`) + `backend/lib/stations.js` (pure, `node --test backend/lib/stations.test.js`). ONE `CONFIG#STATIONS` item, hardcoded fallback so it needed no migration — same pattern as `business-hours.js`'s `CONFIG#OPERATING_HOURS`. **A station id is create-only and can never be renamed or deleted**: `advance-line-item.js` has already written those strings onto line items AND into append-only `EVENT#` audit records, so removal is expressed as `retired: true` (hidden from the picker, still resolvable for history) and `validateStationsPayload()` rejects a payload that drops or renames an id. Read is `isStaff()` (every scheduler needs the picker); write is Admin (retiring a station changes everyone's picker and the Week view's capacity denominators). **`advance-line-item.js` now validates `station` against this list** — it used to accept an unvalidated free string — and deliberately still accepts RETIRED ids so a job already on a retired station stays advanceable; `job-detail.html` re-adds the line item's own retired station to the select for the same reason, or advancing would silently move the job. `PLANNED_HOURS_PER_WEEK` lives in the same config item and feeds `week.html`'s capacity grid |
| Idle-screen privacy lock + staff PIN | `dashboard-shell.js`'s session-guard overlay (`checkIdle()`/`openSessionGuard()`, two stages — privacy lock then session/staleness, opaque backdrop so `backdrop-filter` support is never load-bearing) gates re-entry with a per-staffer PIN via `getStaffPinStatus()`/`setStaffPin()`/`verifyStaffPin()`/`clearStaffPin()` → `backend/staff-api/staff-pin.js` (`GET`/`PUT`/`DELETE /staff/pin`, `POST /staff/pin/verify`, promoted to production 2026-08-08) + `backend/lib/pin.js` (salted-hash storage, unit-tested). PIN input is deliberately not `type="password"` — see the file's autofill-note comment for why a password manager grabbing this field is worse than a masked plain input |
| Staff Email page (live)       | `website/dashboard/email.html` — two-pane mail client (list + read/reply) on `KCMPS_DASH`'s `getMailboxes`/`getMessages`/`getMessage`/`getThread`/`markMessageRead`/`sendReply` — **live since 2026-08-06**, real `fetch()` calls to `backend/mail/*.js` (`get-mailboxes.js`/`get-mail-messages.js`/`get-mail-message.js`/`mark-mail-read.js`/`send-reply.js`) behind the JWT authorizer, same pattern as `jobs.html`/`job-detail.html`. Mailbox set is 6, per-caller: `order@`/`info@`/`admin@kcmps.com` (sendable) plus `unrouted@`/`unparseable@`/`quarantine@kcmps.com` (Admin-only, read-only) — `mailboxId` is the real address, never the `mirror.kcmps.com` receiving identity. No dedicated thread endpoint, so `getThread()` pages INBOX+SENT and filters/sorts client-side. `getMessages()`'s `nextCursor` is an opaque base64 token (pass back as `cursor`, never treat as a number); messages carry no `uid` field. Shapes otherwise mirror an IMAP `FETCH`, including the envelope-vs-body split across `getMessages()`/`getMessage()`. Renders **plain text only** — see the gotcha below. Also renders a "Delivery checks" provenance block (`renderProvenance()`) from the backend's `provenance` field: the four SES verdicts, the routing path, and whether the expected forwarder appears in the `Received` chain. The old localStorage mock mailboxes/emails collections (including a `me@kcmps.com` personal mailbox, since deleted — personal-mailbox mirroring is permanently out of scope, see `backend/lib/mail.js`) are gone from `dashboard-data.js`'s seed; `ensureCollections()` strips them from any pre-existing blob rather than re-seeding. Outstanding: attachment download (metadata-only chips today, needs the fail-closed scan-verdict pattern used elsewhere) and pagination (`nextCursor` plumbed through the API but not wired into the UI) |
| Order↔email linking (lightweight, no relay/IMAP needed) | `website/dashboard/job-detail.html`'s "Customer correspondence" card + `dashboard-data.js`'s `addCorrespondence(orderId, note, files, actorName)` → `backend/staff-api/add-correspondence.js` (`POST /orders/{orderId}/correspondence`, live since 2026-08-04 — the "Log" button used to write straight into the `localStorage` mock and silently do nothing for real orders), backed by a per-order `correspondenceLog` array. Originally staff-written notes only — now also carries system-generated `"System (auto-email)"` entries appended by the backend notification Lambdas (see "Customer email notifications" below) whenever a customer email actually sends, so staff can see at a glance which touchpoints fired without leaving the order — pairs with a "Search Spacemail for this order" deep-link button (`SPACEMAIL_SEARCH_URL` constant in `job-detail.html`) that opens `https://spacemail.com/mail/?f=INBOX&search=<orderId>` against the `admin@kcmps.com` inbox every staff/shop mailbox forwards into. See `docs/roadmap.md` "Order↔email linking" for why this replaced building a full embedded inbox tab, and its 2026-08-04 entry for the attachment upload feature (both here and on order message threads) |
| Customer email notifications  | SES, `Bcc: admin@kcmps.com` on every send so the shared inbox always has a copy. 5 touchpoints across 5 Lambdas, each gated on a `FROM_EMAIL`/`SES_SENDER` env var (unset = silently disabled, best-effort, never blocks the underlying action): `backend/checkout/create-order.js` (order placed), `backend/checkout/submit-payment-proof.js` (order received/pending verification), `backend/staff-api/verify-payment.js` (payment confirmed, payment on hold), `backend/staff-api/advance-line-item.js` (shipped out / ready for pickup — only these 2 of its many transitions notify; `Ready for Dispatch` was a 3rd touchpoint until 2026-08-04, pulled after live testing showed it fires before the item is actually with a courier and leaked internal QA wording ("passed quality check") into customer copy — it now only logs an internal `correspondenceLog` note, `actorName: "System"` not `"System (auto-email)"`, so the card can't be misread as "this was sent" — production-stage transitions otherwise stay silent, self-serve progress bar only), `backend/jobs/expire-pending-orders.js` (auto-cancelled, quote expired). Every successful send also appends a `correspondenceLog` entry (see the row above) — see `backend/infra/README.md` "SES customer notifications" for the IAM/env-var wiring |
| Payment `On Hold` state (replaced `Payment Rejected`) | `backend/lib/constants.js`'s `STATUS.ON_HOLD`. A held payment isn't rejected — it's parked while staff and customer sort out whatever was unclear over email/chat, then verified in **one** click: `backend/staff-api/verify-payment.js` accepts both `Pending Payment Verification` *and* `On Hold` line items (per-item `ConditionExpression` `from`, since one transaction can sweep up a mix), so there's no detour back through `Pending Payment Verification` and the customer is never asked to resubmit proof. Staff action is `POST /orders/{id}/set-on-hold` (was `/reject-payment`) → `dashboard-data.js`'s `setOnHold()` → job-detail.html's "Set to On-Hold" button. Reason text lives on `order.payment.holdReason` (legacy `rejectionReason` still read on display so pre-rename orders keep showing why). Customer-facing copy in `orders-data.js` is deliberately bucket `progress`, not `action` — there is nothing for them to do |
| Dashboard sidebar nav         | `NAV_ITEMS` in `website/dashboard/dashboard-shell.js` — one `{key, href, label, hint}` entry per page plus a matching `svgIcon(key)` path; optional `soon: true` dims the link, appends a "Soon" badge, and sorts it below the live pages. **Display order is derived by `navOrdered()`/`navRank()`, not by the array's order** — live pages first, `soon` previews below, `settings` always last. To promote a page when its backend lands, **delete its `soon: true` and change nothing else**: it moves itself, and the on-page `.demo-notice` banner in that page's `<main>` comes out too. Keep `NAV_ITEMS` in feature order; never hand-reorder it to fake the grouping |
| AWS infra plan (not deployed) | `ops-dashboard/infra/backend-infra-to-deploy.md` + `ops-dashboard/infra/logic-inputs/*.js` (Lambda source) |
| Shared backend conventions | `backend/lib/` — `constants.js`/`money.js`/`keys.js`/`item.js`/`events.js`/`auth.js`/`gsi.js`/`order-status.js`, imported by every deployed Lambda (`backend/checkout/`, `backend/staff-api/`, `backend/jobs/`) for status vocabulary, centavo money, PK/SK strings, role/group checks, and the order-status rollup (see its own `CLAUDE.md`); test with `node --test backend/lib/*.test.js` (name the files — the bare directory form is a false green that exits 0 on failure, see `backend/CLAUDE.md`) |
| Operating-hours-aware verification SLA | `backend/lib/business-hours.js` — pure `businessMinutesBetween()`/`isWithinOperatingHours()`/`nextOperatingStart()` clock math (fixed +8h Asia/Manila, no DST/timezone-lib needed), unit-tested in `business-hours.test.js`. `backend/staff-api/verify-payment.js` uses it to anchor the *next* stage's SLA clock (`enteredStatusAt`) to the next operating-hours opening when a payment is verified off-hours — the Confirmed transition and customer email still fire immediately regardless of hours. Reads an optional `CONFIG#OPERATING_HOURS` item (falls back to a hardcoded default until a future Settings API writes one). `website/dashboard/dashboard-data.js`'s `decorateLineItem()` mirrors the same clock math client-side for the dashboard's red/warn aging display. See `docs/roadmap.md`'s "Operating-hours-aware verification SLA" entry |
| Customer chat via order threads | `backend/staff-api/send-message.js`/`get-messages.js` (deployed, `kcmps-checkout-api`) — `PK: ORDER#<id>`/`SK: MSG#<ISO>#<msgId>` items, staff-vs-customer branch mirroring `get-orders.js`. Polling-based (~8s) frontend: `website/orders-data.js`'s `getMessages`/`sendMessage` + `order-detail.html`'s thread card (customer-facing); `website/dashboard/dashboard-data.js`'s `getOrderMessages`/`sendOrderMessage` (named to avoid colliding with that file's existing IMAP-mock `getMessages()`) + `dashboard/job-detail.html`'s thread card (staff-facing). `backend/jobs/notify-unread-messages.js` (new cron) sends one SES reminder per order with staff replies unread >2h — "digest, don't spam", currently dark (`SES_SENDER` unset). `backend/staff-api/get-unread-messages.js` (staff-vs-customer branched) + `dashboard-shell.js`'s `refreshUnreadBadge()` add a sidebar unread-count badge on the Jobs nav link (staff side) and `orders.html`'s `.new-message-banner`/"Unread messages" section (customer side, `orders-data.js`'s `getUnreadMessageSummary()`) — the cheap first step toward a real Messages tab/inbox, see `docs/roadmap.md`'s follow-up entries. `get-messages.js`'s mark-read side effect is opt-in (`?markRead=true`, fired only when the reply box gains focus — `markMessagesRead()` in `dashboard-data.js`/`orders-data.js`), not automatic on every fetch — see the 2026-08-04 fix entry in `docs/roadmap.md`, since it used to mean opening a ticket to check for a reply silently cleared its own badge first. Messages carry `attachments: [{filename, contentType, ref}]` (up to 5, `image/jpeg\|png\|webp\|gif`/`application/pdf`, built 2026-08-04 — was deferred, `attachmentRef` retired) via the same presigned-upload flow as `submit-payment-proof.js`; both message threads (here) and the correspondence log (`add-correspondence.js` row above) share it. See `docs/roadmap.md`'s "Customer chat via order threads" entry for what's still deliberately deferred (account-level/global view — blocked on a GSI2 that isn't provisioned yet) |
| Milestone 1.0 foundation (CloudFormation, owner-applied) | `backend/infra/foundation.cfn.yaml` — single DynamoDB table + GSI1 + Streams/PITR/deletion-protection, and the 5 Cognito groups added to the *existing* user pool; apply/rollback steps in `backend/infra/README.md` |
| Observability (Milestone 1.5, CloudFormation, deployed 2026-08-05) | `backend/infra/observability.cfn.yaml`, stack `kcmps-observability` — 40 resources: 37 CloudWatch alarms (an Errors + a Throttles alarm per production Lambda, plus `kcmps-streams-handler`'s DynamoDB Streams `IteratorAge`, the shared DLQ's depth, and `kcmps-checkout-api`'s API Gateway 5xx rate), 1 SNS topic (`kcmps-ops-alerts`, email subscription to `admin@kcmps.com`), and 1 SQS dead-letter queue (`kcmps-lambda-dlq`). CLI-only wiring this stack doesn't own (Streams event-source-mapping retry/DLQ config, `expire-pending-orders`' async invoke config, API Gateway stage throttling) → `backend/infra/README.md`'s "Observability" section |
| Staging backend (`dev.kcmps.com`'s own Lambdas/API/table) | `backend/infra/backend-lambdas.cfn.yaml` (new 2026-08-05, Node.js 20.x EOL migration; +3 Lambdas 2026-08-06 for the Asset Library's read/patch/purge routes) — all 32 Lambdas + HTTP API + JWT authorizer + routes + EventBridge + DynamoDB Streams trigger as CloudFormation, deployed as `kcmps-backend-staging` on top of `kcmps-foundation-staging` (same `foundation.cfn.yaml`, `TableName=kcmps-staging`). First CloudFormation-managed Lambdas in this repo — production's Lambdas are still CLI-managed. Full picture, rehearsal workflow, and the runtime-bump procedure it exists to make routine → `backend/infra/README.md`'s "Staging" section |
| Asset Library backend (staging + production, both live) | `backend/asset-library/` (renamed from `backend/design-library/` 2026-08-07, routes renamed `/designs*` → `/assets*` in the same pass — see `docs/asset-library-rebuild-plan-2026-08-06.md` §5) — `get-upload-url.js` (`POST /assets/upload-url`) + `publish-design.js` (`POST /assets`), both Production/Sales/Admin-gated via `requireRole()`, from the write-path pass; `list-designs.js` (`GET /assets`, `isStaff()`-gated — a read, so looser than the write routes) + `patch-design.js` (`PATCH /assets/{id}`, `requireRole()`-gated — metadata edits, archive/restore, and submit/approve/reject/break-glass-publish, see the approval-workflow row below) from the read/patch pass. `design-types.js`/`manifest.js`/`scan-verdict.js` are the shared allowlists, the single manifest writer, and the fail-closed GuardDuty verdict lookup every handler here goes through — never re-derive any of the three independently. `approval.js` is the pure, unit-tested approval-set math (`approval.test.js`) the patch Lambda's `submit`/`approve` actions call. `backend/jobs/purge-archived-designs.js` (15-min EventBridge cron, mirrors `expire-pending-orders.js`'s shape) is the **only** hard-delete path — assets archived >90 days get their DynamoDB item + both private-bucket S3 objects removed, with an `EVENT#` audit record written in the same transaction as the DynamoDB delete. **Promoted to production 2026-08-07**: its own bucket (`kcmps-design-originals-est-2026`), GuardDuty plan, IAM role, five Lambdas, four API routes, and the purge cron — a real, separate build, not a config flip; production data starts empty (0 assets), never migrated from staging. Full picture, IAM, and what shipped → `backend/infra/README.md`'s "Asset Library Lambdas" section |
| Asset Library Admin-approval workflow | `backend/asset-library/patch-design.js`'s `submit`/`approve`/`reject`/`publish` (break-glass) actions + `approval.js`. An asset goes `draft` → `pending_approval` (`submit`, scan-clean required to enter the queue) → `published` only once **every current member of the Cognito Admin group** approves (`approve`, re-evaluated via `ListUsersInGroup` on every call, never snapshotted — an admin added mid-queue must also sign off). `reject` (Admin-only, reason required) returns the asset to `draft` and clears every collected approval. Single-admin case (or an Admin submitting their own asset) publishes immediately — no deadlock waiting for a second founder who doesn't exist. `publish` is a break-glass direct-publish escape hatch, Admin-only + mandatory reason, scan gate still applies in full. **Editing a `published` asset's name/description/tags is Admin-only** (2026-08-07 fix, `requiresAdminToEditPublished()` in `approval.js`) — approval re-reviews the image, never the words next to it, so a non-Admin editing published metadata used to change public storefront copy with zero re-review; draft/pending_approval/archived stay open to the normal Production/Sales/Admin write gate. Full state machine and rationale → `docs/asset-library-rebuild-plan-2026-08-06.md` §4 |
| Asset library dashboard UI (live, staging + production) | `website/dashboard/asset-library.html` (renamed from `design-library.html` 2026-08-07) — upload form (name/description/category/tags + original + web-ready file), two-step presigned PUT with per-file progress (mirrors `store.js`'s `startDesignUpload()` UX) then a save-as-draft call; Library grid with Edit/Submit-for-approval/Archive/Download, an Approvals tab (Admin: approve/reject with reason; non-Admin: read-only "waiting on Ken" status), and a Recycle bin tab with one-click Restore (90-day purge note, actual purge is `backend/jobs/purge-archived-designs.js`). Wired through `dashboard-data.js`'s `getAssets`/`getAssetApprovalSummary`/`getAssetUploadUrls`/`createAsset`/`updateAsset`/`archiveAsset`/`restoreAsset`/`submitAssetForApproval`/`approveAsset`/`rejectAsset`/`publishAssetDirect` (renamed from the `getDesigns`/`publishDesign`/… seam during the 2026-08-07 rebuild, per `docs/asset-library-rebuild-plan-2026-08-06.md` §5) — the only functions on that seam this page calls, no direct `fetch`/`localStorage`. `assetApiAvailable()` always returns `true` now (was hostname-gated to `dev.kcmps.com` only, until the 2026-08-07 production promotion below made that check permanently stale — a leftover "staging only" banner was found and removed the same day, after nav dimming was lifted but this page's own internal gate was missed). A design with no `NO_THREATS_FOUND` verdict yet renders "Scanning…" with no download link (the API already fails closed — see `list-designs.js`); a `409 stillScanning` on submit-for-approval is a friendly retry state, not an error |
| Asset library plan | `docs/roadmap.md` "Parallel track — Asset Library" + `docs/asset-library-rebuild-plan-2026-08-06.md` (the UAT-failure diagnosis, IA/UX rebuild, Admin-approval workflow design, and the design-library → asset-library rename decision log) — private S3 + foundation table, category reuses catalog leaves, access reuses Production/Sales/Admin groups (approve/reject Admin-only). Backend, dashboard UI, and the storefront-side manifest merge into `buildDesignGrid()` are all built (see the rows above) |
| Staff email panel (SES relay, staging + production, both live) | `backend/mail/*.js` + `backend/lib/mail.js` (access model + inbound routing + verdict policy, pure/unit-tested) + `backend/infra/README.md`'s "Inbound hardening" section. **Shared shop mailboxes only** — `order@`/`info@`/`admin@kcmps.com`, which are one real Spacemail mailbox plus two aliases, relayed via ONE forwarding rule to ONE SES receiving address and split back apart by `ingest-inbound.js`. `mailboxId` is the REAL address, never the mirror address. Access is purely group-based; **never add `ROLES.STAFF`** (the owner reverted that once — `Staff` means "may open the dashboard", not a capability). Personal-mailbox mirroring and Tier 1 stored-password IMAP are both **rejected outright**, code path deleted not dormant — see `docs/roadmap.md`'s decision record before reviving either. **Promoted to production 2026-08-07** by *repointing* the single real inbound pipeline (there is only one real mailbox in this business — two pipelines would need a second SES receiving identity + a second Spacemail forwarding rule, real infra nobody wanted) rather than duplicating it: `kcmps-ingest-inbound` (new, production-named) now owns the S3 trigger and writes to the `kcmps` table; `kcmps-staging-ingest-inbound` still exists (CloudFormation-managed) but is no longer wired to anything. `MAIL_ALLOWED_RECIPIENTS` is unset on the production `send-mail-reply` — confirmed unrestricted in code, not assumed. Verified against real production mail traffic and a real owner-sent reply, not synthetic data. **Thread-splitting fix + scan-gated attachment viewing promoted to production 2026-08-08**: `mail-parse.js`'s `deriveThreadId()` was re-parenting replies onto a fresh `THR#subj#` id instead of inheriting the root's `THR#ref#` id, silently splitting a thread after 3 messages; `ingest-inbound.js`/`get-mail-message.js` now also extract and scan-gate attachment bytes into a new `mail-attachments/` S3 prefix (own GuardDuty Malware Protection entry, own additive IAM policy `mail-attachments-bucket` on `kcmps-mail-lambda-role`). `backend/mail/backfill-threading-2026-08-07.js` (dry-run by default, `--apply` to write; safe/idempotent, re-parenting is a pure function of the immutable raw MIME) retroactively repaired every already-split production thread the same day — new mail threads correctly without it, but old split threads needed the one-time run. Full picture → `docs/wip-mail-threading-attachments.md` |
| Product-image bucket plan (not deployed) | `storefront-infra/assets-bucket-structure.md` + `storefront-infra/logic-inputs/generate-asset-manifest.js` |
| dev/staging domain (`dev.kcmps.com`) infra | `storefront-infra/dev-domain.cfn.yaml` — CloudFormation for the second CloudFront distribution + basic-auth Function + response-headers policy, applied via `aws cloudformation deploy` with `kcmps-claude-priv` (needs its own IAM policy grant — see `storefront-infra/CLAUDE.md`) |
| Payment/GCash logic spec      | `project_knowledge/Payment_System_Project_Knowledge.md` |
| ERP architecture (north star) | `project_knowledge/ERP_System_Project_Knowledge.md` — 9-module map, 3-stage scale path, build-vs-integrate (Finance), launch-blocking data conventions |
| Roadmap / next goals          | `docs/roadmap.md` — current-state → prioritized milestones; current focus is Milestone 1, the simple payment backend |
| Cost budget / spend history    | `docs/cost-governance.md` |
| Backup / disaster recovery / CI-CD plan | `docs/disaster-recovery-and-cicd-plan.md` (architecture diagram + the gap analysis + the CI/CD phases) and `docs/dr-owner-actions.md` (the AWS/GitHub setup steps, all executed and rehearsed as of 2026-08-18). **The backup itself is `infra-snapshots/`** — a nightly read-only dump of everything that exists *only* inside AWS (Route 53, all 64 Lambda env maps, API/CloudFront/SES/IAM), written by `infra-snapshots/infra-snapshot.sh` via `.github/workflows/infra-snapshot.yml` and committed to git. Customer data is encrypted against `infra-snapshots/backup-key.pub.pem` (private key is owner-held, never in this repo). **When a snapshot diff shows a resource added or removed, update the matching row in this table in the same commit** — that habit is what keeps this file from drifting from reality again. Restore procedures + rehearsal log → `infra-snapshots/RESTORE.md` |
| Design system full reference  | `design-system/KCMPS Redesign/readme.md` (see also its own `CLAUDE.md`) |

Prefer this table + `Grep`/`Glob` over reading whole files or the README for orientation.
Line numbers drift; the function/constant names above are stable anchors — grep for them.

## Conventions and gotchas (learned the hard way — don't regress)

- **Migration seams**: both `store.js` (`window.KCMPS_STORE`) and `dashboard-data.js`
  (`window.KCMPS_DASH`) are the *only* things callers touch — no page reads `localStorage`
  directly. When a backend exists, only these two files' function bodies change to `fetch()`.
  Keep new features behind this same seam. `KCMPS_DASH` now also fronts a mail API whose return
  shapes are deliberately IMAP-shaped for the same reason.
- **Adding a collection to `dashboard-data.js`? Backfill it, don't bump `STORAGE_KEY`.**
  `load()` calls `ensureCollections(state)` on the success branch (never inside `buildSeed()`,
  which already has every collection — calling it there double-seeds) to fill in collections a
  pre-existing blob lacks. Bumping the key would "work" by throwing away every tester's
  in-progress mock state — advanced jobs, logged spoilage, blockers — for a feature unrelated to
  any of it. Keep related collections under **one** guard so a partial blob can't produce e.g.
  mailboxes-without-messages.
- **The Email page renders plain text and nothing else** (`email.html`). HTML parts are never
  rendered (a `.mail-notice` is shown instead), remote images never load, attachments are
  metadata-only chips with no download path, and URLs are not auto-linkified. Every field that
  reaches the DOM — sender display name, subject, body, attachment filename — is attacker-
  controlled and goes through `escapeHtml`. Rendering third-party HTML would need either an
  iframe (ruled out for this feature in `docs/roadmap.md`) or a hand-maintained sanitizer in a
  repo with no build step; auto-linkifying arbitrary mail is a phishing amplifier. Don't
  "improve" any of these without re-reading that section.
- **The mail layout overrides two dashboard defaults, scoped on purpose.** `.q-list` caps height
  at 320px and `.dash-content` caps width at 1320px — both fight a full-height mail pane, so
  `dashboard.css` overrides them under `.mail-list`/`.mail-wide` only. Unscoping either one
  silently reflows every queue card on `today.html`/`jobs.html`.
- **`.job-row`/`#job-list-head` need `width: max-content; min-width: 100%`, not just a shared
  `grid-template-columns`.** A block-level CSS grid sizes its own box to its container, not to
  its fixed-px tracks — so without this, each row's background/border-bottom/hover band/padding
  stop at the container edge while the row's own cells keep laying out past it. Invisible at
  100% zoom (the gap was small enough to miss) but grows fast on zoom-in, since the container
  shrinks in CSS px while the fixed-px tracks don't — reported live in production as job rows
  "bleeding" out of the card once zoomed in. See `docs/history.md` entry 71.
- **Email `groupThreads()`'s thread-collapse must track unread state per-thread, not off the
  latest message alone — for BOTH the unread indicator and for marking read.** A thread with an
  older unread message under an already-read newer reply used to (a) render as fully read and
  vanish from "Unread only" even though the mailbox's unthreaded badge counted it, and (b) even
  after fixing (a), stay unread forever once opened — `openMessage()` only marked the clicked
  message read, and a thread row's `data-msg` is always the latest message's id, never an older
  one. Fixed by tracking `unreadCount` per thread group, and by `markThreadRead()` marking every
  unread message in the full thread (via `getThread()`), not just the one that was clicked. See
  `docs/history.md` entry 71.
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
- **`addons` vs. `variants` pricing on a `products.js` entry**: `store.js`'s `addonsTotal()`
  sums every addon group's selected option as an independent delta (`base + Σ group deltas`) —
  it can express a second pricing dimension (e.g. paper size) ONLY when that dimension's
  surcharge is uniform across every other selection (see `print-bw-document-printing`'s Color +
  Size groups, both +₱1 Legal regardless of B/W/Colored). The moment a combination's price isn't
  a clean sum — e.g. `print-photocopying`'s Legal surcharge is +₱1 for B/W but +₱2 for Colored —
  addon groups structurally can't represent it (no group's delta can depend on another group's
  current selection). Use a `variants` list instead, one absolute-price entry per combination.
  `variants[sel].price` is already read as the final price, not additive — no new mechanism
  needed. This also matters for `inStoreInfoCard()` (`noOnlineOrder: true` products): it renders
  one reference-price row per `p.variants` entry, so a non-uniform combination product needs
  `variants` there too, not `addons` (which that renderer doesn't read at all).
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
- **Custom sign-up's Cognito `Username` can never be email-shaped.** The pool aliases sign-in
  by email (`AliasAttributes`), and Cognito rejects an email-*formatted* Username outright with
  `InvalidParameterException` — it's a separate identifier from the email itself. Customers
  pick their own username, so this is enforced client-side in `index.html`'s `usernameError()`/
  `USERNAME_RE` (an "@" is rejected before the API ever sees it, since the raw exception text
  is useless to a shopper). `generateUsername()` is **gone** — don't reintroduce an
  auto-generated username, and don't "simplify" the Username to reuse the email.
- **The user pool's required attributes are `email`/`given_name`/`family_name` and that list is
  frozen.** Schema `Required` flags are immutable after pool creation — changing them means
  building a *new* pool, which is exactly what `backend/infra/user-pool-v2.cfn.yaml` is. Before
  touching anything pool-shaped, read that README section: it covers why the Hosted UI sign-up
  link can't be hidden (and no longer needs to be), why `AliasAttributes` must not become
  `UsernameAttributes`, why `ManagedLoginBranding` is load-bearing rather than cosmetic, and
  the `sub`-is-a-foreign-key trap that orphans order history on any future pool move.
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
- **Design manifest merge** (`store.js`'s `loadDesignManifest()`/`mergeDesignManifest()`): the
  fetch must **never block first render** and must **never report failure**. `renderCatalog()`
  runs on the static catalog immediately; the manifest is fire-and-forget afterwards and only
  re-renders if it actually added a tile. A missing/404/malformed/empty/offline manifest is a
  silent no-op — verified byte-for-byte identical to the pre-manifest build across all five
  failure modes, with zero console output. Don't add a `console.warn` to the catch: a storefront
  that logs errors because the *ops dashboard* has published nothing yet is noise, not signal.
  Three things that are load-bearing, not incidental:
  (1) `image` is site-root-relative with **no leading slash**, deliberately — the one manifest
  is correct on both `kcmps.com` and `dev.kcmps.com` (whose CloudFront maps the bucket's
  `dev-site/` prefix onto the site root). Never prepend a slash, a host, or `dev-site/`.
  (2) Every field is attacker-adjacent and reaches the DOM plus an `<img src>`, so `image` is
  validated against `SAFE_IMAGE_RE` (relative only, no scheme — blocks `javascript:`/`data:` —
  no leading slash, no `..`, known raster extension) and an unknown `category` is dropped. This
  is a real gate, not belt-and-braces: without it the manifest is an arbitrary-URL injection
  point. Display text keeps flowing through the existing `textContent`/`escapeHtml` paths.
  (3) Only products that **already** opt into a picker (`Array.isArray(p.images)`) receive
  manifest designs — growing an `images[]` onto e.g. lamination or binding would invent a design
  picker for a product that has no such concept.
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

## Subagent model policy — cost is a real constraint here

Owner runs on limited credits. **Default subagents to the cheapest model that meets the bar:**

1. **Sonnet** — mechanical, well-specified work with an in-repo pattern to copy (a route modeled
   on an existing one, a layout matching a supplied sketch, doc edits, deploys already written down).
2. **Opus** — the default for anything needing judgement: production changes, security-relevant
   code, audits, diagnosing a bug from symptoms, anything where being wrong is expensive.
3. **Fable** — **only after Opus has actually been tried and demonstrably fallen short on that
   specific problem.** Never a starting point.

**The mistake this exists to prevent** (2026-08-07): four subagents, three on Fable, burned ~950k
tokens in one batch and most of the owner's remaining credits — work had to stop mid-flight. Fable
was picked because the tasks *sounded* high-stakes ("production", "payment path", "live customer
mail"). But what actually produced the value was **diligence, not reasoning horsepower**: an agent
checking and finding mail attachments were never GuardDuty-scanned (contradicting its brief),
another finding the real product ids differed from what its brief assumed, another measuring the
DOM instead of trusting a screenshot. That is careful verification — Opus does it well.

**High stakes justify a better brief, not a more expensive model.** Put the care into the prompt:
name the known traps, demand "report what you verified by running vs. by reading", require
invoke-after-deploy. Those instructions are what caught the real bugs. Before reaching for Fable,
be able to name the specific reasoning step Opus is expected to fail at; if the honest answer is
"it feels important", use Opus. Watch spend across a whole batch, not per agent, and say so before
dispatching several expensive agents at once.

### Guardrail — hold the owner to this, at his own request (2026-08-07)

The owner asked to be **actively reminded** when he is about to bypass the ladder above, because
in the moment ("use the best model", "escalate to Fable", "spare no expense") it is easy to
override a budget decision he made deliberately when not under pressure. This is a
pre-commitment he asked to be enforced — honour it.

**When the owner asks for Fable, or for several expensive agents at once:**

1. **Pause before dispatching. Do not spawn first and mention cost afterwards.**
2. Say plainly that it departs from the policy, and give the concrete comparison: what the
   equivalent Opus run would cost against the ~950k-token/4-agent batch that triggered this rule.
3. Offer the Opus alternative explicitly, with what (if anything) is genuinely lost.
4. **If he still wants Fable, require a specific reason** — name the reasoning step Opus is
   expected to fail at. *"It's important"*, *"it's production"*, *"it's security"* are **not**
   sufficient on their own; those describe stakes, not reasoning difficulty, and that exact
   conflation is what caused the overspend.
5. Given a real reason, **proceed** — it is his call and his budget. Record the reason in the
   dispatch so the decision is visible later.

Warn about **batch size** too, not just tier: the 2026-08-07 overspend was four concurrent agents,
and would have been costly even on a cheaper model. Never dispatch several agents without first
stating how many and roughly what they will cost.

Do not be tiresome about this — warn once, clearly, then respect the answer.

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

## Hard rule: sending email during testing

**SES is in production and sends real customer mail. Every test send is charged against the
`kcmps.com` sending reputation. Two rules, no exceptions, in every session and every subagent:**

1. **Permitted test recipients — exactly these four addresses** (owner-owned and confirmed
   2026-08-07; the tag is literally `+test`, not a freeform label):
   - `kenneth.dungca+test@kcmps.com`
   - `ken.rodulfo.dungca+test@gmail.com`
   - `admin+admin.kcmps.uat@kcmps.com`
   - `kenneth.dungca@krdsystems.com`

   **Never invent an address outside this list**: no `example.com`, no `test@test.com`, no
   placeholder or made-up local part, and never a real customer address. A made-up address is not
   "harmlessly fake" — it is *guaranteed to bounce*, which is precisely the damage this rule
   exists to prevent. Anything else needs the owner's explicit approval first, not a guess.

   These are enforced, not just documented: `MAIL_ALLOWED_RECIPIENTS` on
   `kcmps-staging-send-mail-reply` holds exactly this list, and the check is an **exact,
   lowercased string match** (`send-reply.js`'s `isRecipientAllowed()`) — which is why the tag is
   fixed at `+test` rather than freeform. A different tag will be rejected.

   **The four-address rule applies in PRODUCTION too — with no safety net.** Production changes
   inevitably need testing against production, so test sends from production are expected and
   legitimate. When you do, the recipient must still be one of the four above.

   **Production deliberately leaves `MAIL_ALLOWED_RECIPIENTS` UNSET, and it must stay that way.**
   Unset means unrestricted, which is required: `send-mail-reply` is how staff reply to **real
   customers** from the dashboard Email page. Setting the allowlist in production would reject
   every genuine customer reply and silently break a live feature.

   So understand the asymmetry: **on staging the guardrail is enforced by the runtime; in
   production it is enforced only by whoever is typing.** The absence of the env var in
   production is a technical necessity, *not* permission to widen the recipient list. A mistake
   there is unprotected — it is a real send, from the live `kcmps.com` identity, charged against
   the sending reputation that carries every customer order notification. Be correspondingly
   more careful, not less.
2. **Never design a test whose success condition is a bounce or a rejected send.** Prove
   negative cases by *inspecting configuration*, never by sending mail that is expected to fail:
   - accepted recipients / receipt rules → `aws ses describe-active-receipt-rule-set`
   - identity, verification, suppression, quota → `aws sesv2 get-email-identity` / `get-account`
   - routing, parsing, authz logic → invoke the Lambda directly with a synthetic event, or
     unit-test the pure module
   If a check genuinely cannot be made without a bad send, **it does not get made** — say so in
   the report and let the owner decide.

**Why this is a hard rule.** AWS warns at roughly a 5% bounce rate and can suspend sending near
10%; suspension would silently kill every customer order notification. On 2026-08-06 a task brief
told a subagent to "send to a non-permitted address and confirm SES rejects it" as proof a
receipt-rule catchall had been removed — in the same brief that forbade non-approved recipients.
The contradictory instruction won, produced a real bounce, and pushed the trailing-24h rate to
~10%. The check was also **entirely unnecessary**: `describe-active-receipt-rule-set` shows the
accepted-recipient list directly — faster, free, and stronger evidence than inferring config from
a failed delivery. Before dispatching any task, audit its verification steps against both rules.

Staging (`kcmps-backend-staging`) is SES-dark by construction — `FROM_EMAIL`/`SES_SENDER` are
deliberately unset there, and `send-reply.js` additionally refuses any recipient except the
address above. Prefer staging for anything mail-adjacent.

## Standard deploy workflow: dev.kcmps.com first, then production

**Hard rule, every session, no exceptions: staging first, production only on the owner's
explicit go-ahead.** Default to syncing/deploying to `dev.kcmps.com` (frontend) or
`kcmps-backend-staging` (backend) and stop there. Never run the production sync/deploy
command in the same turn as the staging one, and never infer approval from "looks good" or
silence — the owner has to actually say to promote it (e.g. "looks good, push it to prod" /
"promote it" / "deploy to production"). This applies whether the change came from a
one-off fix, a full feature build, or a new session picking up prior work — the gate is on
the *action* (a prod deploy), not on how the session started. See
`docs/claude-code-workflow.md`'s "Deploying" sections for the full frontend/backend
procedures this summarizes.

Default flow for any `website/` change, every session — **stage it, look at it, then wait
for the go-ahead to promote it**:

1. Sync to the dev/staging bucket prefix and check `https://dev.kcmps.com` (Basic Auth —
   credentials aren't in this repo, ask whoever set up the stack or check the password
   manager):
   ```bash
   aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ --cache-control "no-cache, must-revalidate" --profile kcmps-claude-priv
   ```
2. **Stop and report back what changed and how it was verified on dev.kcmps.com.** Only
   after the owner explicitly says to promote, sync the same content to production:
   ```bash
   aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --cache-control "no-cache, must-revalidate" --profile kcmps-claude-priv
   ```

Both use `CachingDisabled` at the CloudFront layer, so either sync is live at the CDN the
instant it lands — no invalidation step, no wait. `--cache-control` (added 2026-08-08) is
the *browser*-side half of that same "always live" promise — CDN caching was already off,
but with no `Cache-Control` header a visitor's own browser was free to apply its own
heuristic caching against `Last-Modified`, so a hard-synced fix could still look "not
deployed" to someone with a warm cache. This was found the hard way: several jobs.html
re-syncs in one session left a browser rendering a stale column set with no way to tell
from the S3/CloudFront side that anything was wrong. `no-cache, must-revalidate` (not
`no-store`) still lets the browser keep a copy, it just forces a revalidation request every
time — cheap on `CachingDisabled` origins, and exactly matches this repo's existing "edits
are live on refresh" premise, which the missing header had been quietly violating.
Skipping straight to step 2 is still technically possible (nothing *enforces* the order)
but is exactly the shortcut this rule exists to prevent — treat step 1 as the default and
step 2 as gated, never automatic.

### NEVER use `--metadata-directive REPLACE` to change one header (2026-08-08, site-down)

**`aws s3 cp` with `--metadata-directive REPLACE` discards EVERY header you don't
re-specify in that same command — including `Content-Type`.** It does not merge. Objects
silently come back as `binary/octet-stream`, and a browser then **downloads** `.html`
instead of rendering it: every page on the affected prefix is dead, and the site looks
completely broken to a visitor while S3 still reports the sync as successful.

This took `dev.kcmps.com` down. The intent was harmless — retrofit `Cache-Control` onto 8
already-uploaded dashboard files. The command carried `--cache-control` and nothing else,
so all 8 lost their `Content-Type`. Production was untouched **only** because the loop
happened to be scoped to the `dev-site/` prefix; the exact same command aimed one prefix
higher would have taken down the live storefront.

**The rule: to change object metadata, re-run the normal `aws s3 sync` from `website/`.**
Sync derives `Content-Type` from the file extension automatically and applies
`--cache-control` at the same time — that is the whole reason both commands above carry the
flag inline. There is no case in this repo that needs a metadata-only rewrite.

If a metadata-only rewrite is ever genuinely unavoidable, it must pass **`--content-type`
explicitly, per file** (extensions differ, so a single loop value is wrong by
construction), and be followed by a `head-object` check of `ContentType` on every key
touched — not just a "command succeeded" read. The failure is invisible from the CLI's exit
code; only the response header shows it.

Detection, if pages ever download instead of render:
```bash
aws s3api head-object --bucket kcmps-online-bucket-est-2026 --key <key> \
  --profile kcmps-claude-priv --query '[ContentType,CacheControl]' --output text
```
`binary/octet-stream` on a `.html`/`.css`/`.js` object is the smoking gun. Fix by
re-syncing that content from `website/`.

### A production push mirrors back to staging too (2026-08-08)

**When the owner approves promoting a file (or set of files) to production, sync that same
content to `dev-site/` as well, in the same turn.** Not a relaxation of the staging-first
gate — new work still stages first, and still waits for explicit approval before it goes to
production. This is specifically about what happens *after* that approval: production must
never end up ahead of staging on content the owner has already signed off on.

**Why:** staging silently regressed behind production on 2026-08-08. `asset-library.html`'s
per-product-targeting picker was promoted to both environments together, correctly. Later
the same session, an unrelated **full** `aws s3 sync website/ ... dev-site/` was run from a
worktree on a *different* branch — one whose local checkout of `asset-library.html` predated
the picker entirely. That sync doesn't know or care what it's overwriting; it silently
reverted staging's copy to the older version while production kept the newer one. The gap
went unnoticed until the owner asked "what's on staging that isn't in prod yet" and a
feature was found *missing from staging* that had already shipped to production days
earlier — backwards from every other gap this workflow produces, and confusing precisely
because it inverts the usual direction of drift.

**How to apply:** after any owner-approved production sync, run the identical `aws s3 cp`/
`sync` (same file, same content) against `dev-site/` immediately after, and verify both
land with a `head-object` byte/`ContentType`/`CacheControl` check — same discipline as any
other sync, not a skip-the-check afterthought. If the production push covered many files, so
does the staging mirror.

Backend/Lambda changes follow the same gate against `kcmps-backend-staging` before
`kcmps-*` production functions/infra — see `backend/infra/README.md`'s "Staging" section
for the exact commands and `docs/claude-code-workflow.md`'s "Deploying — backend" for when
staging is required vs safely skippable.

This is a manual discipline because there's no CI/CD pipeline yet — the owner's intent,
stated 2026-08-08, is to build one eventually; until then, every sync in both directions is
a deliberate CLI command someone has to remember to run, and the rule above exists to make
that memory unnecessary for at least the "prod is ahead of staging" failure mode.

Deliberately **no `--delete`** on either command — this only uploads new/changed files, it
never removes anything from the bucket that isn't in `website/` locally (the bucket has
pre-existing content outside this repo's management, e.g. a root `README.md` and an
`Assets/` folder, distinct from `website/assets/`). Run a `--dryrun` first if unsure what a
sync will touch.

`dev.kcmps.com` is a second CloudFront distribution (`E7PDB5JQRZX0E`, **CLI-managed, not
CloudFormation** — `storefront-infra/dev-domain.cfn.yaml` is a reference template describing
it that has never actually been deployed as a stack; see `storefront-infra/CLAUDE.md` before
assuming otherwise) sitting in front of the **same** S3 bucket as production, reading from a
`dev-site/` prefix instead of the root — so a dev sync never overlaps with or overwrites the
live site. It's gated behind CloudFront-Function basic auth
so work-in-progress isn't publicly browsable. **As of 2026-08-05 it also has its own
backend** — `kcmps-backend-staging` (32 Lambdas + its own HTTP API + `kcmps-staging`
DynamoDB table, all as CloudFormation), not production's. `website/store.js`/
`orders-data.js`/`dashboard-data.js` route to it automatically by hostname; see
`backend/infra/README.md`'s "Staging" section for the full picture and rehearsal
workflow. See `storefront-infra/CLAUDE.md` for the
touching the infra itself (not needed for routine content syncs above).

**Domain/CDN routing lives in two separate AWS accounts, on purpose.** The CloudFront
distribution (`EY6Q5RSWLDCEF`, aliases `kcmps.com`/`www.kcmps.com`/`site.kcmps.com`) and its S3
origin are in `600929977538` (`kcmps-claude-priv`/`kcmps-claude-ro` profiles). The domain's
actual DNS (mail records plus the `kcmps.com`/`www`/`site`/`dev` subdomains) is registered and
hosted in a *different* account, `260866268499` (`default` profile) — Route 53's ~14-day
post-registration/transfer lock is why the domain hasn't been moved into the CloudFront
account. `600929977538` also has its own `kcmps.com` hosted zone, but it's a decoy with only
NS/SOA records — never delegate to it or add records there; the real zone is
`Z06397161LBTJCRTPLL62` in `260866268499`. `kcmps.com`/`www.kcmps.com` resolve straight to
CloudFront; `site.kcmps.com` still resolves to the same distribution but gets 301-redirected to
`https://kcmps.com` by a CloudFront Function (`site-kcmps-redirect`) on viewer-request. See
`docs/history.md` step 41 before changing any of this.

## Where to look next

- What to build next / prioritized goals → `docs/roadmap.md`; the ERP architecture it serves → `project_knowledge/ERP_System_Project_Knowledge.md`
- Current-state overview, layout diagram, local dev, testing checklist → `README.md`
- Full build log / design rationale / auth implementation notes → `docs/history.md`
- Design-system-specific, ops-dashboard-specific, storefront-infra-specific, and
  backend-specific notes → their own `CLAUDE.md` files
- Claude's cross-session auto-memory (what it remembers about the owner, past feedback,
  project state) is mirrored to GitHub at [`docs/memory/`](docs/memory/) — the local
  `~/.claude/.../memory/` store stays the source of truth; `docs/memory/sync-from-local.sh`
  copies it in one direction, on request, never automatically. See that folder's `README.md`.
