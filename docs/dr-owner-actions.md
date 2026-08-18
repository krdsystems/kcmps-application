# DR/CI-CD — owner actions

Companion to [`disaster-recovery-and-cicd-plan.md`](disaster-recovery-and-cicd-plan.md).

## Status as of 2026-08-18 — the backup/DR system is COMPLETE

Everything in this document has been executed, verified, and — as of 2026-08-18 — every
documented restore procedure has been rehearsed at least once. Nothing below is a to-do
list anymore; it's kept as the historical record of what was done and how it was checked,
since that's what a future incident or a future engineer would actually need to trust it.

| Item | Status | Verified by |
|---|---|---|
| §1a OIDC providers, both accounts | **DONE** | ARNs returned for `600929977538` and `260866268499` |
| §1c `KCMPSSnapshotReader` (infra) | **DONE** | `ReadOnlyAccess` + one inline policy, `sts:AssumeRole` scoped to the single DNS-role ARN (see §1e) |
| §1d `KCMPSSnapshotReaderDNS` | **DONE** | 3 Route 53 **read** actions only, no managed policies |
| §1f **backup keypair** | **DONE** | owner-generated; decrypt tested against a real snapshot, `{"Count": 144, …}` recovered |
| §2 termination protection ×3 | **DONE** | all three stacks return `True` |
| §2 mail-bucket versioning | **DONE** | `Enabled` |
| §2 site-bucket lifecycle | **DONE** | `expire-noncurrent-versions / Enabled / 90` |
| Observability change-set | **DONE** | `UPDATE_COMPLETE`; `kcmps-ops` dashboard live; 37 → 49 alarms; 0 Lambdas uncovered |
| Nightly snapshot in production | **DONE** | green every night 2026-08-13 → 2026-08-18, no gaps, heartbeat watching it |
| **All 6 restore procedures rehearsed** | **DONE** | see [`infra-snapshots/RESTORE.md`](../infra-snapshots/RESTORE.md)'s rehearsal log — decrypt, PITR, DNS, Lambda config, API route, SES rule, all PASS |

**Two bugs were found and fixed during first execution**, both worth remembering since they're
exactly the class of failure this whole system exists to catch:

1. The DNS role initially trusted only GitHub's OIDC provider, but the workflow reaches it by
   *chaining* from the infra role. Fixed with a two-statement trust policy
   (`DirectGitHubOIDC` + `ChainFromInfraSnapshotRole`) — now exercised nightly without issue.
2. GitHub's **immutable subject claim** means this org's OIDC `sub` is
   `repo:krdsystems@<org-id>/kcmps-application@<repo-id>:*`, not the `repo:owner/name:*` form
   every tutorial shows. See §1b for the CloudTrail lookup that found it.

### What's genuinely still open — not blockers, just not built yet

The CI/CD hardening phases (§4 below) were always scoped as *later* work, separate from the
backup/DR system itself. None of them are required for the backup to function; they reduce
how much a bad deploy can hurt. Priority order unchanged from when this was written.

---

## 1. Two read-only IAM roles for GitHub OIDC — **required for anything to run**

No AWS access keys go into GitHub. Each account gets a role that GitHub's OIDC provider can
assume, scoped to this repository, with **read-only permissions only**. A backup system
holding write credentials to production is a new attack surface aimed at the thing it
protects.

### 1a. OIDC provider (once per account, both accounts)

```bash
# Account 600929977538
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --profile kcmps-claude-priv

# Account 260866268499
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --profile default
```

If one already exists, this errors with `EntityAlreadyExists` — that is fine, skip it.

### 1b. Trust policy

Save as `/tmp/trust-infra.json`. **The `sub` condition is the security boundary** — without
it, *any* GitHub repository in the world could assume this role.

> ## ⚠️ The `sub` claim is NOT `repo:owner/name:*` on this org
>
> **This cost two failed workflow runs on 2026-08-13. Read it before copying the policy below.**
>
> The `krdsystems` org has GitHub's **immutable subject claim** enabled, so the `sub` GitHub
> actually sends embeds numeric org and repo IDs:
>
> ```
> repo:krdsystems@310685649/kcmps-application@1307558132:ref:refs/heads/main
>              ^^^^^^^^^^                ^^^^^^^^^^^^
> ```
>
> Every AWS/GitHub tutorial — and AWS's own console wizard — shows the plain
> `repo:owner/name:*` form. It does not match here, and the failure is an opaque
> `Not authorized to perform sts:AssumeRoleWithWebIdentity` that names no claim and
> suggests no cause.
>
> **How to find the real value** (the non-obvious step): the rejected claim is in
> CloudTrail, in `userIdentity.principalId`:
>
> ```bash
> aws cloudtrail lookup-events \
>   --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
>   --max-results 5 --profile kcmps-claude-priv
> ```
>
> This is a **good** setting, not a misconfiguration — the IDs are immutable, so renaming
> the repo or the org cannot silently transfer AWS trust to whoever claims the old name.
> Keep it. Just write the policy to match reality. Any future OIDC role for this org hits
> the same thing.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::600929977538:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:krdsystems@310685649/kcmps-application@1307558132:*" }
    }
  }]
}
```

### 1c. Infra reader role (600929977538)

```bash
aws iam create-role --role-name KCMPSSnapshotReader \
  --assume-role-policy-document file:///tmp/trust-infra.json \
  --description "Read-only, GitHub OIDC. Nightly infra snapshot. No write permissions - do not add any." \
  --profile kcmps-claude-priv

# ReadOnlyAccess is the AWS-managed read-only policy. Broad, but READ-ONLY by
# definition, which is the property that matters. A hand-rolled least-privilege
# policy would need updating every time the snapshot script covers a new
# service - and a snapshot that silently skips a service because of a missing
# permission is the exact failure this system exists to prevent.
aws iam attach-role-policy --role-name KCMPSSnapshotReader \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess \
  --profile kcmps-claude-priv
```

> **`ReadOnlyAccess` includes `s3:GetObject` and `dynamodb:Scan`** — i.e. this role can read
> customer data. That is required (Layer B dumps the table) but worth being deliberate
> about. If you would rather narrow it, the snapshot needs: `route53:List*/Get*`,
> `lambda:List*/Get*`, `apigateway:GET`, `cloudfront:Get*/List*`, `ses:Describe*/List*`,
> `ses:Get*`, `iam:Get*/List*`, `cognito-idp:Describe*/List*/Get*`,
> `dynamodb:DescribeTable/DescribeContinuousBackups/Scan`, `s3:GetBucket*`,
> `events:List*`, `cloudformation:Describe*/List*`.

### 1d. DNS reader role (260866268499)

Same trust policy with the `Federated` ARN changed to `260866268499`. This one **should**
be tightly scoped — it only ever reads one zone:

```bash
aws iam create-role --role-name KCMPSSnapshotReaderDNS \
  --assume-role-policy-document file:///tmp/trust-dns.json \
  --description "Read-only Route53. Nightly infra snapshot. NEVER grant write - DNS changes are owner-only." \
  --profile default

aws iam put-role-policy --role-name KCMPSSnapshotReaderDNS \
  --policy-name route53-read \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["route53:ListResourceRecordSets","route53:GetHostedZone","route53:ListHostedZones"],
      "Resource": "*"
    }]
  }' \
  --profile default
```

### 1d-bis. Cross-account chaining needs a grant on BOTH sides

**The second failure of 2026-08-13.** The workflow reaches the DNS role by *chaining* from
the infra role (`credential_source = Environment`), and a cross-account `AssumeRole` requires
two separate permissions that are easy to mistake for one:

1. The **target** role's trust policy must allow the source principal — §1d covers this.
2. The **source** role's identity policy must grant `sts:AssumeRole` on the target — and
   **`ReadOnlyAccess` does not include `sts:AssumeRole`.**

Missing #2 gives `User: .../KCMPSSnapshotReader/infra-snapshot is not authorized to perform:
sts:AssumeRole`, which reads like a trust-policy problem and sends you back to fixing the
side that was already correct.

```bash
aws iam put-role-policy --role-name KCMPSSnapshotReader \
  --policy-name assume-dns-reader \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "ChainIntoDnsAccountReadOnlyRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::260866268499:role/KCMPSSnapshotReaderDNS"
    }]
  }' --profile kcmps-claude-priv
```

Note this is the **one non-read permission** in the whole snapshot system. It is scoped to a
single role ARN, and that role can only read Route 53. Keep it that narrow — the "read-only
by construction" claim in `infra-snapshot.sh`'s header depends on it.

The DNS role's trust policy correspondingly carries **two** statements:
`GitHubOIDCImmutableSubject` (direct OIDC, unused today but kept so the workflow could stop
chaining) and `ChainFromInfraSnapshotRole` (the path actually in use).

### 1e. Verify before trusting it

```bash
# Should list the two roles and show NO write actions in their policies
aws iam get-role --role-name KCMPSSnapshotReader --profile kcmps-claude-priv
aws iam list-attached-role-policies --role-name KCMPSSnapshotReader --profile kcmps-claude-priv
aws iam get-role-policy --role-name KCMPSSnapshotReaderDNS --policy-name route53-read --profile default
```

Then trigger the workflow manually from the GitHub Actions tab (`workflow_dispatch`) and
confirm it commits a snapshot. **Do not wait for the first scheduled run to find out it is
broken.**

---

## 1f. Generate the backup encryption keypair — **DONE, kept for reference**

The production table holds real customer data — mail items with full `bodyText` and sender
addresses, order records with correspondence logs. That is encrypted before it ever reaches
git. `infra-snapshot.sh` **refuses to run** (`exit 95`) if the public cert is missing, rather
than silently writing plaintext PII.

**Generate this yourself. Do not let an agent generate it** — a private key created in an
agent session has been exposed to that session's transcript and tooling. (This is not
hypothetical: the attempt to generate a throwaway test key during the build of this system
was correctly blocked by the sandbox.)

```bash
# Private key + self-signed cert. The cert is only a container for the public
# key here; CN and expiry are cosmetic. 10y so it never silently expires.
openssl req -x509 -newkey rsa:4096 -days 3650 -nodes \
  -keyout kcmps-backup-private.pem \
  -out    kcmps-backup-public.pem \
  -subj "/CN=kcmps-backup"

# The PUBLIC half goes in the repo — safe to commit, it can only encrypt.
mv kcmps-backup-public.pem infra-snapshots/backup-key.pub.pem
```

Then:

1. **Put `kcmps-backup-private.pem` in your password manager**, and in **one other place**
   (a second manager, or offline media). Losing it means this backup layer is gone and you
   fall back to PITR's 35 days.
2. **Delete the local copy** of the private key: `shred -u kcmps-backup-private.pem`
3. Commit `infra-snapshots/backup-key.pub.pem`.
4. Do a round-trip test **once**, so you know the restore works before you need it:
   ```bash
   ./infra-snapshots/infra-snapshot.sh          # writes data/kcmps-table.json.gz.cms
   openssl cms -decrypt -inform DER -binary \
     -in infra-snapshots/data/kcmps-table.json.gz.cms \
     -inkey /path/to/kcmps-backup-private.pem | gunzip | head -c 300
   ```
   Record the result in `infra-snapshots/RESTORE.md`'s rehearsal log.

> **Step 4 was completed 2026-08-13** — decrypting a real production snapshot returned
> `{"Count": 144, …}`, confirming the round trip works end to end. See
> `infra-snapshots/RESTORE.md`'s rehearsal log.

**Why the CI job needs no secret at all:** encryption is asymmetric. The workflow has the
public cert and can *write* a backup it cannot *read*. A compromised runner or leaked GitHub
token yields nothing.

---

## 2. Phase 0 hardening — small, reversible, closes three gaps

Each is a one-line change and none affects runtime behaviour.

```bash
P="--profile kcmps-claude-priv"

# G7 - termination protection. Deletion protection on the table/pool means a
# stack delete would fail PARTWAY; this stops it starting at all.
aws cloudformation update-termination-protection --enable-termination-protection \
  --stack-name kcmps-foundation $P
aws cloudformation update-termination-protection --enable-termination-protection \
  --stack-name kcmps-user-pool-v2 $P
aws cloudformation update-termination-protection --enable-termination-protection \
  --stack-name kcmps-observability $P

# G6 - versioning on the raw-MIME bucket. This holds the immutable source of
# truth every mail feature derives from (deriveThreadId, the threading backfill,
# attachment extraction). A delete here is currently permanent.
aws s3api put-bucket-versioning --bucket kcmps-inbound-mail-est-2026 \
  --versioning-configuration Status=Enabled $P
```

**G9 — lifecycle on the live site bucket.** 925 versions against 223 objects, growing with
every deploy, currently unbounded. Matches what the other three buckets already do:

```bash
cat > /tmp/lifecycle-site.json <<'EOF'
{
  "Rules": [{
    "ID": "expire-noncurrent-versions",
    "Filter": {},
    "Status": "Enabled",
    "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
  }]
}
EOF
aws s3api put-bucket-lifecycle-configuration --bucket kcmps-online-bucket-est-2026 \
  --lifecycle-configuration file:///tmp/lifecycle-site.json $P
```

> **90 days is also your frontend rollback window.** Anything older than that stops being
> restorable per-object from S3 — you would rebuild from git instead. That is the right
> trade at 23 MB, but it is a deliberate trade, not a free win.

After running these, re-run the snapshot and confirm the diff shows exactly these three
changes and nothing else:

```bash
KCMPS_PROFILE_MAIN=kcmps-claude-priv KCMPS_PROFILE_DNS=default ./infra-snapshots/infra-snapshot.sh
git diff infra-snapshots/
```

---

## 3. Rehearse the restores — DONE, all six

Every documented procedure in [`infra-snapshots/RESTORE.md`](../infra-snapshots/RESTORE.md)
has been rehearsed at least once: encrypted-backup decrypt, DynamoDB PITR, DNS record
restore, Lambda config restore, API Gateway route rebuild, and SES rule rebuild. All PASS.
See that file's rehearsal log for what each one actually proved, plus the honest scope
caveats on the two that couldn't be full damage-and-recover tests (DNS writes are
owner-only by standing rule; SES has no staging equivalent and is the live mail pipeline,
so that one proved the reconstruction mechanism without ever risking the real pipeline).

---

## 4. Later — the CI/CD phases

Not owner actions yet; they need building first. See the plan doc §4. Priority order and why:

1. **Phase 2 (Lambda versions + aliases)** — the biggest single win, ₱0. Right now a bad
   Lambda deploy has **no rollback**. This makes it a one-command alias shift.
2. **Phase 1 (frontend pipeline)** — makes both 2026-08-08 incidents structurally impossible.
3. **Phase 3 (CloudFormation imports)** — gradual, lowest-risk resources first.

---

## Explicitly NOT recommended

- **AWS Backup vault** — per-resource charges to protect an 88 KB table. PITR plus the git
  dump already covers it, better and free.
- **AWS Config** for drift detection — ~₱100+/mo for what the nightly snapshot diff gives
  for free.
- **Cross-region replication / standby CloudFront** — an order of magnitude more cost than
  the risk justifies at this scale.
- **A second Route 53 hosted zone** — does not add safety; the zone file in git does.
