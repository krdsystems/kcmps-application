# DR/CI-CD — owner actions

Companion to [`disaster-recovery-and-cicd-plan.md`](disaster-recovery-and-cicd-plan.md).

## Status as of 2026-08-13 — most of this is DONE

Executed with the owner's explicit approval on 2026-08-13 and **verified by reading the
resulting state back**, not by trusting the command's exit code:

| Item | Status | Verified by |
|---|---|---|
| §1a OIDC providers, both accounts | **DONE** | ARNs returned for `600929977538` and `260866268499` |
| §1c `KCMPSSnapshotReader` (infra) | **DONE** | `ReadOnlyAccess` attached, **zero inline policies** |
| §1d `KCMPSSnapshotReaderDNS` | **DONE** | 3 Route 53 **read** actions only, no managed policies |
| §1f **backup keypair** | **NOT DONE — still yours** | see below; blocks the table dump only |
| §2 termination protection ×3 | **DONE** | all three stacks return `True` |
| §2 mail-bucket versioning | **DONE** | `Enabled` |
| §2 site-bucket lifecycle | **DONE** | `expire-noncurrent-versions / Enabled / 90` |
| Observability change-set | **DONE** | `UPDATE_COMPLETE`; `kcmps-ops` dashboard live; 37 → 49 alarms; **0 Lambdas now uncovered** |
| First snapshot pushed off-machine | **DONE** | branch `claude/dr-backup-cicd` on GitHub |

**One bug was found and fixed during execution.** The DNS role initially trusted only
GitHub's OIDC provider, but `.github/workflows/infra-snapshot.yml` reaches it by *chaining*
from the infra role (`credential_source = Environment`). That mismatch would have failed
with `AccessDenied` on the first nightly run — a backup silently not running, which is the
exact failure this system exists to prevent. The trust policy now carries two statements:
`DirectGitHubOIDC` and `ChainFromInfraSnapshotRole`. **The chain has not yet been exercised
by a real workflow run** — the first `workflow_dispatch` is what proves it.

### What is still outstanding

1. **Generate the backup keypair (§1f)** — the only remaining blocker on the nightly job.
2. **Trigger the workflow manually once** and confirm it commits. Do not wait for the first
   scheduled run to discover a problem.
3. **Rehearse one restore (§3).**

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

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::600929977538:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:krdsystems/kcmps-application:*" }
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

## 1f. Generate the backup encryption keypair — **required; the snapshot fails without it**

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

> **The encryption path has NOT been executed end-to-end yet** — it could not be, since the
> keypair does not exist. The code is written and the fail-closed guard is in place, but
> step 4 above is the first real proof it works. Treat this layer as unverified until you
> have done it.

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

## 3. Rehearse one restore — the step that converts plan into capability

Do **procedure #4** from [`infra-snapshots/RESTORE.md`](../infra-snapshots/RESTORE.md)
(PITR restore) against `kcmps-staging`. Entirely reversible, touches no production resource,
and it is the procedure most likely to be needed under real pressure.

Record the result in that file's rehearsal log. Delete the restored table afterwards so it
does not accrue cost.

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
