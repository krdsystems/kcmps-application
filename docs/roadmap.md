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
    Both are deprecated in favor of `Admin`/`Customer` — see "Legacy groups" in
    `backend/infra/README.md` for the retirement steps (migrate members, then update
    `dashboard-shell.js`'s client-side check, then delete the two old groups).
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

## Parallel track — Design Asset Library (no dependency on Milestone 1)
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

**Architecture:**
- Two S3 buckets: a **private** originals bucket (PSD/AI/PDF/whatever the designer works in —
  "virtually unlimited" via a standard→IA→Glacier lifecycle policy, never public) and the
  **existing public** storefront assets bucket for the derived, web-optimized copy.
- Metadata lives as `DESIGN#<id>` items in the same foundation table, stamped via
  `backend/lib/item.js`'s `baseItem()` (tenantId/schemaVersion/soft-delete) and logged via
  `events.js`'s `buildEvent()` — same conventions as orders, not a separate schema style.
- **Category = an existing catalog leaf** from `products.js` (per 2026-07-30 decision) — one
  naming/category vocabulary end to end, not a second taxonomy to keep in sync.
- **Access = existing Production/Sales/Admin Cognito groups** (per 2026-07-30 decision) — no
  new 6th role; reuses the 5-role model already provisioned in
  [`backend/infra/foundation.cfn.yaml`](../backend/infra/foundation.cfn.yaml).
- Autonaming reuses `window.KCMPS_TEXT.titleFromFilename()`'s existing filename→display-title
  convention (`products.js`) so the library and the storefront can never drift into two
  different naming schemes.

**Checklist:**
- [ ] Private S3 bucket for originals — versioned, lifecycle to IA/Glacier, bucket policy
  denies all public access
- [ ] `DESIGN#<id>` META shape: `name`, `description`, `category` (=leaf id), `tags`,
  `uploadedBy` (Cognito `sub`), `s3KeyOriginal`, `s3KeyWeb`, `status` (`draft`/`published`/
  `archived`)
- [ ] `getUploadUrl` Lambda — presigned PUT to the private bucket, key
  `designs/<category>/<uuid>-<sanitized-name>.<ext>`
- [ ] `publishDesign` Lambda — on upload confirm: derives a web-optimized image, renames it
  through the same `titleFromFilename()` convention, copies it into the public storefront
  assets path, writes the `DESIGN#` record, and regenerates the design-grid manifest (same
  pattern as the hero carousel's manifest, new leaf) — this is what makes the storefront
  "auto-update" without a code deploy
- [x] A **"Soon"-badged placeholder page exists**: `website/dashboard/design-library.html`
  (nav key `design`, 2026-07-31). It already carries the correct shell, `mount("design")`, and
  topbar title — building the real page means replacing its `<main>` contents, nothing else.
- [ ] Dashboard "Design Library" page: upload form (category dropdown sourced straight from
  `products.js`'s leaves) + browsable/searchable grid (filter by category, tag, uploader).
  Scan+filter is fine at current volume — add a category GSI only if/when volume actually
  demands it, not before (same "don't build the index before the need" rule as the rest of the
  table)
- [ ] Verify `buildDesignGrid()`/the design picker need zero `.html`/`store.js` changes to pick
  up a newly published design — they should only need the manifest to change

**Open decision:** max upload size / allowed file types (PSD/AI originals can be large —
decide the presigned-URL size ceiling before building, so multipart upload isn't a surprise
requirement mid-build).

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
- [ ] SSM Parameter Store `SecureString`: one parameter per staff `sub`, written only via a
  Lambda the staff calls from their own authenticated session
- [ ] `getInboxMessages` / `sendEmail` Lambdas — JWT-authenticated, IMAP/SMTP client, reads
  only the caller's own parameter
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
- [ ] Shared-mailbox credentials are a **second namespace** the architecture above doesn't cover:
  `/kcmps/shared/order/email-cred`, `/kcmps/shared/info/email-cred`, written once by an admin,
  one credential per shop inbox rather than per staff `sub`. Access decided by **Cognito group**:
  `order@` → Sales/Finance/Admin, `info@` → Sales/Admin, Production → personal mailbox only,
  Customer → none. Encode as `backend/lib/mail.js` (`MAILBOX_ACCESS`, `canAccessMailbox(groups,
  mailboxId)`) so it's unit-testable with the rest of `backend/lib/`. `getMailboxes` decides
  *visibility*, but every other handler must re-check — never trust the client's `mailboxId`.
- [ ] **Trap to honour when writing `putEmailCredential`:** derive `<sub>` from the *verified
  JWT*, never from the request body. Accepting a client-supplied `sub` lets any staff member
  overwrite anyone else's stored credential. Sharpest trap in this feature.
- [ ] SSM Parameter Store `SecureString`: one parameter per staff `sub`, written only via a
  Lambda the staff calls from their own authenticated session
- [ ] `getInboxMessages` / `sendEmail` Lambdas — JWT-authenticated, IMAP/SMTP client, reads
  only the caller's own parameter
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

**Remaining SES-relay checklist (blocked on production access, except where noted):**
- [ ] Configure an SNS topic on the `kcmps.com` identity for bounce/complaint notifications —
  doable now, independent of the access request, and strengthens the pending support case if
  done before AWS's review completes
- [ ] Verify a second identity, `mirror.kcmps.com`, for **receiving** — not gated by sandbox
  mode (only sending is restricted), so this can be built and tested today
- [ ] MX record for `mirror.kcmps.com` → `inbound-smtp.<region>.amazonaws.com`, S3 bucket +
  SES receipt rule delivering incoming mail there
- [ ] Spacemail forwarding rule from each mailbox to an address on `mirror.kcmps.com`
- [ ] Parser Lambda: S3-object-created trigger → parse MIME → write into the same
  `MESSAGE#`/mailbox shape `email.html`'s mock already expects (swap-in, not a rewrite)
- [ ] `sendReply`-equivalent Lambda via `SES.SendEmail`/`SendRawEmail` on the verified
  `kcmps.com` identity — buildable now, testable against your own verified address even while
  in sandbox, full production traffic once access clears

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
