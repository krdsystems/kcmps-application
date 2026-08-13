#!/usr/bin/env bash
# =============================================================================
# KCMPS infra snapshot — read-only backup of everything that exists ONLY in AWS
# =============================================================================
# Dumps unrecreatable production configuration into infra-snapshots/ as sorted,
# pretty-printed JSON so it can be committed to git. See
# docs/disaster-recovery-and-cicd-plan.md for the full design and rationale.
#
# WHY GIT AND NOT AWS BACKUP: this data is small, textual, and its value is in
# being *diffable* — "someone changed kcmps-verify-payment's SES_SENDER" should
# be a two-line diff, not an opaque restore point. It also survives loss of the
# AWS account, which no in-account backup does.
#
# ── HARD RULE: THIS SCRIPT IS READ-ONLY ──────────────────────────────────────
# Every AWS call here is get-*/list-*/describe-*. A backup system with write
# access to production is a new attack surface aimed at the thing it protects.
# assert_readonly() below enforces this at runtime, not just by convention —
# any non-read verb aborts the whole run. Do not add an exception.
#
# ── PAGINATION IS A CORRECTNESS ISSUE HERE, NOT A PERFORMANCE ONE ────────────
# The AWS CLI pages at 25 items for several of these APIs. A naive
# `--query 'length(Items)'` silently returns only the FIRST page — this is
# exactly how the repo came to believe there were 25 API routes when there are
# 30, and 17 Lambdas when there are 32 (see the plan doc §1b/D1). Every list
# call below therefore uses --no-paginate=false semantics via explicit
# pagination (the CLI's default auto-pagination), and counts are taken from the
# assembled JSON, never from a --query on a single page. If you add a call
# here, verify its count against the console before trusting it.
#
# ── FAILURE MUST BE LOUD ─────────────────────────────────────────────────────
# set -euo pipefail plus a verify pass at the end. A backup that silently
# writes nothing is worse than no backup, because it manufactures confidence.
#
# Usage:
#   ./infra-snapshots/infra-snapshot.sh            # write snapshot
#   ./infra-snapshots/infra-snapshot.sh --verify   # verify last run, no writes
#
# Profiles: PROFILE_MAIN (600929977538, all infra) and PROFILE_DNS
# (260866268499, the real kcmps.com hosted zone). In GitHub Actions both are
# assumed via OIDC and these vars are left unset — the CLI picks up the
# ambient role. See .github/workflows/infra-snapshot.yml.
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
PROFILE_MAIN="${KCMPS_PROFILE_MAIN:-}"
PROFILE_DNS="${KCMPS_PROFILE_DNS:-}"

ZONE_ID="Z06397161LBTJCRTPLL62"        # kcmps.com — the REAL zone, in 260866268499.
                                        # 600929977538 also has a kcmps.com zone; it is a
                                        # decoy with only NS/SOA. Never snapshot that one.
PROD_API_ID="6msg2uho6c"
STAGING_API_ID="162ufc121j"
USER_POOL_ID="ap-southeast-1_LHJsFdCgo"
DISTRIBUTIONS=("EY6Q5RSWLDCEF" "E7PDB5JQRZX0E")
BUCKETS=(
  kcmps-online-bucket-est-2026
  kcmps-payment-uploads-est-2026
  kcmps-design-originals-est-2026
  kcmps-inbound-mail-est-2026
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT"

# --- read-only enforcement --------------------------------------------------
# Wraps every AWS call. Rejects anything that isn't an unambiguous read verb.
# This is a real gate: it is the only thing standing between a typo in this
# file and a mutation against production.
READ_VERBS='^(get|list|describe|scan|query|batch-get)-|^(get|list|describe|scan|query)$'

assert_readonly() {
  local svc="$1" op="$2"
  if ! [[ "$op" =~ $READ_VERBS ]]; then
    echo "FATAL: refusing non-read operation '$svc $op'." >&2
    echo "       infra-snapshot.sh is read-only by construction; see header." >&2
    exit 90
  fi
}

# aws_main / aws_dns — the only two ways this script talks to AWS.
aws_main() {
  assert_readonly "$1" "$2"
  if [[ -n "$PROFILE_MAIN" ]]; then
    aws "$@" --profile "$PROFILE_MAIN" --region "$REGION" --output json
  else
    aws "$@" --region "$REGION" --output json
  fi
}

aws_dns() {
  assert_readonly "$1" "$2"
  # Route 53 is global; region is irrelevant but harmless.
  if [[ -n "$PROFILE_DNS" ]]; then
    aws "$@" --profile "$PROFILE_DNS" --output json
  else
    aws "$@" --output json
  fi
}

# Normalise JSON so the daily diff shows real changes, not key reordering or
# a moved timestamp. Volatile fields (LastModified, ETag, dates, ARNs bearing
# version suffixes) would otherwise produce a commit every single night and
# train everyone to ignore the diff — which defeats the drift-detection half
# of this system's value.
VOLATILE_KEYS='LastModified|ETag|CreationDate|CreatedTimestamp|LastUpdatedTime|LastModifiedDate|CodeSha256|RevisionId|ResponseMetadata|CallerReference|RequestId|LastModifiedTime'

normalise() {
  python3 -c '
import sys, json, re
raw = sys.stdin.read()
if not raw.strip():
    # The AWS CLI returns an EMPTY BODY (not {}) for some "nothing configured"
    # responses — notably get-bucket-versioning on a bucket that has never had
    # versioning enabled. That is a meaningful answer, not a failure, so record
    # it explicitly rather than crashing or writing a zero-byte file. The
    # verify() pass below is what turns "versioning absent" into an alert.
    sys.stdout.write('"'"'{\n  "_empty_response": true\n}\n'"'"')
    sys.exit(0)
sys.stdin = None
VOLATILE = re.compile(r"^(" + sys.argv[1] + r")$")
def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in sorted(o.items()) if not VOLATILE.match(k)}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o
json.dump(strip(json.loads(raw)), sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
' "$VOLATILE_KEYS"
}

write() {  # write <relative-path>  (reads JSON on stdin)
  local path="$OUT/$1"
  mkdir -p "$(dirname "$path")"
  normalise > "$path"
}

# try_write — for genuinely-optional config, where "not configured" is a valid
# answer rather than a failure. S3 returns NoSuchLifecycleConfiguration /
# NoSuchBucketPolicy as ERRORS, not as empty results, so these must be caught
# explicitly. The distinction matters: a missing lifecycle rule on the site
# bucket is a real (if minor) finding, and recording it as `_absent` keeps it
# visible in the diff instead of silently producing no file at all.
#
# Deliberately does NOT swallow other errors — an AccessDenied here would mean
# the snapshot role is under-scoped, which must fail loudly, not be recorded as
# "absent". Only the known not-configured error codes are tolerated.
try_write() {  # try_write <relative-path> <aws args...>
  local path="$1"; shift
  local out err rc
  err="$(mktemp)"
  set +e
  out="$("$@" 2>"$err")"
  rc=$?
  set -e
  if (( rc == 0 )); then
    printf '%s' "$out" | write "$path"
  elif grep -qE 'NoSuchLifecycleConfiguration|NoSuchBucketPolicy|NoSuchPublicAccessBlockConfiguration|ServerSideEncryptionConfigurationNotFoundError|NoSuchCORSConfiguration' "$err"; then
    printf '{"_absent": true, "_note": "not configured on this bucket"}' | write "$path"
  else
    echo "FATAL: unexpected error snapshotting $path" >&2
    cat "$err" >&2
    rm -f "$err"
    exit 94
  fi
  rm -f "$err"
}

# --- secret guard -----------------------------------------------------------
# Lambda env vars here are identifiers (table names, pool IDs, bucket names,
# sender addresses) — no credentials today. But this file gets committed to
# git, so if a future env var ever looks secret-shaped, the run must FAIL
# rather than quietly publish it. Fail closed, same principle as the scan
# verdicts in backend/jobs/handle-scan-result.js.
SECRET_PATTERN='(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|_TOKEN|ACCESS_KEY|API_KEY|CREDENTIAL)'

check_no_secrets() {
  local hits
  hits="$(grep -rEl "\"[A-Za-z0-9_]*$SECRET_PATTERN[A-Za-z0-9_]*\"[[:space:]]*:" "$OUT" \
          --include='*.json' 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    echo "FATAL: secret-shaped key found in snapshot output — refusing to continue." >&2
    echo "$hits" >&2
    echo "       Redact it in this script before committing anything." >&2
    exit 91
  fi
}

# =============================================================================
# G1 — Route 53. The highest-blast-radius unbacked thing in the business:
# MX for kcmps.com AND mirror.kcmps.com, 6 DKIM CNAMEs, SPF/DMARC, the
# _autodiscover SRV, and the ACM validation CNAME that silently renews the
# CloudFront cert. Nothing else backs this up. Snapshot it FIRST.
# =============================================================================
snap_route53() {
  echo "  route53 ($ZONE_ID)"
  aws_dns route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    | write route53/kcmps.com.json
  aws_dns route53 get-hosted-zone --id "$ZONE_ID" \
    | write route53/kcmps.com.zone-meta.json

  # A flat BIND-style rendering as well. JSON is what a restore script consumes;
  # this is what a human reads at 2am, and what makes a diff obvious at a glance.
  python3 - "$OUT/route53/kcmps.com.json" > "$OUT/route53/kcmps.com.zonefile.txt" <<'PY'
import json, sys
rrs = json.load(open(sys.argv[1]))["ResourceRecordSets"]
for r in sorted(rrs, key=lambda x: (x["Name"], x["Type"])):
    if "AliasTarget" in r:
        print(f'{r["Name"]}\tALIAS\t{r["Type"]}\t{r["AliasTarget"]["DNSName"]}')
    else:
        for v in r.get("ResourceRecords", []):
            print(f'{r["Name"]}\t{r.get("TTL","-")}\t{r["Type"]}\t{v["Value"]}')
PY
}

# =============================================================================
# G2 — Lambda. Production's 32 functions are CLI-managed with no versions and
# no aliases, and their environment variables exist NOWHERE in the repo.
# This dump is the only record of them. Staging is captured too: it's
# CloudFormation-managed, so its config is reproducible, but the snapshot is
# what proves staging and production haven't silently diverged.
# =============================================================================
snap_lambda() {
  echo "  lambda"
  local fns
  fns="$(aws_main lambda list-functions \
         | python3 -c 'import sys,json;[print(f["FunctionName"]) for f in json.load(sys.stdin)["Functions"] if f["FunctionName"].startswith("kcmps-")]')"

  local count=0
  while read -r fn; do
    [[ -z "$fn" ]] && continue
    aws_main lambda get-function-configuration --function-name "$fn" \
      | write "lambda/$fn.json"
    count=$((count + 1))
  done <<< "$fns"

  # Event source mappings (the DynamoDB Streams trigger, S3/EventBridge wiring)
  # are separate resources from the functions and are just as unrecreatable.
  aws_main lambda list-event-source-mappings | write lambda/_event-source-mappings.json
  echo "    $count functions"
}

# =============================================================================
# G3 — API Gateway. 30 routes + integrations + a JWT authorizer, hand-built.
# Stage is $default with AutoDeploy=true, so there is no deployment history to
# roll back to — this snapshot IS the rollback reference.
# =============================================================================
snap_apigw() {
  echo "  apigateway"
  for api in "$PROD_API_ID" "$STAGING_API_ID"; do
    aws_main apigatewayv2 get-api          --api-id "$api" | write "apigw/$api/api.json"
    aws_main apigatewayv2 get-routes       --api-id "$api" | write "apigw/$api/routes.json"
    aws_main apigatewayv2 get-integrations --api-id "$api" | write "apigw/$api/integrations.json"
    aws_main apigatewayv2 get-authorizers  --api-id "$api" | write "apigw/$api/authorizers.json"
    aws_main apigatewayv2 get-stages       --api-id "$api" | write "apigw/$api/stages.json"
  done
}

# =============================================================================
# G4 — CloudFront. Neither distribution is CloudFormation-managed (there is no
# kcmps-dev-domain stack, despite what the repo said until 2026-08-13 — see the
# plan doc D2). The two CloudFront Functions' SOURCE exists only in AWS.
# =============================================================================
snap_cloudfront() {
  echo "  cloudfront"
  for dist in "${DISTRIBUTIONS[@]}"; do
    aws_main cloudfront get-distribution-config --id "$dist" | write "cloudfront/$dist.json"
  done
  aws_main cloudfront list-functions | write cloudfront/_functions.json

  # Function code, not just metadata. get-function returns the source as a
  # blob on a --outfile; that's the whole point of capturing it.
  local names
  names="$(python3 -c 'import json;print("\n".join(f["Name"] for f in json.load(open("'"$OUT"'/cloudfront/_functions.json"))["FunctionList"].get("Items",[])))')"
  while read -r fname; do
    [[ -z "$fname" ]] && continue
    mkdir -p "$OUT/cloudfront/functions"
    local dest="$OUT/cloudfront/functions/$fname.js"
    if [[ -n "$PROFILE_MAIN" ]]; then
      aws cloudfront get-function --name "$fname" --stage LIVE \
        --profile "$PROFILE_MAIN" --region "$REGION" "$dest" >/dev/null
    else
      aws cloudfront get-function --name "$fname" --stage LIVE --region "$REGION" "$dest" >/dev/null
    fi
    # kcmps-dev-basic-auth embeds the staging Basic Auth credential. Mask it —
    # this file is committed to git. The real credential lives in the owner's
    # password manager; it is deliberately not in this repo.
    if [[ "$fname" == *basic-auth* ]]; then
      python3 - "$dest" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'(["\'])Basic [A-Za-z0-9+/=]+\1', r'\1Basic <REDACTED — see password manager>\1', s)
s = re.sub(r'(["\'])[A-Za-z0-9+/]{16,}={0,2}\1', r'\1<REDACTED>\1', s)
open(p, 'w').write(
    "// NOTE: credential literals redacted by infra-snapshot.sh before commit.\n"
    "// Restore the real value from the owner's password manager.\n" + s)
PY
    fi
  done <<< "$names"
}

# =============================================================================
# G5 — SES. The active receipt rule set IS the entire inbound mail pipeline.
# There is exactly one of it, it was created by CLI, and ses-relay.cfn.yaml is
# documentation rather than a deployed stack (correctly noted in its header).
# =============================================================================
snap_ses() {
  echo "  ses"
  aws_main ses describe-active-receipt-rule-set | write ses/active-receipt-rule-set.json
  aws_main ses list-receipt-rule-sets           | write ses/receipt-rule-sets.json
  aws_main sesv2 list-email-identities          | write ses/identities.json
  aws_main sesv2 get-account                    | write ses/account.json
  aws_main sesv2 list-configuration-sets        | write ses/configuration-sets.json

  local ids
  ids="$(python3 -c 'import json;print("\n".join(i["IdentityName"] for i in json.load(open("'"$OUT"'/ses/identities.json"))["EmailIdentities"]))')"
  while read -r ident; do
    [[ -z "$ident" ]] && continue
    # DKIM tokens + MAIL FROM live here; they must match the Route 53 CNAMEs.
    aws_main sesv2 get-email-identity --email-identity "$ident" \
      | write "ses/identity-$ident.json"
  done <<< "$ids"
}

# =============================================================================
# G8 — IAM. 13 roles built incrementally by hand across many sessions; their
# inline policies are recorded only as prose in backend/infra/README.md.
# =============================================================================
snap_iam() {
  echo "  iam"
  local roles
  # Case-INSENSITIVE match. The snapshot's own OIDC roles are named
  # KCMPSSnapshotReader/KCMPSSnapshotReaderDNS, which a `"kcmps" in name` test
  # silently misses — so the backup system was not backing up its own access
  # roles. Found 2026-08-13 by noticing they were absent from the diff after
  # they were created.
  roles="$(aws_main iam list-roles \
           | python3 -c 'import sys,json;[print(r["RoleName"]) for r in json.load(sys.stdin)["Roles"] if "kcmps" in r["RoleName"].lower()]')"
  while read -r role; do
    [[ -z "$role" ]] && continue
    aws_main iam get-role --role-name "$role" | write "iam/$role.role.json"
    aws_main iam list-attached-role-policies --role-name "$role" \
      | write "iam/$role.attached.json"

    local inline
    inline="$(aws_main iam list-role-policies --role-name "$role" \
              | python3 -c 'import sys,json;print("\n".join(json.load(sys.stdin)["PolicyNames"]))')"
    while read -r pol; do
      [[ -z "$pol" ]] && continue
      aws_main iam get-role-policy --role-name "$role" --policy-name "$pol" \
        | write "iam/$role.inline.$pol.json"
    done <<< "$inline"
  done <<< "$roles"
}

# =============================================================================
# Cognito, DynamoDB, S3, EventBridge, CloudFormation.
# Mostly belt-and-braces over existing templates — but the S3 and DynamoDB
# dumps double as DRIFT DETECTION: if PITR is ever switched off, or bucket
# versioning is disabled, the next morning's diff says so. That early warning
# is worth more than the backup value.
# =============================================================================
snap_cognito() {
  echo "  cognito"
  aws_main cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" \
    | write cognito/user-pool.json
  aws_main cognito-idp list-user-pool-clients --user-pool-id "$USER_POOL_ID" --max-results 60 \
    | write cognito/clients.json
  aws_main cognito-idp get-user-pool-mfa-config --user-pool-id "$USER_POOL_ID" \
    | write cognito/mfa-config.json
  aws_main cognito-idp list-groups --user-pool-id "$USER_POOL_ID" \
    | write cognito/groups.json
  aws_main cognito-idp list-identity-providers --user-pool-id "$USER_POOL_ID" --max-results 60 \
    | write cognito/identity-providers.json
  # Deliberately NOT dumping the user list: it is customer PII and does not
  # belong in a source repo. Losing the pool orphans order history keyed on
  # `sub` regardless — see the plan doc's whole-account-loss row.
}

snap_dynamodb() {
  echo "  dynamodb"
  for t in kcmps kcmps-staging; do
    aws_main dynamodb describe-table --table-name "$t" | write "dynamodb/$t.table.json"
    aws_main dynamodb describe-continuous-backups --table-name "$t" \
      | write "dynamodb/$t.backups.json"
  done
}

snap_s3() {
  echo "  s3"
  for b in "${BUCKETS[@]}"; do
    # Versioning is never absent as a concept — an unversioned bucket returns
    # {} — so this one is a plain write and any error is a real error.
    aws_main s3api get-bucket-versioning --bucket "$b" | write "s3/$b.versioning.json"
    try_write "s3/$b.public-access-block.json" aws_main s3api get-public-access-block --bucket "$b"
    try_write "s3/$b.lifecycle.json"           aws_main s3api get-bucket-lifecycle-configuration --bucket "$b"
    try_write "s3/$b.policy.json"              aws_main s3api get-bucket-policy --bucket "$b"
    try_write "s3/$b.encryption.json"          aws_main s3api get-bucket-encryption --bucket "$b"
  done
}

snap_events() {
  echo "  eventbridge"
  aws_main events list-rules | write eventbridge/rules.json
  local rules
  rules="$(python3 -c 'import json;print("\n".join(r["Name"] for r in json.load(open("'"$OUT"'/eventbridge/rules.json"))["Rules"]))')"
  while read -r r; do
    [[ -z "$r" ]] && continue
    aws_main events list-targets-by-rule --rule "$r" | write "eventbridge/targets-$r.json"
  done <<< "$rules"
}

snap_cloudformation() {
  echo "  cloudformation"
  aws_main cloudformation describe-stacks | write cloudformation/stacks.json
  # Resource inventories, so "what was in this stack" survives the stack.
  local stacks
  stacks="$(python3 -c 'import json;print("\n".join(s["StackName"] for s in json.load(open("'"$OUT"'/cloudformation/stacks.json"))["Stacks"]))')"
  while read -r s; do
    [[ -z "$s" ]] && continue
    aws_main cloudformation list-stack-resources --stack-name "$s" \
      | write "cloudformation/$s.resources.json"
  done <<< "$stacks"
}

# =============================================================================
# Layer B — full logical dump of the production table, ENCRYPTED.
#
# The table is ~88 KB / 144 items. At that size the correct backup is simply
# all of it: gzipped it is a few KB, and git deduplicates the unchanged
# majority night over night. This buys the two things PITR cannot give:
# retention beyond 35 days, and survival of losing the AWS account itself.
# PITR stays on as the FAST path (restore-to-timestamp in minutes); this is
# the deep archive.
#
# ── WHY IT IS ENCRYPTED ──────────────────────────────────────────────────────
# This table holds REAL CUSTOMER DATA: mail items with full bodyText and
# sender addresses, and order records with correspondence logs. Committing
# that to git in the clear would put customer email content on GitHub's
# servers permanently — git history is effectively unrecoverable once pushed,
# and it gets worse as the business grows. Config is safe to commit plainly;
# customer data is not.
#
# ── WHY ASYMMETRIC, AND WHY THAT MATTERS ─────────────────────────────────────
# Encryption uses OpenSSL CMS against a PUBLIC certificate committed at
# infra-snapshots/backup-key.pub.pem. The nightly job therefore needs NO
# secret at all: it can WRITE a backup it cannot READ. A compromised CI
# runner, or a leaked GitHub token, yields nothing. The private key lives only
# in the owner's password manager and is never in this repo, never in GitHub
# secrets, and never on a runner.
#
# The tradeoff, stated plainly: LOSE THE PRIVATE KEY AND THIS LAYER IS GONE.
# It degrades to PITR's 35-day window. Store the key in at least two places.
#
# Restore: see infra-snapshots/RESTORE.md §4.
#
# REVISIT AT ~50 MB: switch to export-table-to-point-in-time into S3 Glacier
# Instant Retrieval and keep only the manifest in git. Nowhere near that yet.
# =============================================================================
MAX_DUMP_BYTES=$((50 * 1024 * 1024))
BACKUP_CERT="$ROOT/backup-key.pub.pem"

snap_table_data() {
  echo "  dynamodb data dump (encrypted)"

  if [[ ! -f "$BACKUP_CERT" ]]; then
    echo "FATAL: $BACKUP_CERT missing — refusing to dump customer data unencrypted." >&2
    echo "       Generate the keypair first: see docs/dr-owner-actions.md §1f." >&2
    exit 95
  fi

  local size
  size="$(python3 -c 'import json;print(json.load(open("'"$OUT"'/dynamodb/kcmps.table.json"))["Table"]["TableSizeBytes"])')"
  if (( size > MAX_DUMP_BYTES )); then
    echo "FATAL: table is ${size} bytes, past the ${MAX_DUMP_BYTES}-byte git-dump threshold." >&2
    echo "       Switch Layer B to export-table-to-point-in-time — see script header." >&2
    exit 92
  fi

  mkdir -p "$OUT/data"
  local plain; plain="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$plain'" RETURN   # plaintext customer data must not outlive this function

  aws_main dynamodb scan --table-name kcmps --consistent-read \
    | python3 -c '
import sys, json
d = json.load(sys.stdin)
# Sort by primary key so the plaintext is byte-stable across runs when the data
# has not changed. ScannedCount/ConsumedCapacity are dropped for the same reason.
items = sorted(d["Items"], key=lambda i: (i.get("PK", {}).get("S", ""), i.get("SK", {}).get("S", "")))
json.dump({"Count": d["Count"], "Items": items}, sys.stdout, indent=1, sort_keys=True)
' | gzip -9 -n > "$plain"
  #      ^^ -n omits the mtime so identical data gzips to identical bytes.

  # CMS uses a fresh random session key every run, so the CIPHERTEXT always
  # differs even when the data is identical — which would produce a commit
  # every single night and destroy the "a commit means something changed"
  # property the rest of this system depends on. So gate re-encryption on a
  # hash of the PLAINTEXT instead.
  #
  # Committing that hash is a deliberate, minor disclosure: it would let
  # someone who already guessed the exact dataset confirm the guess. Against
  # 144 rows of shop data that is not a meaningful attack, and it buys real
  # signal quality. Noted here so the choice is visible rather than assumed.
  local new_hash old_hash
  new_hash="$(sha256sum < "$plain" | cut -d' ' -f1)"
  old_hash="$(cat "$OUT/data/kcmps-table.sha256" 2>/dev/null || echo none)"

  if [[ "$new_hash" == "$old_hash" && -s "$OUT/data/kcmps-table.json.gz.cms" ]]; then
    echo "    unchanged (${size} bytes) — keeping existing ciphertext"
    return 0
  fi

  openssl cms -encrypt -binary -aes-256-cbc \
    -in "$plain" -out "$OUT/data/kcmps-table.json.gz.cms" -outform DER \
    "$BACKUP_CERT"

  echo "$new_hash" > "$OUT/data/kcmps-table.sha256"
  echo "    ${size} bytes scanned, encrypted to CMS/AES-256"
}

# =============================================================================
# Verify. A backup nobody checked is a hypothesis. This runs after every
# snapshot AND can be run standalone in CI to catch a silently-stalled job.
# =============================================================================
verify() {
  echo "verifying…"
  local fail=0

  expect_file() {
    if [[ ! -s "$OUT/$1" ]]; then
      echo "  MISSING or EMPTY: $1" >&2; fail=1
    fi
  }
  expect_min() {  # expect_min <path> <json-expr-yielding-count> <minimum>
    local n
    n="$(python3 -c "import json;d=json.load(open('$OUT/$1'));print($2)" 2>/dev/null || echo 0)"
    if (( n < $3 )); then
      echo "  TOO FEW in $1: got $n, expected >= $3" >&2; fail=1
    fi
  }

  expect_file route53/kcmps.com.json
  expect_file route53/kcmps.com.zonefile.txt
  expect_file data/kcmps-table.json.gz.cms
  expect_file data/kcmps-table.sha256
  expect_file ses/active-receipt-rule-set.json
  expect_file "apigw/$PROD_API_ID/routes.json"
  expect_file cognito/user-pool.json

  # Floors, not exact counts — a NEW resource is fine, a VANISHED one is the
  # alarm. These numbers are the verified 2026-08-13 baseline; raise them
  # deliberately if the real counts grow, never lower them to make CI pass.
  expect_min route53/kcmps.com.json 'len(d["ResourceRecordSets"])' 21
  expect_min "apigw/$PROD_API_ID/routes.json" 'len(d["Items"])' 30
  expect_min ses/active-receipt-rule-set.json 'len(d["Rules"])' 1

  local lambda_count
  lambda_count="$(find "$OUT/lambda" -name 'kcmps-*.json' 2>/dev/null | wc -l)"
  if (( lambda_count < 64 )); then
    echo "  TOO FEW lambda configs: $lambda_count, expected >= 64 (32 prod + 32 staging)" >&2
    fail=1
  fi

  # PITR and versioning are the load-bearing protections. If either flips off,
  # that is an incident, and this is where it gets noticed.
  local pitr
  pitr="$(python3 -c 'import json;print(json.load(open("'"$OUT"'/dynamodb/kcmps.backups.json"))["ContinuousBackupsDescription"]["PointInTimeRecoveryDescription"]["PointInTimeRecoveryStatus"])' 2>/dev/null || echo UNKNOWN)"
  if [[ "$pitr" != "ENABLED" ]]; then
    echo "  ALERT: DynamoDB PITR on kcmps is '$pitr', expected ENABLED" >&2; fail=1
  fi
  for b in kcmps-online-bucket-est-2026 kcmps-payment-uploads-est-2026 kcmps-design-originals-est-2026; do
    local v
    v="$(python3 -c 'import json;print(json.load(open("'"$OUT"'/s3/'"$b"'.versioning.json")).get("Status","NONE"))' 2>/dev/null || echo UNKNOWN)"
    if [[ "$v" != "Enabled" ]]; then
      echo "  ALERT: versioning on $b is '$v', expected Enabled" >&2; fail=1
    fi
  done

  if (( fail )); then
    echo "VERIFY FAILED" >&2
    exit 93
  fi
  echo "verify OK"
}

# =============================================================================
main() {
  if [[ "${1:-}" == "--verify" ]]; then
    verify
    exit 0
  fi

  echo "KCMPS infra snapshot → $OUT"
  snap_route53
  snap_lambda
  snap_apigw
  snap_cloudfront
  snap_ses
  snap_iam
  snap_cognito
  snap_dynamodb
  snap_s3
  snap_events
  snap_cloudformation
  snap_table_data

  check_no_secrets
  verify

  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$OUT/.last-run"
  echo "done."
}

main "$@"
