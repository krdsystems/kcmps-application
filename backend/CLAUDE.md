# CLAUDE.md — backend/

The future single home for KCMPS's server-side code — the modular monolith described in
`project_knowledge/ERP_System_Project_Knowledge.md` (Part 2: one DynamoDB table, one set of
Lambdas behind one API Gateway, modules as code/key-prefix boundaries, not separate services).

**Not deployed.** Like `ops-dashboard/` and `storefront-infra/`, this folder is planning/source
material only — never synced to the `website/` S3 bucket. See the root `CLAUDE.md`'s "Hard
constraint: what's deployed" section.

## Current state: foundation only

No Lambda handlers, DynamoDB clients, or API routes exist here yet — see
`ops-dashboard/infra/logic-inputs/*.js` for those drafts, still in their original location.
What's here today is `lib/` (shared conventions, see below) and `infra/foundation.cfn.yaml`
(provisioning for the DynamoDB table + Cognito groups those conventions target — written but
not yet applied; see `infra/README.md` for the owner-run apply/rollback steps).

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
| `index.js` | Re-exports everything above from one require |

Run the tests: `node --test backend/lib/`.

## Where this is going (not now)

`ops-dashboard/infra/logic-inputs/*.js` currently hand-rolls its own key strings, status list,
and `cognito:groups` parsing inline (see `api-verify-payment.js`/`api-advance-line-item.js`).
Those drafts will migrate to `require("../../backend/lib")` once real Lambda deployment starts
— **not part of this change**. Until then, `lib/` and the `logic-inputs/` drafts describe the
same conventions independently; if you change one, check the other doesn't silently diverge.
