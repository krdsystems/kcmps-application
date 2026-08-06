# Performance audit — "the platform feels slow" (2026-08-06)

Read-only research. No code changed, nothing deployed. All numbers below are labeled
**Measured** (pulled from AWS CLI / repo inspection on 2026-08-07) or **Inferred**
(reasoned from measured facts but not directly observed). Where a commonly-assumed cause
turned out not to hold up, that's called out explicitly — see §5.

## 1. Measured baseline

### Frontend

| Item | Measured value |
|---|---|
| `website/` total size | 6.9 MB (deploys via `aws s3 sync`, no build) |
| `index.html` | 152 KB / 140,911 bytes, 2,824 lines, single file |
| `store.js` | 124 KB / 110,343 bytes, 2,391 lines |
| `products.js` | ~20 KB, 555 lines |
| `styles.css` | 1,264 lines, hand-written (no Tailwind CDN found — see §5) |
| Largest single asset | `bg-texture.png`, 244 KB |
| Design/product JPGs | 40–170 KB each, typically 900–1280px wide. None multi-MB. All already reasonably compressed for photo content. |
| `og-image.jpg` | 75 KB, correctly sized 1200×630 |
| Hero manifest (`assets/manifest.json`) | 11 KB, 37 image references pooled for the hero carousel |
| Design Asset Library manifest | Not present yet (`design-manifest.json` doesn't exist — library is empty). `mergeDesignManifest()`'s fetch currently 404s silently every page load (by design — see CLAUDE.md, this is a documented silent no-op, not a bug) |
| `loading="lazy"` usage | 1 occurrence across `store.js`+`index.html`, out of 3 `<img>`-producing code paths in `store.js` alone (catalog cards, design grid tiles, lightbox all build images programmatically without lazy attributes) |
| S3 object headers on deployed files | `CacheControl: None`, `ContentEncoding: None` on both `index.html` and `store.js` (checked via `head-object`) — no cache metadata is being set at sync time |

### CloudFront (both distributions, checked via `get-distribution-config`, profile `kcmps-claude-priv`)

| Distribution | Cache policy | Compress |
|---|---|---|
| Production `EY6Q5RSWLDCEF` (`kcmps.com`) | `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` = AWS managed **CachingDisabled** | `true` |
| Dev `E7PDB5JQRZX0E` (`dev.kcmps.com`) | Same — **CachingDisabled** | `true` |

Confirmed: every request for every asset (including images that never change — logos,
product photos, `bg-texture.png`) is forwarded to the S3 origin and gets `Cache-Control:
no-cache` treatment at the edge. Gzip/Brotli compression *is* already on, so that part is
fine.

### Backend — Lambda (CloudWatch, 30-day window, profile `kcmps-claude-priv`, ap-southeast-1)

| Function | Invocations (30d) | Avg duration | p95 | p99 | Max |
|---|---|---|---|---|---|
| `kcmps-get-orders` | 2,575 | 742 ms | 1,694 ms | 3,412 ms | 4,260 ms |
| `kcmps-get-messages` | 1,105 | 66 ms | 198 ms | 568 ms | 957 ms |
| `kcmps-get-unread-messages` | 730 | 48 ms | 194 ms | 515 ms | 652 ms |
| `kcmps-verify-payment` | 45 | 554 ms | 928 ms | 956 ms | 956 ms |
| `kcmps-create-order` | 76 | 546 ms | 906 ms | 969 ms | 1,013 ms |
| `kcmps-advance-line-item` | 136 | 191 ms | 589 ms | 647 ms | 856 ms |
| `kcmps-notify-unread-messages` (cron, not user-facing) | 148 | 474 ms | 537 ms | 602 ms | 611 ms |

`kcmps-get-orders` is the clear outlier — 3–15× slower than every other endpoint, and it's
the call that populates the staff Jobs list and the customer Orders page, i.e. one of the
most frequently hit, most visible screens in the product.

### Backend — why `get-orders` is slow (measured, not the documented reason)

- Production DynamoDB table `kcmps`: **24 items total**, 9,954 bytes. Breakdown: 12
  `META` (orders), 6 `EVENT`, 3 `LINEITEM`, 3 `MSG`. That's roughly **12 orders**.
- CLAUDE.md and the code's own comments frame the `Scan` in `get-orders.js` as an accepted
  tradeoff that "gets worse as the table grows." At 24 items, a Scan itself is not the
  bottleneck — DynamoDB Scan latency at this size is single-digit milliseconds.
- CloudWatch Logs Insights (`REPORT` lines, 14-day window) on `kcmps-get-orders`:
  cold starts (`@initDuration` present) are only **2–4% of invocations** (9/211, 20/491,
  22/649, 20/1018, 4/69, 11/135 across the sampled days), averaging ~330–360 ms init time
  when they do happen. **The other 96–98% of invocations are warm** and still average
  400 ms–1.3 s depending on the day.
- So the 742 ms average / 3.4 s p99 is coming predominantly from **warm-path work**, not
  cold starts and not raw Scan cost at this data volume. The function does, per request:
  a table Scan for order `META` items, then `Promise.all(items.map(attachLineItems))` — one
  additional `Query` round-trip **per order** for its line items (an N+1 pattern) — plus,
  for staff callers, a second and third `Promise.all` pass (`withCorrespondenceUrls`,
  `withDesignFileUrls`) that walks every order's `correspondenceLog` entries and
  `designFiles` and calls `getSignedUrl` (local SigV4 computation, not a network call, but
  still real CPU work) per attachment. With 12 orders this is a modest fan-out today; it's
  architecturally an N+1 that will scale **linearly with order count**, independent of
  whether the base Scan is replaced with a Query later.
- API Gateway (`kcmps-checkout-api`, all routes combined, 14-day window): overall average
  latency is a healthy 78.7 ms, but p99 is 1,377 ms and max 4,824 ms — consistent with
  `get-orders` being the tail-latency outlier dragging the aggregate p99/p99 up while every
  other route is fast.

### Frontend polling (measured from source, not runtime)

- `dashboard-shell.js`: unread-badge poll every 45,000 ms (`setInterval(refreshUnreadBadge,
  45000)`), hits `kcmps-get-unread-messages` (fast, 48 ms avg — not a concern).
- `job-detail.html` / `order-detail.html`: message-thread poll every 8,000 ms while a
  ticket is open, hits `kcmps-get-messages` (66 ms avg — not a concern).
- Neither polling loop is itself slow; they're not implicated in "feels slow." They would
  become a real cost/rate concern only at much higher concurrent-user counts than this
  business has today.

## 2. Findings ranked by user-perceived impact

1. **`GET /orders` (staff Jobs list, customer Orders page) — measured 742 ms avg, 1.7 s
   p95, 3.4 s p99, up to 4.3 s.** This is the single highest-impact finding: it's a
   frequently visited screen, the latency is large enough to be consciously perceived as
   "loading," and CloudWatch confirms it's not a rare edge case (2,575 invocations in 30
   days, most on the slow side of the other endpoints). This is very likely a meaningful
   share of "the platform feels slow."
2. **CloudFront `CachingDisabled` on both distributions.** Every page load re-fetches
   *everything* — HTML, JS, CSS, and every image — from S3 through CloudFront with zero
   edge caching, on every single visit, even for a returning visitor whose assets haven't
   changed. This affects literally every page load, every asset, every visitor. It doesn't
   show up in the Lambda/API numbers above because it's origin (S3), not Lambda, but it is
   a plausible major contributor to "pages feel slow to load" — first paint and every
   subsequent asset both pay full S3 origin latency instead of an edge cache hit, on every
   request, forever.
3. **No `loading="lazy"` on catalog/design-grid images**, combined with `buildDesignGrid()`
   and the design-manifest merge running full catalog renders on page load. Not proven slow
   by direct measurement (Lighthouse/RUM wasn't run — see limitations below), but is a
   textbook "why does this feel janky" contributor: images below the fold are requested
   immediately instead of on scroll, competing for bandwidth with the images actually in
   the viewport.
4. **`get-orders`'s N+1 line-item Query + presign fan-out.** Not yet a "flip a switch and
   it explodes" scaling cliff — 12 orders is tiny — but it is the *mechanism* behind
   finding #1, and its cost grows linearly with order count with no ceiling. This is a
   sleeper: it will get slower every month as real orders accumulate, silently, until it's
   the same complaint again at 5–10× today's latency.
- **Ruled out / not supported by measurement**: Tailwind CDN runtime compilation (see §5),
  Lambda cold starts as the dominant driver of `get-orders` latency (only 2–4% of calls),
  and DynamoDB Scan cost at current table size (24 items — genuinely fast).

## 3. Prioritized fixes

### Fix 1 — Enable CloudFront caching for static assets
- **Change**: Move off the managed `CachingDisabled` policy. Recommended: keep
  `CachingDisabled` (or a very short TTL) *only* for `index.html`, `store.js`,
  `products.js`, `styles.css`, `dashboard/*.html`, and other files that change on every
  deploy and must reflect edits immediately (this matches the documented reason
  `CachingDisabled` was chosen — "so syncs show up instantly"). Switch everything under
  `assets/` (images, fonts, `manifest.json`) to a cache policy with a real TTL (e.g. AWS
  managed `CachingOptimized`, or a custom policy with `Cache-Control: max-age` respected
  from S3 object metadata) via a **CloudFront Cache Behavior** matching `assets/*`, ordered
  ahead of the default behavior. This can be layered without a build step — it's pure S3
  metadata (`--cache-control` on `aws s3 sync` for the `assets/` prefix) plus a CloudFront
  behavior added via `dev-domain.cfn.yaml`-style CloudFormation (or directly on the
  existing distributions).
- **Expected improvement**: Every repeat visit (which is most traffic for a storefront with
  returning customers) skips origin entirely for images/fonts/manifest — largest single
  lever on perceived page-load speed available here.
- **Effort**: Low–medium. No code changes to `website/`; a CloudFront config change plus
  changing the `aws s3 sync` invocation to pass `--cache-control` for the `assets/` prefix
  (a deploy-script change, not a `website/` change — doesn't violate the no-build-step
  constraint).
- **Risk**: Low, if scoped only to `assets/*`. The documented reason `CachingDisabled` was
  picked (instant visibility of HTML/JS/CSS edits after a sync) is preserved by leaving the
  root/default behavior untouched.
- **Recurring cost**: **₱0.** CloudFront caching doesn't cost extra; if anything it reduces
  S3 GET request costs (currently near-zero anyway per `docs/cost-governance.md`'s "$0"
  CloudFront egress finding, still inside the free tier through mid-2027). No CachingOptimized
  policy charge exists — cache policies themselves are free, only origin/edge data transfer
  is billed, and this fix reduces origin transfer.
- **Constraint check**: Does not violate no-build-step (config-only). Does not touch content
  inside `website/`.

### Fix 2 — Fix `get-orders`'s N+1 line-item fetch
- **Change**: `attachLineItems` currently issues one `Query` per order. Since orders and
  their line items share the same partition key convention (`ORDER#<id>`), a single
  `Query` per order already scopes correctly — the N+1 is across *orders*, not within one.
  The straightforward fix without introducing a new GSI: batch the line-item queries with
  `BatchGetItem`/parallel `Query` (already parallel via `Promise.all`, so the real win is
  reducing *what* runs inside that fan-out) — or, since the per-order Scan already reads
  the `META` item, consider a single follow-up `Query` per order is likely close to optimal
  without a schema change. The highest-leverage improvement is capping/paginating
  `get-orders` for the *customer*-facing call (`getOrdersForSub`) so a shopper's browser
  never pays for scanning the *entire* orders table — that scan-then-filter-by-`customerSub`
  pattern reads every order in the shop to return one customer's handful, which is the
  worse of the two N+1-adjacent patterns here and the one that scales the wrong direction
  fastest (per-customer request cost grows with *total shop order volume*, not the
  customer's own order count).
- **Expected improvement**: Reduces `get-orders` warm-path latency; magnitude unmeasurable
  without a staging benchmark, but removing an unbounded per-customer Scan-of-everything is
  a correctness/scaling fix as much as a speed one.
- **Effort**: Medium. Needs a GSI (`customerSub` + `createdAt`, per the code's own comment:
  "Requires a CLIENT#-keyed GSI once the CRM view matures") for the customer-facing path to
  be a real Query instead of Scan+filter. The staff-facing "all orders" Scan is a smaller,
  lower-risk change (or can stay a Scan — see §5, it's genuinely fine at current volume).
- **Risk**: Medium — schema/GSI changes touch `backend/infra/foundation.cfn.yaml` and need
  the staging rehearsal workflow (`backend/infra/README.md`).
- **Recurring cost**: A GSI roughly doubles the write-capacity cost of writes to items it
  projects, but on-demand DynamoDB at this table size (9,954 bytes, 24 items) is already
  a few ₱/mo per `docs/cost-governance.md`'s Node.js-migration benchmark entry (~₱3/mo at
  ~300 items). A GSI here stays well under ₱50/mo even at 10× current volume.
- **Constraint check**: Changes a documented deliberate tradeoff (Scan-not-GSI) — flagged
  explicitly per the task's hard constraints; this is being proposed as a change to that
  decision, not a silent override.

### Fix 3 — Lazy-load below-the-fold images
- **Change**: Add `loading="lazy"` to `<img>` tags generated in `store.js`'s catalog card
  builder, `buildDesignGrid()` tiles, and the design-picker popup/subcatalog — everywhere
  except the first hero image and the first visible catalog row.
- **Expected improvement**: Reduces initial-load network contention; browsers defer
  off-screen image fetches until scroll-near. Standard, well-understood win; not measured
  here (no RUM/Lighthouse run — see limitations), but very low risk to claim.
- **Effort**: Very low — attribute addition at each `<img>` construction site in `store.js`.
- **Risk**: Very low. `loading="lazy"` is a no-op progressive enhancement in unsupported
  browsers.
- **Recurring cost**: ₱0.
- **Constraint check**: None violated — pure HTML attribute, no build step needed.

### Fix 4 — Cache-Control headers on the deploy sync
- **Change**: Companion to Fix 1 — even without changing the CloudFront cache policy,
  setting real `Cache-Control` headers on `assets/*` objects during `aws s3 sync` (e.g.
  `max-age=31536000,immutable` for anything under `assets/`) lets browsers cache locally
  between visits within the same session/device, independent of CDN edge caching.
- **Expected improvement**: Smaller, but stacks with Fix 1: covers the case where a shopper
  revisits within a browser session before any CDN edge TTL would matter.
- **Effort**: Trivial — one flag addition to the two documented `aws s3 sync` commands in
  root `CLAUDE.md`.
- **Risk**: Low. Should exclude `index.html`/`store.js`/`products.js`/`styles.css`/
  `dashboard/*` (keep those no-cache, matching the documented "instant visibility" reason).
- **Recurring cost**: ₱0.
- **Constraint check**: None.

## 4. Quick wins (ship immediately, config-only or one-liner)

- **Fix 3** (`loading="lazy"` on catalog/design images) — a `store.js` diff of a handful of
  lines, no infra, no deploy risk beyond the normal staging→prod gate.
- **Fix 4** (`--cache-control` flag on the `aws s3 sync` deploy commands for `assets/`) —
  one flag, documented in root `CLAUDE.md`'s deploy section; no code change.
- **Fix 1's CloudFront behavior for `assets/*`** — config-only, no `website/` edit,
  reversible by deleting the behavior if anything regresses.

None of these three touch backend code, none need the staging-then-production Lambda
rehearsal, and none have a recurring cost.

## 5. What I did NOT recommend, and why (including assumptions the brief itself made that didn't hold up)

- **Tailwind CDN runtime compilation** — the task brief and CLAUDE.md's own architecture
  table describe the storefront as "Tailwind via CDN." **Measured**: no reference to
  `tailwindcss` or any Tailwind CDN `<script>` tag exists anywhere in `website/` (`grep -rn
  tailwind website/` returns nothing). The storefront is 100% hand-written `styles.css` —
  the "Tailwind via CDN" line in CLAUDE.md appears to describe an earlier or aspirational
  state, or scoped intent that was never implemented on the live site. **This is not a
  fix I'm recommending because there is nothing to fix** — flagging it because it was the
  brief's own headline suspected cause, and it's worth someone correcting the CLAUDE.md
  table so the next session doesn't chase the same ghost.
- **Provisioned concurrency for `get-orders` (or any Lambda)** — cold starts are measured
  at 2–4% of `get-orders` invocations, ~330–360 ms each. Provisioned concurrency (typically
  $/GB-second continuously billed, roughly $5–15/mo minimum for even one warm instance)
  would blow through the ₱500/mo cap for a problem that measurement shows is *not* the
  dominant contributor to this function's latency (96%+ of the slow calls are warm).
  Rejected on cost-vs-measured-impact grounds, not architecture.
- **A full rewrite / bundler / build step** — explicitly out of scope per the task and
  CLAUDE.md's "Hard constraint: what's deployed." Every fix above is achievable with the
  existing sync-verbatim deploy model.
- **Switching `get-orders`'s staff-side Scan to a GSI-backed Query right now** — at 12
  orders / 24 total items, the Scan itself is not measurably the bottleneck (see §1); a
  schema change here is lower-leverage today than fixing the N+1 fan-out and the customer-
  side Scan-of-everything (Fix 2, second half). Recommended as a should-do, not an
  emergency — revisit sizing once order volume is meaningfully larger, per the code's own
  documented trigger.
- **Reducing message-thread (8s) or unread-badge (45s) polling intervals/frequency** —
  measured latency on both endpoints they hit (`get-messages` 66 ms avg, `get-unread-
  messages` 48 ms avg) is fine; polling isn't implicated in "feels slow" by any evidence
  gathered here. Not a finding worth spending effort on.
- **Image re-compression/resizing pass over `website/assets/**`** — measured file sizes
  (40–170 KB per product photo, largest non-photo asset 244 KB) are already reasonable for
  web delivery at their served dimensions; nothing multi-MB was found. Not recommending a
  bulk re-encode effort since the evidence doesn't support it being a real problem — lazy-
  loading (Fix 3) and CDN caching (Fix 1) address the actual measured gaps (request count
  and repeat-visit cost), not per-file weight.

## Limitations of this audit

- No synthetic frontend performance run (Lighthouse/WebPageTest/RUM) was executed — findings
  about render-blocking behavior, Largest Contentful Paint, and Time to Interactive are
  reasoned from source inspection, not measured in a real browser. If prioritizing further,
  a Lighthouse pass against `dev.kcmps.com` (Basic Auth aside) would sharpen Fix 1 and Fix 3's
  expected-improvement estimates from qualitative to quantitative.
- DynamoDB per-call latency (Query/Scan RCU-level timing) wasn't isolated from Lambda
  wall-clock duration — the CloudWatch Logs Insights `@duration`/`@initDuration` breakdown
  shows warm-vs-cold split but not a further breakdown of DynamoDB-call-time vs.
  presigning-CPU-time vs. Lambda-runtime-overhead within a warm invocation. If `get-orders`
  is still slow after Fix 2, X-Ray tracing (not currently enabled on any function checked)
  would be the next diagnostic step.
