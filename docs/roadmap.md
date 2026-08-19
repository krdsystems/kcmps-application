# KCMPS — Roadmap & Next Goals

North-star framing: [`project_knowledge/ERP_System_Project_Knowledge.md`](../project_knowledge/ERP_System_Project_Knowledge.md).
This file is the *operational* translation of that architecture into "what to build next,"
grounded in what actually exists in the repo today. When the two disagree, the ERP file wins
on architecture; this file wins on sequencing.

**Governing rule (from the ERP file, Part 0):** build a module only when a real decision or
transaction currently has no home. Everything else stays a stub. Do not build metrics,
inventory decrement, procurement, accounting, or HR before their trigger exists — they are
listed under [Deliberately deferred](#deliberately-deferred) below so nobody "gets ahead."

---

## Where we are today (2026-07)

> **[Updated 2026-08-05] Status in this section is stale.** Milestones 1.0–1.5 have shipped —
> a full payment backend (32 Lambdas, DynamoDB table, observability stack) is deployed and live.
> Sections below are preserved for historical context; current project state → top of this file.
>
> **[Updated 2026-08-13] Backup / DR shipped.** `kcmps.com` going live made "what happens when
> this breaks" a real question. A nightly off-site backup of everything that existed *only*
> inside AWS now runs and has been verified end-to-end in **both** directions (write and
> decrypt). Route 53 — MX, DKIM, and the CNAME that silently renews TLS — previously had zero
> backup of any kind. Alarm coverage also went 17 → 32 Lambdas; the entire mail pipeline had
> been unmonitored. Architecture, gap analysis, and the CI/CD phases (Lambda aliases first,
> since a bad Lambda deploy still has no fast rollback) →
> [`disaster-recovery-and-cicd-plan.md`](disaster-recovery-and-cicd-plan.md).
>
> **[Updated 2026-08-18] All six restore procedures rehearsed, all PASS.** The backup/DR
> system is no longer a hypothesis — decrypt, DynamoDB PITR, DNS, Lambda config, API routes,
> and SES rules have each been proven with a real damage-and-recover test (or, for DNS and
> SES specifically, the closest safe equivalent — see `infra-snapshots/RESTORE.md`'s
> rehearsal log for the scope caveats on those two). The CI/CD hardening phases (Lambda
> aliases, the frontend pipeline, CFN imports) remain unbuilt — that work is unrelated to
> whether backups exist and work, which they now provably do.

**Done and deployed (`website/`, static, S3):**
- Storefront: catalog, mixed cart (`sku` + `custom`), bulk estimator, hero category priming,
  scroll indicator, responsive/mobile. Cart lives in `localStorage` behind the
  `window.KCMPS_STORE` seam ([store.js](../website/store.js)).
- Cognito login (Customer/Staff split), Authorization Code + PKCE, tokens in `sessionStorage`
  under `kcmps_tokens`.
- Ops dashboard (`website/dashboard/*`): full UI — Today/Week/Month/Jobs/Clients/Inventory —
  running entirely on **mock `localStorage`** behind the `window.KCMPS_DASH` seam
  ([dashboard-data.js](../website/dashboard/dashboard-data.js)).

**Written but NOT deployed (no AWS resources exist yet):**
- Backend architecture + Lambda source drafts in
  [`ops-dashboard/infra/`](../ops-dashboard/infra/backend-infra-to-deploy.md): DynamoDB
  single-table schema, GSI1 sparse status index, and drafted handlers —
  `streams-handler.js`, `expire-pending-orders.js`, `daily-digest.js`, `api-get-orders.js`,
  `api-advance-line-item.js`, `api-verify-payment.js`.
- Milestone 1.0 provisioning CloudFormation, [`backend/infra/foundation.cfn.yaml`](../backend/infra/foundation.cfn.yaml)
  (the table + GSI1 + Cognito groups above) — template + apply/rollback docs are done, actual
  `aws cloudformation deploy` is an owner action.
- Storefront asset-bucket plan in [`storefront-infra/`](../storefront-infra/assets-bucket-structure.md).

**The gap that makes the site feel unfinished:** there is **no backend at all**. Checkout is a
`mailto:` (`submitOrder()` in [store.js](../website/store.js), line ~697), orders are never
persisted, and no payment is ever recorded. The dashboard's Verify/Reject buttons act on fake
data. Closing this gap is [Milestone 1](#milestone-1--the-simple-payment-backend-current-focus).

---

## Milestone 1 — The simple payment backend  ⟵ current focus

**Goal:** a customer can check out, pay via GCash, and see their order move through real
statuses; staff can verify or hold that payment from the dashboard against real data. This is
the minimum that makes the storefront "complete" instead of a brochure.

Maps to ERP file Phases **0 → 1 → 2** (Platform foundation → Sales & Order + GCash bridge →
Production/MES payment verification). Reuses the *existing* stack — S3, Cognito, API Gateway,
Lambda, DynamoDB, SES — **no new AWS services** (ERP file Part 7).

Do these **in order** — capture before display, foundation before feature. The order also
matches the dependency chain in the infra doc's Stage A→C checklist.

### 1.0 — Platform foundation (ERP Phase 0, launch-blocking conventions)
These conventions cannot be retrofitted (ERP file §2.3), so they go in with the very first
table write, even though nothing uses most of them yet.
- [x] CloudFormation authored and **applied**: [`backend/infra/foundation.cfn.yaml`](../backend/infra/foundation.cfn.yaml)
  (stack `kcmps-foundation`, `ap-southeast-1`) created the single DynamoDB table (PK/SK
  patterns from [infra §2.1](../ops-dashboard/infra/backend-infra-to-deploy.md)), **GSI1**
  sparse status index (`GSI1PK = STATUS#<status>`, infra §2.3) with Streams/PITR/deletion-
  protection on, and the 5 Cognito groups (`Customer`/`Production`/`Sales`/`Finance`/`Admin`,
  ERP file Part 5) in the existing user pool — verified live via `describe-table` and
  `list-groups`. Slots defined now, enforced later.
  - Admin membership: the pool's existing `admin.kcmps.cognito` account is the `Admin`
    user (not per-founder accounts) — added via `admin-add-user-to-group` (steps in
    [`backend/infra/README.md`](../backend/infra/README.md)), verified live. Still also
    in the legacy `Staff` group (see below) until that group is retired.
  - **Legacy groups found in the pool, not created by this stack:** `Staff` (precedence 10,
    what `dashboard-shell.js` currently gates on) and `Customers` (precedence 100, plural).
    `Customers` is now retired; `Staff` is a first-class role (not deprecated) — see "Legacy
    groups" in `backend/infra/README.md` for the retirement details (only `Customers` was
    deleted after migrating its one member; `Staff` is kept and accepted at both frontend
    and backend layers).
  - **`Customer` membership auto-assigned (2026-08-03):** the group sat permanently empty
    until now — no `PostConfirmation` trigger existed, so a self-signup landed with zero
    groups (harmless in practice, since `backend/lib/auth.js`'s `isStaff()` check means "not
    staff" already reads as customer everywhere, but a future feature checking for `Customer`
    explicitly would have silently broken). New `backend/auth/post-confirmation.js`, deployed
    as `kcmps-post-confirmation` and wired via the user pool's `LambdaConfig`. See
    `docs/history.md` entry 62.
- [ ] Stamp `tenantId`/`siteId` = `SITE#MNL`, `schemaVersion`, money as **integer centavos** +
  explicit `currency`, `status` + soft-delete (never hard-delete) on every item — enforced in
  code via [`backend/lib/item.js`](../backend/lib/item.js)'s `baseItem()`, not by the table
  schema itself, so this checks off as Lambdas start using it in 1.1.
- [ ] Immutable `EVENT#<ts>#<lineItem>` log written on every status transition — this is both
  the ERP audit trail and what BIR expects preserved (ERP file §2.3.2). Never mutate/delete.
  Shape builder ready: [`backend/lib/events.js`](../backend/lib/events.js)'s `buildEvent()`.

### 1.1 — Order creation on checkout (ERP Phase 1, Sales & Order)
- [x] New **customer-facing** Lambda `createOrder` — **drafted (2026-07-31)**:
  [`backend/checkout/create-order.js`](../backend/checkout/create-order.js), the first Lambda
  written against `backend/lib/` conventions rather than hand-rolling keys/status inline like
  the older `ops-dashboard/infra/logic-inputs/*.js` drafts. Splits the cart: writes `ORDER#<id>`
  META + one `LINEITEM#<id>` per line; `sku` items → `Pending Payment Verification`, `custom`
  items → `Quoted`. Emits `EVENT#` per line. Guest checkout preserved (no login required,
  matching the storefront today) — a Bearer token is verified if sent, but its absence never
  blocks the order.
- [x] **Deployed** (2026-07-31) behind `kcmps-checkout-api`, an API Gateway HTTP API
  (`6msg2uho6c`, `ap-southeast-1`) — route `POST /orders`, no authorizer attached (guest
  checkout means this must stay publicly callable; the Lambda does its own optional Bearer
  verification internally). CORS allows the production/dev storefront origins + local dev
  ports. See `backend/infra/README.md`'s "API Gateway" section for the full route/CORS/IAM
  detail and redeploy commands.
- [x] Wire the storefront to it: **done (2026-07-31)**. `submitOrder()`
  ([store.js](../website/store.js)) now POSTs to `CHECKOUT_API_URL` instead of composing a
  `mailto:`, behind the existing `KCMPS_STORE` seam — no other `.html` changes. On success it
  opens the same GCash popup as before, now carrying the real `orderId`. On failure (network
  error, validation error from the Lambda) it alerts the customer and leaves the cart intact
  rather than silently falling back to `mailto:`. Verified in a live browser session: added a
  synthetic item to cart, submitted checkout, confirmed the real order landed in DynamoDB with
  `customerSub: null` (guest), and that the popup showed the actual `orderId` — then deleted
  the test order.
- [x] **CSP:** added (2026-07-31) — `connect-src` in
  [index.html](../website/index.html) now includes the `kcmps-checkout-api` origin alongside
  Cognito.

### 1.2 — GCash payment proof capture (the missing customer-facing half)
The staff side is drafted ([api-verify-payment.js](../ops-dashboard/infra/logic-inputs/api-verify-payment.js));
the customer side that *creates* the `payment` object it reads is **not built** and is the real
work here (infra doc §3 flags `submitPaymentProof` as out-of-scope-for-dashboard, build-it-here).

**Front-end-only interim step already shipped** (`docs/history.md` entry 22): a popup shown
after "Place order," before the `mailto:` fires, with a placeholder QR + copyable
Contact/Fulfillment/Custom Request Details + itemized-cart text. This is *not* the checklist
below — no order record, ref-number field, or S3 upload — just a UX stopgap so customers get
payment instructions today. The checklist items are unchanged and still needed.

Extended further in `docs/history.md` entry 24 (2026-07-28): the checkout form gained a
courier choice (Grab/Lalamove) + address/landmark fields for Delivery, and copy-only policy
statements (1–2 business day confirmation SLA, 3-business-day pickup forfeiture). Still no
real order record or automated enforcement — same interim, front-end-only status as above.

`docs/history.md` entry 25 (2026-07-28) is unrelated to payment proof but touches the same
`print-office` catalog: Photocopying/Lamination/Binding are now gated (`noOnlineOrder`/
`requiresCartProduct` in `products.js`) instead of freely orderable, since they genuinely
can't be fulfilled from an online order alone.
- [x] `submitPaymentProof` Lambda — **drafted (2026-07-31)**:
  [`backend/checkout/submit-payment-proof.js`](../backend/checkout/submit-payment-proof.js).
  Returns a pre-signed S3 upload URL (private uploads bucket) for the screenshot, writes the
  `payment` sub-object (`method: gcash_manual`, `claimedAmount`, `gcashRefNumber`,
  `screenshotRef`, `submittedAt`) onto `ORDER#<id>` META, exact shape in
  [Payment System file](../project_knowledge/Payment_System_Project_Knowledge.md) "Data Model
  Addition". No ownership check on caller vs. order — guest checkout means there's no reliable
  identity to check against; see the file's header for why that's fine (staff still cross-check
  the typed reference number against real GCash history before verifying).
- [x] Uploads S3 bucket — **provisioned (2026-07-31)**: `kcmps-payment-uploads-est-2026`,
  `ap-southeast-1`, private (all public access blocked, `BucketOwnerEnforced` — no ACLs
  possible), versioned, SSE-S3 default encryption, noncurrent versions expire after 90 days.
  Applied via `kcmps-claude-priv`. Now wired: `kcmps-submit-payment-proof`'s `UPLOADS_BUCKET`
  env var points at it, and the execution role's `s3:PutObject` grant is scoped to this
  bucket's `payments/*` prefix. See `backend/infra/README.md` for the full detail.
- [x] Deploy `create-order.js`/`submit-payment-proof.js` as Lambdas — **done (2026-07-31)**.
  `kcmps-checkout-lambda-role` (least-privilege: `dynamodb:{Get,Query,Put,Update}Item` +
  `TransactWriteItems` scoped to the `kcmps` table + its indexes, `s3:PutObject` scoped to
  `kcmps-payment-uploads-est-2026/payments/*`, `ses:SendEmail` scoped to the `kcmps.com`
  identity, CloudWatch Logs) created via `kcmps-claude-priv` — it turned out that profile
  already has `AdministratorAccess` attached (see `docs/history.md`'s audit entry), but the
  Lambda's own execution role was still built least-privilege regardless, since the deploying
  profile's permissions and what the function itself can do are two separate things.
  `kcmps-create-order` and `kcmps-submit-payment-proof` both `nodejs24.x`/`arm64` in
  `ap-southeast-1`, each bundled with its own copy of `backend/lib/` (no Lambda Layer yet — two
  small functions didn't justify one). Smoke-tested with a synthetic guest order via direct
  `aws lambda invoke` (not through API Gateway, which doesn't exist yet): order created with
  correct `ORDER#`/`LINEITEM#`/`EVENT#` items and `GSI1PK`/`GSI1SK` set, then payment proof
  attached via a real presigned S3 URL — verified against the live table, then deleted the
  test items afterward so the table is back to its pre-test state.
- [x] API Gateway HTTP API + routes pointing at both Lambdas, and wiring the storefront to
  `create-order` — **done (2026-07-31)**, see the 1.1 checklist above for the full detail
  (`kcmps-checkout-api`, both routes, CORS, CSP, and the live-browser verification). No JWT
  authorizer on either route — both must stay publicly callable for guest checkout.
- [x] Wire the storefront to `submitPaymentProof` — **done (2026-07-31)**. The post-checkout
  popup (`store.js`) now branches on whether the order has anything to pay: an order with
  `sku` lines renders `renderPaymentProofStep()` — QR, a **typed** GCash reference number field
  (not screenshot-only, per the cross-check requirement below), a claimed-amount field
  (prefilled from the server's `payNowTotal`, editable), and a real file input constrained to
  `image/png|jpeg|webp`. Submitting calls `submitPaymentProof()`: `POST
  /orders/{orderId}/payment-proof` for a pre-signed S3 URL, then a direct browser→S3 `PUT` of
  the file — the Lambda never proxies the bytes. An all-`custom` order (nothing to pay yet)
  gets `renderCustomOnlyConfirmation()` instead, skipping the payment step entirely. The old
  copy-to-clipboard/mailto: interim from `docs/history.md` entry 22 is retired — `ORDER_EMAIL`
  now only appears as a "trouble uploading?" fallback link. Verified in a live browser session
  (both branches, plus the client-side validation cascade: missing ref → missing amount →
  missing file, each blocking submission with an inline error) and the two-step upload chain
  independently via direct API calls (order created → proof submitted → real image landed in
  `kcmps-payment-uploads-est-2026` → `payment` sub-object correctly shaped) — then all test
  artifacts (DynamoDB items, the S3 object) were deleted.
- [x] SES sending identity for the checkout confirmation email — **deployed and live
  (2026-08-03/04)**. `ProductionAccessEnabled: true`, 50k/day quota, DKIM/MAIL FROM verified
  live. `FROM_EMAIL` set on all 5 notification Lambdas (`create-order`, `submit-payment-proof`,
  `verify-payment`, `advance-line-item`, `expire-pending-orders`). See `backend/infra/README.md`
  "SES customer notifications" section for full wiring detail.
- [x] GCash matching mechanism decided (2026-08-01): keep the typed reference number as the
  only cross-check field — see [open decisions](#open-decisions-that-gate-milestone-1). No
  further implementation needed.
- [x] SES: "Order received — under verification, we'll confirm within [X] hours." — sent from
  `submit-payment-proof.js` above when `customerContact` looks like an email address (checkout's
  contact field is free text; a phone number can't receive an SES email, so it's skipped rather
  than forced).

### 1.3 — Staff verification live against real data ✅ done (2026-07-31)
- [x] Ported the drafted API Lambdas to `backend/lib/` conventions (matching `backend/checkout/`'s
  style, not the old hand-rolled drafts): [`backend/staff-api/get-orders.js`](../backend/staff-api/get-orders.js),
  `advance-line-item.js`, `verify-payment.js` — deployed as `kcmps-get-orders`,
  `kcmps-advance-line-item`, `kcmps-verify-payment`. `get-orders.js` also attaches each order's
  `EVENT#` records (`order.events`) so the dashboard's timeline has real data.
- [x] API Gateway (`kcmps-checkout-api`) extended with a Cognito **JWT authorizer**
  (`kcmps-cognito-jwt`) and 4 new routes (`GET /orders`, `POST /line-items/{lineItemId}/advance`,
  `POST /orders/{orderId}/verify-payment`, `POST /orders/{orderId}/set-on-hold`). Each Lambda
  enforces the role/group itself (`backend/lib/auth.js`'s `isStaff()` OR the legacy `Staff`
  group) — the authorizer validates the token but doesn't filter by group.
- [x] Deployed `backend/jobs/streams-handler.js` — DynamoDB Streams event source mapping,
  filtered to `LINEITEM#` writes, derives `orderStatus` via `backend/lib/order-status.js` and
  maintains GSI1 sparse-index hygiene. (METRIC# rollups deferred, as originally planned.)
- [x] Deployed `backend/jobs/expire-pending-orders.js` on a 15-minute EventBridge cron
  (`kcmps-expire-pending-orders-schedule`).
- [x] Cut the dashboard over: `getAllOrders`/`getOrder`/`verifyPayment`/`setOnHold`/
  `advanceLineItem` in [dashboard-data.js](../website/dashboard/dashboard-data.js) now `fetch()`
  the real API (Bearer = `kcmps_tokens`'s **ID token**, not the access token — see below), with
  the manual-order-entry path (`createManualOrder`, mock-only, no Lambda built for it) merged in
  so it doesn't disappear from the jobs list. `jobs.html`/`job-detail.html` updated to `await`
  the now-`async` calls; both pages' CSP got a `connect-src` for the API origin. No other
  `.html`/mock function touched.
- **3 real bugs found and fixed during this pass** (see `docs/history.md` for the full story):
  1. `backend/lib/auth.js`'s `getGroups()` didn't handle API Gateway HTTP API's actual
     `cognito:groups` claim serialization — confirmed live to be a bracketed,
     **space**-separated string (`"[Staff Admin]"`), not a comma-join. Fixed + covered by a new
     `lib.test.js` case.
  2. `backend/lib/constants.js`'s `STATUS.DISPATCH` wrongly collapsed two real, distinct
     dashboard statuses (`"Ready for Dispatch"` → `"Dispatched"`) into one — split back out and
     `advance-line-item.js`'s `LEGAL_TRANSITIONS` fixed to match.
  3. Real line items use `name`, real orders have no nested `client` object — mock UI expected
     `description`/`client.name`. Normalized inside `dashboard-data.js`'s fetch wrapper, not any
     `.html`.
  4. (IAM, not a code bug) both new Lambda roles were missing `dynamodb:PutItem` — needed
     alongside `TransactWriteItems` for the `EVENT#` item writes inside each transaction.
- **Known, deliberately-accepted gaps**: `sendToRework`/`setSetupMinutes` stay mock-only (no
  Lambda built for spoilage/rework in this pass); the dashboard's local-dev fake-login bypass no
  longer works on `jobs.html`/`job-detail.html` specifically (real JWT authorizer correctly
  rejects the unsigned fake token); `store.js` sends the *access* token as Bearer for checkout
  while `create-order.js`'s verifier expects the *ID* token — pre-existing, unrelated to 1.3,
  likely means `customerSub` is always `null` even for logged-in customers today.
- Verified end-to-end against a real (throwaway) Cognito test user in the `Admin`+`Staff`
  groups and a real leftover order: fetched via the real dashboard-data.js code (run in Node
  against the live API, since the sandboxed test browser blocks all outbound cross-origin
  `fetch()` — confirmed independent of this app, `example.com` failed identically), verified its
  payment (`Pending Payment Verification` → `Confirmed`), advanced it twice more (`→ Scheduled →
  In Production`), confirmed `orderStatus` and GSI1 caught up correctly a few seconds later via
  the Streams handler. All test data (order items, Cognito test users) deleted afterward.

### 1.4 — Customer order tracking (closes the loop, makes it "feel complete") ✅ done (2026-08-01)
- [x] Fixed the pre-existing bug from 1.3's notes: `store.js` was sending the *access* token as
  Bearer on checkout while `create-order.js`'s verifier requires the *ID* token — `customerSub`
  was silently `null` for every order, logged in or not. `store.js`'s `accessToken()` renamed to
  `idToken()` (reads `id_token`, mirroring `dashboard-data.js`'s existing helper) and both
  checkout call sites (`submitOrder`, `submitPaymentProof`) switched over.
- [x] New [`website/orders.html`](../website/orders.html) — logged-in customer sees their orders
  + a 6-stage progress bar (`Order Placed → Payment Verification → Confirmed → In Production →
  QC → Delivered`, Payment System file), plus a rejected-payment branch and each line item's own
  status underneath. Calls the existing `GET /orders` route (already filtered server-side via
  `getOrdersForSub()`), Bearer = ID token. Redirects to `index.html?login=required` if no session.
- [x] "My Orders" nav link added to `index.html`'s `renderLoggedIn()`, visible to every
  logged-in user (unlike the Staff-gated Dashboard link).
- **Verified end-to-end live (2026-08-02)** against a real, permanent Cognito test user
  (`test-customer`, `Customer` group — kept, not deleted, for future re-testing) and a real
  order (`ORD-AMT5L9`): logged in via the real Hosted UI, placed a real order as that customer,
  confirmed via `dynamodb get-item` that `customerSub` now populates (previously always `null`),
  and confirmed `orders.html` fetched and rendered the order with the correct "Payment
  Verification" stage highlighted. No console errors.

**Definition of done for Milestone 1:** a real order in DynamoDB, a GCash proof on S3, a staff
verify/on-hold that moves real statuses, an auto-expiry cron, and a customer who can see the
result. `mailto:` checkout retired.

### 1.5 — My Orders expansion (closes real gaps found in 1.4's UAT pass) ✅ done (2026-08-02)

1.4 shipped the minimum: an order ID, a status pill, and a progress bar that was actually buggy.
`GET /orders` already returned the full event timeline, GCash payment detail, and delivery
address to the customer — none of it was rendered. Phased so the bulk of the customer value
shipped with zero backend changes; Phases 2–3 below closed the rest.

**Phase 1 (frontend only):**
- [x] New [`website/orders-data.js`](../website/orders-data.js) — the `window.KCMPS_ORDERS` seam
  (mirrors `KCMPS_STORE`/`KCMPS_DASH`). Owns session handling, fetch/cache (30s, no polling —
  `getOrdersForSub()` is a table Scan), and one canonical status model covering both the
  line-item and order-rollup vocabularies — the previous `orders.html` keyed its stage map on the
  wrong one, so `Awaiting Quote`/`Awaiting Payment`/`Partially Fulfilled`/`Unknown` all silently
  collapsed to stage 0, and `Cancelled` rendered as a fully-filled "Delivered" bar. Both fixed.
- [x] `website/orders.html` rebuilt as bucketed tabs (Action needed / In progress / Completed /
  Cancelled, Shopee/Lazada-style) with search. New [`website/order-detail.html`](../website/order-detail.html)
  — deep-linkable `?id=ORD-XXXX`, with order total, full timeline, GCash payment card, and the
  delivery address (captured at checkout, previously rendered nowhere in the app, staff side
  included).
- [x] Reorder (zero backend — re-adds via the real `KCMPS_STORE.addToCart`, always re-priced from
  the live catalog, never the stored `priceEach`) and resubmit-payment-proof (reuses
  `POST /orders/{id}/payment-proof` verbatim) — the rejected-payment message used to say "please
  resubmit your GCash proof" with no way to actually do that anywhere on the site.
- [x] `store.js`'s post-checkout popup now links to the order-detail page; `index.html`'s
  `?login=required` redirect now shows a sign-in banner instead of silently dropping the visitor
  on the homepage.

**Phase 2 (existing Lambdas, no new routes) — verified live against real orders, then redeployed:**
- [x] `backend/staff-api/get-orders.js` now redacts staff-internal fields (`li.station`,
  `li.setupMinutes`, `li.spoilage`, `order.correspondenceLog`, event `actorSub`/`actorName`/
  `station`/`meta` beyond `holdReason`) for non-staff callers, and sorts newest-first
  server-side. The redaction is pure and shared via new
  [`backend/lib/customer-view.js`](../backend/lib/customer-view.js) (`redactForCustomer`,
  `contactsMatch`) — covered by `backend/lib/lib.test.js`. This data was already reaching the
  customer's browser unrendered; now it doesn't leave the Lambda at all for a non-staff caller.
- [x] `backend/checkout/create-order.js` stamps `originalPromisedDate` (business-day offset from
  `BASE_LEAD_BUSINESS_DAYS = 3`, skips weekends) on SKU-only orders — real orders previously had
  no ETA at all (`originalPromisedDate` was mock-data-only). Left `null` for any order containing
  a custom line, since those have no price or production slot yet to promise a date against.
  Frozen at creation, never overwritten (OTIF per the ERP file is measured against the original
  promise).
- [x] `backend/staff-api/verify-payment.js` sends the two customer emails the Payment System spec
  always called for but never had (`verifyPayment`/`setOnHold` sent nothing; only the
  "under verification" email at submission existed). Same best-effort pattern as
  `submit-payment-proof.js` — wired live (2026-08-03/04): `FROM_EMAIL` set, SES production
  access enabled (`ProductionAccessEnabled: true`), DKIM/MAIL FROM verified working. See
  `backend/infra/README.md` "SES customer notifications" section.

**Phase 3 (two new routes on the existing `kcmps-checkout-api`, id `6msg2uho6c`):**
- [x] `POST /orders/lookup` → new `kcmps-lookup-order` Lambda
  ([`backend/checkout/lookup-order.js`](../backend/checkout/lookup-order.js)) — guest order
  lookup by `{orderId, contact}`. `orderId` alone isn't a meaningful secret (6-char base36, same
  tradeoff `submit-payment-proof.js` already accepts), so the contact match is the real
  authentication: identical generic 404 for both a wrong order ID and a wrong contact (no
  enumeration oracle), a 300ms artificial delay on both failure paths, route throttled to
  5 req/s (burst 10) — tighter than the other two no-authorizer routes. Recovers a customer
  segment that was previously locked out of `GET /orders` forever (guest orders have
  `customerSub: null`).
- [x] `POST /orders/{orderId}/cancel` → new `kcmps-cancel-order` Lambda
  ([`backend/checkout/cancel-order.js`](../backend/checkout/cancel-order.js)) — authorizes via a
  Bearer ID token matching `customerSub`, or the same contact-match fallback for guests. Only
  allowed while every line item is `Quoted`/`Priced`/`Pending Payment Verification`/
  `On Hold`; the moment anything is `Confirmed` or beyond, KCMPS has committed
  material/schedule, so it 409s pointing at support instead. Same `TransactWriteItems` +
  optimistic-lock shape as `verify-payment.js`; never writes `orderStatus` (streams-handler.js
  stays the only writer). Wired into `order-detail.html` as a "Cancel order" button, gated on the
  same cancellable-status set client-side (UI-only — the backend re-checks authoritatively).
- Both routes reuse the existing API (same origin already in the CSP `connect-src` of both order
  pages — no CSP change needed) and the existing `kcmps-checkout-lambda-role` (already had exactly
  the DynamoDB permissions both new Lambdas need — no new IAM role).
- **Verified live end-to-end** through the real public HTTPS endpoint (not just direct Lambda
  invoke): a real order created, looked up with the correct contact (succeeds) and an incorrect
  one (byte-identical 404 to a nonexistent order ID), cancelled while pre-production (succeeds,
  line item → `Cancelled`, `GSI1PK` correctly removed) and rejected once advanced to `Confirmed`
  (409, correct message). All throwaway test orders deleted afterward, matching this repo's
  established smoke-test convention (see 1.3's notes in `backend/infra/README.md`).
- **Not built**: a guest-facing UI for `/orders/lookup` (a "track your order without logging in"
  entry point) — the backend route is live and tested, but wiring it up is a new page/nav entry,
  not a button on an already-authenticated page, so it's left for a follow-up request rather than
  folded into this pass.

---

## Parallel track — Design Asset Library (no dependency on Milestone 1)
Cost impact of the plan below is tracked in [docs/cost-governance.md](cost-governance.md)'s
decision log — check it before deviating from the storage/lifecycle choices here.

**Status (2026-08-06): backend fully built and live on staging** — all 5 Lambdas (upload-url,
publish, list, patch, purge), all 4 API routes, and the recycle-bin cron, per the checklist
below. **Not yet done:** the dashboard's real upload/browse/recycle-bin UI (still the
placeholder page) and the one-time `store.js` manifest-merge that makes a published design
actually appear in the storefront's design picker — see the two open checklist items near the
end of this section. Production has none of this — promotion is owner-gated. Original
(2026-08-02) note, now historical: architecture finalized, no backend built. A minimal,
non-functional structure was
built deliberately small so a future session can implement the real backend (S3 buckets,
Lambdas, IAM, API routes) with full context in one pass, rather than half-building it here:
- [`website/dashboard/design-library.html`](../website/dashboard/design-library.html) — real
  upload-form markup (name/description/category/tags/original-file/web-ready-file, category
  options sourced from `KCMPS_STORE_DATA.leaves` so they can't drift from the storefront) and a
  library grid, both wired to `dashboard-data.js`. Submit button is disabled ("Backend not built
  yet") — no Lambda exists to call.
- [`dashboard-data.js`](../website/dashboard/dashboard-data.js)'s `getDesigns()` — stub behind
  the same `KCMPS_DASH` seam, returns `[]`. Swap its body for a real `GET /designs` fetch once
  `backend/design-library/` exists; the `.html` shouldn't need to change.
- **Correction found during planning:** `buildDesignGrid()` in `store.js` reads a static,
  hardcoded `images[]` array per product in `products.js` — there is no manifest fetch for
  design images today (unlike the hero carousel's `HERO_MANIFEST_URL`). A future publish-design
  Lambda writing to S3 alone cannot make a new design appear in the storefront picker; a
  one-time `store.js` change (merge each product's static `images[]` with a fetched
  `design-manifest.json`, mirroring the hero carousel's proven pattern) is required first. Not
  yet implemented — flagged here so the next session doesn't rediscover it from scratch.

**Trigger (2026-07-30):** the designer has no home for source files today — no versioned
storage, no way to browse past work, and publishing a new design to the storefront is a manual
file-drop that only scales because the catalog is still small. This is a real, currently-unmet
need, so it's in scope now rather than deferred (ERP file Part 0 governing rule). Extends
Module 1 (Sales & Order) in the ERP file's module map — it's the supply side of the existing
design picker, not a new module.

Reuses the Milestone 1.0 foundation (the `kcmps` DynamoDB table, `backend/lib/` conventions)
and the S3/manifest pattern already proven for the hero carousel
(`storefront-infra/logic-inputs/generate-asset-manifest.js`), so it can be built before, during,
or after Milestone 1 — nothing here blocks or is blocked by the payment work.

**Architecture (finalized 2026-08-02 — this is the spec a future implementation session builds
from; no code/CloudFormation/frontend changes were made this session):**

*Storage — two buckets, deliberately asymmetric:*
- New **private** bucket, e.g. `kcmps-design-originals-est-2026`, for source files
  (PSD/AI/PDF). Versioning ON. Public access blocked entirely. No CloudFront in front of it —
  staff-only, low-frequency, authenticated access via presigned URLs only, same pattern as
  [`backend/checkout/submit-payment-proof.js`](../backend/checkout/submit-payment-proof.js). A
  CDN here would add a second distribution for zero caching benefit.
- **Existing public** bucket (`kcmps-online-bucket-est-2026`) for the derived web-ready image,
  same as every other storefront asset — reuses the existing CloudFront distribution and the
  manifest pattern already proven for the hero carousel
  ([`storefront-infra/assets-bucket-structure.md`](../storefront-infra/assets-bucket-structure.md),
  `generate-asset-manifest.js`).
- **No server-side image processing.** `design-library.html`'s upload form already collects
  both an original file and a web-ready file directly from the designer — keep it that way,
  don't add a Lambda-side resize pipeline (see the cost-governance decision log entry).

*Upload path — direct-to-S3 presigned PUT*, mirroring `submit-payment-proof.js`:
1. `getUploadUrl` Lambda (JWT-verified, Production/Sales/Admin group) returns presigned PUT URLs
   for both files, 300MB size ceiling each (single PUT, no multipart needed at that ceiling).
2. Browser PUTs directly to S3 for both files — never proxied through Lambda.
3. `publishDesign` Lambda writes the `DESIGN#<id>` META item (`name`/`description`/`category`/
   `tags`/`uploadedBy`/`s3KeyOriginal`/`s3KeyWeb`/`status`; `category` = an existing catalog
   leaf from `products.js`), copies the web-ready file into the public bucket, and regenerates
   `design-manifest.json` (same short-`Cache-Control`, no-invalidation pattern as the hero
   carousel's manifest) — this is what makes the storefront "auto-update" without a code
   deploy.

*Metadata:* reuse the existing single `kcmps` DynamoDB table, stamped via `backend/lib/item.js`'s
`baseItem()` and logged via `events.js`'s `buildEvent()` — same conventions as orders. **No new
GSI yet** — `Scan` + client-side filter is fine at current volume; add a category GSI only once
the catalog exceeds ~500 items or scan latency is visibly bad.

*Recycle bin — soft delete, two independent layers* (owner's explicit requirement: an
accidental dashboard delete must always be recoverable):
1. **App-level:** "Delete" flips `DESIGN#<id>` to `status: "archived"` + `deletedAt` (same
   convention as `baseItem()`). Dashboard adds a "Recycle bin" tab with one-click Restore. S3
   objects are never touched by this action. A 15-minute-cron Lambda (same shape as
   [`backend/jobs/expire-pending-orders.js`](../backend/jobs/expire-pending-orders.js)) sweeps
   archived items older than 90 days and hard-deletes both the DynamoDB item and both S3
   objects — the actual permanent purge.
2. **S3-level:** versioning on the originals bucket with `NoncurrentVersionTransition` to
   Glacier at 30 days, and `NoncurrentVersionExpiration` with `NewerNoncurrentVersions: 5` —
   keeps the 5 most recent prior revisions indefinitely, caps runaway growth from repeated
   re-uploads.

*Lambda sizing:* default 128–256MB, no provisioned concurrency — staff-admin actions, not a
customer-facing critical path (see cost-governance decision log).

*API surface:* routes on the **existing** HTTP API Gateway (no second API Gateway):
`POST /designs/upload-url`, `POST /designs`, `GET /designs`, `PATCH /designs/{id}`, plus the
non-API-routed purge cron.

*Access = existing Production/Sales/Admin Cognito groups* (per 2026-07-30 decision) — no new
6th role; reuses the 5-role model already provisioned in
[`backend/infra/foundation.cfn.yaml`](../backend/infra/foundation.cfn.yaml).

*Autonaming* reuses `window.KCMPS_TEXT.titleFromFilename()`'s existing filename→display-title
convention (`products.js`) so the library and the storefront can never drift into two different
naming schemes.

**Checklist:**
- [x] Private S3 bucket (staging: `kcmps-design-originals-staging`, 2026-08-05) — versioned, public access blocked,
  `NoncurrentVersionTransition` to Glacier at 30 days + `NoncurrentVersionExpiration`
  `NewerNoncurrentVersions: 5`
- [x] `DESIGN#<id>` META shape (2026-08-06, `backend/design-library/publish-design.js`): `name`, `description`, `category` (=leaf id), `tags`,
  `uploadedBy` (Cognito `sub`), `s3KeyOriginal`, `s3KeyWeb`, `status` (`draft`/`published`/
  `archived`), `deletedAt` (soft-delete only)
- [x] `getUploadUrl` Lambda (2026-08-06, staging only — `backend/design-library/get-upload-url.js`) — presigned PUT to the private bucket, key
  `designs/<category>/<uuid>-<sanitized-name>.<ext>`, 300MB size ceiling, single PUT
- [x] `publishDesign` Lambda (2026-08-06, staging only — `backend/design-library/publish-design.js`) — on upload confirm: copies the caller-supplied web-ready file
  (no server-side resize) into the public storefront assets path via `titleFromFilename()`,
  writes the `DESIGN#` record, and regenerates the design-grid manifest (same pattern as the
  hero carousel's manifest, new leaf)
- [x] Recycle-bin sweep Lambda (2026-08-06, `backend/jobs/purge-archived-designs.js`, 15-min
  cron, shape of `expire-pending-orders.js`) — archives older than 90 days get hard-deleted
  from both DynamoDB (with an `EVENT#` audit record written in the same transaction, before
  the delete) and both S3 objects on the private originals bucket. Live-tested against a
  backdated real record on staging. Staging only — production promotion is owner-gated, see
  `backend/infra/README.md`
- [x] Wire the 4 API routes onto the existing HTTP API Gateway, JWT-authorizer-gated — **all 4
  live on staging** as of 2026-08-06: `POST /designs/upload-url` + `POST /designs` (gated to
  Production/Sales/Admin via `requireRole()`, 2026-08-06), `GET /designs` (gated to any staff
  role via `isStaff()` — a read) + `PATCH /designs/{id}` (gated to Production/Sales/Admin,
  2026-08-06). **Production has none of the 4** — promotion is owner-gated, see
  `backend/infra/README.md`'s "Design Asset Library Lambdas" section
- [x] `PATCH /designs/{id}` also owns the **draft → published** transition (2026-08-06,
  `backend/design-library/patch-design.js`'s `publish` action) — reuses `publish-design.js`'s
  exact scan-gate + public-bucket-copy logic rather than a second copy of it. Live-tested:
  uploaded a real design as a draft, promoted it once GuardDuty's scan landed, confirmed the
  manifest and public S3 copy both picked it up
- [x] A **"Soon"-badged placeholder page exists**: `website/dashboard/design-library.html`
  (nav key `design`, 2026-07-31). It already carries the correct shell, `mount("design")`, and
  topbar title — building the real page means replacing its `<main>` contents, nothing else.
- [ ] Dashboard "Design Library" page: upload form (category dropdown sourced straight from
  `products.js`'s leaves) + browsable/searchable grid (filter by category, tag, uploader) +
  Recycle bin tab with Restore
- [ ] **One-time `store.js` change (not yet implemented, see "Correction found during
  planning" above):** `buildDesignGrid()` must merge each product's static `images[]` with a
  fetched `design-manifest.json`, mirroring `HERO_MANIFEST_URL`'s pattern — without it,
  `publishDesign` alone can't make new designs appear in the storefront picker
- [ ] Verify `buildDesignGrid()`/the design picker need zero further `.html`/`store.js` changes
  beyond the manifest-merge above to pick up a newly published design

**Resolved decision (2026-08-02):** max upload size is 300MB per file via a single presigned
PUT — no multipart upload needed at that ceiling.

**Implemented 2026-08-06 (staging only) — the manifest is now a contract.** The upload +
publish backend is live on `kcmps-backend-staging` and was exercised end-to-end: presign →
real PUT of both files → GuardDuty verdict → publish → `design-manifest.json` written to the
public bucket under the `dev-site/assets/designs/` prefix. The fail-closed scan gate was
verified against a real `PENDING` state (publish refused with `stillScanning: true`, no record
written, no public object created) and then against real `NO_THREATS_FOUND` verdicts (publish
succeeded). **The exact `design-manifest.json` JSON shape is documented in
`backend/design-library/publish-design.js`'s header** — that is the spec the still-unbuilt
`store.js` `buildDesignGrid()` merge (the "Correction found during planning" item above) must
read. Its `image` field is site-root-relative with no leading slash, which is what makes the
same manifest correct on both `kcmps.com` and `dev.kcmps.com`.

---

## Parallel track — Staff email panel (no dependency on Milestone 1)
**Trigger (2026-07-30):** requested as an embedded, already-logged-in staff mailbox inside the
dashboard. **Technical constraint found during planning:** a literal "logged-in mini-browser"
iframe is not viable for any modern webmail — providers set `X-Frame-Options`/CSP
`frame-ancestors` specifically to block this as a clickjacking defense, and even where framing
happens to be allowed, piping a live authenticated third-party session through our own app
would make the dashboard a full man-in-the-middle for that mailbox's session cookie. Staff mail
is on **Spacemail** (Spaceship, formerly under Namecheap), which supports standard IMAP/SMTP —
that's the actual integration point, not the webmail UI.

**Research finding (2026-07-30) — Spacemail app-specific passwords, unresolved:** Spacemail's
own client-setup docs (Spark, Outlook, Thunderbird, macOS Mail) all authenticate IMAP/SMTP with
the **regular mailbox password**, with no app-password step mentioned anywhere. Spacemail's
documented Security Center covers 2FA, Activity Log, and Device Management — no "Application
Passwords" feature is documented, unlike the older, separate "Namecheap Private Email" product
which explicitly has one (`Settings > Security > Application Passwords`). Spacemail appears to
be a newer, distinct platform that didn't inherit that feature. **Not confirmed either way from
docs alone** — the deciding test is empirical: enable 2FA on one staff mailbox and try an IMAP
client login with the regular password; if it's rejected with no app-password fallback offered,
the gap is confirmed. Do this test before starting the build.

**Revised architecture — a native inbox panel backed by IMAP/SMTP, not an iframe:**
- Staff connects their mailbox **once**, in their own dashboard session: enters their
  `@kcmps.com` address + credential (app-specific password if the test above confirms Spacemail
  supports them; otherwise see the two-tier fallback below).
- **Credential storage: SSM Parameter Store `SecureString`, not Secrets Manager.** Secrets
  Manager charges a flat $0.40/secret/month regardless of use, which is a fixed recurring cost
  for a handful of rarely-touched staff credentials on a 4-person team. Parameter Store
  standard-tier parameters are **free** (no monthly fee) with the same KMS-backed encryption at
  rest and the same per-item IAM scoping (`/kcmps/staff/<sub>/email-cred`) — only the KMS
  encrypt/decrypt API calls are billed, at ~$0.03/10,000 requests, negligible at this usage
  level. Trade-off: no built-in rotation-Lambda templates like Secrets Manager has, but that's
  not needed here — a compromised app password is rotated manually by the staff member from
  their own Spacemail settings, not on an automated schedule. Written via a Lambda the staff
  calls themselves; never stored in DynamoDB, never touches client-side JS after that one call.
- `getInboxMessages` Lambda — opens a short-lived IMAP connection scoped to the caller's own
  parameter, fetches headers/snippets/thread list, closes the connection. No standing
  connection.
- `sendEmail` Lambda — same pattern over SMTP.
- Dashboard gets a new "Email" tab that renders the fetched messages in KCMPS's own UI. To the
  staff member it feels like an always-logged-in embedded mailbox; under the hood it's API
  calls, not a framed session — this is what makes it both possible and safe to build, versus
  the originally-requested literal iframe.

**Two-tier fallback if Spacemail has no app-password mechanism:**
1. **Near-term:** store the staff member's *regular* mailbox password (same Parameter Store
   design above) rather than a scoped app password. Works today, but is a materially weaker
   design — a leaked credential is full account takeover, not just mail access — and creates
   pressure to leave 2FA off on staff mailboxes, which is the wrong trade for a business email
   account. Treat this as a stopgap, not the end state.
2. **Better, if the trade-off in (1) is unacceptable:** migrate staff email off Spacemail to a
   provider with real OAuth support — Google Workspace (~$7/user/mo) or Microsoft 365 Business
   Basic (~$6/user/mo). Both expose Gmail API / Microsoft Graph: no stored passwords at all,
   staff revoke dashboard access from their own account settings, scoped + revocable tokens
   instead of a stored secret of any kind. This is the architecture this feature actually wants
   — worth a real cost/migration-effort comparison against staying on Spacemail if tier 1 turns
   out to be necessary.

**Checklist:**
- [ ] Empirically test Spacemail app-password support (2FA + third-party client login test
  above) — resolves which tier of the fallback plan applies
- [~] **WITHDRAWN 2026-08-06** — SSM Parameter Store `SecureString`, one parameter per staff
  `sub`. This is Tier 1 (stored real mailbox passwords) and personal mailboxes, both rejected.
- [~] **WITHDRAWN 2026-08-06** — `getInboxMessages` / `sendEmail` IMAP/SMTP Lambdas reading a
  stored per-staffer credential. Replaced by `backend/mail/*.js` over the SES relay.
- [x] **DONE (mock data), 2026-07-31 — `website/dashboard/email.html`.** The full Email tab,
  running on mock data behind the `window.KCMPS_DASH` seam exactly like every other dashboard
  page, so it was unblocked by the still-pending app-password test. Scope: **read + reply**
  (no "compose new"). Mailbox selector covers both shared shop inboxes (`order@`, `info@`) and
  the signed-in staffer's personal mailbox. The mock function shapes deliberately mirror an IMAP
  `FETCH` — including the envelope/body split across `getMessages()`/`getMessage()`, matching
  IMAP's two round-trips — so wiring the real Lambdas is a function-**body** change with no
  `.html` edit. New API: `getMailboxes`, `getMessages`, `getMessage`, `getThread`,
  `markMessageRead`, `sendReply`.
- [x] **v1 deliberately renders plain text only.** HTML parts are never rendered (a notice is
  shown instead), remote images are never loaded (the page CSP `img-src 'self' data:` also fails
  closed), attachments are metadata-only (no download path exists yet), and URLs are not
  auto-linkified (auto-`<a>` on arbitrary mail is a phishing amplifier). Verified against
  injected `<script>`/`<img onerror>` in every field — sender name, subject, body, filename.
- [~] **WITHDRAWN 2026-08-06** (see the decision record further down this section — Tier 1
  stored-credential IMAP is rejected outright, and the access model below now lives in
  `backend/lib/mail.js` over the SES relay with **no credential storage anywhere**; `order@`/
  `info@` are aliases into the single `admin@kcmps.com` mailbox, not separate mailboxes with
  separate passwords). Kept for the reasoning, which still holds:
  Shared-mailbox credentials are a **second namespace** the architecture above doesn't cover:
  `/kcmps/shared/order/email-cred`, `/kcmps/shared/info/email-cred`, written once by an admin,
  one credential per shop inbox rather than per staff `sub`. Access decided by **Cognito group**:
  `order@` → Sales/Finance/Admin, `info@` → Sales/Admin, Production → personal mailbox only,
  Customer → none. Encode as `backend/lib/mail.js` (`MAILBOX_ACCESS`, `canAccessMailbox(groups,
  mailboxId)`) so it's unit-testable with the rest of `backend/lib/`. `getMailboxes` decides
  *visibility*, but every other handler must re-check — never trust the client's `mailboxId`.
- [ ] **Trap to honour when writing `putEmailCredential`:** derive `<sub>` from the *verified
  JWT*, never from the request body. Accepting a client-supplied `sub` lets any staff member
  overwrite anyone else's stored credential. Sharpest trap in this feature.
- [~] **WITHDRAWN 2026-08-06** — SSM Parameter Store `SecureString`, one parameter per staff
  `sub`. This is Tier 1 (stored real mailbox passwords) and personal mailboxes, both rejected.
- [~] **WITHDRAWN 2026-08-06** — `getInboxMessages` / `sendEmail` IMAP/SMTP Lambdas reading a
  stored per-staffer credential. Replaced by `backend/mail/*.js` over the SES relay.
- [ ] Explicitly **not building**: any iframe/embedded-session approach to Spacemail's webmail
  — closed off above as a hard constraint, not a missing feature

**Open decisions:** (1) Spacemail app-password support — test before starting the *backend*,
gates which credential tier gets built (the UI above did not need it). (2) If tier 2 (provider
migration) becomes necessary, get owner sign-off on cost/migration effort before touching DNS/MX
records — that's a shared-infrastructure change, not something to do unilaterally. (3) **Shared
inbox `\Seen` semantics:** IMAP flags are per-mailbox, not per-user, so one staffer opening a
shared-inbox message marks it read for everyone. Defensible for a triage inbox, but decide it
deliberately rather than discovering it in production; if it's wrong, the fix is per-user read
state in DynamoDB keyed on `<sub>` + `Message-ID`, layered over the IMAP flags.

**RESOLVED (2026-07-31) — Spacemail has no app-password mechanism.** Confirmed empirically:
Settings → Connect third-party apps → IMAP/SMTP/POP3 configuration screen states the password
field is "Your mailbox password" — no app-specific credential option anywhere in the flow. This
closes the open question above: any IMAP/SMTP integration against Spacemail must either store
the real mailbox password (Tier 1, a materially weaker design — see below) or bypass
IMAP/SMTP-with-stored-credentials entirely.

**Reconsidered (2026-07-31) — is an embedded inbox tab worth building at all?** Re-examined
whether the value here is "staff read mail inside the dashboard" (marginal — Spacemail's own
webmail already does this, a bookmark costs nothing) versus "email threads are linked to
orders" (real — order-linked correspondence is discoverable and disputable, the reason this
was worth discussing in the first place). Decision: **the order-linking payoff is what's worth
building toward, not a generic embedded-inbox UI.** This reframes the whole track — the
mock `email.html` inbox built earlier stays as-is (useful, already shipped) but is no longer the
required path to get order-linking; see the lightweight alternative shipped below, which
delivers the linking value today with zero relay infrastructure.

**Order↔email linking — lightweight version, DONE (2026-07-31).** Before committing to the
SES-relay build (below), shipped the actual payoff at near-zero cost: `job-detail.html` gained a
"Customer correspondence" card with (a) a manual log — staff type a note referencing what was
discussed by email (`KCMPS_DASH.addCorrespondenceLog(orderId, note, actorName)`, a new
`order.correspondenceLog` array, backfilled via `ensureCollections()` per this file's existing
additive-migration pattern) — and (b) a "Search Spacemail for this order" button that deep-links
to `https://spacemail.com/mail/?f=INBOX&search=<orderId>`, which works because every staff
mailbox already forwards into `admin@kcmps.com` (owner-configured Spacemail forwarding rule),
making that one inbox the de facto shared search target. No email content is ever stored by the
dashboard — only the staff-written note and a link to go find the real thread. This alone
resolves the two real pros identified for order-linking (fast lookup, disputable audit trail)
without any of the SES-relay/credential-storage complexity.

**SES relay — in progress (2026-07-31), pursuing despite the above** because full inbound
mirroring (auto-populating the dashboard with actual message content, not just a manual log) is
still the more complete end state and its infra cost is near-zero. Progress so far:
- `kcmps.com` verified as an SES sending identity (`ap-southeast-1`) — DKIM CNAMEs, a
  `mail.kcmps.com` MAIL FROM domain (its own MX to `feedback-smtp.ap-southeast-1.amazonses.com`
  + SPF TXT), and a `_dmarc.kcmps.com` DMARC TXT (`p=none`) all added via `UPSERT` to the real
  zone `Z06397161LBTJCRTPLL62` in account `260866268499` (`default` profile) — change ID
  `C09946213N3M6GO6S21RC`. Purely additive; `kcmps.com`'s existing MX (Spacemail) untouched.
- SES production-access request submitted for the same region; AWS Support asked for more
  detail (standard for new accounts) — response drafted covering sending volume/frequency,
  recipient-list policy (existing-customer replies only, no marketing list), bounce/complaint
  handling plan, and a sample email; saved outside the repo at
  `~/Desktop/ses-production-access-response.txt` (not committed — support-ticket correspondence,
  not project documentation). **Status: pending AWS review as of 2026-07-31.**

**Remaining SES-relay checklist (production access cleared — `ProductionAccessEnabled: true`
as of 2026-08-06):**
- [x] **Bounce/complaint SNS notifications** (2026-08-06) — topic `kcmps-ses-bounce-complaint`,
  subscribed to `admin@kcmps.com`, wired as an event destination on the `kcmps.com` identity's
  existing configuration set. **Owner still needs to click the SNS confirmation email** —
  subscription is `PendingConfirmation`. See `backend/infra/README.md`'s new SES-relay section.
- [x] **`mirror.kcmps.com` verified as a receiving identity** (2026-08-06) —
  `VerificationStatus: SUCCESS`. Confirmed SES email receiving **is available in
  `ap-southeast-1`**, so no cross-region workaround was needed.
- [x] **MX record + DKIM CNAMEs for `mirror.kcmps.com`, S3 bucket, SES receipt rule** (2026-08-06)
  — MX → `inbound-smtp.ap-southeast-1.amazonaws.com` added via `UPSERT` to the real zone
  (change `C10397382N3T7IMLFR6TL`, no existing record touched); bucket
  `kcmps-inbound-mail-est-2026` (private, 30-day IA lifecycle); receipt rule set
  `kcmps-mirror-inbound` (active), one domain-catchall rule delivering to `inbound/`. Verified
  end-to-end: a real send from `admin+admin.kcmps.uat@kcmps.com` to `test@mirror.kcmps.com`
  landed in the bucket within seconds. Full detail + CFN doc in `backend/infra/README.md` /
  `backend/infra/ses-relay.cfn.yaml`.
- [x] Parser Lambda: S3-object-created trigger → parse MIME → write into the same
  `MESSAGE#`/mailbox shape `email.html`'s mock already expects (swap-in, not a rewrite) — C2
- [x] `sendReply`-equivalent Lambda via `SES.SendEmail`/`SendRawEmail` on the verified
  `kcmps.com` identity — C3
- [x] **Inbound hardening + shared-mailbox-only scope** (C5, 2026-08-06) — see the decision
  record immediately below, and `backend/infra/README.md`'s "Inbound hardening" section for the
  applied commands and the verification matrix.
- [ ] **ONE** Spacemail forwarding rule, `admin@kcmps.com` → `shop@mirror.kcmps.com`, plus a
  filter excluding AWS/SNS notification senders — **owner manual step**, no Spacemail
  credentials available to any Claude session. Exact instructions in `backend/infra/README.md`.
  Until this exists, nothing external reaches the relay.
- [ ] SES IP allowlist (`CreateReceiptFilter`, block `0.0.0.0/0` + allow Spacemail's ranges) —
  ranges resolved and commands written, deliberately **not applied** until real forwarded mail
  has been observed. Rationale and the fail-closed risk are in `backend/infra/README.md`.

### DECISION RECORD — staff email panel scope (owner, 2026-08-06)

**Shared shop mailboxes only.** `order@kcmps.com`, `info@kcmps.com`, `admin@kcmps.com` — read
and reply, inside the dashboard, off an SES relay of forwarded mail. That is the whole feature.

**Personal staff-mailbox mirroring: REJECTED, permanently.** Not deferred. A forward-based
mirror is a **one-way copy**: it can never reconcile sent mail or read state back to the real
mailbox. A staffer would open their "inbox" in the dashboard and see a permanently diverging
shadow — replies they sent from their phone missing, messages they already read still bold.
That is the wrong architecture for an individual's mail and no amount of polish fixes it. The
code path, its stack parameter, and its unit tests were **deleted, not left inert** — a dormant
`{mailboxId: sub}` parameter is an invitation to repopulate it and silently revive a rejected
design.

**Tier 1 (stored Spacemail mailbox passwords): REJECTED outright.** Previously carried above as
"a materially weaker design" pending a decision; the decision is now no. Spacemail has no
app-password mechanism (confirmed 2026-07-31), so Tier 1 means storing the *real* mailbox
password — which grants full mailbox takeover to anything that reads the parameter, and applies
active pressure to turn 2FA **off** so the automation can log in. Meanwhile the shared-mailbox
relay already covers the real use case at zero credential risk. A design that trades away
account security for a capability we already have is not worth building at any price.
Consequently the "shared-mailbox credentials as a second namespace"
(`/kcmps/shared/order/email-cred` …) and `putEmailCredential` items above are **withdrawn** —
the access model they described survives, but as `backend/lib/mail.js`'s group matrix over the
relay, with no credential storage anywhere.

**Tier 2 (Google Workspace or M365, OAuth, real two-way IMAP/Graph): the only correct path IF
personal mailboxes are ever genuinely wanted.** ~₱1,400–1,600/mo for 4 users, which is over the
₱500/mo soft cap on its own — a real decision, not a code change, and one for the owner with
`docs/cost-governance.md` open. Nobody should attempt to approximate it with forwarding again.

### The SES relay is a REPLACEABLE BACKEND, not a lock-in

Recorded at the owner's request so a later session doesn't unknowingly break it. Four properties
keep a future migration to Google Workspace (Gmail API) or M365 (Graph) a **backend-only**
change. **This is documentation, not a mandate to build a provider-abstraction layer** — there
is exactly one provider today, and building an abstraction for a second one that doesn't exist
would violate this repo's "build only when a real transaction has no home" rule.

1. **The `KCMPS_DASH` mail contract is provider-neutral.** `getMailboxes` / `getMessages` /
   `getMessage` / `getThread` / `markMessageRead` / `sendReply` are IMAP-shaped because IMAP is
   the lowest common denominator across Gmail, Graph, and raw IMAP. `email.html` does not change
   on a migration — only Lambda function bodies do. **Never leak SES-, S3-, or
   DynamoDB-specific fields into these responses.**
2. **`mailboxId` is the real address** (`order@kcmps.com`), never the mirror address. This is
   why the 2026-08-06 change matters beyond UX: `order@kcmps.com` is the identifier under *any*
   provider, whereas `order@mirror.kcmps.com` is relay-specific and would itself need migrating.
3. **Message identity is the RFC822 `Message-ID`**, which every provider preserves. `threadId`
   however is currently *derived* (References / In-Reply-To → normalized-subject fallback),
   whereas Gmail and Graph supply native thread ids. **Treat `threadId` as an opaque string
   everywhere — never parse it, never reconstruct it.** It is the one field a migration has to
   remap.
4. **`backend/lib/mail.js` stays pure and SDK-free**, so the access model and its unit tests
   survive a provider change untouched.

Two of today's compromises **disappear** on such a migration rather than needing fixes: sent-mail
divergence and read-state divergence both resolve, because you would be reading the real mailbox
instead of a forwarded copy of it.

---

## Parallel track — Operating-hours-aware verification SLA (built 2026-08-04)
**Status: shipped.** The payment-verification SLA clock (§5.5's 4-working-hour threshold) now
skips overnight/weekend gaps instead of counting raw wall-clock hours.

**Trigger:** the raw wall-clock aging read (`dashboard-data.js`'s old `agingHours()`) turned
"red" on Monday morning for a payment that had actually only sat unverified for a few real
working hours over a weekend — a false alarm every Monday, undermining trust in the red/warn
signal exactly when it should matter most.

**What shipped:**
- [`backend/lib/business-hours.js`](../backend/lib/business-hours.js) — pure
  `businessMinutesBetween`/`isWithinOperatingHours`/`nextOperatingStart`, fixed +8h Asia/Manila
  offset (no DST, so no timezone library needed). Unit-tested
  (`backend/lib/business-hours.test.js`) for same-day, overnight-spanning, and
  weekend-spanning cases — run via `node --test backend/lib/*.test.js`.
- `CONFIG#OPERATING_HOURS`/`META` — a new item type (`keys.js`'s `configPk()`), no CFN change.
  Doesn't exist in the table yet; every reader falls back to
  `DEFAULT_OPERATING_HOURS` (Mon–Fri 09:00–18:00, Sat 09:00–14:00, Sun closed) until a future
  Settings API (behind `/dashboard/settings`, currently a read-only mock) writes a real one —
  zero migration either way.
- [`backend/staff-api/verify-payment.js`](../backend/staff-api/verify-payment.js) — verifying
  is never gated on operating hours (staff can confirm a payment at 2am and the customer is
  emailed immediately, unchanged). What changed: if `verifiedAt` falls outside operating hours,
  the line item's `enteredStatusAt` (what `streams-handler.js` copies onto `GSI1SK`, what every
  SLA/aging read keys off) is stamped with the next operating-hours opening instead — so the
  *next* stage's clock doesn't count the overnight/weekend gap. The real `verifiedAt` is never
  lost: it's on the `EVENT#` record's `meta.verifiedAt` (alongside the adjusted
  `meta.slaClockStartsAt`) and on `payment.verifiedAt`, both audit trails a future Settings/CRM
  view could read.
- [`website/dashboard/dashboard-data.js`](../website/dashboard/dashboard-data.js)'s
  `decorateLineItem()` — the "Pending Payment Verification" red/warn threshold now reads
  `agingBusinessHours()` (a second, browser-side copy of the same clock math — no bundler in
  this repo to share one module across backend/frontend, see that function's header). Every
  other status (`Quoted`/`Priced`) is unchanged, still wall-clock.

**Explicitly NOT changed (flagged back to the requester, kept wall-clock on purpose):** the
48-hour payment-verification **auto-expiry** window
(`backend/jobs/expire-pending-orders.js`'s `VERIFICATION_EXPIRY_HOURS`) stays wall-clock. It's a
customer-facing promise stated in copy/email as calendar time ("submit proof within 48 hours") —
making it operating-hours-aware would silently extend it (a Friday-evening order wouldn't expire
until well into the next week) with no one having asked for that behavior change.

## Parallel track — Customer chat via order threads (built 2026-08-04)
**Status: shipped, hybrid model — polling now, upgradeable to real-time later without a data
model change.** Per-order message threads, readable/writable by the order's own customer
(logged in) or any staff member.

**Trigger:** the only existing customer↔staff channel was `correspondenceLog` — staff-only
manual notes the customer never sees — plus the "Contact us" `mailto:` link on
`order-detail.html`, which drops the customer out of the app entirely into their email client
with no order context attached.

**Data model — same table, no infra change:**
- New item type: `PK: ORDER#<id>`, `SK: MSG#<ISO timestamp>#<msgId>` (`keys.js`'s
  `messageSk()`) — co-located with the order, same pattern as `EVENT#`.
- Fields: `{ senderSub, senderRole: "customer"|"staff", body, attachments, readAt, at,
  orderId }`. `attachments` (was a single `attachmentRef` until the 2026-08-04 attachment
  upload feature below) is `[{filename, contentType, ref}]`, `ref` an `s3://` URI.
- `GSI2PK`/`GSI2SK` (`CLIENT#<customerSub>`/`MSG#<at>`) are written on every message **in
  preparation**, not activation — GSI2 isn't provisioned on the table
  (`backend/infra/foundation.cfn.yaml` only has GSI1). Adding the index later needs zero
  backfill. Until then, "all my messages across every order" is a client-side fan-out (call
  `GET /orders`, then `GET /orders/{id}/messages` per order) — the same accepted-interim
  tradeoff `staff-api/get-orders.js`'s own `CLIENT#`-filtered scan already documents. This is
  also why no separate account-level/global-inbox endpoint or floating chat widget was built —
  deferred deliberately, per the "manual-first, expand on signal" principle, not an oversight.

**Backend:**
- [`backend/staff-api/send-message.js`](../backend/staff-api/send-message.js) — `POST
  /orders/{orderId}/messages`. No guest posting (unlike `checkout/cancel-order.js`'s
  contact-match fallback) — chat requires a logged-in account by design, so this always goes
  through the JWT authorizer like every other `staff-api/*.js` Lambda.
- [`backend/staff-api/get-messages.js`](../backend/staff-api/get-messages.js) — `GET
  /orders/{orderId}/messages`, same staff-vs-customer branch as `get-orders.js`. Side effect
  (opt-in via `?markRead=true`, see 2026-08-04 follow-up below): marks the *other* party's
  unread messages read — the only "mark read" path, feeding the unread-reminder job below.
- [`backend/jobs/notify-unread-messages.js`](../backend/jobs/notify-unread-messages.js) — new
  EventBridge cron (every 30 min). "Digest, don't spam" (§5.5's principle, applied to customer
  notifications too): one SES reminder per order with unread staff replies older than 2 hours,
  not one per message. Bounded table Scan (no GSI for "unread" yet) — same accepted-interim
  tradeoff as the GSI2 note above; revisit if message volume ever makes this scan costly (see
  [docs/cost-governance.md](cost-governance.md)).
- **New Lambdas need owner deployment** — package/IAM/route wiring per
  `backend/infra/README.md`'s existing pattern (see that file's own note on these two routes
  and the new cron).

**Frontend (polling-based, ~8s interval while the panel is visible/tab is focused — not a
WebSocket):**
- `website/orders-data.js`'s `getMessages`/`sendMessage` + `order-detail.html`'s message thread
  card (customer-facing).
- `website/dashboard/dashboard-data.js`'s `getOrderMessages`/`sendOrderMessage` (named to avoid
  colliding with that file's existing IMAP-mock `getMessages(mailboxId)` for `email.html`) +
  `dashboard/job-detail.html`'s message thread card (staff-facing), sender-role styled
  (customer left-aligned / staff right-aligned, mirrored on the customer side).
- Swapping polling for a WebSocket subscription later only touches each page's poll-interval
  wiring — the message shape, the Lambda read/write logic, and the `KCMPS_ORDERS`/`KCMPS_DASH`
  function signatures don't change.

**Built 2026-08-04 (was deferred): attachment uploads for messages, and for the correspondence
log.** Both now use the presigned-upload pattern from `submit-payment-proof.js`: `send-message.js`/
`add-correspondence.js` (new) accept `attachments: [{filename, contentType}]`, validate against an
allow-list (`image/jpeg|png|webp|gif`, `application/pdf`; max 5 per note/message), and hand back a
presigned PUT url per file — the browser uploads directly to S3, the Lambda never sees file bytes.
`get-messages.js`/`get-orders.js` presign a short-lived GET url per attachment on every read (bucket
is private), mirroring the existing `payment.screenshotUrl` pattern. Same S3 bucket as GCash proof
uploads (`kcmps-payment-uploads-est-2026`), new `messages/<orderId>/…` and
`correspondence/<orderId>/…` prefixes — no new bucket, no CORS change needed (the existing PUT rule
is bucket-wide). `add-correspondence.js` is also the first live backend for the correspondence log
manual-note button at all — it was mock-only before (`dashboard-data.js`'s `addCorrespondenceLog()`
read/wrote `localStorage`, so a note logged against any real order silently threw "Order not
found" since real orders were never in that mock array). `correspondenceLog` stays stripped for
customers (`customer-view.js`'s `redactForCustomer()`), so attachment URLs are never presigned or
sent to a non-staff caller.

**Still explicitly NOT built:** any global/floating chat widget or true single-query
account-level view (blocked on GSI2 actually being provisioned — see the data-model note above).

**Follow-up (2026-08-04): unread-message badge, step one toward a real Messages tab.**
A full Messages nav tab needs a real cross-order query GSI2 doesn't provide yet (see above) —
too much to build just to answer "did anyone reply?". Shipped the cheap version instead:
- [`backend/staff-api/get-unread-messages.js`](../backend/staff-api/get-unread-messages.js) —
  `GET /messages/unread`, staff-vs-customer branched (like `get-orders.js`), same bounded-Scan/
  Query tradeoff as `notify-unread-messages.js` (no cutoff/side-effect, since this is a live
  read not a sweep). Returns `{ threads: [{orderId, customerName, unreadCount, lastMessageAt,
  lastMessageBody}], totalUnread }` — deliberately a list of threads, not just a count, so a
  future Messages tab (staff) or inbox view (customer) renders this SAME response as full rows
  instead of a badge; only the frontend changes then, this Lambda doesn't.
- `dashboard-data.js`'s `getUnreadMessageSummary()` wraps it under the same `KCMPS_DASH` seam.
- `dashboard-shell.js`'s `refreshUnreadBadge()` — called from every page's `mount()` (not just
  jobs.html, since an unread reply can sit on any ticket), paints a count badge
  (`.badge-unread`) on the sidebar's "Jobs" link, polls every 45s, and `job-detail.html` calls
  it again right after a markRead-triggered `getOrderMessages()` call so the badge drops
  immediately instead of waiting out the poll.
- When the real tab gets built: add a `messages` `NAV_ITEM`, a `messages.html` that calls the
  same `getUnreadMessageSummary()` for its list view, and a per-thread detail pane that's
  really just `job-detail.html`'s existing message-panel markup lifted into its own page.

**Fix (2026-08-04): mark-read decoupled from merely opening the ticket.** `get-messages.js`
marking the other party's messages read on *every* call meant the natural way to check "did I
get a reply?" — open the order/ticket page — was the same action that erased the unread signal,
often before the person looking ever saw the badge (confirmed live: unread went 1 → 0 across a
single simulated page-open). Fixed by making the mark-read side effect opt-in
(`?markRead=true`) instead of unconditional: the initial page-load fetch and the 8s background
poll in both `job-detail.html` and `order-detail.html` now call the endpoint read-only (still
render the thread immediately — nothing about seeing message content changed), and mark-read
only fires from a real engagement signal — the reply textarea gaining focus, via
`markMessagesRead(orderId)` in `dashboard-data.js`/`orders-data.js`. Glancing at a ticket to
check for a reply no longer silently clears the badge before you look.

**Follow-up (2026-08-04): customer-facing "New message!" banner, same seam, mobile-first.**
Extended `get-unread-messages.js` above with a customer branch — same response shape, scoped
to the caller's own orders (a bounded per-order `Query` after finding their orders via the same
`customerSub`-filtered scan `get-orders.js`'s `getOrdersForSub()` already uses, not a table-wide
scan — a customer's own order count is small, and scoping by everyone else's data would be
wrong anyway) instead of every order. `orders.html` ("My Orders"):
- A `.new-message-banner` full-width word-button — placed as the FIRST element inside
  `.orders-wrap`, before the page's own `<h1>`, since that's the one spot guaranteed
  above-the-fold on a phone (the nav bar is already tight on mobile — see its own collapse
  history — so a nav-icon badge risked being missed entirely).
- Clicking it scrolls to a `.unread-messages-card` "Unread messages" section right below,
  listing one row per order with an unread staff reply (message preview + count); clicking a
  row navigates to `order-detail.html?id=<order>#messages`, which auto-scrolls straight to that
  order's message thread (`renderMessagesCard()`'s card now has `id="messages"` for exactly
  this).
- `orders-data.js`'s `getUnreadMessageSummary()` is the customer-side twin of
  `dashboard-data.js`'s function of the same name — same endpoint, same response shape, so a
  future account-level inbox view (deferred, see the data-model note above) could reuse either
  side's fetch logic near-verbatim.

---

## Parallel track — Cash Book, job costing and production stations (built 2026-08-18/20)

Live in production. See `docs/cashbook-job-costing-plan-2026-08-18.md` for the original design
and `docs/history.md` entries 72–73 for what actually shipped.

**In production:** the ledger (log/void/day/month/categories), per-job costing, CSV day export,
re-linking a posted transaction to a job, transaction IDs, cross-day search, and the History
sub-tab (year → month → day → transactions, Admin-only).

**On staging only:** editable production stations in Settings (`CONFIG#STATIONS`,
`GET`/`PUT /stations`, Admin-gated). Promote once the owner has confirmed a retire sticks and the
job picker excludes it.

### Deliberately not built yet

- **Per-client cash book totals** — blocked on GSI2, which is not provisioned. Same blocker as the
  Clients page and account-level message threads; worth doing as one coordinated pass.
- **Server-side free-text search beyond the current design.** Search is bounded by walking day
  partitions of active months, which is proportional to real activity, not table size. If volume
  ever makes that slow the answer is a real index, **not** a filtered `Scan` — see
  `backend/cashbook/search-transactions.js`'s header for why a Scan is the wrong tool here.
- **`verify-payment.js` auto-post.** The plan's second ledger writer (Trap 1) is still an unwired
  seam: a verified GCash payment does not yet post itself to the cash book, so staff log it
  manually and `log-transaction.js` warns when an order already carries a system-posted row.
- **A `deleted` filter on the orders read path.** Nothing filters soft-deleted orders today, which
  is why removing 4 test orders needed a hard delete rather than a flag (history entry 73).

## Milestone 2 — Operational telemetry (ERP Phase 4, after M1 has real orders)
Only meaningful once real orders flow. Instrument now because a metric not captured is gone.
- METRIC# atomic counters in `streams-handler.js`; `api-metrics.js`; `/today` numbers real.
- Spoilage + setup-minute capture (`api-spoilage.js`) in the QC flow.
- CRM thin: order history, reorder-from-history, quiet-client detection.

## Milestone 3 — Capacity & inventory (ERP Phases 5, 3)
- `/week` capacity/scheduling (utilization always paired with throughput + WIP).
- Inventory basics + Streams stock decrement + storefront "made to order" availability flip.

## Milestone 4+ — Growth (ERP Phases 6–8, weeks each, when the need is real)
Procurement (suppliers/POs/receiving) → **integrate a BIR-accredited accounting platform**
over the event backbone (never build the invoicing engine first — ERP file Part 4) → analytical
plane (S3 export + Athena + `/month`). HR/payroll and multi-site are genuinely later.

---

## Deliberately deferred (do NOT build during Milestone 1)
Reserved seats in the data model, dark until their trigger fires:
- Analytics/BI counters and the S3/Athena analytical plane (no reporting need yet).
- Inventory decrement / BOM per SKU (no real consumption events yet).
- Procurement, Finance/accounting integration, HR/payroll.
- `payCustomItem` + `submitQuotePrice` (custom-item follow-up payment links) — deferred until
  the `sku` GCash path in M1 works end-to-end; same model, extended later.
- Automated payment gateway (PayMongo/HitPay) — blocked on BIR/DTI registration; the manual
  GCash `verifyPayment` step is designed to become a webhook with the pipeline unchanged.

---

## Open decisions that gate Milestone 1
Carried from the Payment System + ERP files' open-questions sections. These change *what you
build in M1*, so decide before/at 1.2:
1. **GCash matching mechanism: decided 2026-08-01 — keep the existing GCash reference-number
   field as the only cross-check.** Typing the last digits of the GCash reference is already
   enough friction/verification for staff to match a payment; no Order-ID-in-note addition or
   centavo-variance pricing change needed. No implementation follows from this.
2. **Verification SLA window** in hours — drives the SES copy and the `expire-pending-orders`
   cutoff (draft assumes 48h).
3. **Deposit vs. pay-on-quote for `custom` items** (current assumption: pay-on-quote, no
   deposit). Doesn't block the `sku` path but shapes the UI copy.
4. **EIS covered-taxpayer status** (ERP file Part 9): does the Dec-2026 e-invoicing deadline
   apply to KCMPS? The manual GCash flow deliberately records only *cash movement* and defers
   formal invoicing to the accounting integration — confirm with the accountant so M4's timing
   is right. Does **not** block M1.

---

## What can't be done from inside this repo
Milestone 1 requires an AWS account with deploy access (DynamoDB, Lambda, API Gateway,
EventBridge, SES, an S3 uploads bucket) and the Cognito pool admin. The Lambda **source** and
the storefront/dashboard **wiring** can be written and reviewed here; the provisioning +
deploy is an owner action following the checklist in
[`ops-dashboard/infra/backend-infra-to-deploy.md`](../ops-dashboard/infra/backend-infra-to-deploy.md)
§11.

## Customer design-file uploads + malware scanning/quarantine (shipped 2026-08-04/05)

**Trigger:** checkout's only way to hand KCMPS artwork was `#co-notes`, a freeform textarea where
the customer pastes a Drive link — a poor fit for the print-office leaf (documents, catalogs,
packaging files), which is exactly where a real file is the norm.

**What shipped:** a drag-and-drop upload zone next to that textarea (the textarea stays — a link
is still the right answer for a big multi-file job). Two-step presigned PUT straight to S3, the
same pattern as `submit-payment-proof.js`; no file bytes ever pass through a Lambda.

- [`backend/checkout/upload-design-file.js`](../backend/checkout/upload-design-file.js) —
  `POST /design-uploads`, unauthenticated (guest checkout), throttled 10 req/s. Read its header
  for the full threat model; the validation layers are summarized there, not duplicated here.
- [`backend/lib/upload-types.js`](../backend/lib/upload-types.js) — the allowlist. Owner chose
  images + PDF/AI/EPS/PSD + Office, **excluding SVG** (a script container) and **archives**
  (opaque to Content-Type checks). Requires the declared type AND the filename extension to
  agree, so a spoofed `application/pdf` on `payload.exe` is refused server-side.
- Refs persist on `order.designFiles` via `create-order.js`, which re-validates that every ref
  sits under `design-uploads/` in our own bucket — without that check a caller could attach
  `s3://…/payments/<someone-else>.jpg` to a throwaway order and have staff presign another
  customer's GCash proof, since all four upload prefixes share one bucket.

**Malware scanning (2026-08-04), extended to every upload prefix (2026-08-05).** GuardDuty
Malware Protection for S3 covers `design-uploads/`, `payments/`, `messages/`, `correspondence/`.
[`backend/jobs/handle-scan-result.js`](../backend/jobs/handle-scan-result.js) (EventBridge)
deletes **every version** of an infected object — the bucket is versioned, so a plain delete
would leave the malware retrievable by versionId for 90 days — then persists the verdict plus a
plain-English description ([`threat-descriptions.js`](../backend/lib/threat-descriptions.js), a
static table, deliberately not an LLM call) onto the referencing record. The record survives the
file: staff still see what arrived, what it was, and that it was destroyed.

Read paths hand out a URL only for `NO_THREATS_FOUND`, force
`Content-Disposition: attachment`, and treat a missing verdict as PENDING (fail closed). This
also **closed a gap from the day before**: `send-message.js` accepts attachments from customers,
and that path had neither a scan gate nor a disposition override.

**One bug worth remembering** (found by owner UAT, not by the build): design files are uploaded
*before* checkout, so GuardDuty routinely finishes scanning while the customer is still filling
in the form — there is no order to annotate yet. The first implementation logged "abandoned
checkout?" and discarded the verdict, leaving the file stuck "Scanning…" forever. Harmless-looking
on an infected file; **fatal on a clean one**, since staff could then never download legitimate
artwork. Fixed by always writing a standalone `SCAN#<ref>` verdict item that the read paths fall
back to. Scripted testing missed it because the script placed the order seconds after uploading;
only a human working at human speed hit the race.

**Cost:** ~₱0–10/mo — see [cost-governance.md](cost-governance.md)'s decision log, which also
records the earlier ~7x pricing overstatement that entry corrects.
