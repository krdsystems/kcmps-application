# CI/CD Pipeline — context + instruction prompt for a Fable 5 planning session

Written 2026-08-08 by a Claude Code session that scanned the repo and queried live AWS
(`kcmps-claude-ro`, account `600929977538`, `ap-southeast-1`). Everything below marked
**[verified]** was read from the repo or returned by an AWS API call in that session;
everything marked **[from docs]** was read out of `CLAUDE.md` / `backend/infra/README.md`
and not independently re-verified against AWS.

---

## YOUR TASK (read this first)

You are planning a **CI/CD pipeline** for KCMPS. Deliverable is a **plan document**, not
code — no files created, no AWS calls that mutate anything, no deploys. Produce:

1. A recommended pipeline architecture (which runner, which triggers, which stages, which
   environments, what gates human approval) with the reasoning made explicit, and an
   honest statement of what it costs per month against the ₱500/mo soft cap.
2. A phased implementation plan — what to build first so the pipeline is useful before it
   is complete, and what can wait. Assume a solo owner with limited AI credits and no
   platform team.
3. A security section: the identity model for the pipeline (see "Deploy identity" below —
   this is the single biggest open design question), secret handling, blast-radius
   containment, and what the pipeline must refuse to do.
4. An explicit mapping of every **existing manual rule** in this repo onto either
   "enforced by the pipeline", "still human-enforced and why", or "deliberately dropped".
   Do not silently drop one. The manual rules are listed in "Rules the pipeline must
   preserve" below; they were each written after a real production incident.
5. A migration/cutover story for the fact that **production Lambdas are CLI-managed and
   staging Lambdas are CloudFormation-managed** — this asymmetry is the central technical
   obstacle and any pipeline plan that ignores it is wrong.

**Ground rules for your plan:**
- Do not propose a bundler, a framework, a monorepo tool, or a `package.json` at the repo
  root for the frontend. `website/` has no build step by hard architectural constraint and
  the plan must not break that.
- Do not propose auto-deploying to production. The owner's staging-first rule is
  deliberate and incident-derived. The pipeline may *automate the mechanics* of a
  production deploy but the *trigger* stays human.
- Prefer boring and cheap. GitHub Actions on a public-ish private repo, AWS-native, or a
  hybrid — argue for one, don't survey all three at length.
- Where you are uncertain about live state, say so and name the exact command that would
  settle it, rather than assuming.

---

## 1. What this project is

Manila print/merch shop. Static marketing site + storefront + staff ops dashboard, plus a
serverless backend. Solo owner (Kenneth Dungca), no team, no platform engineer, no CI today.

Repo: `https://github.com/krdsystems/kcmps-application.git`, default branch `main`. **[verified]**

273 tracked files. **[verified]** Top-level layout:

| Folder | Deployed? | What it is |
|---|---|---|
| `website/` (89 files) | **YES** — synced verbatim to S3, no build step | storefront + `website/dashboard/` staff ops UI. Vanilla HTML/ES6/hand-written CSS. No npm, no bundler, no `package.json`. Edits are live on refresh. |
| `backend/` (72 files) | YES — as Lambdas, packaged per-function | `checkout/`, `staff-api/`, `jobs/`, `mail/`, `asset-library/`, `auth/`, shared `lib/`, and `infra/*.cfn.yaml` |
| `design-system/`, `ops-dashboard/`, `storefront-infra/`, `disaster-recovery/`, `docs/`, `project_knowledge/` | NO | planning/reference/IaC-source only |

**Hard constraint:** only `website/` is deployed to the site bucket. A dev-only file placed
inside `website/` goes live. Any pipeline must preserve that boundary and ideally *enforce*
it (a check that no `.md`/`.test.js`/`node_modules` lands in `website/` would be new value).

---

## 2. Live AWS state **[verified 2026-08-08 via `kcmps-claude-ro`]**

Account `600929977538`, region `ap-southeast-1` for everything below.

### CloudFormation stacks (5)
```
kcmps-foundation           (prod DynamoDB table `kcmps` + GSI1 + Streams + PITR)
kcmps-foundation-staging   (TableName=kcmps-staging)
kcmps-backend-staging      (ALL staging Lambdas + HTTP API + authorizer + routes + rules)
kcmps-user-pool-v2         (Cognito pool ap-southeast-1_LHJsFdCgo, shared prod+staging)
kcmps-observability        (SNS topic, shared DLQ, 37 CloudWatch alarms)
```
Note what is **absent**: there is no `kcmps-backend` production stack. Production's Lambdas,
API routes, IAM roles and EventBridge rules were all created by hand via CLI.

### Lambda functions
- **25 production functions**, all `nodejs24.x`, all **CLI-managed, not in any stack.**
- **29 staging functions** (`kcmps-staging-*`), all `nodejs24.x`, all managed by
  `kcmps-backend-staging`.

**Staging is ahead of production by 4 functions** — `kcmps-staging-create-manual-order`,
`kcmps-staging-dashboard-prefs`, `kcmps-staging-set-order-tags`, `kcmps-staging-staff-pin`.
Their source (`backend/staff-api/create-manual-order.js`, `dashboard-prefs.js`,
`set-order-tags.js`, `staff-pin.js`, plus `backend/lib/pin.js` and `backend/lib/tags.js`)
**is already merged into `main`** but has never been promoted to production. **[verified]**
This is exactly the drift a pipeline exists to make visible; treat it as a live example, not
a hypothetical.

### API Gateway (HTTP APIs)
```
6msg2uho6c  kcmps-checkout-api          https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com
162ufc121j  kcmps-checkout-api-staging  https://162ufc121j.execute-api.ap-southeast-1.amazonaws.com
```

### S3 buckets (7)
```
kcmps-online-bucket-est-2026     site bucket. Root = production. `dev-site/` prefix = staging.
                                 ALSO holds pre-existing content outside this repo's control
                                 (a root README.md, an `Assets/` folder) — this is why no
                                 sync ever uses --delete.
kcmps-payment-uploads-est-2026   prod uploads (payments/, messages/, correspondence/, design-uploads/)
kcmps-payment-uploads-staging    staging equivalent
kcmps-design-originals-est-2026  prod asset-library originals (private)
kcmps-design-originals-staging   staging equivalent
kcmps-inbound-mail-est-2026      SES inbound raw mail (shared by both envs — only one real mailbox)
kcmps-lambda-artifacts-staging   Lambda deployment zips. STAGING ONLY — there is no
                                 production artifacts bucket. Production zips are uploaded
                                 straight from a laptop via `update-function-code --zip-file`.
```
Artifact prefixes are hand-named per deploy, e.g. `staging-reconcile-2026-08-08`,
`mail-thread-attach-2026-08-08`, `node20-eol-migration-2026-08-05`. **[verified]** The
stack's `ArtifactsPrefix` parameter is **stack-wide**: every function reads its zip from
that one prefix, so a partial deploy must first copy all unchanged zips forward into the
new prefix or CloudFormation fails on missing objects. **[from docs, backend/infra/README.md]**

### CloudFront
```
EY6Q5RSWLDCEF  kcmps.com / www.kcmps.com / site.kcmps.com   (production)
E7PDB5JQRZX0E  dev.kcmps.com                                (staging, CloudFront-Function basic auth)
```
Both use the `CachingDisabled` policy — a sync is live at the CDN immediately, no
invalidation step. `site.kcmps.com` 301s to `https://kcmps.com` via a CloudFront Function.

### DNS — CROSS-ACCOUNT, and off-limits
The real hosted zone is `Z06397161LBTJCRTPLL62` in a **different account, `260866268499`**
(`default` profile). Account `600929977538` has a decoy `kcmps.com` zone with only NS/SOA —
never delegate to it. **There is a standing owner rule that no agent touches Route 53 in
`260866268499`**; hand the owner exact steps instead. If the pipeline plan needs a DNS
record (ACM validation, a new subdomain), it must surface that as an owner manual step.

### IAM — read this carefully, it drives the security section
```
IAM users:  kcmps-claude-privileged  (profile kcmps-claude-priv — the deploy identity today)
            kcmps-claude-ro          (profile kcmps-claude-ro  — read-only)
OIDC providers: NONE.  aws iam list-open-id-connect-providers returns [].
```
**[verified]** So today, every deploy is a long-lived IAM access key on the owner's laptop,
and there is **no GitHub→AWS OIDC trust configured at all**. Setting one up
(`token.actions.githubusercontent.com`, a role with a `sub` condition scoped to
`repo:krdsystems/kcmps-application:ref:refs/heads/main` or an `environment:` claim) is
net-new work your plan must specify precisely, including the trust policy conditions —
getting the `sub` condition wrong is the classic way this becomes an any-repo-can-deploy
hole.

Lambda execution roles (7 prod-named + 6 staging-named) are per-module and least-privilege:
`kcmps-checkout-lambda-role`, `kcmps-staff-api-lambda-role`, `kcmps-jobs-lambda-role`,
`kcmps-mail-lambda-role`, `kcmps-design-library-lambda-role`,
`kcmps-post-confirmation-lambda-role`, `kcmps-guardduty-malware-s3`. **[verified]** The
design-library role holds the only grant in the account that copies an object from the
private originals bucket into the **public site bucket** — scoped to `designs/*` source and
a `PublicAssetsKeyPrefix*` destination. Blast radius matters here.

### EventBridge rules **[verified]**
```
kcmps-expire-pending-orders-schedule / kcmps-staging-...
kcmps-notify-unread-messages-schedule / kcmps-staging-...
kcmps-purge-archived-designs-schedule / kcmps-staging-...   (15-min cron, ONLY hard-delete path)
kcmps-guardduty-scan-result / kcmps-staging-...             (filtered on bucketName — see below)
kcmps-guardduty-design-originals-scan-result / kcmps-staging-...
+ 4 DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3-* (managed by GuardDuty)
```
The GuardDuty rules **must keep their `detail.s3ObjectDetails.bucketName` filter** — the
account has one event bus and an unfiltered rule matched *both* environments, which once
wrote production scan verdicts into the staging table.

---

## 3. How deploys work today (the manual process the pipeline replaces)

### Frontend **[from CLAUDE.md, authoritative]**
```bash
# 1. Stage
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ \
  --cache-control "no-cache, must-revalidate" --profile kcmps-claude-priv
# 2. STOP. Report what changed and how it was verified on https://dev.kcmps.com.
#    Only after the owner explicitly says to promote:
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ \
  --cache-control "no-cache, must-revalidate" --profile kcmps-claude-priv
# 3. Mirror the same content back to dev-site/ so staging never falls behind prod.
```
Never `--delete`. Never `--metadata-directive REPLACE` (see incidents below).

### Backend **[from backend/infra/README.md]**
There is **no build script anywhere in the repo** — no Makefile, no `scripts/`, no
`npm run build`. **[verified: the only `.sh` in the repo is `docs/infra-audit-script.sh`]**
The zip build is a documented-by-prose, hand-run procedure:

1. `npm install` in `backend/<module>/` (each module has its own `package.json` +
   `package-lock.json`; `backend/*/node_modules/` is gitignored — vendoring is the build).
2. Assemble a per-function zip: the handler as `index.js`, **with its `require("../lib")`
   rewritten to `./lib`**, a flattened copy of `backend/lib/` minus `*.test.js`, any
   shared sibling module (`mail-parse.js`, `design-types.js`, `manifest.js`,
   `scan-verdict.js`, `approval.js`), and `node_modules/`. No Lambda layers, no bundler.
3. **Staging:** upload every zip to `s3://kcmps-lambda-artifacts-staging/<new-prefix>/`,
   then `aws cloudformation deploy --stack-name kcmps-backend-staging --template-file
   backend/infra/backend-lambdas.cfn.yaml --capabilities CAPABILITY_NAMED_IAM
   --parameter-overrides TableStreamArn=... ArtifactsPrefix=<new-prefix>`.
4. Exercise it for real on `dev.kcmps.com`, then **stop and report**.
5. **Production:** only on explicit owner go-ahead, and by a *different mechanism* —
   `aws lambda update-function-code --function-name kcmps-<fn> --zip-file fileb://<fn>.zip`.
   A runtime bump is a different command again (`update-function-configuration --runtime`,
   which `update-function-code` never touches).

That step-3-vs-step-5 asymmetry is the crux. Any real pipeline has to either (a) bring
production under `backend-lambdas.cfn.yaml` as a second stack — a genuine, risky migration
against 25 live functions with hand-built roles/routes — or (b) keep two deploy paths and
make the pipeline honest about it. Argue for one; do not hand-wave it.

Staging stack parameters as currently deployed **[verified]**:
```
EnvName=staging  Runtime=nodejs24.x  TableName=kcmps-staging
TableStreamArn=arn:aws:dynamodb:ap-southeast-1:600929977538:table/kcmps-staging/stream/2026-08-05T08:58:42.425
UploadsBucket=kcmps-payment-uploads-staging   DesignOriginalsBucket=kcmps-design-originals-staging
InboundMailBucket=kcmps-inbound-mail-est-2026 ArtifactsBucket=kcmps-lambda-artifacts-staging
ArtifactsPrefix=staging-reconcile-2026-08-08
PublicAssetsBucket=kcmps-online-bucket-est-2026
PublicAssetsKeyPrefix=dev-site/assets/designs/   PublicAssetsPath=assets/designs/
CognitoUserPoolId=ap-southeast-1_LHJsFdCgo  CognitoClientId=2rsbhkjooja4h5e0ijpl4siuug
SesSenderIdentity=kcmps.com  SesConfigurationSet=my-first-configuration-set
MailAllowedRecipients=admin+admin.kcmps.uat@kcmps.com   ExpectedForwarderHost=(empty)
```

---

## 4. Testing — what exists **[verified]**

Four test files, all `node --test`, no framework, no config, no coverage tool, no linter,
no formatter, no type checking, no pre-commit hook:
```
backend/lib/lib.test.js
backend/lib/business-hours.test.js
backend/asset-library/approval.test.js
backend/asset-library/design-types.test.js
```
Local Node is **v22.23.2 / npm 10.9.8**; Lambda runtime is **nodejs24.x** — a version skew
the pipeline should probably close by pinning the CI runner to Node 24.

**Critical, non-obvious testing trap (do not get this wrong in the plan):**
`node --test backend/lib/` — the **directory** form — is a **false green in this repo**. It
reports `ok 1 - backend/lib` / `# tests 1` and **exits 0 even when a test fails** (verified
in-repo 2026-08-06 with a deliberately-failing probe). Only the **glob** form
`node --test backend/lib/*.test.js` reports the real count and exits non-zero. Any CI step
that runs the directory form is a test stage that can never fail. `backend/CLAUDE.md` says
this explicitly.

There are **zero** frontend tests, zero integration tests, and zero smoke tests against a
deployed environment. Post-deploy verification today is "a human clicks through
dev.kcmps.com". Your plan should say what minimum automated verification is worth adding
(a `curl` of a few API routes? a headless page load asserting no console errors? a
`head-object` header check after each sync?) and what is not worth it yet.

---

## 5. Rules the pipeline MUST preserve — each written after a real incident

Every one of these is in `CLAUDE.md`. Map each to enforced / still-human / dropped.

1. **Staging first, production only on explicit human go-ahead.** Never both in one turn.
   Approval is never inferred from "looks good" or silence.
2. **A production push mirrors back to staging in the same turn.** (2026-08-08: an
   unrelated full `dev-site/` sync from a stale worktree branch silently reverted staging
   *behind* production; the gap was only found days later when the owner asked what was on
   staging that wasn't in prod. Direction of drift was backwards from every other failure
   mode, which is why it went unnoticed.) A pipeline that deploys per-branch from worktrees
   can reproduce this exact bug — address it.
3. **NEVER `aws s3 cp --metadata-directive REPLACE`.** It discards every header you don't
   re-specify, including `Content-Type`; objects come back `binary/octet-stream` and
   browsers *download* `.html` instead of rendering. This took `dev.kcmps.com` down on
   2026-08-08 while S3 reported success and the CLI exit code was 0. The fix is always to
   re-run `aws s3 sync` from `website/`, which derives `Content-Type` from the extension.
   Detection: `aws s3api head-object ... --query '[ContentType,CacheControl]'`.
4. **Never `--delete` on a site sync** — the bucket holds content outside this repo.
5. **`--cache-control "no-cache, must-revalidate"` on every site sync.** Without it a warm
   browser cache makes a shipped fix look undeployed, invisibly from the S3/CloudFront side.
6. **Email/SES is live production mail.** Test sends go to **exactly four owner-owned
   addresses** and no others; a made-up address is not harmless, it is a guaranteed bounce,
   and AWS warns at ~5% / suspends near 10% — suspension silently kills every customer
   order notification. On 2026-08-06 a contradictory task brief caused a real bounce that
   pushed the 24h rate to ~10%. **Never design a test whose success condition is a bounce or
   a rejected send** — prove negative cases by inspecting configuration
   (`describe-active-receipt-rule-set`, `get-email-identity`) or by invoking a Lambda with a
   synthetic event. Staging is SES-dark by construction (`FROM_EMAIL`/`SES_SENDER` unset) and
   additionally allowlist-enforced; **production deliberately leaves `MAIL_ALLOWED_RECIPIENTS`
   UNSET and must stay that way** (staff reply to real customers through it), so in
   production the guardrail is *only* the human. A CI job that can invoke a production mail
   Lambda is a CI job that can bounce mail — say how you contain that.
7. **Never `git add -A`** — stage by explicit path; verify `git status --short` before
   commit and `git show --stat` before push.
8. **Nothing dev-only inside `website/`** — it would go live.
9. **Cost is a real constraint.** Soft cap ₱500/mo (~US$9) pre-revenue, rising to
   `max(₱500, 3% of trailing-30-day gross)`. Going over is allowed but must be stated and
   justified, never shipped silently. Full baseline in `docs/cost-governance.md`. Staging's
   whole backend runs at ~₱3/mo. State your pipeline's monthly cost explicitly.
10. **CSP `connect-src` must be updated the moment a page starts fetching a new host** —
    a silent CSP block looks exactly like a dead feature. Every page listing the production
    API/uploads host must list the staging equivalents too. Ten `website/` pages carry a CSP
    meta tag today. A CI check that greps for `fetch(`/`API_BASE` hosts against each page's
    CSP would be genuinely new value.
11. **Environment routing is runtime, not build-time.** `website/store.js`,
    `website/orders-data.js` and `website/dashboard/dashboard-data.js` each branch on
    `location.hostname === "dev.kcmps.com"` to pick the staging API. There is no build-time
    substitution and the plan must not introduce one.

---

## 6. Branching / worktree reality **[verified]**

Feature work happens on `claude/<slug>` branches in git worktrees under
`.claude/worktrees/` (gitignored). Right now:
```
main                                 (checked out at repo root)
claude/asset-library-v2              6 ahead of main, 16 behind
claude/idle-pin-backend              0 ahead, 22 behind   (merged, worktree not pruned)
claude/mail-threading-attachments    0 ahead, 22 behind   (merged, not pruned)
claude/order-tags-mobile-nav         0 ahead, 20 behind   (merged, not pruned)
claude/staging-integration           0 ahead, 11 behind   (merged, not pruned)
claude/cicd-pipeline-context-fc571f  0 ahead, 13 behind   (this session)
```
Five stale worktrees are full repo copies inflating every glob/grep. There is **one** remote
feature branch (`origin/claude/lambda-nodejs-eol-migration-1e81be`) and **no PRs in the
workflow today** — merges are local fast-forwards then `git push origin main`.

This matters for your plan: if the pipeline keys off PRs, that is a *workflow change* for
the owner, not just config. Say so, and say whether it's worth it. A pipeline that deploys
staging from any `claude/*` branch will reproduce incident #2 above (last-writer-wins on the
shared `dev-site/` prefix) — there is exactly one staging environment and it is a shared
mutable resource.

---

## 7. Open questions you should answer (or explicitly defer)

- **Deploy identity.** GitHub OIDC role vs. keeping the IAM user's keys as repo secrets.
  If OIDC: give the exact trust policy, the `sub` conditions, and the permission boundary.
  If you propose separate `staging-deploy` and `production-deploy` roles, say what each can
  and cannot touch — remember `kcmps-design-library-lambda-role` writes to the public bucket.
- **Does production get a CloudFormation stack?** If yes: how do you import 25 existing
  CLI-created functions, their hand-built routes on `6msg2uho6c`, their IAM roles, and their
  EventBridge rules without a window where production is broken? (CloudFormation resource
  import exists but is fiddly and doesn't cover everything.) If no: what does the pipeline
  do for production instead, and how does drift stay visible?
- **The stack-wide `ArtifactsPrefix`.** Every function reads from one prefix, so any deploy
  must publish a complete set. Does CI rebuild all zips every time (simple, slower, immune
  to the carry-forward bug) or copy-forward-then-overwrite (fast, and the documented source
  of a real "deploy failed on missing objects" trap)?
- **Reproducible zips.** No lockfile-to-zip determinism today. Is `npm ci` + a fixed Node
  24 image enough, or does the plan want a checksum recorded per deploy so `CodeSha256`
  can be diffed against what's live?
- **Where does the four-lambda staging→production gap get resolved** — is closing it the
  pipeline's first real job, or a manual promotion done before the pipeline exists?
- **Rollback.** Today there is none beyond re-running an older zip / re-syncing older files.
  Lambda versions+aliases are unused. What's the cheapest credible rollback story?
- **Secrets.** `dev.kcmps.com` basic-auth credentials are not in the repo (password
  manager). Cognito IDs and API IDs are already public in `website/`. What actually needs to
  be a secret vs. just a variable?

---

## 8. Where to read more (don't read all of it — these are pointers)

| Topic | File |
|---|---|
| Project orientation, every hard rule, the deploy workflow verbatim | `CLAUDE.md` (root, ~71KB — the deploy sections are the relevant part) |
| Exact deploy commands, per-feature deploy history, IAM detail, staging architecture | `backend/infra/README.md` (1980 lines — use the heading list, don't read it all) |
| When to use staging vs skip it, the *why* behind the gate | `docs/claude-code-workflow.md` §"Deploying" (lines 108–182) |
| `lib/` conventions, the `node --test` false-green trap | `backend/CLAUDE.md` |
| Cost baseline + decision log | `docs/cost-governance.md` |
| What's next / priorities | `docs/roadmap.md` |
| Prior infra audits (findings may still be open) | `docs/infra-audit-2026-08-05.md`, `docs/infra-audit-2026-08-06.md`, `docs/infra-audit-script.sh` |
| DR templates (Terraform + CFN, separate track) | `disaster-recovery/` |
| Dev-domain CloudFront/basic-auth stack | `storefront-infra/dev-domain.cfn.yaml`, `storefront-infra/CLAUDE.md` |

Read-only AWS is available as profile `kcmps-claude-ro` (region `ap-southeast-1`). Use it to
verify anything above you intend to build on. **Do not use `kcmps-claude-priv`** — that is
the write identity and this is a planning task.
