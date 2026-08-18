# RESTORE — how to use this snapshot when something is broken

**A backup nobody has restored is a hypothesis.** As of 2026-08-18, every procedure below
has been rehearsed at least once — see the rehearsal log in §4 for what each one actually
proved, and the honest scope caveats on the two (DNS, SES) that couldn't be full
damage-and-recover tests. A restore first attempted during an outage is a restore being
debugged during an outage; that's no longer the position this repo is in.

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

## 4. Data corruption or a bad bulk write — rehearsed 2026-08-13, PASS

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
| 2026-08-13 | §4 — **PITR restore-to-point-in-time**, damage-and-recover | `kcmps-staging` | **PASS**, 4/4 checks — see below | owner + Claude |
| 2026-08-18 | §1 — **DNS record restore**, damage-and-recover via the detect/generate/execute relay | production zone `Z06397161LBTJCRTPLL62` | **PASS** — see below | owner + Claude |
| 2026-08-18 | §2 — **Lambda config restore**, damage-and-recover, dropped keys + corrupted value | `kcmps-staging-create-order` | **PASS**, 2/2 checks — see below | Claude |
| 2026-08-18 | §5 — **API route rebuild**, damage-and-recover, deleted route + integration | staging API `162ufc121j` | **PASS** — see below | Claude |
| 2026-08-18 | §6 — **SES rule rebuild**, structural proof via a throwaway rule set (no live damage) | production SES | **PASS** — see below | Claude |

The decrypt rehearsal matters more than it looks: until it was done, the encryption path had
only ever been exercised in the **write** direction. A backup that encrypts correctly but
cannot be decrypted looks identical to a working one from the outside, and the difference
only surfaces on the day it is needed.

### The 2026-08-13 PITR rehearsal — what it proved, and what it exposed

Deliberately **not** a smoke test. "The restore command succeeded" proves almost nothing;
the question worth answering is *"can I undo a specific bad thing?"* So staging was damaged
on purpose and the restore had to reverse it:

1. Enabled PITR on `kcmps-staging` (it was **off** — found at rehearsal time; ~₱0.002/mo at
   130 KB, now left on permanently so staging resembles production)
2. Recorded `T0` from `LatestRestorableDateTime` while the table was known intact
3. **Damaged it**: wrote a `REHEARSAL#…/MARKER` item, deleted 3 real `SCAN#` items
   (259 → 257)
4. Waited for `LatestRestorableDateTime` to advance past the damage
5. Restored to `T0` into `kcmps-staging-restored-20260813`

| Check | Result |
|---|---|
| Marker item **absent** from restored table | PASS |
| 3 deleted items **present** again | PASS |
| Item count matches pre-damage (259) | PASS |
| **Exact set equality** — 0 missing, 0 extra | PASS |

Staging was then returned to a byte-identical baseline (verified by full-scan diff: 0
missing, 0 extra, 0 differing) and the restored table deleted.

### ⚠️ What a restored table does NOT inherit

The real value of the rehearsal. A restored table is **not** a drop-in replacement, and
these gaps are silent — the data looks perfect while the plumbing around it is missing:

| Setting | Source | Restored | Consequence if unnoticed |
|---|---|---|---|
| **DynamoDB Streams** | Enabled | **OFF** | **The most dangerous one.** `streams-handler` is driven by the stream. Repoint the app at a restored table and event processing silently stops — no error, no alarm, just nothing happening. The event source mapping must be recreated and re-pointed. |
| **PITR** | Enabled | **OFF** | Your restored table has no backup. Re-enable immediately or a second incident has no recovery. |
| **Deletion protection** | On | **OFF** | Convenient for cleanup, dangerous if the restored table becomes the live one. |
| GSI1 | Present | **Present, ACTIVE** | Carries over correctly — verified, since several read paths depend on it. |
| Tags | none | none | n/a here |

**So a real production recovery is not "restore and repoint".** It is: restore → re-enable
PITR → recreate the stream + event source mapping → re-enable deletion protection → *then*
repoint. Anything less leaves a table that passes an item count and fails in production.

Also worth knowing: a freshly restored table reports `ItemCount: 0` and `TableSizeBytes: 0`.
That metadata only refreshes about every 6 hours — **it is not evidence the restore failed.**
Always verify with an actual `scan`, as above.

### The 2026-08-18 DNS restore rehearsal — what it proved, and its scope

**This is the one procedure agents cannot execute end-to-end by design** — the standing rule
(§1 above) is that Route 53 writes are owner-only. So the rehearsal shape is different from
the DynamoDB one: it proves the **detect → diff → generate → execute → verify relay**, with
the owner performing both writes and Claude performing everything else.

1. Owner ran a `CREATE` for a throwaway TXT record (`dr-rehearsal-2026-08-18.kcmps.com`) —
   an isolated subdomain, nothing live depends on it
2. Claude re-read the live zone (read-only) and confirmed drift: 21 → 22 records
3. Claude diffed live against `route53/kcmps.com.zonefile.txt` — the diff isolated **exactly
   the one changed line**, nothing else
4. Claude generated the restore `DELETE` change-batch **from the live read, not from
   memory** — matching name/type/TTL/value exactly, since Route 53 requires an exact match
   to delete a record
5. Owner ran the generated `DELETE`
6. Claude re-read and diffed again: **0 missing, 0 extra, exit code 0** — zone is
   byte-identical to the snapshot baseline

| Check | Result |
|---|---|
| Drift detected correctly (21→22, isolated to the 1 real change) | PASS |
| Restore change-batch generated from live data, not guessed | PASS |
| Zone returns to exact snapshot baseline post-restore | PASS |

**Scope, stated plainly:** this proved the *mechanism* — the generation logic is identical
regardless of which record it targets, since it always derives the change-batch from a live
read rather than from memory. It did **not** rehearse recovering a genuinely critical record
(MX, a DKIM CNAME, or the ACM validation CNAME) — deliberately breaking one of those even
briefly isn't a test worth running. Treat the mechanism as proven; treat "restoring MX under
real pressure" as one inference away from proven, not identical to it.

### The 2026-08-18 Lambda config restore rehearsal — what it proved

Unlike DNS, no standing rule blocks agents from executing Lambda config changes — so this
one ran fully agent-side, against staging rather than production to keep it low-stakes and
reversible.

**Target:** `kcmps-staging-create-order`, picked deliberately because its environment is
richer (4 keys) than the first candidate tried (`kcmps-staging-dashboard-prefs`, 1 key) — a
thin env doesn't exercise the "dropped key among several" trap convincingly.

**Worth knowing before reading the steps:** this function's env vars are actually defined in
`backend-lambdas.cfn.yaml` (the `kcmps-backend-staging` stack owns it), so for *staging*
specifically, a full `cloudformation deploy` would also have fixed this. The CLI-based
restore below was rehearsed anyway because **production Lambdas have no such template at
all** — they are 100% CLI-managed with zero CloudFormation backing — so the CLI path is the
*only* option there, and is the one that actually needed proving.

1. Read live config, confirmed **byte-identical** to the committed snapshot before touching
   anything
2. Damaged it with one `update-function-configuration --environment` call, recreating two
   real failure modes at once: dropped `COGNITO_CLIENT_ID` and `UPLOADS_BUCKET` entirely,
   corrupted `TABLE_NAME` to `kcmps-WRONG-TABLE`
3. Diffed live against `lambda/kcmps-staging-create-order.json` — **all three problems
   isolated correctly**, nothing missed, nothing spurious
4. Restored using the **complete** map read from the snapshot file, not a patch of just the
   broken keys — this is the actual point of the rehearsal, since `--environment` replaces
   the whole map and a partial fix would silently re-drop whatever it didn't mention
5. Verified

| Check | Result |
|---|---|
| Restored env vars match the snapshot exactly | PASS |
| Nothing else on the function drifted (Timeout/MemorySize/Runtime/Role unchanged) | PASS |

CloudFormation stack status stayed `UPDATE_COMPLETE` throughout — the CLI patches didn't
register as drift against the stack, so no separate reconciliation was needed on staging.

### The 2026-08-18 API route rebuild rehearsal — what it proved, and one real finding

Ran fully agent-side against **staging** (`162ufc121j`), not production — no standing rule
blocks this, but there's no reason to risk a live route when staging proves the same
mechanism.

**Target:** `POST /orders/manual`, picked because its integration (`kuhokb4`) was **not**
shared with any other route — several staff-pin and order-verification routes share a single
integration across up to 5 routes each, and deleting one of those would have taken out
multiple endpoints for one test. This one's blast radius was exactly one route.

1. Captured live route + integration, confirmed both **byte-identical** to the committed
   backup before touching anything
2. Deleted **both** the route and its integration — the worst realistic case (a bad bulk
   delete or deploy script wiping both, not just one)
3. Confirmed `POST /orders/manual` fully gone from `get-routes`
4. Diffed live route keys against the backup — the missing route was isolated correctly,
   nothing else flagged
5. Rebuilt in the order the runbook specifies: **integration first**, then the route pointing
   at it, with the JWT authorizer (`67s34x`) explicitly reattached
6. Verified

| Check | Result |
|---|---|
| Integration fields match the backup exactly | PASS |
| Route's `AuthorizationType`/`AuthorizerId`/Lambda target match, after normalizing two fields — see finding below | PASS |
| Full route count restored (30), 0 missing / 0 extra vs. backup | PASS |

**Finding: a rebuilt route is not byte-identical to the original, even when it's functionally
correct.** `create-route` doesn't populate `AuthorizationScopes`/`RequestModels` the same way
a route created through the original tooling did — the field is simply *absent* on the
rebuild rather than present-as-empty. Behaviorally identical (API Gateway treats a missing
optional field and an empty one the same way), but a naive byte-diff would report FAIL on a
functionally perfect restore. Worth knowing before trusting an automated "did it match"
check for this resource type.

**Also worth knowing: AWS always assigns fresh `RouteId`/`IntegrationId` values on create —
the original IDs (`ph9ltcn`/`kuhokb4`) cannot be restored, only the content can.** This
means the committed snapshot goes stale immediately after any real API restore (it still
references the deleted IDs) until the next snapshot runs. **A fresh snapshot should always
be triggered manually right after a real API restore**, not left for the nightly schedule —
done here via `workflow_dispatch`, confirmed green.

### The 2026-08-18 SES rule rebuild rehearsal — deliberately NOT a live-damage test

**This one could not be shaped like the others.** There is exactly **one** SES receipt rule
set in the entire account — `kcmps-mirror-inbound` — and no staging equivalent exists to
damage safely. It is the live inbound-mail pipeline for the whole business. Deactivating or
deleting it, even briefly, risks real customer mail loss during the test window. That is not
a cost worth paying to prove a point, so the real pipeline was never touched.

Instead: proved the **reconstruction mechanism** without ever putting the real pipeline at
risk, using the fact that an SES rule set only affects mail routing once explicitly
activated — an inactive one is completely inert regardless of its content.

1. Confirmed the real rule set was the sole one, active, before starting
2. Created a **throwaway** rule set (`kcmps-dr-rehearsal-2026-08-18`) reproducing the real
   rule's exact content byte-for-byte — same recipient, same S3 target, same scan/TLS
   settings — **never activated**
3. Confirmed the real active rule set was still `kcmps-mirror-inbound` throughout (proof the
   throwaway never became live)
4. Diffed the throwaway's rule content against the backup — **exact match**
5. Deleted the throwaway
6. Re-confirmed: exactly one rule set exists, active, content identical to the backup (the
   only difference is `CreatedTimestamp`, which the backup normalizer deliberately strips as
   volatile — `Rules`, the part that matters, is untouched)

| Check | Result |
|---|---|
| Rebuilt rule content matches the backup exactly | PASS |
| Real rule set remained the sole active one throughout | PASS |
| Real rule set's content unchanged after cleanup | PASS |

**Scope, stated as plainly as the DNS rehearsal's:** this proves the reconstruction mechanism
— the `create-receipt-rule-set` / `create-receipt-rule` calls produce byte-correct structure
from the backup JSON. It does **not** prove recovering from an actual outage where the real
rule set is gone and inbound mail is already down — that scenario additionally requires the
`set-active-receipt-rule-set` activation step, which was deliberately never exercised here
because there is no safe way to test it without a moment of real risk. Treat activation as
one documented, unrehearsed step, not an unknown one — see §6 above for the exact command.

### Still unproven

Nothing on the original list remains. Every documented restore procedure (§1 DNS, §2 Lambda
config, §4 DynamoDB, §5 API routes, §6 SES) has now been rehearsed at least once. What
hasn't been rehearsed: §2's *code* rollback path (Lambda aliases, blocked on CI/CD Phase 2
not being built yet), and SES's activation step specifically (see above).
