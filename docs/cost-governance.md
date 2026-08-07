# Cost governance — KCMPS

How infrastructure spend is checked, not gated. See the root [`CLAUDE.md`](../CLAUDE.md)'s
"Cost governance" section for the one-paragraph summary; this file is the detail behind it.

## The principle

Infrastructure cost must always be justified against actual sales volume/gross revenue, and
grow only when a measurable trigger — not a hunch — says it should. The ₱500/mo figure below is
a **soft cap**: a trigger for review and an explicit "is this worth it" justification, not an
absolute ceiling that blocks work. Crossing it is allowed; crossing it *silently*, without
saying what it costs and why, is what this doc exists to prevent.

## Two-stage formula

- **Stage 0 (now, pre-revenue/early):** target ceiling ₱500/mo (~US$9). Staying under it needs
  no extra justification. Going over it is allowed, but any change that would push spend past
  this line should be flagged explicitly — in the PR/commit or the decision log below — with
  what it costs and why it's worth it, not skipped silently.
- **Stage 1 (once revenue flows):** the soft target becomes `max(₱500/mo, 3% of trailing-30-day
  gross revenue)` — spend is expected to track the business's actual revenue, not race ahead of
  it speculatively. Still guidance to check against, not a hard gate.

Any single change that adds recurring monthly cost (provisioned concurrency, a new GSI, a
larger CloudFront price class, a paid third-party service, reserved capacity) should cite the
specific numbers it's checked against — current spend, what this adds, where that lands
relative to the soft cap — before it ships. Pay-per-request/cost-neutral changes don't need
this.

## Cost Explorer baseline (2026-08-02)

- ~$0.24–1/mo compute + storage combined, across both AWS accounts
  (`600929977538`/`260866268499`).
- $16/yr one-time domain registrar renewal.
- $0.50/mo Route 53 hosted zone.
- CloudFront egress: **$0** — the site is 27MB, well inside the 12-month CloudFront free tier
  (distribution created 2026-07-31, so the free tier runs through ~2027-07-31).

All comfortably under the Stage 0 soft cap today.

## Decision log

Each entry: decision, $ reasoning, trigger that would revisit it.

- **30-day CloudWatch log retention on all Lambdas** (applied 2026-08-02 to all 7 existing log
  groups; convention for future Lambdas recorded in
  [`backend/CLAUDE.md`](../backend/CLAUDE.md)) — unbounded log storage has no benefit past the
  debugging window it exists for. Revisit only if compliance ever requires longer retention.
- **Payment-uploads S3 lifecycle** (applied 2026-08-02 to `kcmps-payment-uploads-est-2026`:
  Standard → Standard-IA at 30 days → Glacier Instant Retrieval at 90 days, no expiration) —
  GCash screenshots are write-once and rarely read again after verification, but are financial
  evidence that must be kept forever. No expiration rule was added on top of the pre-existing
  `NoncurrentVersionExpiration: 90 days` rule on that bucket.
- **No lifecycle policy on `kcmps-online-bucket-est-2026`** (the live production site) — it's
  small (27MB) and frequently read; IA/Glacier would add retrieval latency for no benefit at
  this size. Revisit only if the bucket's total size or read pattern changes materially.
- **Design-originals bucket** (planned, not yet built — see
  [`docs/roadmap.md`](roadmap.md#parallel-track--design-asset-library-no-dependency-on-milestone-1)):
  no CloudFront in front of it, versioned, `NewerNoncurrentVersions: 5` lifecycle rule — caps
  revision-history growth from repeated re-uploads while keeping recent history free/cheap.
- **No image-processing Lambda planned for the design library** — the designer's own export
  tool already produces the web-ready file for free; a server-side resize pipeline would be
  pure added cost and complexity for a capability that already exists client-side.
- **Recycle-bin 90-day purge window** (planned) — balances "an accidental dashboard delete must
  always be recoverable" (owner's explicit requirement) against unbounded storage growth from
  never actually deleting anything.
- **No provisioned concurrency anywhere** — revisit only if a specific customer-facing path
  shows cold starts hurting conversion, AND order volume justifies the $5–15/mo it would add.
- **Scan-not-GSI for design listing** (planned) — a client-side-filtered `Scan` is fine at
  current/expected catalog volume; add a category GSI only once the catalog exceeds ~500 items
  or scan latency is visibly bad.
- **GuardDuty Malware Protection for S3 on customer uploads** (applied 2026-08-04, plan
  `7acfe6ba55d9edc67956`, scoped to `design-uploads/` on `kcmps-payment-uploads-est-2026`) —
  scans every uploaded object and tags it `GuardDutyMalwareScanStatus`; `staff-api/get-orders.js`
  withholds the download link for anything not `NO_THREATS_FOUND`.

  **Actual ap-southeast-1 pricing (verified against the AWS Pricing API 2026-08-05):**
  data scanned is **free for the first 1 GB/mo**, then **$0.135/GB**; scan requests are **free
  for the first 1,000 PUT/mo**, then **$0.000323/request**. An earlier version of this entry
  quoted ~$0.60/GB + ~$0.19/1,000 and claimed ~$1.30/mo (~₱75, 15% of cap) — that was generic
  US-region list pricing recalled from memory, and it ignored the free tier. It overstated the
  real cost by roughly 7x. Check the Pricing API for the actual region before quoting a rate.

  **Measured, not estimated**: over 2026-07-31 → 08-05 the whole uploads bucket took 42 objects
  / 56 MB across `payments/`, `messages/` and `correspondence/` — a ~0.34 GB, ~250 object
  monthly run rate, i.e. **entirely inside the free tier**. Cost today is **$0.00/mo**.

  | scenario | GB/mo | objects/mo | cost | % of ₱500 cap |
  |---|---|---|---|---|
  | today's traffic, all upload prefixes scanned | 0.34 | 250 | $0.00 | 0% |
  | + 50 design uploads/mo (~10MB) | 0.84 | 300 | $0.00 | 0% |
  | + 200 design uploads/mo (the planning estimate) | 2.34 | 450 | ~$0.18 (₱10) | 2% |
  | 5x that | 11.7 | 2,260 | ~$1.85 (₱104) | 21% |
  | 10x that | 23.4 | 4,520 | ~$4.16 (₱233) | 47% |

  Worth it because the checkout upload zone is the one path where an outsider hands KCMPS a file
  a staff member later opens on the machine that drives the press. Containment (private bucket,
  `Content-Disposition: attachment`, presigned-GET-only, server-generated keys) stops browser-side
  attacks but does nothing about that download. Rejected alternatives: ClamAV in a Lambda
  container image (needs a container build pipeline this repo deliberately doesn't have), and no
  scanning at all.

  Cost is bounded by construction: uploads capped at 50MB each and 10 per order, route throttled
  to 10 req/s. **Revisit at ~10 GB scanned/mo** (~₱100/mo, 20% of cap) — that means upload volume
  is ~5x the estimate, at which point either revenue justifies the Stage-1 formula or the
  per-order upload cap comes down.

- **Scan extended to all four upload prefixes** (applied 2026-08-05 — `payments/`, `messages/`,
  `correspondence/` added alongside `design-uploads/`) — **+~$0.05/mo (~₱3)**, because design
  files dominate the bytes and the other three prefixes sit inside the free tier. Cost was never
  the reason to defer it; the reason to do it was that `send-message.js` accepts attachments from
  *customers*, and that path previously had neither a scan gate nor a forced-download header.
- **Auto-quarantine of infected uploads** (`backend/jobs/handle-scan-result.js`, 2026-08-05) —
  **₱0**. One more Lambda on an existing role, invoked once per upload by EventBridge; at ~250
  uploads/mo that is far inside the Lambda free tier. It *reduces* running cost slightly by
  removing a per-attachment `GetObjectTagging` call from every staff order-list load, and by
  deleting infected objects instead of storing them forever.
- **Plain-English threat descriptions** (`backend/lib/threat-descriptions.js`, 2026-08-05) —
  **₱0**. A static lookup table, deliberately not a Bedrock/LLM call. Beyond cost, an LLM would
  add latency, IAM surface, a network failure mode, and non-deterministic wording on a security
  message — AV signature names are a small, highly conventional vocabulary that a table handles
  exactly and testably.
- **No delete endpoint for design uploads** — removing an attached file at checkout is
  client-side only; the S3 object lingers until lifecycle collects it. An unauthenticated
  pre-checkout `DELETE` (checkout is guest-friendly, so there is no identity to authorize
  against) is a worse thing to expose than a few orphan objects costing fractions of a centavo.
- **Staging backend for `dev.kcmps.com`** (`kcmps-foundation-staging` + `kcmps-backend-staging`,
  applied 2026-08-05 as part of the Node.js 20.x EOL migration) — **~₱3/mo**: DynamoDB on-demand
  against a table matching prod's current size (~300 items, well under free-tier-adjacent
  pricing), near-zero API Gateway/Lambda invocation volume (staging traffic is deliberate
  rehearsal only, not real customers), and CloudWatch log storage at 14-day retention. No PITR
  (staging holds no data worth protecting), no SES sending (`FROM_EMAIL`/`SES_SENDER` env vars
  omitted — staging can never email a real customer by construction, not by discipline). Chosen
  over skipping staging entirely because the AWS cost was never the blocker — the labor cost of a
  second Lambda deploy target was — and chosen over parameterizing it away because
  `dev.kcmps.com` sharing production's backend meant every "safe to rehearse on dev" claim in
  this repo was false for anything past static HTML.
- **GuardDuty Malware Protection added to the staging bucket too** (plan
  `b2cfe8b34e713cef6b48`, applied 2026-08-05, hours after the entry above) — **~₱0/mo**, staging's
  volume is nowhere near the 1GB/1,000-object free tier. Reverses the "skip GuardDuty on staging"
  call from the entry above: that turned out not to be a cosmetic gap but a dead end — the
  read-path "fail closed" rule (no scan verdict = no download link, ever) means an attachment
  uploaded to a bucket with no GuardDuty plan watching it stays stuck at "Scanning…" permanently.
  Found via the owner's own real use of the new staging environment within hours of it shipping.
  See `docs/history.md` entry 69 for the full story, including a second bug (an unfiltered
  EventBridge rule pattern) this surfaced along the way.
- **Design Asset Library infra, staging only** (`kcmps-design-originals-staging` bucket +
  GuardDuty Malware Protection plan `32cfe94851fa0764a465` + a second, bucket-filtered
  EventBridge rule, applied 2026-08-05, first infra step of `docs/roadmap.md`'s "Parallel
  track — Design Asset Library") — **~₱0/mo at current (zero) volume**:
  - **S3 storage/requests**: the bucket is empty today — no `publishDesign` Lambda exists yet
    to write to it (that's a later pass). Even once designer uploads start, this is a
    low-frequency, staff-only path (originals only, not the public-facing derivative), so
    volume is expected to stay well under the storage costs already tracked for the payment
    uploads bucket above.
  - **GuardDuty Malware Protection scanning**: same free-tier math as the entry above this one
    — first 1 GB/mo scanned and first 1,000 scan requests/mo are free in `ap-southeast-1`
    (verified against the AWS Pricing API 2026-08-05, cited in the "GuardDuty Malware
    Protection for S3 on customer uploads" entry above). A handful of PSD/AI test uploads
    during a future pass's live verification is nowhere near either threshold, so this rides
    the same free tier the payment-uploads bucket's GuardDuty plan already does.
  - **No new Lambda invocation cost**: scan-result events route to the *existing*
    `handle-scan-result` function (shared `JobsLambdaRole`, no new function deployed) — one
    more EventBridge rule targeting a function that's already within its free-tier invocation
    volume, per the "Auto-quarantine of infected uploads" entry above.
  - **Lifecycle (Glacier transition + capped noncurrent-version retention)** costs nothing
    extra until real originals are uploaded and superseded — it exists to bound *future* growth
    from repeated re-uploads, not to generate charges today. Same reasoning as the "S3
    versioning + lifecycle for design-library originals" planning entry above, now actually
    applied to the staging bucket.
  - **Revisit trigger**: once the `publishDesign` Lambda exists and real designer uploads
    start landing, re-measure against the same free-tier thresholds the payment-uploads plan
    uses (1 GB / 1,000 requests scanned per month) — expected to stay within them at the
    catalog's current size, but re-check once uploads are actually flowing rather than assume.
  - **Production bucket + GuardDuty plan are NOT created** — owner-gated per this repo's
    staging-first rule; the equivalent CLI commands are documented in
    `backend/infra/README.md`'s "Design originals bucket" section for when the owner approves
    promotion, but nothing was run against `kcmps-design-originals-est-2026`.

- **Design Asset Library Lambdas, staging only** (`kcmps-staging-design-upload-url` +
  `kcmps-staging-publish-design` + a dedicated IAM role + 2 JWT API routes, deployed
  2026-08-06 to `kcmps-backend-staging`) — **~₱0/mo**, and the reasons are worth recording
  because two of them were deliberate design choices, not luck:
  - **Two more Lambdas, no new fixed cost.** Both are 256MB/arm64, invoked only when a staff
    member uploads or publishes a design — a handful of invocations per week at most. That is
    orders of magnitude inside the always-free 1M requests/mo, and both are staff-admin
    actions rather than a customer-facing critical path, so **no provisioned concurrency**
    (the roadmap's own sizing note). Cold starts are acceptable here; paying to avoid them
    would not be.
  - **No file bytes pass through a Lambda.** Both uploads go browser→S3 on a presigned PUT,
    and the publish step uses a server-side S3 `CopyObject`. A 300MB PSD therefore costs no
    Lambda duration at all — the alternative (proxying bytes) would have meant a much larger
    memory tier *and* a long duration on the single most expensive dimension.
  - **No image processing.** The designer supplies the web-ready derivative; there is no
    resize/transcode pipeline (the earlier decision-log entry on this stands, now actually
    implemented). Sharp-in-Lambda on a 300MB source would have been the single largest line
    item in this whole feature.
  - **Manifest regeneration is a full table `Scan` per publish.** Cheap and correct at the
    catalog's current size (tens of items, a handful of publishes a week), and deliberately
    chosen over provisioning a GSI that would cost storage continuously to serve a query that
    runs a few times a week. **Revisit trigger unchanged from the roadmap: ~500 designs**, or
    if publish latency becomes visible.
  - **Public-bucket storage** for published web-ready images rides the existing storefront
    bucket + CloudFront distribution — no second distribution, no new origin, and the images
    are served with a 1-year immutable `Cache-Control` so repeat views hit the CDN rather
    than S3.
  - **Promoted to production 2026-08-07** — see the dated entry below for the production
    bucket/GuardDuty/Lambda cost, which follows the same near-₱0 reasoning as this staging
    entry (empty bucket, no scans yet, on-demand DynamoDB against ~0 additional items).

- **SES inbound-mail relay: `mirror.kcmps.com` receiving + bounce/complaint alerting**
  (applied 2026-08-06 — `docs/roadmap.md`'s "Staff email panel" / SES-relay track,
  `backend/infra/ses-relay.cfn.yaml`) — **near-₱0/mo**:
  - **SES receiving is $0.10 per 1,000 emails received, plus $0.09 per GB for anything past
    the first free 1,000/month**, and a trivial per-object S3 PutObject charge alongside it.
    At the volume this relay will actually see (a handful of staff mailboxes forwarding, not
    a marketing inbox), this rounds to **~₱0–5/mo** — nowhere near worth a line-item unless
    volume changes by orders of magnitude. Revisit trigger: >1,000 inbound emails/mo.
  - **S3 storage for raw MIME**: `kcmps-inbound-mail-est-2026` has a 30-day Standard→IA
    lifecycle transition (same pattern as the payment-uploads bucket) since a mail parser
    Lambda (C2, not yet built) will read each object once shortly after arrival — no reason
    to pay Standard rates for it indefinitely.
  - **Bounce/complaint SNS topic** (`kcmps-ses-bounce-complaint`) costs nothing until it fires
    — SNS's free tier (1M requests/mo, 1,000 email notifications/mo) comfortably covers
    alerting volume for a 4-person shop. This was priority #1 in the build specifically
    because bounce/complaint monitoring had been **completely unmonitored** despite an
    elevated (~13%) trailing bounce rate from earlier test sends — the cost is negligible,
    the value (catching a reputation problem before AWS enforcement action) is not.
  - **No new sending infrastructure** — this track is receiving-only plus alerting on the
    *existing* `kcmps.com` sending identity/configuration-set. It doesn't add sending volume
    or change the production sending cost profile at all.
  - **Parser Lambda and reply-send Lambda are explicitly out of scope for this session** (C2/C3
    own those) — so this entry covers only what's live today: the bucket, the receipt rule,
    and the bounce/complaint event destination.

- **Asset Library + mail relay: production promotion (2026-08-07)** — **near-₱0/mo added**:
  - **Asset Library production**: new bucket `kcmps-design-originals-est-2026` (empty at
    promotion — 0 objects, so storage cost is exactly ₱0 until the first upload), a GuardDuty
    Malware Protection plan on it (same per-object pricing as every other protected bucket in
    this account — free tier covers current volume across all of them combined), 5 new Lambdas
    at effectively-zero invocation count (0 assets exist in production yet), and one EventBridge
    rule (free). Same reasoning as the staging entry above — the marginal cost of a second
    empty bucket + idle Lambdas is indistinguishable from ₱0.
  - **Mail relay production**: **zero new AWS resources** for the inbound side — the existing
    single pipeline (SES receiving identity, inbound bucket, receipt rule) was *repointed*, not
    duplicated, so there's no second bucket or second SES identity to price. Five new Lambdas
    (near-zero invocation volume — a handful of staff mailbox reads/replies a day) plus one new
    IAM role, both free. The only genuinely new spend category is that `send-mail-reply` can now
    send real customer-facing email from production — but that rides the *existing* `kcmps.com`
    sending identity/configuration-set already priced under SES's standard sending rate elsewhere
    in this file; it does not add a new pricing dimension, only a small increase in send volume.
  - **Revisit trigger**: unchanged from both entries above — Asset Library at ~500 designs or
    visible publish latency; mail at meaningfully higher invocation/storage volume than a
    4-person shop's inbox produces. Neither is expected soon.
