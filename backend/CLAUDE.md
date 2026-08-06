# CLAUDE.md — backend/

The future single home for KCMPS's server-side code — the modular monolith described in
`project_knowledge/ERP_System_Project_Knowledge.md` (Part 2: one DynamoDB table, one set of
Lambdas behind one API Gateway, modules as code/key-prefix boundaries, not separate services).

**Not deployed.** Like `ops-dashboard/` and `storefront-infra/`, this folder is planning/source
material only — never synced to the `website/` S3 bucket. See the root `CLAUDE.md`'s "Hard
constraint: what's deployed" section.

## Current state: foundation + checkout + staff-api + jobs + auth, all deployed

`checkout/` (Module 1 — Sales & Order, customer-facing half) and `staff-api/`/`jobs/`
(dashboard-side, staff-facing) are both deployed as real Lambdas (see `infra/README.md`'s
"Checkout Lambdas" and "Staff API Lambdas" sections). All four modules are written against
`lib/` conventions — the old hand-rolled drafts at `ops-dashboard/infra/logic-inputs/*.js` have
been superseded (kept there for historical reference only; see `docs/history.md` entry 49 for
the migration). `auth/` (Cognito Lambda triggers, invoked by Cognito directly rather than API
Gateway) joined the same pattern in `docs/history.md` entry 62.

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
- `observability.cfn.yaml` — Milestone 1.5: SNS alert topic, shared Lambda DLQ, and 37
  CloudWatch alarms (Errors/Throttles on all 17 deployed Lambdas, `streams-handler`'s IteratorAge,
  DLQ depth, checkout API 5xx). Deployed as stack `kcmps-observability`. Full detail, plus the
  CLI-only updates it doesn't cover (Streams ESM retry/DLQ config, `expire-pending-orders`' async
  invoke config, API Gateway route throttling), in `README.md`'s "Observability" section.

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
| `customer-view.js` | `redactForCustomer()` (strips staff-internal fields — station, setupMinutes, spoilage, correspondenceLog, event actor identity — from an order before a non-staff caller sees it) and `contactsMatch()` (the free-text-contact comparison every guest-facing endpoint authenticates against, since orderId alone isn't a meaningful secret) — shared by `staff-api/get-orders.js`, `checkout/lookup-order.js`, `checkout/cancel-order.js` |
| `business-hours.js` | Pure operating-hours clock math — `businessMinutesBetween()`/`isWithinOperatingHours()`/`nextOperatingStart()`, fixed +8h Asia/Manila offset (no DST, so no timezone library). Backs the operating-hours-aware verification SLA in `staff-api/verify-payment.js`; unit-tested in `business-hours.test.js` |
| `upload-types.js` | The customer design-file upload allowlist + `resolveUploadType()` — the single server-side source of truth for what checkout accepts. `website/store.js` mirrors it client-side for UX only; if the two ever disagree, this one is correct. Requires the declared Content-Type AND the filename extension to agree, so a spoofed type on an executable is rejected. Unit-tested in `lib.test.js` |
| `threat-descriptions.js` | `describeThreats()` — turns an AV signature name (`Trojan:Win32/Emotet`) into plain English a non-technical staffer can act on: label, one-line explanation, what-to-do advice, severity, plus the raw name kept for real investigation. Static table, **not** an LLM call — deterministic, free, no latency, unit-tested. Resolved once at scan time by `jobs/handle-scan-result.js` and stored on the record |
| `index.js` | Re-exports everything above from one require |

Run the tests: `node --test backend/lib/*.test.js`.

**Name the files explicitly — never `node --test backend/lib/`.** The directory form is a
false green in this repo: it reports `ok 1 - backend/lib` / `# tests 1` and **exits 0 even
when a test in that directory fails** (verified 2026-08-06 on Node v22.23.2 by dropping a
deliberately-failing probe file into `backend/lib/` — the directory form passed, the glob form
correctly exited 1). A future session trusting it would see "tests pass" while running nothing.
The glob form reports the real count (71 as of 2026-08-06).

## `checkout/` — what's in it

Module 1 (Sales & Order)'s customer-facing Lambdas — the ones the storefront calls directly,
as opposed to `ops-dashboard/infra/logic-inputs/*.js`'s staff-facing dashboard Lambdas.

| File | Purpose |
|---|---|
| `create-order.js` | `POST /orders` — splits the cart into `sku`/`custom` line items, writes `ORDER#<id>` META + `LINEITEM#`/`EVENT#` items in one `TransactWriteItems`. Guest checkout preserved (Bearer token verified if present, never required). Also stamps a business-day `originalPromisedDate` for SKU-only orders (null if any custom line is present) |
| `submit-payment-proof.js` | `POST /orders/{orderId}/payment-proof` — pre-signed S3 upload URL for the GCash screenshot, writes the `payment` sub-object, transitions sku line items Order Placed -> Pending Payment Verification (the only Lambda that does), sends the "under verification" SES email when the order has an `email` on file |
| `upload-design-file.js` | `POST /design-uploads` — presigned S3 PUT for a customer's own artwork/print file at checkout (the drag-and-drop zone next to store.js's `#co-notes`). No auth (guest checkout), no orderId yet (pre-checkout — the ref travels into `create-order.js`'s `designFiles`). Allowlist lives in `../lib/upload-types.js`; **SVG is allowed (2026-08-07) but attachment-only, never inline — `INLINE_VIEWABLE_TYPES` must never include it; archives are still excluded on purpose**. Read its header before touching any of it — the validation layers, the forced-download rule, and the GuardDuty scanning decision (incl. its ~₱75/mo cost) are all documented there |
| `lookup-order.js` | `POST /orders/lookup` — guest order lookup by `{orderId, contact}`, no authorizer. `contactsMatch()` (`../lib/customer-view.js`) is the real auth boundary since orderId alone isn't a meaningful secret; identical generic 404 for wrong-id vs wrong-contact, artificial delay, tight route throttle (5 req/s) |
| `cancel-order.js` | `POST /orders/{orderId}/cancel` — no authorizer; JWT sub-match if a Bearer token verifies, else the same `contactsMatch()` fallback as `lookup-order.js`. Only allowed while every line item is pre-production (`Quoted`/`Priced`/`Pending Payment Verification`/`On Hold`) — 409 once anything is `Confirmed`+. Never writes `orderStatus` (streams-handler.js owns that) |
| `package.json` | Lambda dependencies for this folder (S3 presigner + SES + `aws-jwt-verify` on top of `ops-dashboard/infra/logic-inputs/package.json`'s DynamoDB deps) |

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
| `get-orders.js` | `GET /orders` — staff (any of `backend/lib/auth.js`'s `isStaff()` roles, or the legacy `Staff` group) see every order; anyone else sees only their own (`customerSub`). Attaches each order's `LINEITEM#`/`EVENT#` items, sorted newest-first, and redacts staff-internal fields via `../lib/customer-view.js`'s `redactForCustomer()` for non-staff callers. For staff callers, presigns a GET url for `payment.screenshotUrl` and for every `correspondenceLog` attachment (`withScreenshotUrl`/`withCorrespondenceUrls`) — the bucket is private, and `correspondenceLog` is stripped before a non-staff caller ever sees it anyway |
| `add-correspondence.js` | `POST /orders/{orderId}/correspondence` — staff-only manual note on the "Customer correspondence" card, optionally with up to 5 attachments (`image/jpeg\|png\|webp\|gif`, `application/pdf`). First live backend for this feature (deployed 2026-08-04) — the "Log" button used to write straight to `dashboard-data.js`'s localStorage mock, so a note on any real order silently never persisted. Presigned-upload flow mirrors `submit-payment-proof.js`: hands back a PUT url per attachment, never sees file bytes |
| `advance-line-item.js` | `POST /line-items/{lineItemId}/advance` — validates the requested transition against `LEGAL_TRANSITIONS` (must match the *real* dashboard status vocabulary in `dashboard-data.js`'s `NEXT_STATUS` — see the `STATUS.READY_FOR_DISPATCH`/`DISPATCHED` split in `constants.js`, a bug found and fixed in this area), writes the line-item update + `EVENT#` atomically |
| `verify-payment.js` | `POST /orders/{orderId}/verify-payment` \| `.../set-on-hold` — order-level: one GCash payment covers every `sku` line item still `Pending Payment Verification` on that order (plus any already `On Hold`), verified or held together. Verification is also operating-hours-aware (see `lib/business-hours.js`'s table row) — the transition/email are never gated on operating hours, only the *next* stage's SLA clock anchor is |
| `send-message.js` | `POST /orders/{orderId}/messages` — customer chat via order threads (deployed 2026-08-04). Staff can post to any order; a customer only to their own (`customerSub` match). Body/attachments same "either is enough" rule and attachment allow-list/cap as `add-correspondence.js`; each message's `attachments` field stores `{filename, contentType, ref}` (an `s3://` URI, not `attachmentRef` — that name was retired the same day the upload UI shipped, see `docs/roadmap.md`) |
| `get-messages.js` | `GET /orders/{orderId}/messages` — same staff-vs-customer branch as `get-orders.js`; `?markRead=true` marks the other party's unread messages read as a side effect (feeds `jobs/notify-unread-messages.js`) — opt-in since 2026-08-04 so opening a ticket to glance at it doesn't silently clear its own unread badge before anyone sees it; the frontend only passes it when the reply box gains focus. Also presigns a GET url per message attachment on every read, same private-bucket reasoning as `get-orders.js` |
| `get-unread-messages.js` | `GET /messages/unread` — staff-vs-customer branched like `get-orders.js`: staff get `{ threads, totalUnread }` across every order (bounded Scan, same tradeoff as `jobs/notify-unread-messages.js`); a customer gets the same shape scoped to their own orders (bounded per-order Query). Backs `dashboard-shell.js`'s sidebar unread badge and `orders.html`'s "New message!" banner/"Unread messages" section — shaped so a future Messages tab/inbox view renders the same response as full rows instead |

`getGroups()` (`backend/lib/auth.js`) is the one thing every one of these depends on getting
right — API Gateway's HTTP API JWT authorizer serializes a multi-value `cognito:groups` claim
as a bracketed, **space**-separated string (`"[Staff Admin]"`, confirmed live), not the more
commonly-documented comma-join. Covered by `lib.test.js`.

## `jobs/` — what's in it

Event-driven, not API-Gateway-invoked.

| File | Purpose |
|---|---|
| `streams-handler.js` | DynamoDB Streams trigger (filtered to `LINEITEM#` writes) — derives `orderStatus` via `order-status.js`'s `deriveOrderStatus()`, maintains GSI1 sparse-index hygiene via `gsi.js`. METRIC# rollups deferred (see `docs/roadmap.md`). |
| `expire-pending-orders.js` | 15-minute EventBridge cron — two GSI1-driven sweeps: 48h `Pending Payment Verification` → `Auto-Cancelled`, 7-day `Priced` → `Quote Expired`. SES notice is best-effort (degrades gracefully like `submit-payment-proof.js`). Deliberately stays wall-clock, NOT operating-hours-aware (unlike the verification SLA in `staff-api/verify-payment.js`) — see `docs/roadmap.md`'s "Operating-hours-aware verification SLA" entry for why. |
| `handle-scan-result.js` | EventBridge (`aws.guardduty` / "GuardDuty Malware Protection Object Scan Result") — fires per uploaded object across **all four** upload prefixes. On `THREATS_FOUND` deletes **every version** of the object (the bucket is versioned; a plain delete would leave the malware retrievable by versionId for 90 days), then writes the verdict + plain-English description onto whatever record referenced it so the dashboard keeps the filename/threat/history. Also persists CLEAN verdicts, which is what lets the read path skip a per-attachment `GetObjectTagging` round trip. Never throws — a retried event would re-delete |
| `notify-unread-messages.js` | 30-minute EventBridge cron (deployed 2026-08-04, currently dark — `SES_SENDER` unset) — bounded Scan for staff→customer chat messages unread >2h, one SES reminder per affected order ("digest, don't spam"), idempotent via a `reminderSentAt` stamp. |

## `auth/` — what's in it

Cognito Lambda triggers — invoked by Cognito itself as part of the auth flow, not by API
Gateway or an event source mapping.

| File | Purpose |
|---|---|
| `post-confirmation.js` | Cognito User Pool `PostConfirmation` trigger — adds a newly-confirmed self-signup to the `Customer` group (`AdminAddUserToGroup`). Filters to `triggerSource === "PostConfirmation_ConfirmSignUp"` only. Never throws — every failure path (including the group-add itself) is caught and logged instead of re-thrown, since an error returned from this trigger fails the client's `ConfirmSignUp` call even though Cognito already confirmed the user server-side by that point. See `docs/history.md` entry 62. |

Wired via the user pool's `LambdaConfig`, not an API Gateway route or event source mapping —
redeploying a code change is the same zip-and-`update-function-code` pattern as every other
Lambda here, but re-pointing *which* Lambda handles the trigger (or adding a second trigger
like `PreSignUp`) means `aws cognito-idp update-user-pool --lambda-config ...`. `update-user-pool`
isn't a partial-patch API in the way `update-function-code` is — it wasn't worth the risk of
finding out the hard way whether an omitted field resets to a default, so build the payload
from a fresh `describe-user-pool` (every current mutable setting, plus just the `LambdaConfig`
field changing) rather than a hand-written partial one, and diff before/after to confirm
nothing else moved — see entry 62 for the exact approach.

## `design-library/` — what's in it (STAGING ONLY, 2026-08-06)

Design Asset Library (`docs/roadmap.md`'s parallel track). **Deployed to
`kcmps-backend-staging` only** — production has no originals bucket and no `/designs` routes,
and promotion is owner-gated (`backend/infra/README.md`'s "Design Asset Library Lambdas").

| File | Purpose |
|---|---|
| `get-upload-url.js` | `POST /designs/upload-url` — presigned PUT URLs for BOTH files (source + web-ready), 300MB each, single PUT (no multipart, a resolved spec decision). Keys are always server-generated: `designs/<category>/<designId>/{original,web}.<ext>` |
| `publish-design.js` | `POST /designs` — writes the `DESIGN#<id>` META record + `EVENT#` audit item, then on publish copies the web-ready image into the public bucket and regenerates `design-manifest.json`. **The manifest's exact JSON shape is documented in this file's header — it is a contract with `website/store.js`'s `buildDesignGrid()`; change both ends or neither.** |
| `design-types.js` | Server-side allowlists (originals: PSD/AI/PDF; web: JPG/PNG/WebP), the 300MB cap, the catalog-leaf category list, and `parseDesignKey()` |
| `manifest.js` | `regenerateManifest()` — the ONE place `design-manifest.json` is produced. Regenerates whole from DynamoDB every time, never patches. Shared with archive/restore so two writers can't emit two shapes |
| `scan-verdict.js` | Fail-closed GuardDuty verdict lookup against the standalone `SCAN#<ref>` item |

Three things here are easy to get wrong and were each proven live:

- **`requireRole(Production/Sales/Admin)`, not `isStaff()`.** `isStaff()` includes `Finance`,
  which has no business writing to the design library. Both handlers use `requireRole()`.
- **Fail closed on the scan, and "no verdict" is a refusal, not a pass.** Publishing makes an
  object world-readable, so both objects must carry a persisted `NO_THREATS_FOUND`. The files
  are uploaded *before* any `DESIGN#` record exists, so the verdict routinely lands with
  nothing to annotate — `scan-verdict.js` reads the standalone `SCAN#<ref>` item precisely to
  cover that race. Anything other than a clean verdict (including none) returns 409; a
  `stillScanning: true` flag distinguishes "retry in a moment" from "this file is bad."
- **Copy to the public bucket happens BEFORE the DynamoDB write, deliberately.** The reverse
  order leaves a `published` record pointing at an image that was never created, and no retry
  fixes it because the same designId is refused twice. Failing the other way leaves only a
  harmless orphan object.

`parseDesignKey()` is the reason a caller cannot turn `POST /designs` into an arbitrary
private→public copy primitive: the `s3Key*` strings in the body are re-parsed and every
component re-validated (prefix, known catalog leaf, well-formed uuid, allowlisted extension,
exact basename), so only a key this system would itself have issued is ever accepted. Likewise
`uploadedBy` is the JWT's verified `sub`, never a body field.

**Known gap for the next pass:** a design saved as `status: "draft"` can't currently be
promoted to `published` — `publish-design.js` refuses a second write for the same designId.
That transition belongs to the roadmap's `PATCH /designs/{id}` route, which isn't built.

## Hard rule before you send ANY test email

Read the "Hard rule: sending email during testing" section in the root `CLAUDE.md` first. In
short: **the only permitted test recipient anywhere is `admin+admin.kcmps.uat@kcmps.com`**, and
**never design a test whose success condition is a bounce or a rejected send** — prove negative
cases by inspecting config (`describe-active-receipt-rule-set`, `sesv2 get-email-identity`) or by
invoking a Lambda with a synthetic event. SES is in production; every bounce is charged against
the reputation of the identity that delivers real customer order mail, and AWS suspends near a
10% bounce rate. This was violated once (2026-08-06) by a "confirm SES rejects it" verification
step — the config check was available, free, and stronger evidence.

## `mail/` — what's in it (STAGING ONLY, hardened 2026-08-06)

SES relay inbound-mail ingest + staff mail read/reply API (`docs/roadmap.md`'s "Parallel track —
Staff email panel"). **Deployed to `kcmps-backend-staging` only.** Infra:
`backend/infra/ses-relay.cfn.yaml` (`mirror.kcmps.com` receiving identity, the
`kcmps-inbound-mail-est-2026` private bucket) — but note the domain-wide catchall receipt rule it
originally described is **gone**, see below.

**The one thing to internalize:** there is exactly ONE real Spacemail mailbox,
`admin@kcmps.com`. `order@kcmps.com` and `info@kcmps.com` are **aliases delivering into it**
(both publicly committed — `order@` is `ORDER_EMAIL` in `website/store.js`, `info@` is in the
site footer/JSON-LD/refunds policy — neither may be retired). So: **one** Spacemail forwarding
rule into **one** mirror address, and `ingest-inbound.js` splits that single stream back into
three logical mailboxes.

| File | Purpose |
|---|---|
| `ingest-inbound.js` | S3-`ObjectCreated`-triggered — parses raw MIME (`mailparser`, vendored, see its package.json), routes by ORIGINAL recipient, enforces the SES verdicts, writes one `MAILBOX#<address>`/`MSG#<hash>` item per target mailbox. Never crashes on malformed mail — falls back to a minimal record under `unparseable@kcmps.com` so the S3 ref is never lost |
| `mail-parse.js` | MIME→contract field mapping (`toMailFields()`), thread-id derivation, and the routing/provenance header extraction (`extractForwardedRecipients`, `extractSesVerdicts`, `receivedViaExpectedForwarder`). Extraction only — the *decisions* live in `../lib/mail.js` so they stay pure and unit-tested. Also imports `../lib`, so the packaging require-rewrite applies to this file too, not just `index.js` |
| `get-mailboxes.js` / `get-mail-messages.js` / `get-mail-message.js` / `mark-mail-read.js` / `send-reply.js` | JWT-authorized read/reply API, every one gated on `../lib/mail.js`'s `canAccessMailbox()`. Mirrors `dashboard-data.js`'s mock contract field-for-field so C4's swap to real `fetch()` is a function-body change only |

**Key shape**: `PK: MAILBOX#<mailboxId>`, `SK: MSG#<sha256(messageId)[0:32]>` — see
`../lib/keys.js`'s `mailboxPk()`/`mailMessageSk()` header for why the SK has no date component
and why the hash makes ingest naturally idempotent on S3-event retry.

**`mailboxId` is the REAL address** — `order@kcmps.com`, never `order@mirror.kcmps.com`. The
mirror domain is plumbing; it must not leak into the data model, the UI, or the access rules.
(It also keeps a future provider migration a backend-only change — `order@kcmps.com` is the
identifier under Gmail/Graph too. See the roadmap's "replaceable backend" note.) A unit test
pins this. The old mirror-address items were throwaway test data and were deleted.

**Access is purely group-based** (`../lib/mail.js`): `order@` → Sales/Finance/Admin, `info@` →
Sales/Admin, `admin@` → Admin, system mailboxes (`unrouted@`/`unparseable@`/`quarantine@`) →
Admin read-only. **Do not add `ROLES.STAFF`** — the owner reverted that once (commit `49dad04`);
`Staff` means "may open the dashboard", not a capability. Personal mailboxes are permanently out
of scope and their code path is deleted, not dormant. Read that module's header first.

**Routing is by ORIGINAL recipient, not delivery address.** The receipt rule now accepts exactly
one recipient (`shop@mirror.kcmps.com` — the domain catchall was deleted, which removed the
"guess a local part and inject a message into the staff UI" surface), so the delivery address is
identical on every message and carries no information. `resolveMailboxes()` prefers
forwarder-stamped envelope headers (`Delivered-To`, `X-Original-To`, …) and falls back to
`To:`/`Cc:` — **the envelope header wins because a BCC'd message has no `To:` naming the alias**
and would otherwise be mis-filed. No match → the single `unrouted@kcmps.com`; never dropped,
never auto-creating a mailbox. Which header Spacemail really stamps is still unconfirmed (no
genuinely forwarded message exists yet) — move it to the front of `FORWARDER_HEADERS` once one does.

**Verdicts are enforced at ingest.** Virus/spam = hard reject into a metadata-only
`quarantine@kcmps.com` stub (body/snippet/attachments stripped). **SPF is recorded but NEVER
enforced** — forwarding breaks SPF by design, so enforcing it would discard every legitimate
forwarded message. DKIM pass is the positive signal. All four persist on `provenance.verdicts`
and render in `email.html`. **No ARC** — the IETF is moving it to Historic by Nov 2026.

## Where this is going (not now)

`ops-dashboard/infra/logic-inputs/*.js`'s originals are now superseded reference material only
— don't edit them expecting it to affect anything deployed; edit `staff-api/`/`jobs/` instead.

## Cost convention: set log retention at creation

Every one of the 7 deployed Lambdas' CloudWatch log groups was found with **no retention
policy** (unbounded storage, i.e. never expires) during the 2026-08-02 cost-governance audit —
fixed then via `aws logs put-retention-policy --retention-in-days 30`. Any new Lambda must set
30-day retention as part of its own creation (CLI `--retention-in-days 30` right after
`aws logs create-log-group`, or the CloudFormation `AWS::Logs::LogGroup` resource's
`RetentionInDays: 30` property if provisioned via template) instead of relying on a future
audit to catch it. See [docs/cost-governance.md](../docs/cost-governance.md) for the reasoning.
