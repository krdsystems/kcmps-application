# CLAUDE.md — backend/

The future single home for KCMPS's server-side code — the modular monolith described in
`project_knowledge/ERP_System_Project_Knowledge.md` (Part 2: one DynamoDB table, one set of
Lambdas behind one API Gateway, modules as code/key-prefix boundaries, not separate services).

**Not deployed.** Like `ops-dashboard/` and `storefront-infra/`, this folder is planning/source
material only — never synced to the `website/` S3 bucket. See the root `CLAUDE.md`'s "Hard
constraint: what's deployed" section.

## Current state: foundation + checkout + staff-api + jobs, all deployed

`checkout/` (Module 1 — Sales & Order, customer-facing half) and `staff-api/`/`jobs/`
(dashboard-side, staff-facing) are both deployed as real Lambdas (see `infra/README.md`'s
"Checkout Lambdas" and "Staff API Lambdas" sections). All four modules are written against
`lib/` conventions — the old hand-rolled drafts at `ops-dashboard/infra/logic-inputs/*.js` have
been superseded (kept there for historical reference only; see `docs/history.md` entry 49 for
the migration).

`infra/foundation.cfn.yaml` provisions the DynamoDB table + Cognito groups these Lambdas
target — written but not yet applied; see `infra/README.md` for the owner-run apply/rollback
steps.

`lib/` is the shared conventions module every future Lambda (checkout, dashboard, whichever
module builds next) imports so the ERP's launch-blocking data conventions
(`tenantId`/`siteId`, `schemaVersion`, centavo money, the event log, GSI1 sparse-index hygiene,
soft-delete) are applied **identically everywhere**, instead of each Lambda reinventing its own
key-formatting and status logic that quietly drifts.

## `infra/` — what's in it

- `foundation.cfn.yaml` — the CloudFormation template for Milestone 1.0 (Roadmap
  [docs/roadmap.md](../docs/roadmap.md)): creates the single DynamoDB table with GSI1,
  Streams, PITR, and deletion protection, plus the 5 Cognito groups
  (`Customer`/`Production`/`Sales`/`Finance`/`Admin`) in the **existing** user pool. Does not
  create a Cognito user pool. Cross-check any attribute/index name changes here against
  `ops-dashboard/infra/backend-infra-to-deploy.md` §2 so the two can't drift.
- `README.md` — validate/apply/rollback commands, and how the stack's outputs
  (`TableName`/`TableStreamArn`/`GSI1Name`) feed the 1.1+ Lambdas.

## `lib/` — what's in it

Pure functions and constants only. No AWS SDK clients, no I/O — a Lambda imports these to build
the *shape* of a DynamoDB item or API response, then does its own `DynamoDBDocumentClient` call
with what it builds.

| File | Purpose |
|---|---|
| `constants.js` | `SITE_ID`, `CURRENCY`, `SCHEMA_VERSION`, the canonical `STATUS` vocabulary, `ACTIVE_STATUSES`/`TERMINAL_STATUSES` |
| `money.js` | Integer-centavos money helpers — `toCentavos`/`toPesos`/`formatPeso`/`assertCentavos`. No floats stored, ever |
| `keys.js` | Every PK/SK builder, matching `ops-dashboard/infra/backend-infra-to-deploy.md` §2.1 field-for-field |
| `item.js` | `baseItem()` — stamps `tenantId`/`siteId`/`schemaVersion`/`createdAt`/`updatedAt`/`status`/`deleted:false` on every item by construction |
| `events.js` | `buildEvent()` — the append-only event record shape from §2.2, as a pure function so the write composes into a caller's `TransactWriteItems` |
| `auth.js` | The 5-role model (`Customer`/`Production`/`Sales`/`Finance`/`Admin`) and claims helpers — run server-side only, on the already-JWT-verified `event.requestContext.authorizer.jwt.claims` |
| `gsi.js` | GSI1 sparse-index hygiene — when to write `GSI1PK`/`GSI1SK`, and the attribute names to `REMOVE` on a terminal status |
| `order-status.js` | `deriveOrderStatus()` — the line-item-statuses → order-level rollup rule (ERP file §2.4). A third independent copy of the same rule already exists in `dashboard-data.js` and `ops-dashboard/infra/logic-inputs/streams-handler.js` (predating this lib) — new Lambdas should import this one instead of adding a fourth |
| `index.js` | Re-exports everything above from one require |

Run the tests: `node --test backend/lib/`.

## `checkout/` — what's in it

Module 1 (Sales & Order)'s customer-facing Lambdas — the ones the storefront calls directly,
as opposed to `ops-dashboard/infra/logic-inputs/*.js`'s staff-facing dashboard Lambdas.

| File | Purpose |
|---|---|
| `create-order.js` | `POST /orders` — splits the cart into `sku`/`custom` line items, writes `ORDER#<id>` META + `LINEITEM#`/`EVENT#` items in one `TransactWriteItems`. Guest checkout preserved (Bearer token verified if present, never required) |
| `submit-payment-proof.js` | `POST /orders/{orderId}/payment-proof` — pre-signed S3 upload URL for the GCash screenshot, writes the `payment` sub-object, sends the "under verification" SES email when `customerContact` is email-shaped |
| `package.json` | Lambda dependencies for this folder (S3 presigner + SES on top of `ops-dashboard/infra/logic-inputs/package.json`'s DynamoDB deps) |

Both import `../lib` directly rather than hand-rolling keys/status — the first Lambdas in the
repo to do so (see "Where this is going" below). Both keep money as peso floats, not `lib/
money.js`'s integer centavos — see `create-order.js`'s header for why a partial centavo
migration would corrupt every downstream metric, and revisit as one coordinated pass across
`streams-handler.js`, `api-get-orders.js`, and the dashboard's mock layer together.

## `staff-api/` — what's in it

Milestone 1.3's staff-facing Lambdas, all JWT-authorizer-gated (API Gateway validates the
token; each Lambda itself checks the role/group — the authorizer never filters by group).

| File | Purpose |
|---|---|
| `get-orders.js` | `GET /orders` — staff (any of `backend/lib/auth.js`'s `isStaff()` roles, or the legacy `Staff` group) see every order; anyone else sees only their own (`customerSub`). Attaches each order's `LINEITEM#`/`EVENT#` items. |
| `advance-line-item.js` | `POST /line-items/{lineItemId}/advance` — validates the requested transition against `LEGAL_TRANSITIONS` (must match the *real* dashboard status vocabulary in `dashboard-data.js`'s `NEXT_STATUS` — see the `STATUS.READY_FOR_DISPATCH`/`DISPATCHED` split in `constants.js`, a bug found and fixed in this area), writes the line-item update + `EVENT#` atomically |
| `verify-payment.js` | `POST /orders/{orderId}/verify-payment` \| `.../reject-payment` — order-level: one GCash payment covers every `sku` line item still `Pending Payment Verification` on that order, verified/rejected together |

`getGroups()` (`backend/lib/auth.js`) is the one thing every one of these depends on getting
right — API Gateway's HTTP API JWT authorizer serializes a multi-value `cognito:groups` claim
as a bracketed, **space**-separated string (`"[Staff Admin]"`, confirmed live), not the more
commonly-documented comma-join. Covered by `lib.test.js`.

## `jobs/` — what's in it

Event-driven, not API-Gateway-invoked.

| File | Purpose |
|---|---|
| `streams-handler.js` | DynamoDB Streams trigger (filtered to `LINEITEM#` writes) — derives `orderStatus` via `order-status.js`'s `deriveOrderStatus()`, maintains GSI1 sparse-index hygiene via `gsi.js`. METRIC# rollups deferred (see `docs/roadmap.md`). |
| `expire-pending-orders.js` | 15-minute EventBridge cron — two GSI1-driven sweeps: 48h `Pending Payment Verification` → `Auto-Cancelled`, 7-day `Priced` → `Quote Expired`. SES notice is best-effort (degrades gracefully like `submit-payment-proof.js`). |

## Where this is going (not now)

`ops-dashboard/infra/logic-inputs/*.js`'s originals are now superseded reference material only
— don't edit them expecting it to affect anything deployed; edit `staff-api/`/`jobs/` instead.
