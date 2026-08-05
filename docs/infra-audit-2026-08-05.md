# Infra audit — 2026-08-05

Read-only AWS CLI audit (`docs/infra-audit-script.sh`, `kcmps-claude-priv`/`default` profiles,
`ap-southeast-1` + manual `us-east-1`/global checks) compared against the four docs listed in
the audit request. No resources were created, modified, or deleted.

**Headline: drift is minor.** Everything AWS-side matches the docs almost exactly — the stack
list, Lambda runtimes, Cognito groups, API routes, GuardDuty coverage, DNS/CDN routing, S3
lifecycle/CORS rules all check out byte-for-byte against what the docs claim. The only real
findings are (1) `docs/roadmap.md` has gone stale on SES status — it still says sandboxed/unset
when SES has actually been live since 2026-08-03/04 — and (2) two production Lambdas are
missing the log-retention policy the repo's own convention requires.

---

## Confirmed live and matching docs

- **CloudFormation stacks** — `kcmps-foundation` (CREATE_COMPLETE), `kcmps-foundation-staging`
  (CREATE_COMPLETE), `kcmps-user-pool-v2` (UPDATE_COMPLETE), `kcmps-observability`
  (UPDATE_COMPLETE), all in `ap-southeast-1`. `kcmps-dev-domain` (UPDATE_COMPLETE) confirmed in
  `us-east-1` — **the audit script only queries `ap-southeast-1`, so this stack is invisible to
  it**; I checked it manually against `storefront-infra/CLAUDE.md`'s claim that it lives in
  `us-east-1` for the ACM cert. No `ROLLBACK_COMPLETE`/orphaned stacks anywhere.
- **DynamoDB** — `kcmps` (prod): `ACTIVE`, Streams `NEW_AND_OLD_IMAGES`, GSI1 present, **PITR
  enabled** (35-day recovery window), deletion protection `true`. `kcmps-staging`: same shape,
  **PITR disabled** — exactly matches `backend/infra/README.md`'s "What staging deliberately
  doesn't have: PITR."
- **Lambda runtimes** — all **34 functions** (17 production + 17 staging, 1:1 name-mirrored) are
  `nodejs24.x`/`arm64`. Zero functions left on `nodejs20.x`. Matches the EOL migration claim
  exactly (see Q5 below).
- **API Gateway** — production (`6msg2uho6c`) and staging (`162ufc121j`) HTTP APIs each have
  exactly **13 routes**, byte-identical route sets, each with **8** JWT-authorizer-gated routes.
  Both authorizers (`kcmps-cognito-jwt` / `kcmps-cognito-jwt-staging`) verified live to point at
  audience `2rsbhkjooja4h5e0ijpl4siuug` / issuer `ap-southeast-1_LHJsFdCgo` — the new pool v2,
  not the deleted old pool. `kcmps-create-order`/`kcmps-cancel-order` (prod and staging) all have
  `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` env vars pointed at the new pool — the two Lambdas
  the README specifically flags as needing a *separate* update from the authorizer.
- **Cognito** — exactly one pool (`ap-southeast-1_LHJsFdCgo`); the old pool
  (`ap-southeast-1_iDvAEumNp`) is confirmed gone. `DeletionProtection: ACTIVE`. Groups: `Admin`,
  `Customer`, `Production`, `Sales`, `Finance`, `Staff` (+ the auto-managed
  `..._Google` federation group) — see Q3 below.
- **SES** — `ProductionAccessEnabled: true`, 50,000/day quota, `kcmps.com` DKIM `SUCCESS`, MAIL
  FROM (`mail.kcmps.com`) `SUCCESS`. `FROM_EMAIL`/`SES_SENDER` actually **set** on all 5
  documented notification Lambdas in production (`create-order`, `submit-payment-proof`,
  `verify-payment`, `advance-line-item`, `expire-pending-orders`); `notify-unread-messages`
  correctly has neither (matches "currently dark"). No staging Lambda has any SES env var —
  matches "staging can never email a real customer by construction." See Q2 below — this is
  where the docs disagree with each other.
- **GuardDuty Malware Protection for S3** — 2 `ACTIVE` plans (not the "GuardDuty detector"
  service, which has zero detectors — Malware Protection for S3 doesn't need one). Plan
  `7acfe6ba55d9edc67956` on `kcmps-payment-uploads-est-2026` and `b2cfe8b34e713cef6b48` on
  `kcmps-payment-uploads-staging`, both scoped to exactly the 4 documented prefixes
  (`design-uploads/`, `payments/`, `messages/`, `correspondence/`). Both `kcmps-guardduty-
  scan-result` EventBridge rules correctly filter on their own bucket name only — the
  cross-bucket-duplication bug `docs/history.md` entry 69 describes is not present.
- **S3** — exactly 4 `kcmps-*` buckets exist (`kcmps-online-bucket-est-2026`,
  `kcmps-payment-uploads-est-2026`, `kcmps-payment-uploads-staging`,
  `kcmps-lambda-artifacts-staging`) — no `kcmps-design-originals-est-2026` yet, correctly still
  "planned, not built" per `docs/roadmap.md`. Production uploads bucket's lifecycle rules
  (90-day noncurrent-version expiry, IA@30/Glacier-IR@90, abort-incomplete-multipart@7d on
  `design-uploads/`) match `docs/cost-governance.md` word-for-word. CORS on both uploads buckets
  matches `backend/infra/README.md`'s documented rule exactly (prod: 6 origins incl. both
  localhost ports; staging: `dev.kcmps.com` + 2 localhost ports only, no production origins).
- **DNS/CDN** — `kcmps.com`/`www.kcmps.com`/`site.kcmps.com` all alias to CloudFront
  `EY6Q5RSWLDCEF` (`d370ib8wcl1f2f.cloudfront.net`); `dev.kcmps.com` CNAMEs to `E7PDB5JQRZX0E`
  (`ds2x71y4pbzj3.cloudfront.net`) — matches root `CLAUDE.md`'s domain/CDN split exactly, and
  confirms the real zone (`Z06397161LBTJCRTPLL62` in the `260866268499`/`default`-profile
  account) is the one actually live, not the decoy zone in the CloudFront account.
- **`kcmps-foundation`'s dangling parameter** — `UserPoolId=ap-southeast-1_iDvAEumNp` (the
  deleted old pool) confirmed still set on the stack. This is *documented as expected* ("do not
  try to fix this by redeploying it against the new pool ID") — not drift, just confirming the
  doc's warning is accurate.
- **Observability plumbing** — the SNS alert subscription to `admin@kcmps.com` is now a
  **confirmed** subscription (real ARN, not `PendingConfirmation`) — the doc's warning that it
  "sits in PendingConfirmation until someone clicks the link" is no longer the live state, in a
  good way. Streams-handler event source mapping: `MaximumRetryAttempts: 3`,
  `BisectBatchOnFunctionError: true`, DLQ → `kcmps-lambda-dlq` — matches. `expire-pending-orders`
  async invoke config: 2 retries, same DLQ — matches.

## Drift found

1. **`docs/roadmap.md` is stale on SES/production-access status — this directly contradicts
   live AWS state and `backend/infra/README.md`.**
   - Milestone 1.2 still carries an **open** checkbox: *"`[ ]` SES sending identity for the
     checkout confirmation email — blocked on the pending SES production-access request...
     status pending as of 2026-07-31."*
   - Milestone 1.5 Phase 2 states outright: *"gated on `FROM_EMAIL`, which is **still unset**
     (SES remains sandboxed, `ProductionAccessEnabled: false`, confirmed via `sesv2
     get-account`)."*
   - **Live reality**: `sesv2 get-account` returns `"ProductionAccessEnabled": true"` right now,
     and `FROM_EMAIL` is set (`order@kcmps.com`) on `kcmps-verify-payment` in production.
     `backend/infra/README.md`'s own "SES customer notifications — wired 2026-08-03/04" section
     *already* has this right — it explicitly says `ProductionAccessEnabled: true` and lists the
     touchpoints as wired. `docs/roadmap.md` simply never got updated when that later work
     landed, so it now actively misleads a reader into thinking every customer email is dark.
     This is exactly the thing the task asked me to check, and it's the one place a doc
     disagrees with reality (and with another doc).

2. **Two production Lambdas have no CloudWatch log retention set — a real, if small, violation
   of `backend/CLAUDE.md`'s own convention.** `backend/CLAUDE.md` states: *"Every new Lambda must
   set 30-day retention as part of its own creation... instead of relying on a future audit to
   catch it."* Live check of every `/aws/lambda/kcmps-*` log group shows all 15 other production
   Lambdas correctly at 30 days (and all 17 staging Lambdas at 14 days) — but
   **`kcmps-cancel-order`** and **`kcmps-lookup-order`** (both deployed 2026-08-02 per the
   README's "Guest order lookup + self-cancel Lambdas" section) show `Retention: None`
   (unbounded). Their staging counterparts (`kcmps-staging-cancel-order`,
   `kcmps-staging-lookup-order`) *do* have 14-day retention set correctly, so this looks like a
   one-off miss on the production deploy that was never caught. Cost impact is negligible at
   current log volume, but it's exactly the class of thing this convention exists to prevent.

3. **`backend/infra/README.md`'s "Observability — Milestone 1.5" section describes a smaller,
   older version of the stack than what's actually deployed (favorable drift, but still stale
   documentation).** The README section (dated 2026-08-02) says the stack creates "17 CloudWatch
   alarms" covering the original 7 Lambdas. Live check: `kcmps-observability` (last updated
   2026-08-05, `list-stack-resources`) now manages **37 alarms** — Errors+Throttles for **all 17**
   production Lambdas, plus `streams-handler`'s IteratorAge alarm, the DLQ-depth alarm, and the
   API 5xx alarm. Someone extended the stack as new Lambdas shipped (correspondence, design
   uploads, scan-result handling, chat, unread-messages, post-confirmation all now have alarms),
   but the README's Observability section was never revised to say so — a reader following that
   section today would wrongly conclude 10 of the 17 production Lambdas are unmonitored.

## Undocumented resources

None found. Every CloudFormation stack, Lambda, API route, Cognito group, S3 bucket, GuardDuty
plan, EventBridge rule, and CloudFront distribution returned by the audit is accounted for by
one of the four docs (or, for `kcmps-dev-domain`, by `storefront-infra/CLAUDE.md`, checked
manually since it's outside the script's single-region scope). The two
`DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3-*` EventBridge rules are AWS-managed system
rules GuardDuty creates automatically for Malware Protection — standard artifacts, not
undocumented custom infra. The `krdungca.com` Route 53 zone in the second account is the owner's
personal domain, unrelated to KCMPS.

---

## Direct answers

**Is `kcmps-backend-staging` actually deployed and does it mirror production, or has it
drifted?** Deployed (`UPDATE_COMPLETE`) and mirrors production exactly: 17 Lambdas on each side
with identical names (minus the `staging-` prefix), all `nodejs24.x`/`arm64`; both HTTP APIs
have 13 routes each, 8 of them JWT-gated, both authorizers pointed at the same `kcmps-user-pool-v2`.
No drift beyond the intentional, documented differences (no PITR, no SES env vars, 14-day vs.
30-day log retention, separate table/bucket).

**Is SES production access actually approved now, or still sandboxed?** **Approved and live** —
`ProductionAccessEnabled: true`, DKIM/MAIL FROM both `SUCCESS`, and `FROM_EMAIL`/`SES_SENDER`
are genuinely set on all 5 documented notification Lambdas in production. `backend/infra/README.md`
already reflects this correctly; `docs/roadmap.md` does not (see Drift #1) — worth fixing there.

**Do the legacy Cognito groups (`Staff`, `Customers`) still exist alongside
Admin/Customer/Production/Sales/Finance?** `Staff` — yes, present, but that's intentional: per
`backend/infra/README.md`'s "Legacy groups" section it was promoted to a first-class role, not
left as cruft. `Customers` (plural) — confirmed gone, retirement completed as documented. Live
pool groups are exactly `Admin`/`Customer`/`Production`/`Sales`/`Finance`/`Staff` plus the
auto-managed Google IdP group — matches the target state precisely.

**Does the CloudFormation stack list match exactly what the docs describe, with no
orphaned/rolled-back stacks?** Yes — 5 stacks total (4 in `ap-southeast-1`, `kcmps-dev-domain` in
`us-east-1`), all `CREATE_COMPLETE`/`UPDATE_COMPLETE`, none in `ROLLBACK_COMPLETE`.
`kcmps-foundation`'s dangling old-pool parameter is explicitly documented as an accepted, do-not-
fix state, not an error.

**Any Lambda still on a runtime the docs say was migrated off?** No. All 34 Lambda functions
(17 production + 17 staging) are on `nodejs24.x`/`arm64`. Zero remain on `nodejs20.x`.

---

Report path: `docs/infra-audit-2026-08-05.md`. No files other than this report were modified.
