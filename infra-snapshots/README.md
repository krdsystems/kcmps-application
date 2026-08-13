# infra-snapshots/

**Machine-generated. Do not hand-edit anything in here except this file and `RESTORE.md`.**

A nightly read-only dump of every piece of KCMPS production configuration that exists
**only inside AWS** and could not be rebuilt from this repo's CloudFormation templates.

- **What breaks without it** → [`RESTORE.md`](RESTORE.md)
- **Why it is built this way** → [`../docs/disaster-recovery-and-cicd-plan.md`](../docs/disaster-recovery-and-cicd-plan.md)
  (§0 has the architecture diagram — start there)
- **What the owner still has to set up** → [`../docs/dr-owner-actions.md`](../docs/dr-owner-actions.md)

![Architecture](../docs/assets/kcmps-backup-architecture.png)

## Why git and not an AWS backup service

Three properties an in-account backup cannot give:

1. **It survives loss of the AWS account.** A backup living in `600929977538` cannot back
   up the loss of `600929977538`.
2. **It is diffable.** "Someone changed `kcmps-verify-payment`'s `SES_SENDER`" is a
   two-line diff, not an opaque restore point. This makes the backup double as **drift
   detection** — arguably the more valuable half, since it works every day rather than only
   on the worst one.
3. **It costs nothing.** AWS Backup would charge real money to protect an 88 KB table.

## Running it

```bash
# Local (read-only; safe to run any time)
KCMPS_PROFILE_MAIN=kcmps-claude-priv KCMPS_PROFILE_DNS=default \
  ./infra-snapshots/infra-snapshot.sh

# Check the last run without writing anything
./infra-snapshots/infra-snapshot.sh --verify
```

In CI this runs nightly at 02:10 Asia/Manila via
[`.github/workflows/infra-snapshot.yml`](../.github/workflows/infra-snapshot.yml), using
GitHub OIDC to assume read-only roles in both accounts. No AWS keys are stored anywhere.
A separate [heartbeat workflow](../.github/workflows/infra-snapshot-heartbeat.yml) fails
loudly if the nightly job stops running — a backup that silently stops is worse than none,
because it manufactures confidence.

## Layout

| Path | Covers |
|---|---|
| `route53/` | The kcmps.com zone: A records, **MX for both domains**, 6 DKIM CNAMEs, SPF/DMARC, and the ACM validation CNAME that silently renews TLS. Nothing else backs this up. |
| `lambda/` | All 64 function configs (32 prod + 32 staging) — **including env vars, which are recorded nowhere else** — plus event source mappings |
| `apigw/` | Both HTTP APIs: routes, integrations, authorizers, stages |
| `cloudfront/` | Both distributions + the two CloudFront Functions' **actual source** |
| `ses/` | The active receipt rule set — the entire inbound mail pipeline — plus identities and DKIM state |
| `iam/` | 13 roles with their inline and attached policies |
| `cognito/` | Pool, clients, groups, IdPs, MFA config. **Deliberately not the user list** — that is customer PII and does not belong in a source repo. |
| `dynamodb/`, `s3/`, `eventbridge/`, `cloudformation/` | Structure + protection state; these double as drift detection |
| `data/kcmps-table.json.gz` | Full logical dump of the production table (~88 KB raw). Gives what PITR cannot: retention beyond 35 days, and survival of account loss. |

## Two things to know before changing the script

**Pagination is a correctness issue here, not a performance one.** The AWS CLI pages at 25
items for several of these APIs, and a naive `--query 'length(Items)'` silently returns only
the first page. That is precisely how this repo came to believe there were 25 API routes
(there are 30) and 17 Lambdas (there are 32). Never count from a `--query` on a single page.

**The script is read-only by construction and must stay that way.** `assert_readonly()`
rejects any non-read verb at runtime, aborting the whole run. Do not add an exception. A
backup system with write access to production is a new attack surface pointed at the thing
it protects.

## Noise control

Volatile fields (`LastModified`, `ETag`, `RevisionId`, `CodeSha256`, …) are stripped and all
JSON is key-sorted, so an unchanged infra produces **no commit at all**. This is deliberate:
a system that commits every night trains everyone to ignore its diffs, which destroys the
drift-detection value. A commit here means something actually changed — treat it as a signal
worth reading.

Credentials embedded in CloudFront Function source (the `dev.kcmps.com` Basic Auth string)
are masked before writing. A `check_no_secrets()` pass aborts the run if any secret-shaped
key ever appears in the output rather than committing it.

## When the diff shows a resource added or removed

Update the matching row in `CLAUDE.md` **in the same commit**. That habit is what stops the
repo drifting from reality again — stale Lambda counts and a CloudFormation stack that
didn't exist were both found on 2026-08-13 and had been wrong for weeks.
