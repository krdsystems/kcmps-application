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
