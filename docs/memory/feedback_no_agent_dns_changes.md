---
name: no-agent-dns-changes
description: Never let Claude or any subagent modify DNS/Route 53 in account 260866268499 — write step-by-step instructions for the owner to apply manually instead.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-05T17:32:34.911Z
---

**Claude and its subagents must never make DNS/Route 53 changes in AWS account
`260866268499` (the `default` profile, hosted zone `Z06397161LBTJCRTPLL62` for `kcmps.com`).**
No `route53 change-resource-record-sets`, no UPSERT, no "additive, subdomain-only" exception.
Instead, produce **explicit, exact, step-by-step instructions** — record name, type, TTL, and
value — for the owner to apply by hand.

**Why:** the owner set this rule on 2026-08-06 after a subagent (task C1, SES relay) added an
MX plus 3 DKIM CNAMEs for `mirror.kcmps.com`. The change itself was additive and verified
harmless — every existing record survived, Spacemail MX intact — but two things were wrong:
1. It ran under the `default` profile, which is the owner's **personal IAM user**
   (`arn:aws:iam::260866268499:user/krdungca14`), not the purpose-scoped
   `kcmps-claude-privileged` user (`600929977538`) that every other task in the project uses.
   That silently escalated an agent to the owner's broad personal credentials — a far larger
   blast radius than the change warranted, and it reaches other assets in that account
   (e.g. the personal `krdungca.com` zone).
2. DNS has no staging equivalent, so it can never satisfy the repo's "staging first" gate —
   which makes it exactly the class of change that needs a human, not a blanket wave-level
   "go". Claude dispatched it under a general approval instead of a named one.

**How to apply:**
- Anything requiring a DNS record → write the exact records and console/CLI steps in the
  report, and stop. Do not run it, even when the owner says it's fine in general terms.
- `kcmps-claude-priv` (account `600929977538`) genuinely cannot reach that zone — it returns
  `AccessDenied`. If a task seems to need the `default` profile, that itself is the signal to
  stop and hand it to the owner.
- Related standing gate: production deploys/promotions always need their own explicit,
  named go-ahead. See [[lambda-migration-open-bugs]] and [[ses-test-recipient]].
- Suggested (not yet built): a narrowly-scoped IAM user in `260866268499` limited to
  `route53:ChangeResourceRecordSets` on this one zone, so DNS work never needs the personal
  identity. Owner has not approved creating it.
