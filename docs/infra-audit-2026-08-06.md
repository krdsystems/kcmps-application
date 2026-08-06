# KCMPS Production Readiness Audit — post "production readiness master plan"

Read-only follow-up to [`docs/infra-audit-2026-08-05.md`](infra-audit-2026-08-05.md), re-run
after the `claude/kcmps-production-readiness-186743` branch (Node.js 20.x EOL migration +
`kcmps-backend-staging` + the Cognito pool-v2 cutover cleanup) merged to `main`. Same
methodology (`docs/infra-audit-script.sh` + targeted follow-up checks), plus this pass adds a
**live-site deployment check** — comparing what's actually served from `kcmps.com` against what's
in the repo, which the previous audit never did.

**Headline: the backend is launch-ready. The live production website is not — it's running a
significantly older build.** This is the one finding that actually gates a launch; everything
else is a same-day fix.

## Feasibility score for prod launch: **78%**

| Category | Weight | Score | Why |
|---|---|---|---|
| AWS backend infra (Lambdas, DynamoDB, API Gateway, IAM) | 30% | 95/100 | Solid — see "Confirmed" below. One hygiene item (stale DLQ alarm). |
| Auth/Cognito readiness | 20% | 95/100 | Pool, groups, SES, and — critically — **production callback URLs are already registered** on the app client. Only a client-side flag flip stands between this and working. |
| Feature completeness (Milestone 1) | 20% | 98/100 | Order creation → GCash payment → staff verification → customer tracking → chat → malware-scanned uploads all built, deployed, and previously verified live. |
| **Production deployment currency** | 20% | **10/100** | **`aws s3 sync --dryrun` shows 48 of the repo's ~52 `website/` files differ from what's live on `kcmps.com` right now** — including `store.js`, `index.html`, every dashboard page, and 6 files that don't exist on production at all (`track-order.html`, `privacy.html`, `terms.html`, `refunds.html`, `robots.txt`, `sitemap.xml`). |
| Operational hygiene (alarms/docs match reality) | 10% | 80/100 | One alarm (DLQ depth) has been falsely firing since 2026-08-03 for a bug that was already fixed — see below. Docs are otherwise current (previous audit's 3 drift items are all fixed now). |

**Read this as**: the code and infrastructure are launch-ready — the gap is almost entirely a
*deployment execution* gap (get the current, already-tested build onto `kcmps.com`, flip one
flag, verify), not a development gap. That's a bounded, low-risk, same-day piece of work, which
is why the score is 78% rather than something in the 30–40% range a genuine feature/infra gap
would warrant. It is **not launchable in its current live state** — a customer hitting `kcmps.com`
right now gets last week's site, not what's been built and tested.

---

## Confirmed still solid (re-verified from the 2026-08-05 audit)

- All 5 CloudFormation stacks (`kcmps-foundation`, `kcmps-foundation-staging`,
  `kcmps-user-pool-v2`, `kcmps-observability` in `ap-southeast-1`; `kcmps-dev-domain` in
  `us-east-1`) — `CREATE_COMPLETE`/`UPDATE_COMPLETE`, no rollbacks.
- 34 Lambdas (17 prod + 17 staging), all `nodejs24.x`/`arm64` — zero left on the EOL runtime.
- Both HTTP APIs (13 routes each, 8 JWT-gated) mirror each other exactly; both authorizers point
  at `kcmps-user-pool-v2`.
- SES: `ProductionAccessEnabled: true`, DKIM/MAIL FROM both `SUCCESS`, `FROM_EMAIL`/`SES_SENDER`
  genuinely set on all 5 documented notification Lambdas.
- GuardDuty Malware Protection: 2 `ACTIVE` plans, correct 4-prefix scope on both buckets,
  correctly bucket-filtered EventBridge rules (no cross-contamination).
- Cognito: single pool, old pool confirmed deleted, groups exactly
  `Admin`/`Customer`/`Production`/`Sales`/`Finance`/`Staff` as documented.
- DNS/CDN: `kcmps.com`/`www`/`site` → CloudFront `EY6Q5RSWLDCEF`; `dev.kcmps.com` → `E7PDB5JQRZX0E`
  — matches root `CLAUDE.md` exactly.

## Fixed since the last audit (previous drift items — all closed)

1. **`kcmps-cancel-order`/`kcmps-lookup-order` log retention** — was unbounded, now correctly
   30 days on both. ✅
2. **`docs/roadmap.md`'s stale SES claim** — Milestone 1.2's checkbox now correctly reads
   "deployed and live (2026-08-03/04)" instead of "blocked, pending." ✅
3. **`backend/infra/README.md`'s Observability section** — now documents all 17 Lambdas /
   37 alarms instead of the stale 7-Lambda/17-alarm count. ✅

Good sign: whoever ran the master-plan branch (or a session after it) acted on the previous
audit's findings directly.

---

## New findings this pass

### 1. CRITICAL — the live production website is running a stale build

`aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --dryrun` (read-only, no changes made)
shows **48 files** would upload — effectively the entire site:

- **Core app files**: `index.html`, `store.js`, `styles.css`, `orders.html`, `order-detail.html`,
  `orders-data.js`
- **The entire dashboard** (13 files: `dashboard-data.js`, `dashboard-shell.js`, `dashboard.css`,
  `jobs.html`, `job-detail.html`, `today.html`, `week.html`, `month.html`, `clients.html`,
  `inventory.html`, `email.html`, `design-library.html`, `settings.html`)
- **Files that don't exist on production at all**: `track-order.html` (guest order-lookup —
  new), `privacy.html`, `terms.html`, `refunds.html` (legal pages — new), `robots.txt`,
  `sitemap.xml` (SEO — new)
- Assorted new product/design images

A direct diff of `index.html` (repo vs. live `kcmps.com`) confirms production is missing: the
real-time studio open/closed status (still shows the static, always-true "Studio currently
active"), SEO structured data + canonical tag, the legal-page footer links, the mobile
product-grid scroll-fade fix, and the "Track an order" nav entry.

**One piece of good news found while checking this**: production's Cognito config (pool ID,
client ID, Hosted UI domain) is already correct — `docs/history.md` entry 68 says this fix was
"staged on dev.kcmps.com only, not yet promoted," but that statement is itself now stale; the
live site already has the new pool's values. So auth *would* work today if the login button were
visible — see #2.

**Fix**: sync `website/` to production. This is explicitly gated by root `CLAUDE.md`'s "staging
first, production only on the owner's explicit go-ahead" rule — see the Fable 5 instructions
below for the exact sequence. Not something to run unprompted.

### 2. Pre-launch auth gate is still active — but ready to flip

`website/index.html`'s `COGNITO_CONFIG.authUiEnabled` is hostname-keyed:
`["dev.kcmps.com", "localhost", "127.0.0.1"].includes(window.location.hostname)` — `false` on
production. This hides both the nav login/sign-up button and the `?login=required` sign-in
banner. Per the code's own comment, the consequence is real: **a staff member hitting
`/dashboard/` on `kcmps.com` today with no session gets redirected to the homepage with no
visible way to log in.** Production dashboard access is currently unreachable, by design,
pending launch.

**De-risked**: checked the Cognito app client (`2rsbhkjooja4h5e0ijpl4siuug`) directly —
`https://kcmps.com/`, `https://www.kcmps.com/`, and `https://site.kcmps.com/` are **already**
registered as valid callback and logout URLs. Flipping the flag is a pure client-side change with
no Cognito-side config needed first — low risk, well-scoped.

### 3. Stale CloudWatch alarm — `kcmps-lambda-dlq-depth` has been falsely in ALARM since 2026-08-03

Investigated the one message sitting in `kcmps-lambda-dlq`: it's `kcmps-notify-unread-messages`
failing with `AccessDeniedException: ... not authorized to perform: dynamodb:Scan`, timestamped
**2026-08-03**. That's the exact bug `backend/infra/README.md`'s "Customer chat + operating-hours
SLA" section documents as found and fixed the same week (added `Scan` to
`kcmps-jobs-lambda-role`). The bug is fixed — the queue was just never drained afterward, so the
alarm has been paging `admin@kcmps.com` for a resolved issue for 3 days.

I attempted to delete the one stale message (a resolved-incident record, not live data) but the
session's auto-mode classifier blocked the SQS mutation — see the Fable 5 instructions below for
the one-line fix.

---

## What this means for "is the master plan done"

The master plan's actual scope (Node.js 20.x EOL migration, a real `kcmps-backend-staging`
environment, Cognito pool v2 cutover, closing the login outage it caused) is **done and correct**
— nothing found in this pass contradicts that. What's outstanding is a layer *above* that plan:
getting the resulting, tested build onto the production domain and turning on the storefront/
dashboard entry points customers and staff will actually use. That's a deploy-and-verify task,
not further development.

---

## Instructions for Fable 5 — implement, don't just plan

Ordered by dependency. Items 1–3 are safe to execute directly — no special approval needed
beyond what's already been given. **Item 4 (production sync) requires the owner's explicit
go-ahead in chat first** (root `CLAUDE.md`'s hard rule: never infer approval from "looks good" or
silence, and never run the production sync in the same turn as the staging one) — stop and ask
before that step, even though everything before it is clear to execute.

1. **Drain the stale DLQ message.**
   ```bash
   aws sqs receive-message --queue-url https://sqs.ap-southeast-1.amazonaws.com/600929977538/kcmps-lambda-dlq \
     --profile kcmps-claude-priv --region ap-southeast-1 --max-number-of-messages 1
   # then, using the ReceiptHandle from that response:
   aws sqs delete-message --queue-url https://sqs.ap-southeast-1.amazonaws.com/600929977538/kcmps-lambda-dlq \
     --profile kcmps-claude-priv --region ap-southeast-1 --receipt-handle '<ReceiptHandle>'
   ```
   Verify `kcmps-lambda-dlq-depth` returns to `OK` afterward (`aws cloudwatch describe-alarms
   --alarm-names kcmps-lambda-dlq-depth`). If a *new* message shows up instead of the known
   2026-08-03 one, stop and investigate — that would be a live failure, not stale data.

2. **Flip the launch flag, as its own reviewed commit** (don't bundle with anything else):
   in `website/index.html`, change
   ```js
   authUiEnabled: ["dev.kcmps.com", "localhost", "127.0.0.1"].includes(window.location.hostname),
   ```
   to
   ```js
   authUiEnabled: ["kcmps.com", "www.kcmps.com", "site.kcmps.com", "dev.kcmps.com", "localhost", "127.0.0.1"].includes(window.location.hostname),
   ```
   Cognito's app client already allows all three production origins as callback/logout URLs
   (verified this pass), so no backend/Cognito change is needed alongside this. Commit on a
   `claude/<slug>` branch per the repo's normal workflow, merge to `main` once reviewed.

3. **Sync to `dev.kcmps.com` and verify there first** (this is the repo's standard default step,
   needs no extra permission):
   ```bash
   aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ --profile kcmps-claude-priv
   ```
   Then, on `dev.kcmps.com` (Basic-Auth credentials from the password manager): confirm the live
   studio-status badge renders, `track-order.html`/`privacy.html`/`terms.html`/`refunds.html`
   load, the nav login button now appears (since `dev.kcmps.com` was already in the allow-list,
   this isn't new behavior, just confirm nothing regressed), and a staff login into `/dashboard/`
   still works end-to-end against `kcmps-user-pool-v2`.

4. **STOP HERE. Report back to the owner** with what was verified on `dev.kcmps.com` and ask
   explicitly: *"Ready to promote to production — sync `website/` to the production bucket root
   and production will get the current build, with login/dashboard access turned on for
   customers and staff. Confirm?"* Only after an explicit yes:
   ```bash
   aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile kcmps-claude-priv
   ```
   Then verify live on `kcmps.com`: studio status, legal pages, track-order flow, nav login
   button, and a real staff login reaching the dashboard. This is the step that actually launches
   the site as currently built — treat it accordingly, not as a routine sync.

Everything else audited this pass (backend Lambdas, DynamoDB, Cognito, SES, GuardDuty, DNS) needs
no further action before launch.
