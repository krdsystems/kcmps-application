---
name: lambda-migration-open-bugs
description: Pre-existing bugs found during the 2026-08-05 Node.js Lambda EOL migration session that still need fixing — surface these at the start of the next KCMPS session.
metadata: 
  node_type: memory
  type: project
  originSessionId: fe7da4e8-2246-4503-a293-b65a7620f26c
  modified: 2026-08-05T15:27:36.179Z
---

During the 2026-08-05 Node.js 20.x→24.x Lambda migration session (see [[docs/history.md]]
entries 67-69 in the repo), several pre-existing bugs surfaced that were fixed if directly
blocking, but two remain open. Remind the user of these at the start of the next KCMPS
session.

## Still open

1. **`website/orders-data.js`'s customer-login `COGNITO_CONFIG` may still be stale.**
   During the session, `website/index.html`, `orders-data.js`, and
   `website/dashboard/dashboard-shell.js` were all found pointing at a *deleted* Cognito
   pool's dead Hosted UI domain — all three were fixed (repointed at
   `kcmps-user-pool-v2`/`kcmps-auth.auth...`), verified end-to-end on `dev.kcmps.com` only
   (real login tested, real tokens returned). **Not yet promoted to production** — the user
   explicitly said "don't promote to production, just to dev.kcmps.com" mid-session. Check
   whether they've promoted it since; if not, the login fix (and the CSP `connect-src`
   correction that went with it) is still staged-only and `kcmps.com`'s login is still
   broken.
   - Also still live in the *production* S3 bucket root (not dev-site): the stale
     `login-test.html` file, which the user asked to remove from dev but production wasn't
     touched per the same "don't promote" instruction.

2. **DONE (2026-08-05, branch `claude/retired-pool-sweep`, worktree `wt-pool-sweep`).**
   AWS side was verified clean by the separate read-only infra audit
   (`docs/infra-audit-2026-08-05.md`): both API JWT authorizers and
   `kcmps-create-order`/`kcmps-cancel-order` env vars (prod + staging) point at the v2 pool,
   old pool confirmed gone.
   Repo text swept (`grep -rni "iDvAEumNp\|95rrk0mflffentqdiomg1fipc" .`), 8 files hit. Fixed
   3: `backend/infra/README.md` (admin-group example commands, checkout-API-authorizer
   Audience description), `disaster-recovery/cloudformation/params.example.md`
   (`CognitoDomainPrefix` example for a live DR redeploy), `ops-dashboard/infra/
   backend-infra-to-deploy.md` (JWT authorizer Issuer example). Left as historical/
   accepted-exception: `docs/history.md`, `user-pool-v2.cfn.yaml`'s explanatory comments,
   `foundation.cfn.yaml`'s documented stale `UserPoolId` default, the README's explicitly-
   labeled-historical rollback section, `docs/build-prompts/milestone-1.0-foundation.md`.
   **Flagged, not fixed**: `backend/infra/README.md`'s PostConfirmation-trigger section
   (`kcmps-post-confirmation-lambda-role` + its Cognito invoke permission) still cites the
   old pool's ARN — the infra audit never checked whether that Lambda's IAM role/trigger
   wiring was actually re-scoped to `ap-southeast-1_LHJsFdCgo` during the cutover. If not,
   new self-signups may be silently failing to land in the `Customer` group. Needs an
   AWS-side check (`aws cognito-idp describe-user-pool --user-pool-id
   ap-southeast-1_LHJsFdCgo` for `LambdaConfig.PostConfirmation`, plus the role's IAM
   policy) before anyone edits those IDs in the doc.

3. **FIXED 2026-08-05 (owner-authorized). Was: the v2 pool's `LambdaConfig` went empty —
   the `PostConfirmation` trigger was unwired entirely.**
   **Resolution:** restored via `aws cognito-idp update-user-pool` with a *complete* payload
   (every non-default field passed explicitly: policies incl. `SignInPolicy`, deletion
   protection, MFA, admin-create-user config, verification template, email config, account
   recovery, attribute-update settings, and the 3 CloudFormation tags). Verified by diffing
   full `describe-user-pool` output before vs after: **`LambdaConfig` was the only field that
   changed** — 21 schema attributes, `AliasAttributes: ["email"]`, `DeletionProtection:
   ACTIVE`, `UserPoolTier: ESSENTIALS`, and domain `kcmps-auth` all preserved. Backups of
   both states are in that session's scratchpad (`pool-backup-before.json`/`pool-after.json`).
   **Still unverified end-to-end:** no real self-signup was performed after the fix (would
   need a live email inbox). Confirm with one signup on dev.kcmps.com and check the new user
   lands in the `Customer` group.
   **Root cause is NOT fully closed — this can recur.** The `kcmps-user-pool-v2` CFN template
   *does* define `LambdaConfig.PostConfirmation` (line ~151), and the stack updated cleanly at
   16:35 +08:00 with the trigger still firing at 16:36:43. Something then modified the pool
   **outside CloudFormation at 16:41:06 +08:00** and wiped it — a partial `update-user-pool`
   payload, exactly the trap `backend/CLAUDE.md` documents. Whatever script/session made that
   16:41 call will re-break this if re-run. CloudFormation will NOT self-heal it (drift is not
   auto-remediated), though the template agreeing means a future stack deploy won't undo the
   fix either.
   Minor leftover: `kcmps-post-confirmation`'s resource policy still carries a stale
   `kcmps-cognito-post-confirmation` statement conditioned on the deleted old pool's ARN —
   harmless (can never match) but removable in a future cleanup.

   *(Original finding, for context: verified read-only that `describe-user-pool` returned
   `LambdaConfig: {}` while the Lambda's resource policy correctly allowed invoke from the v2
   pool; log streams showed the last real invocations at 16:23:09 and 16:36:43 +08:00 matching
   the creation of `newsignuptest` and `google_117929641081785202386`, both of which did reach
   the `Customer` group. Impact was low — nothing today requires that membership, since
   `isStaff()` means "not staff" already reads as customer everywhere — but the group silently
   stopped filling, which is what the trigger exists to prevent.)*
## Already fixed this session (context only, no action needed)

- Site-wide login outage (deleted old Cognito pool, frontend never repointed) — fixed on
  `dev.kcmps.com`, not yet on production (see #1 above).
- Staging (`dev.kcmps.com`'s backend) had no GuardDuty malware scanning at all — any
  attachment upload there got permanently stuck at "Scanning…". Fixed: added a second
  GuardDuty Malware Protection Plan on the staging bucket.
- Both GuardDuty EventBridge rules (prod's original + the new staging one) had no
  bucket-name filter, so scan events from either bucket were processed by both — production
  and staging scan-verdict data was cross-contaminating. Fixed both with a
  `detail.s3ObjectDetails.bucketName` filter.
- 3 of the user's own staging test uploads (attached to test order `ORD-344FACB480`,
  already Cancelled) are permanently stuck — they were uploaded before the GuardDuty plan
  existed, and S3 malware protection doesn't backfill old objects. Not fixed — re-uploading
  is the practical fix, not worth building tooling for 3 throwaway files.
