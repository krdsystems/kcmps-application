Run `bash docs/infra-audit-script.sh` (requires the `kcmps-claude-priv` AWS profile to already be
configured locally). This is a read-only AWS CLI audit — do not create, modify, or delete any AWS
resource, and do not run any `aws cloudformation deploy`/`s3 sync`/`lambda update-function-code`
etc. commands. Just capture the output.

Then compare what the script actually returned against what these files *claim* is deployed:
- Root `CLAUDE.md` (the "Key files — feature → location" table, especially rows for Cognito user
  pool v2, staging backend, dev domain, foundation stack)
- `docs/roadmap.md` (Milestone 1 checklist items marked `[x]`/done, and the Design Asset
  Library / Staff Email / Operating-hours-SLA / Customer-chat sections' "shipped"/"in progress"
  claims)
- `backend/infra/README.md` (stack names, Lambda names/runtimes, API Gateway routes, legacy
  Cognito group retirement status)
- `docs/cost-governance.md` (the Cost Explorer baseline and decision log — check nothing's grown
  unexpectedly)

Produce a single markdown report at `docs/infra-audit-<today's date>.md` with these sections:

1. **Confirmed live and matching docs** — resources that exist exactly as documented.
2. **Drift found** — anything documented as done/deployed that the script shows is missing,
   different (wrong runtime, wrong stack name, extra/fewer routes, etc.), or in a bad state
   (e.g. `ROLLBACK_COMPLETE`). Be specific: quote the doc's claim next to the actual CLI output.
3. **Undocumented resources** — anything the script found that isn't mentioned in any of the
   files above (could be leftover test infra, could be something real that docs never caught up
   to).
4. **Specifically answer:**
   - Is `kcmps-backend-staging` actually deployed and does it mirror production's Lambda count/
     routes, or has it drifted?
   - Is SES production access actually approved now, or still sandboxed? (This gates every
     customer email touchpoint — see `docs/roadmap.md`'s notes on `FROM_EMAIL` being unset.)
   - Do the legacy Cognito groups (`Staff`, `Customers`) still exist in the pool alongside
     `Admin`/`Customer`/`Production`/`Sales`/`Finance`?
   - Does the CloudFormation stack list match exactly what `backend/infra/README.md` and
     `storefront-infra/CLAUDE.md` (if present) describe as applied, with no orphaned or
     rolled-back stacks?
   - Any Lambda still on a runtime `backend/CLAUDE.md`/`docs/history.md` says was migrated off
     (the Node.js 20.x EOL migration mentioned in the root `CLAUDE.md`)?

Do not edit any other file, do not fix any drift you find — this is audit-only. Stop after
writing the report and give me a short summary in chat (a few sentences: how much drift, the
answers to the 5 bullet questions above, and the report's file path).
