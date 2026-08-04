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
