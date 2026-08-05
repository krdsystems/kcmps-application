# KCMPS — Production-Readiness Master Planning Brief

**To: Claude Fable 5, in intensive planning mode**
**From: repo owner, via a prior Claude planning pass that already scanned the codebase**
**Your job: produce a plan and a set of prompts. Do not write code. Do not edit files. Do not run commands. Do not deploy anything.**

---

## 0. Your role and output contract (read this first, it governs everything below)

You are the planning layer only. Every other Claude session in this project — Sonnet, Opus,
Haiku, whatever gets assigned — does the actual implementation. Your entire deliverable is:

1. A **master task breakdown** (a table, not prose): task, files/functions touched, assigned
   model + reasoning effort, dependencies, which tasks can run in parallel (and in which git
   worktree), and one line of rationale for the model/effort choice.
2. **One fully self-contained prompt per task or tightly-coupled task cluster** — copy-pasteable
   into a fresh Claude Code / Cowork session with zero other context. Each prompt must restate
   its own goal, exact files/functions to touch, acceptance criteria, the relevant repo
   conventions it must not violate, and the model + effort it's written for.
3. A **final integration/verification task**, sequenced last, gated on staging deploy + owner
   sign-off before any production promotion.
4. A short **"decisions requiring my explicit approval"** list, pulled out separately — anything
   cost-impacting or architecture-changing, per the ground rules in §5 and §6.

Do not produce any of the actual implementation yourself, even as an example "here's roughly
what the code would look like" — that defeats the entire point of using you (an expensive,
high-reasoning model) for planning while cheaper models execute. If you're tempted to write a
function body, stop — that belongs inside a task prompt as an *instruction* to the executing
model, not as code you've already written.

Read the repo's actual files before finalizing anything below — this brief is grounded in a
real scan (see §2), but you have full repo access and should verify against the live source,
especially `CLAUDE.md` (root), `backend/CLAUDE.md`, `design-system/CLAUDE.md` (if present),
`storefront-infra/CLAUDE.md`, `docs/roadmap.md`, `docs/cost-governance.md`, and
`project_knowledge/ERP_System_Project_Knowledge.md`. Where this brief and the live repo
disagree, the live repo wins — this brief may already be slightly stale by the time you read it.

---

## 1. What KCMPS is

A Manila print/merch shop (custom apparel printing + design services). Public marketing site +
storefront with cart/checkout, plus a staff-only ops dashboard. Static frontend (`website/`,
vanilla HTML5/ES6, Tailwind via CDN, no build step, synced verbatim to S3/CloudFront) backed by
a real serverless backend (API Gateway + Lambda + DynamoDB single-table + Cognito + S3 + SES)
that has been incrementally built and deployed over the last ~2 weeks.

## 2. Ground truth — current state (do not resurrect anything not on this list; deployed = real)

**Fully built, deployed, and verified end-to-end (Milestone 1 — the payment backend):**
storefront catalog/cart/checkout, guest + logged-in checkout, GCash payment-proof capture with
S3 presigned upload, staff payment verification/on-hold against real DynamoDB data, order-status
rollup via DynamoDB Streams, auto-expiry cron for unpaid orders, customer order tracking
(`orders.html`/`order-detail.html`) with bucketed tabs, reorder, resubmit-proof, per-order
customer↔staff chat threads with attachments + unread badges, customer design-file upload with
GuardDuty malware scanning across every upload prefix, operating-hours-aware SLA clocking,
Cognito auth (custom sign-up + Hosted UI login, pool v2), lightweight order↔email correspondence
linking (manual log + Spacemail deep-link search).

**Architected in full detail but with zero backend built (this is real, spec'd work, not a
vague idea — read `docs/roadmap.md`'s corresponding sections before touching either):**
- **Design Asset Library** — storage architecture (two S3 buckets, presigned upload path,
  DynamoDB item shape, recycle-bin soft-delete, manifest-merge requirement in `store.js`) is
  fully decided. Dashboard placeholder page + "Soon" badge exists
  (`website/dashboard/design-library.html`). Nothing else built.
- **Staff email panel** — mock UI fully shipped (`website/dashboard/email.html`, plain-text-only
  rendering, IMAP-shaped mock functions designed so wiring a real backend is a function-body
  swap). Spacemail's IMAP/SMTP app-password question is **resolved**: no app-password mechanism
  exists, so any stored-credential approach is a materially weaker "Tier 1" design; a real
  provider migration ("Tier 2") is the better long-term answer, not yet decided by the owner.
  Separately, an **SES-relay approach is in progress**: `kcmps.com` is verified as an SES
  sending identity (DKIM/MAIL FROM/DMARC all applied), but **SES production access is still
  pending AWS review** — this is a big deal, see the next bullet.

**Known, currently-live gap that blocks the site from being fully "production real" even though
Milestone 1 shipped:** every customer-facing SES email touchpoint (order received, payment
verified, on-hold, shipped, auto-cancelled) is coded and gated on a `FROM_EMAIL`/`SES_SENDER` env
var that is **still unset** — every one of these emails is silently disabled today, pending the
SES production-access approval. Customers currently get zero automated email at any stage. This
is very likely the single highest-leverage item for "does this feel like a real business" and
should be weighted accordingly in your plan (even though the underlying AWS approval isn't
something a coding session can force — the plan should make sure everything downstream of
approval is *already wired and tested* so approval → live is a zero-code-change flip).

**Mock/localStorage-only, deliberately deferred per the repo's own governing rule ("build a
module only when a real transaction has no home" — do not build ahead of this without a
concrete trigger):** dashboard metrics (`today.html`'s numbers), inventory, spoilage/rework
capture, manual order entry, capacity/scheduling (`week.html`), CRM. Do not silently promote
these to "in scope" — see §3 for what this planning pass actually covers.

**Known live bugs / cleanup items found during the scan, worth folding into a stabilization
track:**
- `create-order.js` and `verify-payment.js`'s `TransactionCanceledException` handling throws an
  `Error` with a `.statusCode` attached but nothing catches it — a real concurrent-edit race
  surfaces as a raw 500 instead of the intended, documented 409. (`cancel-order.js`, built later,
  does this correctly — use it as the reference pattern.)
- `POST /orders/lookup` (guest order lookup by orderId + contact) is built, deployed, and tested
  at the API level, but has **no UI** — no page or nav entry calls it yet. Guest customers today
  have no self-serve way to track an order without logging in.
- Legacy Cognito groups `Staff` (precedence 10) and `Customers` (plural, precedence 100) still
  exist in the pool alongside the real `Admin`/`Customer`/`Production`/`Sales`/`Finance` groups
  and are still partially checked by `dashboard-shell.js` — retirement steps are written in
  `backend/infra/README.md` but not executed.
- A merged, stale worktree (`.claude/worktrees/<slug>`, branch already merged to `main`) exists
  and should be pruned per the repo's own git-hygiene convention (`git worktree remove`) — cheap,
  do it, don't build a task prompt heavier than it needs to be for this one.
- `disaster-recovery/` (cloudformation + terraform) exists in the repo with unknown
  applied-vs-planned status — audit this as part of your production-readiness discovery in §7;
  a real business accepting real payments needs to know whether its backup/DR story is actually
  live or just drafted.

---

## 3. Scope decided for this planning pass (do not silently expand past this without flagging it)

The owner has decided the following scope. Build your plan to cover exactly this — flag
anything you think is missing rather than quietly adding it to the main plan (see §7's
discovery instruction for the one exception: production-launch gaps like accessibility/SEO/
monitoring, which you should actively hunt for and add).

- **Track A — Stabilization.** Fix the two unhandled-exception bugs, build the missing guest
  order-lookup UI, retire the legacy Cognito groups (migrate members first), prune the stale
  worktree, and make sure every SES-gated email touchpoint is fully wired/tested so the moment
  `FROM_EMAIL` is set (an owner action, not yours to force), live traffic starts flowing with
  zero further code changes.
- **Track B — Design Asset Library backend.** Build the fully-spec'd (see §2) backend: both S3
  buckets, `getUploadUrl`/`publishDesign` Lambdas, the recycle-bin sweep cron, the 4 API routes,
  the real dashboard page (replacing the placeholder), and the one required `store.js`
  manifest-merge change so published designs actually appear in the storefront picker.
- **Track C — Staff Email SES-relay.** Continue the in-progress SES-relay build: SNS
  bounce/complaint topic, the `mirror.kcmps.com` receiving identity + MX + S3 + receipt rule, the
  MIME-parser Lambda, the send-reply Lambda, and wiring it under `email.html`'s existing mock
  seam. Treat the Spacemail Tier 1 vs Tier 2 (provider migration) decision as an **owner
  approval item** in your final callout list, not something to decide unilaterally — Tier 1 (store
  the real mailbox password) is buildable now as a stopgap; flag its security trade-off plainly.
- **Track D — Legal/trust.** Privacy Policy, Terms of Service, and Refund/Return Policy pages,
  plus a plain-language note on Philippine Data Privacy Act (RA 10173) basics relevant to a
  storefront that collects names/addresses/contact info and payment proof screenshots. These are
  content + page-creation tasks, not backend work — keep them cheap (see §6).
- **Track E — Frontend/UX conversion pass**, scoped by §4 and §5 below (Apple design principles,
  mobile-first, conversion-over-aesthetics, radical-change permission with guardrails).

Explicitly **out of scope** for this pass (Milestone 2+): real metrics/telemetry, inventory,
spoilage/rework backend, manual order entry backend, capacity/scheduling, procurement, HR,
accounting integration. If your repo audit surfaces something in this list that you believe is
actually launch-blocking (not just "would be nice"), say so explicitly in your callout list —
don't fold it into the main plan.

---

## 4. Hard constraints (non-negotiable, verify current wording against the live `CLAUDE.md` files)

- **Deploy gate:** staging (`dev.kcmps.com` / `kcmps-backend-staging`) first, always. Production
  sync/deploy only on the owner's explicit go-ahead, never inferred from "looks good." Every task
  prompt you write must bake this in as its last step, not assume it away.
- **Migration seams are load-bearing.** `website/store.js` (`window.KCMPS_STORE`),
  `website/dashboard/dashboard-data.js` (`window.KCMPS_DASH`), and `website/orders-data.js`
  (`window.KCMPS_ORDERS`) are the *only* things any page touches — no page reads `localStorage`
  or calls `fetch()` directly. Every new feature must extend one of these seams, never bypass it.
  New dashboard collections get **backfilled** via the existing `ensureCollections()` pattern —
  never bump the storage key (that wipes every tester's in-progress mock state).
- **Data model conventions:** money as integer centavos, soft-delete only (never hard-delete),
  `tenantId`/`schemaVersion` stamping via `backend/lib/item.js`'s `baseItem()`, immutable
  `EVENT#` audit log via `backend/lib/events.js`, GSI1 sparse-status-index hygiene maintained by
  `streams-handler.js`. Any new Lambda should be written against `backend/lib/` conventions the
  way `backend/checkout/*` and `backend/staff-api/*` already are — never hand-roll keys/status
  inline the way the old `ops-dashboard/infra/logic-inputs/*.js` drafts did.
- **No new AWS services without a cost note.** See §6 — this repo has an active, explicit
  cost-governance discipline, not an implicit "keep it cheap" vibe. Match that rigor.
- **Cognito pool v2 is fragile in specific, documented ways** (frozen required attributes,
  `AliasAttributes` not `UsernameAttributes`, `sub`-as-foreign-key trap on any future pool move).
  Read `backend/infra/README.md`'s "User pool v2" section before any task touches auth.
- **Uploads share one bucket across four prefixes** (`design-uploads/`, `payments/`, `messages/`,
  `correspondence/`) with GuardDuty malware scanning across all of them and fail-closed read
  paths (no verdict yet = no download link). Any new upload surface (e.g. Design Library
  originals) should follow this exact pattern, including a standalone `SCAN#<ref>` verdict
  fallback for the "scanned before there's a parent record to annotate" race that was already
  found and fixed once elsewhere in this repo — don't let a new track rediscover it.
- **Never let two parallel tracks touch the same file without a stated merge order.**
  `store.js`, `dashboard-data.js`, and the root `CLAUDE.md` are the most likely collision points
  across Tracks A–E — see §8.

---

## 5. Design & conversion directive

**Principle ranking, in order: conversion first, then mobile experience, then aesthetics —
aesthetics still matters, it's just the tiebreaker, not the goal.** Most KCMPS customers are on
mobile; optimize mobile first, then adapt up to desktop, not the reverse.

- Apply Apple-style interface design principles (fluid/physical motion, restraint, spatial
  consistency, clear feedback, careful typography, momentum/interruptible transitions,
  `prefers-reduced-motion` support) to every frontend task in Track E. This repo has an
  `apple-design` skill and an `emil-design-eng` skill available in this environment's skill
  library — any executing session touching frontend polish should be told to invoke them, not
  reinvent this guidance from scratch.
- **Radical changes are allowed, but only when justified by real research or live external
  examples showing a conversion lift** — not aesthetic preference, yours or the executing
  model's. Any task prompt proposing a significant UX/flow change must require the executing
  session to cite what it's basing the change on (competitor pattern, published UX research,
  A/B test data if any exists) before implementing, and must flag it in your final "requires
  approval" callout rather than treating it as pre-approved.
- **Architecture flexibility, decided by the owner:** the site's current hard constraint is
  static HTML/vanilla JS/Tailwind-CDN, zero build step, `website/` synced verbatim to S3. The
  owner is open to introducing a build step or lightweight framework **if and only if**: (a) your
  research shows a real, cited conversion case for it, (b) you include a concrete migration plan
  (not just "and then we add Vite"), and (c) the added recurring cost stays as close to free as
  possible — target under **₱1,500/mo** for any new tooling this would require, though the owner
  will consider going over that if the justification is strong. **This is an owner-approval
  decision, not something any task prompt should execute unilaterally** — put it in your
  separate callout list with the research citation attached, don't bury a build-step migration
  inside an otherwise-normal frontend task.
- Any frontend task prompt in Track E should default to working within the existing static/
  vanilla-JS model unless it's the one flagged, owner-approved exception above.

---

## 6. Model and reasoning-effort assignment (optimize for lowest cost that meets the bar — this matters, token budget is real)

Default every task to the **cheapest model and lowest effort that can meet its acceptance
criteria**, and only escalate when the task genuinely requires it. Use this as your rubric, not
a rigid rule — adjust per task where you have a clear reason to:

- **Haiku 4.5 (low effort):** mechanical, low-ambiguity work — the stale-worktree prune, legal
  page content drafting from a template/outline you provide, straightforward copy/content fills,
  simple IAM/CFN boilerplate that mirrors an existing stack 1:1, a Lambda that's a near-exact
  structural copy of an existing one in the same directory (e.g. a new route following
  `backend/checkout/*`'s established shape almost verbatim).
- **Sonnet 5 (default, mid effort):** the bulk of implementation work — new Lambdas written
  against `backend/lib/` conventions, dashboard-page wiring behind the existing seams, most bug
  fixes (including the two unhandled-exception fixes, once you hand over the exact reference
  pattern from `cancel-order.js`), frontend components/pages that follow an existing pattern in
  the repo, most of Track B and Track D.
- **Opus 5 (high effort, use sparingly):** anything touching Cognito/auth semantics, anything
  crossing or modifying one of the three seam files (`store.js`/`dashboard-data.js`/
  `orders-data.js`) in a way that isn't purely additive, the conversion-research-backed UX
  decisions in Track E, security-sensitive validation logic (upload type/size checks, IAM policy
  scoping, the guest-lookup contact-match auth logic), and the final integration/consistency/
  security review pass (§9's Task Z).
- State your reasoning for each assignment in the task table — one line is enough ("mirrors
  `cancel-order.js` almost exactly → Sonnet, mid effort" / "touches the pool's group model →
  Opus, high effort").

---

## 7. Missing-feature discovery (actively hunt for these, don't just wait for them to be requested)

Beyond the tracks in §3, audit the live repo for genuine production-launch gaps and add findings
to the plan (as their own small tasks, appropriately model-assigned) rather than skipping them
for lack of an explicit ask:

- Basic SEO hygiene (`robots.txt`, `sitemap.xml`, canonical tags — `og-image`/meta tags already
  exist per `CLAUDE.md`, verify the rest).
- Accessibility basics (WCAG-level contrast/focus-state/alt-text spot-check on the storefront and
  dashboard — don't do a full audit, a targeted pass is enough for this stage).
- Conversion/analytics instrumentation (is there any way today to know if a design change
  actually helped? If not, this is worth a minimal, near-free addition — note the cost per §6's
  cap).
- Uptime/error monitoring for the Lambdas and the site (CloudWatch alarms exist for logs per
  `cost-governance.md`'s retention entry — check if anything actually *alerts* anyone).
- Rate limiting / abuse protection on the public, unauthenticated routes (`create-order`,
  `submit-payment-proof`, `lookup-order`, `upload-design-file`) — some have throttling already
  per the roadmap notes, confirm consistency across all of them.
- `disaster-recovery/`'s actual applied-vs-planned status (flagged in §2) — a real answer to
  "if the DynamoDB table or S3 bucket were lost today, what actually happens" belongs in a
  production-readiness plan.
- Anything else the ERP north-star document (`project_knowledge/ERP_System_Project_Knowledge.md`)
  flags as a **launch-blocking convention** rather than a future-phase feature — re-read its Part
  0/§2.3 framing to be sure nothing genuinely foundational is being skipped versus correctly
  deferred.

Bias toward *flagging with a small, clearly-scoped task* rather than either ignoring these or
turning any one of them into a large build — match the repo's existing "build only when a real
trigger exists" discipline.

---

## 8. Sequencing and parallelization

Produce an explicit dependency graph, not just an ordered list. Use git worktrees
(`.claude/worktrees/<slug>`, this repo's established pattern) for genuinely independent tracks.
As a starting hypothesis to verify against the live repo:

- **Parallel-safe candidates** (disjoint files, can run in separate worktrees/sessions
  simultaneously): Track B (Design Library backend — new files + isolated `store.js` diff),
  Track C (SES relay — new files + isolated `email.html`/`dashboard-data.js` diff), Track D
  (legal pages — entirely new files), the stale-worktree prune, the two unhandled-exception bug
  fixes (isolated to their own Lambda files).
- **Likely sequential / needs a stated merge order:** anything that touches `store.js` (Track B's
  manifest-merge change) or `dashboard-data.js` (Track B's design-library wiring, Track C's email
  wiring, any Track A dashboard fix) should be sequenced so these land as separate, reviewable
  diffs rather than concurrent edits to the same file across worktrees — state which track "owns"
  each shared file first, and have the others rebase after.
- **Legacy Cognito group retirement** should be sequenced after (not parallel with) anything
  touching `dashboard-shell.js`'s auth checks, since it changes what that file gates on.
- **The final integration/verification pass (Task Z, see §9) is always last**, after every
  parallel track has merged to `main`, never running concurrently with any other task.

For each task in your master table, state its parallel-group (or "sequential, after X").

---

## 9. Required final task — verification, not optional

The last item in your master task list must be an integration/consistency/security review pass,
assigned Opus/high-effort, that:
- Re-reads every seam file (`store.js`, `dashboard-data.js`, `orders-data.js`) end-to-end for
  drift introduced by the parallel tracks.
- Runs the repo's existing test suite (`node --test backend/lib/*.test.js`) plus any new tests added by
  the tracks above.
- Invokes this environment's `security-review` skill against the accumulated diff before any
  staging sync.
- Confirms every new upload surface (if Track B added one) follows the fail-closed
  GuardDuty-verdict pattern.
- Produces the staging deploy commands (dev.kcmps.com / kcmps-backend-staging) as its last step,
  explicitly stopping there and stating that production promotion requires the owner's separate,
  explicit go-ahead — never bundled into the same task.

---

## 10. Extensibility requirement

For every new feature in your plan, state in one line which existing seam/module it extends
(`KCMPS_STORE` / `KCMPS_DASH` / `KCMPS_ORDERS` / `backend/lib/` conventions / the existing HTTP
API Gateway) and how a plausible *future* feature could extend it further without a rewrite —
this repo's whole architecture is built around additive extension (see `ensureCollections()`,
the manifest-merge pattern, the GSI2-prepared-but-not-provisioned message schema), and your plan
should keep that property, not quietly introduce a second, parallel way of doing something the
repo already has one way of doing.

---

## 11. What NOT to do

- Do not write implementation code in your output, only inside task prompts as instructions to
  the executing model.
- Do not edit any repo file, run any command, or deploy anything yourself.
- Do not silently expand scope beyond §3 + your §7 discovery findings — flag, don't build.
- Do not treat the ₱1,500/mo build-step ceiling in §5 as pre-approved — it's a ceiling *for the
  owner's later approval decision*, not a budget you should spend down by default.
- Do not skip the staging-first gate in any task prompt, even ones that feel low-risk.
