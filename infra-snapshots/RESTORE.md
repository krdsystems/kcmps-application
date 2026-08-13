# RESTORE — how to use this snapshot when something is broken

**A backup nobody has restored is a hypothesis.** Rehearse the procedures marked
`REHEARSABLE` against staging at least once, before you need them. A restore first
attempted during an outage is a restore being debugged during an outage.

Design and rationale: [`docs/disaster-recovery-and-cicd-plan.md`](../docs/disaster-recovery-and-cicd-plan.md).

---

## Before you touch anything

1. **Find the last-good snapshot.** `git log --oneline -- infra-snapshots/` — each
   commit is one night. `git show <sha> --stat` shows what changed that night, which is
   usually how you identify *when* the break happened.
2. **Diff current reality against the snapshot before restoring.** Re-run
   `./infra-snapshots/infra-snapshot.sh` and `git diff`. The diff tells you what actually
   changed — restoring from a guess is how a small outage becomes a large one.
3. **Never restore over a live resource when you can restore beside it and then switch.**
   This applies especially to DynamoDB (below).

---

## 1. A DNS record is wrong or missing — **highest severity**

Symptom: site unreachable, mail stops arriving or sending, or (13 months later, quietly)
TLS fails because the ACM validation CNAME went missing and the certificate could not
auto-renew.

Reference: `route53/kcmps.com.json` (machine-readable) and `route53/kcmps.com.zonefile.txt`
(human-readable — start here).

> **AGENTS MUST NOT APPLY DNS CHANGES.** Standing rule in this project: Route 53 in account
> `260866268499` is owner-executed only. An agent's job here is to produce the exact
> change-set JSON and hand it over, with an explanation of what each record does. Not to run it.

Procedure:

```bash
# 1. What does the zone look like NOW?
aws route53 list-resource-record-sets --hosted-zone-id Z06397161LBTJCRTPLL62 \
  --profile default --output json > /tmp/zone-now.json

# 2. Diff against the snapshot (the zonefile rendering is easier to eyeball)
diff <(sort infra-snapshots/route53/kcmps.com.zonefile.txt) \
     <(python3 - /tmp/zone-now.json <<'PY' | sort
import json,sys
for r in json.load(open(sys.argv[1]))["ResourceRecordSets"]:
    if "AliasTarget" in r: print(f'{r["Name"]}\tALIAS\t{r["Type"]}\t{r["AliasTarget"]["DNSName"]}')
    else:
        for v in r.get("ResourceRecords",[]): print(f'{r["Name"]}\t{r.get("TTL","-")}\t{r["Type"]}\t{v["Value"]}')
PY
)
```

Then build an `UPSERT` change batch for each missing record and hand it to the owner.

**Zone is `Z06397161LBTJCRTPLL62` in account `260866268499`.** Account `600929977538` also
has a `kcmps.com` hosted zone — it is a **decoy** containing only NS/SOA. Never add records
there and never delegate to it.

What each record group does, so you can triage which matter most:

| Records | Breaks if lost |
|---|---|
| `A` kcmps.com / www / site → CloudFront | The storefront. Immediate, total. |
| `MX` kcmps.com | Inbound customer mail to the shop mailboxes |
| `MX` mirror.kcmps.com | The SES receiving pipeline — the dashboard Email page goes silent |
| 6 `_domainkey` CNAMEs (3 kcmps.com + 3 mirror) | DKIM signing → outbound mail starts landing in spam |
| `TXT` kcmps.com (SPF), `_dmarc` | Deliverability, then reputation |
| `_bebe137c…` CNAME | **ACM certificate renewal.** Silent for ~13 months, then TLS dies. |
| `CNAME` dev.kcmps.com | Staging only — not urgent |
| `SRV` _autodiscover._tcp | Mail client auto-config |

---

## 2. Bad Lambda deploy

**After Phase 2 of the plan (aliases) is done** — the fast path:

```bash
aws lambda list-versions-by-function --function-name kcmps-create-order \
  --profile kcmps-claude-priv --query 'Versions[].Version'
aws lambda update-alias --function-name kcmps-create-order \
  --name live --function-version <previous> --profile kcmps-claude-priv
```

Seconds, no rebuild. **Until aliases exist**, there is no fast path — rebuild the zip from
the last-good commit and `update-function-code`. This gap is exactly why Phase 2 is the
highest-priority CI/CD item.

**If the problem is configuration rather than code** (a dropped env var), reference
`lambda/<function-name>.json` and re-apply the **complete** environment map:

```bash
# Show what the env SHOULD be
python3 -c 'import json;print(json.dumps(json.load(open("infra-snapshots/lambda/kcmps-create-order.json"))["Environment"]["Variables"],indent=2))'
```

> **`update-function-configuration --environment` REPLACES the entire map — it does not
> merge.** Any key you omit is silently deleted. This is the same trap as
> `aws s3 cp --metadata-directive REPLACE`, which took `dev.kcmps.com` down on 2026-08-08.
> Always pass every key from the snapshot, then re-read with `get-function-configuration`
> and diff against the snapshot to confirm. The CLI exit code will not tell you.

---

## 3. Bad frontend deploy

Fastest correct fix — redeploy known-good content, don't hand-patch:

```bash
git checkout <last-good-sha> -- website/
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ \
  --cache-control "no-cache, must-revalidate" --profile kcmps-claude-priv
# Mirror to staging so it doesn't fall behind (2026-08-08 rule)
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ \
  --cache-control "no-cache, must-revalidate" --profile kcmps-claude-priv
```

**If pages DOWNLOAD instead of rendering**, `Content-Type` was destroyed — almost certainly
by `--metadata-directive REPLACE`. Confirm and fix by re-syncing (sync re-derives
`Content-Type` from the file extension):

```bash
aws s3api head-object --bucket kcmps-online-bucket-est-2026 --key index.html \
  --profile kcmps-claude-priv --query '[ContentType,CacheControl]' --output text
# binary/octet-stream on an .html object is the smoking gun
```

S3 versioning is enabled on this bucket (925 versions at last count), so per-object
rollback is also available if you need to be surgical.

---

## 4. Data corruption or a bad bulk write — `REHEARSABLE`

**PITR is the primary path.** 35-day window, restore-to-timestamp, minutes.

```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name kcmps \
  --target-table-name kcmps-restored-$(date +%Y%m%d) \
  --restore-date-time <ISO8601> --profile kcmps-claude-priv
```

> **Restore to a NEW table, verify, then migrate. Never restore over `kcmps`.**
> DynamoDB cannot restore in place anyway, but the instinct to "just put it back" leads
> people to delete the live table first — which destroys the very PITR history they are
> relying on.

**Beyond 35 days, or if the account itself is gone**, use the git dump:

```bash
gunzip -c infra-snapshots/data/kcmps-table.json.gz | python3 -c '
import json,sys
d = json.load(sys.stdin)
print(f"{d[\"Count\"]} items")
'
```

Items are stored in DynamoDB JSON (`{"S": ...}` typed) form, so they feed straight into
`batch-write-item` in batches of 25. Sorted by `PK`/`SK`.

---

## 5. API Gateway route or integration broken

Reference: `apigw/6msg2uho6c/{api,routes,integrations,authorizers,stages}.json`.

The stage is `$default` with `AutoDeploy: true`, so **there is no deployment history to roll
back to** — changes go live instantly and the previous state exists only in this snapshot.
Rebuild the affected route + integration from the JSON.

Route→integration mapping is via `Target: "integrations/<id>"` in `routes.json`, resolved
against `integrations.json`. The JWT authorizer (`kcmps-cognito-jwt`) is referenced by
`AuthorizerId` — restore it first if it is the thing that is missing, since every protected
route points at it.

---

## 6. SES inbound relay deleted — inbound mail stops

Reference: `ses/active-receipt-rule-set.json`.

There is exactly **one** rule set (`kcmps-mirror-inbound`) with **one** rule
(`mirror-single-recipient`): `shop@mirror.kcmps.com` → S3
`kcmps-inbound-mail-est-2026/inbound/`, scan enabled. This single rule is the entire inbound
mail pipeline for the business. Rebuild it from the JSON, then **re-activate the rule set** —
a rule set that exists but is not active does nothing, and this is the step people forget.

`backend/infra/ses-relay.cfn.yaml` describes these resources but is **not a deployed stack**
(its header says so). Deploying it against the live account fails with "already exists"
unless the resources are genuinely gone.

Verify configuration by reading it, never by sending mail that is expected to fail:

```bash
aws ses describe-active-receipt-rule-set --profile kcmps-claude-priv
```

> **Do not test this by sending mail to an unlisted address to "confirm rejection".** That
> produces a real bounce against `kcmps.com`'s sending reputation. On 2026-08-06 exactly
> that test pushed the trailing-24h bounce rate to ~10%, near the level where AWS suspends
> sending — which would kill every customer order notification. `describe-active-receipt-rule-set`
> answers the question directly, for free.

---

## 7. IAM role or policy damaged

Reference: `iam/<role>.role.json`, `.attached.json`, `.inline.<policy>.json`.

Symptom is usually a Lambda failing with `AccessDenied` on something it did yesterday.
Diff the live policy against the snapshot; the inline policies here were built up
incrementally across many sessions and are otherwise recorded only as prose in
`backend/infra/README.md`.

---

## 8. Whole-account loss — the accepted-slow scenario

Target ~1 day. In order:

1. Deploy `foundation.cfn.yaml` → table + GSI1 + Streams
2. Deploy `user-pool-v2.cfn.yaml` → Cognito
3. Deploy `backend-lambdas.cfn.yaml` (parameterised for prod) → Lambdas + API
4. Restore table data from `data/kcmps-table.json.gz`
5. Recreate CloudFront + the two CloudFront Functions from `cloudfront/`
6. Recreate the SES identities + receipt rule; **re-verify the domain** (new DKIM tokens)
7. Owner updates Route 53: `A` records to the new distribution, new DKIM CNAMEs
8. Re-sync `website/` from git

> **Cognito `sub` values do not survive this.** Order history is keyed on `sub`, so every
> customer's order history orphans. There is no fix — this is the same trap documented for
> the user-pool-v2 migration. Accepted; the alternative (a second standby pool) costs more
> than the risk is worth at this scale.

Note steps 6–7 mean **mail deliverability degrades for a while** regardless: new DKIM keys
need DNS propagation and a fresh sending reputation.

---

## Rehearsal log

Record each rehearsal here. An untested procedure in this file is a claim, not a capability.

| Date | Procedure | Against | Result | By |
|---|---|---|---|---|
| 2026-08-13 | §4 — decrypt the Layer B dump with the private key | production snapshot | **PASS** — `{"Count": 144, …}` recovered from ciphertext | owner |
| 2026-08-13 | Full snapshot via CI (OIDC both accounts, encrypt, auto-commit) | live infra | **PASS** — run `31679938179` green after 2 IAM fixes | owner + Claude |

The decrypt rehearsal matters more than it looks: until it was done, the encryption path had
only ever been exercised in the **write** direction. A backup that encrypts correctly but
cannot be decrypted looks identical to a working one from the outside, and the difference
only surfaces on the day it is needed.

**Next rehearsal: #4's PITR half (restore-to-timestamp) against `kcmps-staging`** — still
unproven. Entirely reversible, touches no production resource. Delete the restored table
afterwards so it does not accrue cost.

Also still unproven, in rough priority order: #2 (Lambda config restore from a snapshot env
map), #5 (rebuilding an API route from JSON), #6 (SES receipt-rule rebuild).
