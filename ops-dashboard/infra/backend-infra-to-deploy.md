# KCMPS Ops Dashboard — Backend Infrastructure To Deploy

This is the AWS build-out needed to make `website/dashboard/*` real instead of
mock. The frontend (already built, see `../../website/dashboard/` and
`../../README.md`) runs entirely on a mock data layer (`dashboard-data.js`, backed by
`localStorage`) so it can be demoed and user-tested today with **zero AWS
spend**. This document is what you need to stand up so that mock layer can
be swapped for the real thing — one function body at a time, per the "one
seam" note at the top of `dashboard-data.js`.

It layers on the storefront's existing stack (see the main README):
**S3 + CloudFront + Cognito + API Gateway + Lambda + DynamoDB + SES.** No new
AWS *services* are introduced — this matches Part 8 of the Operations
Dashboard Project Knowledge file ("Cost Impact: essentially nil, by design").

**Source documents this build reconciles:**
- `../../project_knowledge/Payment_System_Project_Knowledge.md` — the
  mixed-cart (`sku` + `custom` line items on one order) design and the
  manual GCash bridge verification flow. This is where the `payment`
  sub-object on the `ORDER#<id>` item (§2.2) and the `verifyPayment` /
  `setOnHold` / `submitPaymentProof` / `expirePendingOrders` Lambda
  names (§3) come from.
- The Operations Dashboard Project Knowledge file (not checked into this
  repo under a stable path — see the original chat upload) — the daily/
  weekly/monthly cadence UI, the per-line-item event-sourcing model, and
  the GSI1 sparse status index that §2.3 below extends the Payment System
  file's original design with (see the note in §2.1 on why line items are
  separate DynamoDB items, not the array the Payment System file sketches).

---

## 1. Architecture overview

```
                                   ┌─────────────────────────┐
                                   │   S3 (website/ bucket)   │
                                   │  dashboard/*.html+js/css │
                                   └────────────┬─────────────┘
                                                │ served via
                                   ┌────────────▼─────────────┐
                                   │        CloudFront        │
                                   └────────────┬─────────────┘
                                                │ browser (staff, Cognito JWT)
                     ┌──────────────────────────┼──────────────────────────┐
                     │                          ▼                          │
                     │                 API Gateway (HTTP API)              │
                     │   /orders  /line-items/{id}/advance  /blockers      │
                     │   /inventory  /metrics/day  /metrics/week           │
                     │   /metrics/month  /clients                         │
                     └───────┬───────────────┬───────────────┬─────────────┘
                             │               │               │
                    ┌────────▼───────┐ ┌─────▼──────┐ ┌──────▼───────┐
                    │ api-get-orders │ │api-advance-│ │  (5 more thin │
                    │    (Lambda)    │ │ line-item  │ │  CRUD Lambdas)│
                    └────────┬───────┘ │  (Lambda)  │ └──────┬───────┘
                             │         └─────┬──────┘        │
                             └────────────────┼───────────────┘
                                               ▼
                                  ┌─────────────────────────┐
                                  │   DynamoDB single table  │
                                  │   (existing KCMPS table) │
                                  │   + GSI1 (STATUS#...)    │
                                  └────────────┬─────────────┘
                                               │ DynamoDB Streams
                                               ▼
                                  ┌─────────────────────────┐
                                  │  streams-handler Lambda  │
                                  │  (rollup + orderStatus)  │
                                  └────────────┬─────────────┘
                                               │ writes METRIC# items
                                               ▼
                                  ┌─────────────────────────┐
                                  │   DynamoDB (same table)  │
                                  └─────────────────────────┘

              ┌───────────────────────┐        ┌───────────────────────┐
              │ EventBridge (cron)     │        │ EventBridge (cron)     │
              │ every 15 min           │        │ 07:00 + 18:00 daily    │
              └───────────┬────────────┘        └───────────┬────────────┘
                          ▼                                  ▼
              ┌───────────────────────┐        ┌───────────────────────┐
              │ expire-pending-orders  │        │   daily-digest Lambda │
              │        Lambda          │        │   (reads METRIC#DAY)  │
              └───────────┬────────────┘        └───────────┬────────────┘
                          ▼                                  ▼
                  DynamoDB + SES (customer)          SES (staff digest)
```

**Everything here reuses the existing Cognito User Pool and App Client** —
see the main README's "Cognito app client requirements" section. The
dashboard already gates on the `Staff` group claim client-side
(`dashboard-shell.js`); the API layer below is what makes that gate real
(client-side group checks are for UI only — **every Lambda below must
independently verify the JWT**, per the note in the main README's "Client-side
JWT decoding is for display only" section).

---

## 2. DynamoDB — single-table design

Reuses the **existing** table (no new table). Add one GSI (§2.3) and adopt
these key patterns for new item types.

### 2.1 Item types and key patterns

**Reconciling the two source docs:** the Payment System file's own schema
sketch nests `lineItems` as an **array inside the `ORDER#<id>` item**
(`PK: ORDER#1234, SK: ORDER#1234`). That's fine for the checkout/mixed-cart
logic it's describing, but it can't support the Ops Dashboard's per-line-item
action queues — you cannot put a sparse GSI on individual array elements.
This doc keeps the Payment System file's **field names and `payment` shape
verbatim**, but promotes each line item to its **own DynamoDB item**
(`SK: LINEITEM#<lineItemId>`) precisely so GSI1 (§2.3) can index line items
by status individually. The `ORDER#<id>` item itself keeps the same
`SK: META` convention used elsewhere in this doc — functionally identical
to the Payment System file's `SK: ORDER#<id>`, just consistent with the
other `META` rows below.

| Item type | PK | SK | Notes |
|---|---|---|---|
| Order | `ORDER#<orderId>` | `META` | Carries `customerSub`, `createdAt`, `orderStatus` (derived, §2.4), and the `payment` sub-object below when a GCash bridge payment exists on this order |
| Line item | `ORDER#<orderId>` | `LINEITEM#<lineItemId>` | One per cart line — `type: "sku" \| "custom"` (Payment System file §"Core Design"). Carries `status`, `enteredStatusAt`, `station`, `setupMinutes`, `spoilage[]`, `originalPromisedDate` (frozen at creation — **never overwritten**) |
| Event | `ORDER#<orderId>` | `EVENT#<isoTimestamp>#<lineItemId>` | Append-only. Written on every status transition. Never updated or deleted (except by TTL if you choose to age them out after ~18 months) |
| Day metric | `METRIC#DAY#<yyyy-mm-dd>` | `SUMMARY` | Atomic counters, see §2.5 |
| Day/station metric | `METRIC#DAY#<yyyy-mm-dd>` | `STATION#<stationId>` | Atomic counters per station |
| Month metric | `METRIC#MONTH#<yyyy-mm>` | `SUMMARY` | Atomic counters |
| Month/pillar metric | `METRIC#MONTH#<yyyy-mm>` | `PILLAR#<PRINT\|STUDIO\|HARDWARE>` | Atomic counters |
| Blocker | `BLOCKER#<yyyy-mm-dd>` | `<blockerId>` | Free-text + owner + due date, `resolved` boolean, `tag` |
| Inventory item | `INV#<sku>` | `META` | `qty`, `reorderPoint`, `unit`, trailing-30-day consumption (updated by the streams handler when a job consumes material — see Open Question in Part 10 of the Ops Dashboard Project Knowledge file: wire this once real consumption events exist) |
| Client | `CLIENT#<clientId>` | `META` | `totalRevenue` and `lastOrderAt` kept current by the streams handler on every `Delivered` transition |

### 2.2 Event record shape, and the order-level `payment` sub-object

Event shape exactly as specified in Part 5.2 of the Ops Dashboard Project
Knowledge file:

```json
{
  "PK": "ORDER#1234",
  "SK": "EVENT#2026-07-24T09:14:00Z#L2",
  "lineItemId": "L2",
  "from": "Scheduled",
  "to": "In Production",
  "actorSub": "<cognito-sub>",
  "station": "PRESS-01",
  "at": "2026-07-24T09:14:00Z",
  "meta": { "setupMinutes": 22 }
}
```

`payment` sub-object on the `ORDER#<id>` / `META` item — copied verbatim
(field names unchanged) from the Payment System file's "Data Model Addition"
section, since that section is what `dashboard-data.js`'s mock layer and
`job-detail.html`'s Verify/Reject UI were built against:

```json
{
  "PK": "ORDER#1234",
  "SK": "META",
  "orderStatus": "Pending Payment Verification",
  "payment": {
    "method": "gcash_manual",
    "claimedAmount": 1500.07,
    "gcashRefNumber": "1234567890123",
    "screenshotRef": "s3://kcmps-uploads/payments/order-1234.jpg",
    "submittedAt": "2026-07-21T14:00:00Z",
    "verifiedBy": null,
    "verifiedAt": null,
    "holdReason": null
  }
}
```

**One `payment` object covers every `sku` line item on that order together**
— the customer pays one GCash transaction for the sum of their pay-now
items at checkout (Payment System file, "Checkout Flow" step 1), so
`verifyPayment` / `setOnHold` (§3) act on the *order*, transitioning
every line item currently `Pending Payment Verification` on it in one
call, not line-by-line. `custom` items never touch this object — each gets
its **own** follow-up payment link once priced (`submitQuotePrice` /
`payCustomItem` in the Payment System file's "Backend Logic" section,
out of scope for this dashboard build since that's storefront/checkout
Lambda work, not a dashboard action).

### 2.3 Required GSI

```
GSI1PK = STATUS#<status>          (e.g. STATUS#Pending Payment Verification)
GSI1SK = <ISO timestamp of entry into that status>
```

Applied to **line item items only**, and only while the line item is
"active" (sparse index — see §2.6). This is what makes every `/today` action
queue a single sorted `Query`.

Add via the DynamoDB console or CLI:

```bash
aws dynamodb update-table \
  --table-name <YOUR_TABLE_NAME> \
  --attribute-definitions \
      AttributeName=GSI1PK,AttributeType=S \
      AttributeName=GSI1SK,AttributeType=S \
  --global-secondary-index-updates \
    '[{"Create":{"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]'
```

Optional, once the CRM view needs it (Part 5.4):

```
GSI2PK = CLIENT#<id>    GSI2SK = ORDER#<createdAt>
```

### 2.4 `orderStatus` — derived, never set directly

Computed by the streams handler on every line-item transition (see
`logic-inputs/streams-handler.js`). Never write it from an API Lambda.

### 2.5 Metric counters — atomic increments only

**Do not scan the table to compute dashboard numbers.** Every dashboard
metric is a pre-aggregated counter, incremented with `UpdateItem` +
`ADD`/`SET` expressions inside the streams handler, exactly as specified in
Part 5.3 of the Ops Dashboard Project Knowledge file. This keeps `/today` at one `Query`,
`/week` at ~7 `GetItem`s, `/month` at one `Query` — dashboard load cost stays
in the fractions-of-a-centavo range regardless of order volume.

### 2.6 Sparse index hygiene

`GSI1PK` should only exist on line items in an *active* state. When a line
item reaches `Delivered`, `Cancelled`, `Quote Expired`, or `Auto-Cancelled`,
the streams handler must **remove** `GSI1PK`/`GSI1SK` from the item (a
`REMOVE` in the `UpdateExpression`, not a `SET` to null) so completed work
drops out of the index automatically.

---

## 3. Lambda functions

All code is in `logic-inputs/`. Runtime: **Node.js 24.x**, ARM64
(`arm64`/Graviton — cheaper, and these are small I/O-bound functions).

| File | Trigger | Purpose |
|---|---|---|
| `streams-handler.js` | DynamoDB Streams on the main table | On every line-item write: derive `orderStatus`, maintain GSI1 sparse index, increment METRIC# counters, update client `totalRevenue`/`lastOrderAt` on `Delivered` |
| `expire-pending-orders.js` | EventBridge cron, every 15 min | Auto-cancel line items stuck in `Pending Payment Verification` > 48h; expire `Priced` quotes > 7 days with no payment; release any inventory hold |
| `daily-digest.js` | EventBridge cron, 07:00 and 18:00 Asia/Manila | One SES email per run summarizing SLA breaches (verification queue age, quote queue age, due-today-at-risk) — **digest, not per-event**, per Part 5.5 |
| `api-get-orders.js` | API Gateway `GET /orders` | Role-filtered order/line-item read. Verifies the Cognito JWT server-side (JWKS), branches on `cognito:groups` — staff see all, customers see only their own `sub` |
| `api-advance-line-item.js` | API Gateway `POST /line-items/{id}/advance` | Validates the requested transition against the state machine (Part 5.1), writes the line item + event atomically (`TransactWriteItems`), rejects illegal transitions (e.g. `Delivered` → `Quoted`) |
| `api-verify-payment.js` | API Gateway `POST /orders/{orderId}/verify-payment` and `POST /orders/{orderId}/set-on-hold` | Staff-side half of the Payment System file's `verifyPayment`/`setOnHold` — bulk-transitions every `sku` line item on the order still `Pending Payment Verification`, and stamps `order.payment.verifiedBy`/`verifiedAt` or `holdReason` (§2.2). Mirrors `dashboard-data.js`'s `verifyPayment()`/`setOnHold()` exactly — see §6 |

Two Lambdas named in the Payment System file are **customer-facing storefront
work, not dashboard work**, and are intentionally not included here — build
them alongside the checkout flow, not this dashboard:

- **`submitPaymentProof`** — the customer-facing counterpart that creates the
  `payment` object in the first place (pre-signed S3 upload URL for the
  screenshot, writes `gcashRefNumber`/`claimedAmount`). `api-verify-payment.js`
  above is the Lambda that *reads and updates* what this one wrote.
  **Drafted 2026-07-31** at
  [`backend/checkout/submit-payment-proof.js`](../../backend/checkout/submit-payment-proof.js)
  (alongside `create-order.js`, the checkout Lambda itself) — not deployed, and not part of
  this dashboard build; see `backend/CLAUDE.md`'s `checkout/` section.
- **`payCustomItem`** — the customer-facing endpoint hit via the emailed
  per-line-item payment link once staff prices a `custom` item (`Priced` →
  `Confirmed`). On the dashboard side, that transition is just a plain
  `api-advance-line-item.js` call once the customer has paid — no dashboard
  Lambda needs to know how the payment itself was collected.

Five more thin CRUD Lambdas are needed to fully retire the mock layer — they
are not included as separate files because they're straightforward
`Query`/`PutItem`/`UpdateItem` wrappers around the schema in §2, but they are
each a **required** API route (see §4):

- `api-blockers.js` — `GET/POST /blockers`, `POST /blockers/{id}/resolve`
- `api-inventory.js` — `GET /inventory`, `PATCH /inventory/{sku}`
- `api-metrics.js` — `GET /metrics/day/{date}`, `GET /metrics/week`, `GET /metrics/month/{yyyymm}`
- `api-clients.js` — `GET /clients`
- `api-spoilage.js` — `POST /line-items/{id}/spoilage` (called from the QC-fail flow instead of a generic advance, since it needs to also write to Rework — see `job-detail.html`'s `sendToRework` call for the exact shape to match)

Build each the same way as `api-advance-line-item.js`: verify JWT → check
`Staff` group → validate input → single `TransactWriteItems` or `UpdateItem`
call → return JSON shaped exactly like the corresponding `dashboard-data.js`
function's return value (see §6).

---

## 4. API Gateway routes

Use an **HTTP API** (not REST API — cheaper, sufficient here), with a
**JWT authorizer** pointed at the existing Cognito User Pool. This replaces
manual JWT verification inside every Lambda with API Gateway doing it at the
edge — simpler and cheaper than doing it in each function.

```bash
aws apigatewayv2 create-authorizer \
  --api-id <YOUR_HTTP_API_ID> \
  --authorizer-type JWT \
  --identity-source '$request.header.Authorization' \
  --jwt-configuration Audience=<YOUR_APP_CLIENT_ID>,Issuer=https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_LHJsFdCgo \
  --name kcmps-staff-jwt-authorizer
```

Then attach it to every dashboard route below (all require the `Staff`
group — enforce that inside each Lambda since API Gateway JWT authorizers
validate the token but don't filter by group claim):

| Method | Route | Lambda |
|---|---|---|
| GET | `/orders` | `api-get-orders.js` |
| POST | `/line-items/{lineItemId}/advance` | `api-advance-line-item.js` |
| POST | `/line-items/{lineItemId}/spoilage` | `api-spoilage.js` |
| POST | `/orders/{orderId}/verify-payment` | `api-verify-payment.js` |
| POST | `/orders/{orderId}/set-on-hold` | `api-verify-payment.js` |
| GET, POST | `/blockers` | `api-blockers.js` |
| POST | `/blockers/{id}/resolve` | `api-blockers.js` |
| GET | `/inventory` | `api-inventory.js` |
| PATCH | `/inventory/{sku}` | `api-inventory.js` |
| GET | `/metrics/day/{date}` | `api-metrics.js` |
| GET | `/metrics/week` | `api-metrics.js` |
| GET | `/metrics/month/{yyyymm}` | `api-metrics.js` |
| GET | `/clients` | `api-clients.js` |

CORS: allow only the production origin (`https://site.kcmps.com`) and
`http://localhost:5500` for local dev, matching the Cognito callback URL
list in the main README.

---

## 5. EventBridge (cron)

Two schedules, both effectively free at this frequency (Part 8):

```bash
# Every 15 minutes — catches 48h verification expiry and 7-day quote expiry
aws events put-rule \
  --name kcmps-expire-pending-orders \
  --schedule-expression "rate(15 minutes)"
aws events put-targets --rule kcmps-expire-pending-orders \
  --targets "Id"="1","Arn"="<expire-pending-orders Lambda ARN>"

# Daily digest — 07:00 and 18:00 Asia/Manila (UTC+8 → 23:00 and 10:00 UTC)
aws events put-rule \
  --name kcmps-daily-digest-morning \
  --schedule-expression "cron(0 23 * * ? *)"
aws events put-rule \
  --name kcmps-daily-digest-evening \
  --schedule-expression "cron(0 10 * * ? *)"
aws events put-targets --rule kcmps-daily-digest-morning \
  --targets "Id"="1","Arn"="<daily-digest Lambda ARN>"
aws events put-targets --rule kcmps-daily-digest-evening \
  --targets "Id"="1","Arn"="<daily-digest Lambda ARN>"
```

Grant EventBridge permission to invoke each Lambda (`aws lambda
add-permission --action lambda:InvokeFunction --principal
events.amazonaws.com --source-arn <rule ARN>`).

---

## 6. Wiring the frontend to the real API — the actual swap

`dashboard-data.js` is intentionally written as a set of named functions
(`getQueues`, `getTodayNumbers`, `advanceLineItem`, etc.) whose **return
shapes already match what the API above returns**. To cut over:

1. Deploy the API (§3–§4) and note its invoke URL.
2. In `dashboard-data.js`, replace the body of each function that currently
   reads/writes `localStorage` with a `fetch()` call to the matching route,
   passing the Cognito access token (already in `sessionStorage` under
   `kcmps_tokens`, read by `dashboard-shell.js`) as a Bearer token.
3. Leave every `.html` file untouched — they only ever call
   `window.KCMPS_DASH.*`, never `localStorage` directly. This is the same
   pattern the main storefront already uses for its cart
   (`store.js` → `KCMPS_STORE`, see the main README's migration path).
4. Delete `resetSeed()`'s call sites (the "Reset demo data" button in
   `settings.html`) once mock mode is retired, or leave it gated behind a
   `?mock=1` query flag for future demos.

No other frontend changes are expected. One shape note specific to the
payment endpoints: `dashboard-data.js`'s `verifyPayment(orderId, staffName)`
and `setOnHold(orderId, reason, staffName)` return the full mutated
order object, while `api-verify-payment.js` (§3) returns a smaller
`{orderId, action, lineItemsAffected, at}` acknowledgment — that's fine and
requires no reconciliation, because `job-detail.html` never reads either
return value; it just calls `render()` again afterward, which re-fetches
the order fresh via `getOrder()`/`GET /orders`.

---

## 7. IAM — least privilege sketch

- **streams-handler.js**: `dynamodb:UpdateItem`, `dynamodb:GetItem` on the
  table + its GSIs; triggered via Lambda's DynamoDB Streams event source
  mapping (needs `dynamodb:DescribeStream`, `dynamodb:GetRecords`,
  `dynamodb:GetShardIterator`, `dynamodb:ListStreams` — attach the AWS
  managed `AWSLambdaDynamoDBExecutionRole` policy, or a scoped equivalent).
- **expire-pending-orders.js**: `dynamodb:Query` (via GSI1), `dynamodb:UpdateItem`,
  `ses:SendEmail`.
- **daily-digest.js**: `dynamodb:GetItem`/`Query`, `ses:SendEmail`.
- **api-*.js**: `dynamodb:GetItem`, `Query`, `PutItem`, `UpdateItem`,
  `TransactWriteItems` — scoped to the single table ARN, no `*` resource.
- All Lambdas: `logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents`
  (standard CloudWatch Logs policy).

Do **not** grant `dynamodb:Scan` to any of these — if a Lambda "needs" a
scan to answer a dashboard query, that's a signal the metric should be a
counter instead (§2.5).

---

## 8. SES

Reuses the existing verified sending identity from the storefront's
checkout flow. Add:

- A **staff digest recipient list** (the 4 founders' emails) — either a
  hardcoded array in `daily-digest.js` for now, or an SES contact list once
  the team grows.
- No new domain/DKIM setup needed if the storefront's SES identity is
  already verified.

---

## 9. Build phasing (maps to Part 7 of the Ops Dashboard Project Knowledge file)

Do this in order — **capture before display**. A metric not instrumented on
day one cannot be recovered retroactively; a chart with no data yet is
trivially fixable later.

| Stage | What to deploy | Depends on |
|---|---|---|
| **A** | GSI1 (§2.3) + event-record writes on every line-item transition (via `api-advance-line-item.js` and `streams-handler.js`) | Existing order/checkout Lambda already writing line items |
| **B** | `api-get-orders.js`, `api-advance-line-item.js`, `api-blockers.js` — enough for `/today`'s queues + blockers board to go live against real data | Stage A |
| **C** | Wire the GCash verification queue (`Pending Payment Verification` → `Confirmed`/`On Hold`) into `api-advance-line-item.js`; deploy `expire-pending-orders.js` | Stage B |
| **D** | `streams-handler.js`'s METRIC# rollup logic; `api-metrics.js`; `api-spoilage.js`; setup-minutes capture in `api-advance-line-item.js` | Stage A |
| **E** | `/week` capacity view goes live against `api-metrics.js` + `api-get-orders.js` | Stage D |
| **F** | Storefront feedback loops (capacity→turnaround, stock→availability threshold) — new Lambda logic in the *storefront's* checkout path, out of scope for this doc | Stage E |
| **G** | `/month` — needs ~8 weeks of real METRIC#MONTH data to be meaningful. Deploy the Lambdas early (Stage D covers it) but don't expect the numbers to mean anything until then | Stage D, + time |

---

## 10. Cost impact

No new AWS services — everything above reuses DynamoDB, Lambda, Streams,
API Gateway (HTTP API, not REST — cheaper), EventBridge, and SES, all
already provisioned for the storefront. Incremental cost:

- **GSI1**: proportional to indexed writes only, sparse index keeps it
  small. Estimate **+$0.10–0.30/month** at early volume.
- **HTTP API + Lambda invocations**: at 4 staff checking the dashboard a
  few times a day, this is effectively **within the AWS free tier**
  (1M Lambda requests/month free, 1M HTTP API calls/month free for 12
  months then ~$1/million after).
- **EventBridge cron**: negligible at 15-min + twice-daily frequency.
- **Pre-aggregated counters replace what would otherwise be scans** — a
  cost *reduction* vs. the naive implementation.

Revised envelope carried over from the Ops Dashboard Project Knowledge file: **~₱120–250/month**
total (storefront + dashboard backend), still under the ₱500 hard cap.

---

## 11. Deployment checklist (console or CLI, in order)

1. [ ] Confirm the existing DynamoDB table name and its current key schema.
2. [ ] Add GSI1 (§2.3).
3. [ ] Deploy `streams-handler.js` as a Lambda; wire it to the table's
       DynamoDB Streams as an event source (`NEW_AND_OLD_IMAGES` view type).
4. [ ] Deploy `expire-pending-orders.js`; create its EventBridge rule (§5).
5. [ ] Deploy `daily-digest.js`; create its two EventBridge rules (§5);
       hardcode the 4 founders' emails as the recipient list; verify the
       sending identity in SES if not already verified.
6. [ ] Deploy `api-get-orders.js`, `api-advance-line-item.js`, and
       `api-verify-payment.js`; build the 5 remaining thin CRUD Lambdas per
       §3. Confirm `submitPaymentProof` (storefront/checkout side, not part
       of this build) is already writing the `payment` sub-object (§2.2) in
       the shape `api-verify-payment.js` expects, or this route has nothing
       to verify against.
7. [ ] Create the HTTP API, JWT authorizer (§4), routes, and CORS config.
8. [ ] Smoke-test each route with `curl` + a real staff access token before
       touching the frontend.
9. [ ] Follow §6 to swap `dashboard-data.js` function bodies from
       `localStorage` to `fetch()`, one function at a time — re-run
       `../user-test/README.md` after each swap.
10. [ ] Once `/today`, `/week`, blockers, and inventory are confirmed
        working against the real API, remove the "Reset demo data" control
        from `settings.html` (or gate it behind `?mock=1`).
