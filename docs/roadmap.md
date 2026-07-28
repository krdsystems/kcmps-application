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
statuses; staff can verify or reject that payment from the dashboard against real data. This is
the minimum that makes the storefront "complete" instead of a brochure.

Maps to ERP file Phases **0 → 1 → 2** (Platform foundation → Sales & Order + GCash bridge →
Production/MES payment verification). Reuses the *existing* stack — S3, Cognito, API Gateway,
Lambda, DynamoDB, SES — **no new AWS services** (ERP file Part 7).

Do these **in order** — capture before display, foundation before feature. The order also
matches the dependency chain in the infra doc's Stage A→C checklist.

### 1.0 — Platform foundation (ERP Phase 0, launch-blocking conventions)
These conventions cannot be retrofitted (ERP file §2.3), so they go in with the very first
table write, even though nothing uses most of them yet.
- [x] CloudFormation authored: [`backend/infra/foundation.cfn.yaml`](../backend/infra/foundation.cfn.yaml)
  creates the single DynamoDB table (PK/SK patterns from
  [infra §2.1](../ops-dashboard/infra/backend-infra-to-deploy.md)), **GSI1** sparse status index
  (`GSI1PK = STATUS#<status>`, infra §2.3) with Streams/PITR/deletion-protection on, and the
  5 Cognito groups (`Customer`/`Production`/`Sales`/`Finance`/`Admin`, ERP file Part 5) in the
  existing user pool — slots defined now, enforced later. **Not yet applied** — owner runs
  [`backend/infra/README.md`](../backend/infra/README.md)'s `aws cloudformation deploy` steps,
  then adds the 4 founders to `Admin` via `admin-add-user-to-group` (also in that README).
- [ ] Apply the stack above against the real AWS account (owner action, outside this repo's
  reach — see [What can't be done from inside this repo](#what-cant-be-done-from-inside-this-repo)).
- [ ] Stamp `tenantId`/`siteId` = `SITE#MNL`, `schemaVersion`, money as **integer centavos** +
  explicit `currency`, `status` + soft-delete (never hard-delete) on every item — enforced in
  code via [`backend/lib/item.js`](../backend/lib/item.js)'s `baseItem()`, not by the table
  schema itself, so this checks off as Lambdas start using it in 1.1.
- [ ] Immutable `EVENT#<ts>#<lineItem>` log written on every status transition — this is both
  the ERP audit trail and what BIR expects preserved (ERP file §2.3.2). Never mutate/delete.
  Shape builder ready: [`backend/lib/events.js`](../backend/lib/events.js)'s `buildEvent()`.

### 1.1 — Order creation on checkout (ERP Phase 1, Sales & Order)
- [ ] New **customer-facing** Lambda `createOrder` (the "checkout" half of the Payment System
  file's Backend Logic — *not yet drafted in the repo*). Splits the cart: writes `ORDER#<id>`
  META + one `LINEITEM#<id>` per line; `sku` items → `Pending Payment Verification`, `custom`
  items → `Quoted`. Emits `EVENT#` per line.
- [ ] Wire the storefront to it: replace the `mailto:` body of `submitOrder()`
  ([store.js](../website/store.js) ~697) with a `fetch()` POST, **behind the existing
  `KCMPS_STORE` seam** — no `.html` changes. Swap `ORDER_EMAIL` → API base URL (the file's own
  migration note at store.js:20 calls this out).
- [ ] **CSP:** add the API Gateway origin to `connect-src` in
  [index.html](../website/index.html) line 21 (currently only `'self'` + the Cognito domain) —
  the `fetch()` is blocked otherwise.

### 1.2 — GCash payment proof capture (the missing customer-facing half)
The staff side is drafted ([api-verify-payment.js](../ops-dashboard/infra/logic-inputs/api-verify-payment.js));
the customer side that *creates* the `payment` object it reads is **not built** and is the real
work here (infra doc §3 flags `submitPaymentProof` as out-of-scope-for-dashboard, build-it-here).
- [ ] `submitPaymentProof` Lambda — returns a pre-signed S3 upload URL (private uploads
  bucket) for the screenshot, writes the `payment` sub-object (`method: gcash_manual`,
  `claimedAmount`, `gcashRefNumber`, `screenshotRef`, `submittedAt`) onto `ORDER#<id>` META,
  exact shape in [Payment System file](../project_knowledge/Payment_System_Project_Knowledge.md)
  "Data Model Addition".
- [ ] Checkout UI: show the GCash QR + exact amount (with a unique-centavo variance **or**
  Order ID as the payment note — pick one, see [open decisions](#open-decisions-that-gate-milestone-1)),
  collect screenshot upload + **typed** reference number (not screenshot-only — it's the
  cross-check field), submit → order shows `Pending Payment Verification` immediately.
- [ ] SES: "Order received — under verification, we'll confirm within [X] hours."

### 1.3 — Staff verification live against real data
- [ ] Deploy the drafted API Lambdas: `api-get-orders.js`, `api-advance-line-item.js`,
  `api-verify-payment.js`. Create the HTTP API + Cognito **JWT authorizer** + routes
  (infra §4). Enforce the `Staff`/role group **inside** each Lambda — the authorizer validates
  the token but does not filter by group.
- [ ] Deploy `streams-handler.js` for derived `orderStatus` + GSI1 sparse-index hygiene.
  (METRIC# rollups in the same file can wait — see deferred.)
- [ ] Deploy `expire-pending-orders.js` on its 15-min EventBridge cron — auto-cancel orders
  stuck in `Pending Payment Verification` past the SLA window.
- [ ] Cut the dashboard over: replace the `localStorage` bodies of `getOrders`/`verifyPayment`/
  `rejectPayment` in [dashboard-data.js](../website/dashboard/dashboard-data.js) with `fetch()`
  (Bearer = `kcmps_tokens` access token), **one function at a time**, leaving every `.html`
  untouched (infra §6). Add the API origin to the dashboard's CSP too.

### 1.4 — Customer order tracking (closes the loop, makes it "feel complete")
- [ ] Logged-in customer sees their orders + the payment→production progress bar
  (`Order Placed → Payment Verification → Confirmed → In Production → QC → Delivered`, Payment
  System file). `GET /orders` filtered to the caller's `sub`. This is the visible payoff that
  turns "I emailed an order" into "I placed an order and can watch it."

**Definition of done for Milestone 1:** a real order in DynamoDB, a GCash proof on S3, a staff
verify/reject that moves real statuses, an auto-expiry cron, and a customer who can see the
result. `mailto:` checkout retired.

---

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
1. **GCash matching mechanism:** unique-centavo variance vs. Order-ID-as-note. (Affects the
   checkout UI and how staff cross-check.)
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
