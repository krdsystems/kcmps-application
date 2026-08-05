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
| Customer design-file upload (checkout drag & drop) | `website/store.js`'s `wireDesignUpload()`/`startDesignUpload()` + the `.upload-drop` zone rendered next to `#co-notes` (the design-links textarea **stays** — a link is still the right answer for a big multi-file job, and archives aren't an accepted upload type). Two-step presigned PUT straight to S3, same pattern as `submitPaymentProof()` — no bytes through a Lambda. Backend: `backend/checkout/upload-design-file.js` + the allowlist in `backend/lib/upload-types.js` (**SVG and zip/rar excluded on purpose**; server re-validates Content-Type *and* extension, so the client list is UX only). Refs persist on `order.designFiles` via `create-order.js`; staff download them from `job-detail.html` via a presigned GET forced to `Content-Disposition: attachment`. Files are malware-scanned by GuardDuty and a failed/pending scan means **no download link at all** — see the Lambda's header for the full threat model and `docs/cost-governance.md` for the ~₱75/mo scanning cost |
| Uploaded-file malware scanning + quarantine | GuardDuty Malware Protection for S3 covers **all four** upload prefixes on `kcmps-payment-uploads-est-2026` (`design-uploads/`, `payments/`, `messages/`, `correspondence/`). `backend/jobs/handle-scan-result.js` (EventBridge-triggered) deletes every version of an infected object and persists the verdict + a plain-English explanation (`backend/lib/threat-descriptions.js`) onto the referencing record, so the dashboard still shows *what arrived, what it was, and that it was destroyed*. Read paths (`staff-api/get-orders.js`, `staff-api/get-messages.js`) hand out a download URL **only** for `NO_THREATS_FOUND`, and force `Content-Disposition: attachment` so nothing renders inline. No verdict yet = blocked (fail closed). Cost is ~₱0–10/mo — see `docs/cost-governance.md` |
| Catalog / product data        | `website/products.js` — `window.KCMPS_STORE_DATA = { currency, shirtAddon, leaves, products }`; each leaf has an `image` (AI-generated, `website/assets/leaves/<leaf>.jpg`) used as the product-thumb fallback in `store.js`'s `thumbImage()` |
| Filename → display-title convention | `window.KCMPS_TEXT.titleFromFilename()` in `products.js` — shared by the hero carousel, the design picker grid, and cart thumbnails so naming never drifts between views |
| Design picker (pre-made design selection) | `store.js` `buildDesignGrid()` — selectable design cards under a SKU's gallery thumb, capped at `DESIGN_GRID_MAX` (8) tiles with a hover/tap "+N more" popup for the rest; clicking any tile (inline, popup, or the mobile subcatalog) opens the shared fullscreen lightbox rather than selecting instantly — see "Fullscreen design lightbox" below; selection travels into the cart line as `designRef`/`designName` (see `addToCart` call in `skuCard()`) |
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
| Ops dashboard mock data/API   | `website/dashboard/dashboard-data.js` — `window.KCMPS_DASH.*`; never touch `localStorage` directly outside this file. **`getAllOrders`/`getOrder`/`verifyPayment`/`setOnHold`/`advanceLineItem`/`addCorrespondence` are live** (Milestone 1.3) — real `fetch()` calls to `backend/staff-api/*.js` behind API Gateway's Cognito JWT authorizer, used by `jobs.html`/`job-detail.html`. Everything else in this file (metrics, inventory, clients, mail, manual-order entry, rework/spoilage) is still mock/localStorage-only |
| Staff Email page (mock)       | `website/dashboard/email.html` — two-pane mail client (list + read/reply) on `KCMPS_DASH`'s `getMailboxes`/`getMessages`/`getMessage`/`getThread`/`markMessageRead`/`sendReply`. Shapes mirror an IMAP `FETCH`, including the envelope-vs-body split across `getMessages()`/`getMessage()`, so wiring the real Lambdas is a function-body change with no `.html` edit. Renders **plain text only** — see the gotcha below |
| Order↔email linking (lightweight, no relay/IMAP needed) | `website/dashboard/job-detail.html`'s "Customer correspondence" card + `dashboard-data.js`'s `addCorrespondence(orderId, note, files, actorName)` → `backend/staff-api/add-correspondence.js` (`POST /orders/{orderId}/correspondence`, live since 2026-08-04 — the "Log" button used to write straight into the `localStorage` mock and silently do nothing for real orders), backed by a per-order `correspondenceLog` array. Originally staff-written notes only — now also carries system-generated `"System (auto-email)"` entries appended by the backend notification Lambdas (see "Customer email notifications" below) whenever a customer email actually sends, so staff can see at a glance which touchpoints fired without leaving the order — pairs with a "Search Spacemail for this order" deep-link button (`SPACEMAIL_SEARCH_URL` constant in `job-detail.html`) that opens `https://spacemail.com/mail/?f=INBOX&search=<orderId>` against the `admin@kcmps.com` inbox every staff/shop mailbox forwards into. See `docs/roadmap.md` "Order↔email linking" for why this replaced building a full embedded inbox tab, and its 2026-08-04 entry for the attachment upload feature (both here and on order message threads) |
| Customer email notifications  | SES, `Bcc: admin@kcmps.com` on every send so the shared inbox always has a copy. 5 touchpoints across 5 Lambdas, each gated on a `FROM_EMAIL`/`SES_SENDER` env var (unset = silently disabled, best-effort, never blocks the underlying action): `backend/checkout/create-order.js` (order placed), `backend/checkout/submit-payment-proof.js` (order received/pending verification), `backend/staff-api/verify-payment.js` (payment confirmed, payment on hold), `backend/staff-api/advance-line-item.js` (shipped out / ready for pickup — only these 2 of its many transitions notify; `Ready for Dispatch` was a 3rd touchpoint until 2026-08-04, pulled after live testing showed it fires before the item is actually with a courier and leaked internal QA wording ("passed quality check") into customer copy — it now only logs an internal `correspondenceLog` note, `actorName: "System"` not `"System (auto-email)"`, so the card can't be misread as "this was sent" — production-stage transitions otherwise stay silent, self-serve progress bar only), `backend/jobs/expire-pending-orders.js` (auto-cancelled, quote expired). Every successful send also appends a `correspondenceLog` entry (see the row above) — see `backend/infra/README.md` "SES customer notifications" for the IAM/env-var wiring |
| Payment `On Hold` state (replaced `Payment Rejected`) | `backend/lib/constants.js`'s `STATUS.ON_HOLD`. A held payment isn't rejected — it's parked while staff and customer sort out whatever was unclear over email/chat, then verified in **one** click: `backend/staff-api/verify-payment.js` accepts both `Pending Payment Verification` *and* `On Hold` line items (per-item `ConditionExpression` `from`, since one transaction can sweep up a mix), so there's no detour back through `Pending Payment Verification` and the customer is never asked to resubmit proof. Staff action is `POST /orders/{id}/set-on-hold` (was `/reject-payment`) → `dashboard-data.js`'s `setOnHold()` → job-detail.html's "Set to On-Hold" button. Reason text lives on `order.payment.holdReason` (legacy `rejectionReason` still read on display so pre-rename orders keep showing why). Customer-facing copy in `orders-data.js` is deliberately bucket `progress`, not `action` — there is nothing for them to do |
| Dashboard sidebar nav         | `NAV_ITEMS` in `website/dashboard/dashboard-shell.js` — one `{key, href, label, hint}` entry per page plus a matching `svgIcon(key)` path; optional `soon: true` dims the link and appends a "Soon" badge (used by `design-library.html`, the Design Asset Library placeholder) |
| AWS infra plan (not deployed) | `ops-dashboard/infra/backend-infra-to-deploy.md` + `ops-dashboard/infra/logic-inputs/*.js` (Lambda source) |
| Shared backend conventions | `backend/lib/` — `constants.js`/`money.js`/`keys.js`/`item.js`/`events.js`/`auth.js`/`gsi.js`/`order-status.js`, imported by every deployed Lambda (`backend/checkout/`, `backend/staff-api/`, `backend/jobs/`) for status vocabulary, centavo money, PK/SK strings, role/group checks, and the order-status rollup (see its own `CLAUDE.md`); test with `node --test backend/lib/` |
| Operating-hours-aware verification SLA | `backend/lib/business-hours.js` — pure `businessMinutesBetween()`/`isWithinOperatingHours()`/`nextOperatingStart()` clock math (fixed +8h Asia/Manila, no DST/timezone-lib needed), unit-tested in `business-hours.test.js`. `backend/staff-api/verify-payment.js` uses it to anchor the *next* stage's SLA clock (`enteredStatusAt`) to the next operating-hours opening when a payment is verified off-hours — the Confirmed transition and customer email still fire immediately regardless of hours. Reads an optional `CONFIG#OPERATING_HOURS` item (falls back to a hardcoded default until a future Settings API writes one). `website/dashboard/dashboard-data.js`'s `decorateLineItem()` mirrors the same clock math client-side for the dashboard's red/warn aging display. See `docs/roadmap.md`'s "Operating-hours-aware verification SLA" entry |
| Customer chat via order threads | `backend/staff-api/send-message.js`/`get-messages.js` (deployed, `kcmps-checkout-api`) — `PK: ORDER#<id>`/`SK: MSG#<ISO>#<msgId>` items, staff-vs-customer branch mirroring `get-orders.js`. Polling-based (~8s) frontend: `website/orders-data.js`'s `getMessages`/`sendMessage` + `order-detail.html`'s thread card (customer-facing); `website/dashboard/dashboard-data.js`'s `getOrderMessages`/`sendOrderMessage` (named to avoid colliding with that file's existing IMAP-mock `getMessages()`) + `dashboard/job-detail.html`'s thread card (staff-facing). `backend/jobs/notify-unread-messages.js` (new cron) sends one SES reminder per order with staff replies unread >2h — "digest, don't spam", currently dark (`SES_SENDER` unset). `backend/staff-api/get-unread-messages.js` (staff-vs-customer branched) + `dashboard-shell.js`'s `refreshUnreadBadge()` add a sidebar unread-count badge on the Jobs nav link (staff side) and `orders.html`'s `.new-message-banner`/"Unread messages" section (customer side, `orders-data.js`'s `getUnreadMessageSummary()`) — the cheap first step toward a real Messages tab/inbox, see `docs/roadmap.md`'s follow-up entries. `get-messages.js`'s mark-read side effect is opt-in (`?markRead=true`, fired only when the reply box gains focus — `markMessagesRead()` in `dashboard-data.js`/`orders-data.js`), not automatic on every fetch — see the 2026-08-04 fix entry in `docs/roadmap.md`, since it used to mean opening a ticket to check for a reply silently cleared its own badge first. Messages carry `attachments: [{filename, contentType, ref}]` (up to 5, `image/jpeg\|png\|webp\|gif`/`application/pdf`, built 2026-08-04 — was deferred, `attachmentRef` retired) via the same presigned-upload flow as `submit-payment-proof.js`; both message threads (here) and the correspondence log (`add-correspondence.js` row above) share it. See `docs/roadmap.md`'s "Customer chat via order threads" entry for what's still deliberately deferred (account-level/global view — blocked on a GSI2 that isn't provisioned yet) |
| Milestone 1.0 foundation (CloudFormation, owner-applied) | `backend/infra/foundation.cfn.yaml` — single DynamoDB table + GSI1 + Streams/PITR/deletion-protection, and the 5 Cognito groups added to the *existing* user pool; apply/rollback steps in `backend/infra/README.md` |
| Staging backend (`dev.kcmps.com`'s own Lambdas/API/table) | `backend/infra/backend-lambdas.cfn.yaml` (new 2026-08-05, Node.js 20.x EOL migration) — all 17 Lambdas + HTTP API + JWT authorizer + routes + EventBridge + DynamoDB Streams trigger as CloudFormation, deployed as `kcmps-backend-staging` on top of `kcmps-foundation-staging` (same `foundation.cfn.yaml`, `TableName=kcmps-staging`). First CloudFormation-managed Lambdas in this repo — production's 17 are still CLI-managed. Full picture, rehearsal workflow, and the runtime-bump procedure it exists to make routine → `backend/infra/README.md`'s "Staging" section |
| Design asset library plan (not built) | `docs/roadmap.md` "Parallel track — Design Asset Library" — private S3 + foundation table, category reuses catalog leaves, access reuses Production/Sales/Admin groups |
| Staff email panel plan (not built) | `docs/roadmap.md` "Parallel track — Staff email panel" — IMAP/SMTP bridge to Spacemail, not an embedded webmail iframe (see that section for why) |
| Product-image bucket plan (not deployed) | `storefront-infra/assets-bucket-structure.md` + `storefront-infra/logic-inputs/generate-asset-manifest.js` |
| dev/staging domain (`dev.kcmps.com`) infra | `storefront-infra/dev-domain.cfn.yaml` — CloudFormation for the second CloudFront distribution + basic-auth Function + response-headers policy, applied via `aws cloudformation deploy` with `kcmps-claude-priv` (needs its own IAM policy grant — see `storefront-infra/CLAUDE.md`) |
| Payment/GCash logic spec      | `project_knowledge/Payment_System_Project_Knowledge.md` |
| ERP architecture (north star) | `project_knowledge/ERP_System_Project_Knowledge.md` — 9-module map, 3-stage scale path, build-vs-integrate (Finance), launch-blocking data conventions |
| Roadmap / next goals          | `docs/roadmap.md` — current-state → prioritized milestones; current focus is Milestone 1, the simple payment backend |
| Cost budget / spend history    | `docs/cost-governance.md` |
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
   aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ --profile kcmps-claude-priv
   ```
2. **Stop and report back what changed and how it was verified on dev.kcmps.com.** Only
   after the owner explicitly says to promote, sync the same content to production:
   ```bash
   aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile kcmps-claude-priv
   ```

Both use `CachingDisabled`, so either sync shows up immediately — no invalidation step,
no wait. Skipping straight to step 2 is still technically possible (nothing *enforces* the
order) but is exactly the shortcut this rule exists to prevent — treat step 1 as the
default and step 2 as gated, never automatic.

Backend/Lambda changes follow the same gate against `kcmps-backend-staging` before
`kcmps-*` production functions/infra — see `backend/infra/README.md`'s "Staging" section
for the exact commands and `docs/claude-code-workflow.md`'s "Deploying — backend" for when
staging is required vs safely skippable.

Deliberately **no `--delete`** on either command — this only uploads new/changed files, it
never removes anything from the bucket that isn't in `website/` locally (the bucket has
pre-existing content outside this repo's management, e.g. a root `README.md` and an
`Assets/` folder, distinct from `website/assets/`). Run a `--dryrun` first if unsure what a
sync will touch.

`dev.kcmps.com` is a second CloudFront distribution (stack `kcmps-dev-domain`, defined in
`storefront-infra/dev-domain.cfn.yaml`) sitting in front of the **same** S3 bucket as
production, reading from a `dev-site/` prefix instead of the root — so a dev sync never
overlaps with or overwrites the live site. It's gated behind CloudFront-Function basic auth
so work-in-progress isn't publicly browsable. **As of 2026-08-05 it also has its own
backend** — `kcmps-backend-staging` (17 Lambdas + its own HTTP API + `kcmps-staging`
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
