# AI employee proposal — KCMPS (2026-08-06)

Owner's ask: given otherwise-idle Claude Code subscription hours, what recurring "employee"
role(s) would actually earn their keep on this repo — both as a genuine force-multiplier for a
solo dev and as a way to not waste paid capacity that's sitting idle.

This is a **proposal document, not an implementation**. Nothing in this repo was changed to
produce it beyond this file.

---

## 1. What recurring work actually exists here (evidence, not speculation)

Five things keep recurring, each with a paper trail:

**(a) Infra-vs-docs drift audits.** Two full audits already happened by hand —
`docs/infra-audit-2026-08-05.md` and `docs/infra-audit-2026-08-06.md` — both using the same
tool: `docs/infra-audit-script.sh` (a read-only AWS CLI sweep) plus a hand-written brief,
`docs/claude-code-infra-audit-prompt.md`, that tells a session how to diff the script's output
against five specific docs. The second audit's own text says "whoever ran the master-plan
branch... acted on the previous audit's findings directly" — i.e. this is already a loop, just
a manually-restarted one. The second audit also caught something a doc-diff alone wouldn't:
**the live production website was 48 of ~52 files stale** relative to `main`, entirely separate
from the AWS-resource drift the script checks. That's a second, distinct check (live site vs.
repo) riding along in the same report.

**(b) Deploy-gate discipline enforced only by convention.** Root `CLAUDE.md` states a hard rule
("staging first, production only on the owner's explicit go-ahead") in the imperative, not as
tooling — there is no hook or gate that would stop a session from running the production sync
command back-to-back with the staging one. The 2026-08-06 audit's headline finding (stale prod
site) is a direct symptom of nothing checking this after the fact.

**(c) A hard rule that has already been violated once.** The root `CLAUDE.md`'s "Hard rule:
sending email during testing" section documents, by name and date, a 2026-08-06 incident where
a subagent brief told a session to "confirm SES rejects" a bad address — producing a real bounce
and pushing the trailing bounce rate to ~10% (AWS suspends near there). The section explicitly
says future sessions should "audit \[a task's] verification steps against both rules... before
dispatching." That's a standing instruction for a check nobody but the CLAUDE.md text currently
performs.

**(d) Doc drift as a general pattern, not just infra.** `docs/history.md` and `docs/roadmap.md`
both contain repeated after-the-fact corrections: stale SES status, stale Lambda/alarm counts,
a stale rejection-vs-hold status name, `roadmap.md`'s 1.4 checklist marked done "with the still-
owed live-verification" caveat. `backend/CLAUDE.md` itself documents catching `node --test
backend/lib/` (bare directory form) as a silently-passing false green — the kind of thing a
convention-aware reviewer catches and a generic linter wouldn't.

**(e) UAT/regression passes, done manually, repeatedly.** `docs/history.md` entry 58
("Adversarial UAT pass"), entry 2775 (owner UAT catching a 45-second-timeout bug the build
missed), the 1.5 roadmap entry ("closes real gaps found in 1.4's UAT pass"), and
`README.md`'s "Testing checklist for storefront changes" — all instances of a human (or an
ad-hoc session) re-walking known flows (checkout, cart, mobile layout) after a change, looking
for regressions against documented gotchas.

**Not recurring enough to justify a dedicated role:** cost governance. It's real and
documented (`docs/cost-governance.md`'s decision log), but changes that add cost are infrequent
and already require the author to write a justification inline — folding a cost check into the
infra auditor (below) covers it without a second standing job.

---

## 2. Recommended roster — small, on purpose

Three roles. Each maps to a mechanism already native to Claude Code; none require new
infrastructure.

### 2.1 `infra-drift-auditor` (subagent) — build this one first

- **Job**: run the existing read-only AWS sweep, diff its output against what the docs claim,
  diff the live S3 bucket against `website/` in the repo, and write a dated report.
- **Why this repo needs it**: this exact workflow already happened twice by hand, already has a
  script and a brief written for it, and already caught a launch-blocking issue (stale prod)
  that no other check in the repo would surface. It is the most validated, lowest-risk,
  highest-evidence candidate on this list — there is nothing hypothetical about its value.
- **Mechanism**: subagent (`.claude/agents/infra-drift-auditor.md`), invoked on demand today;
  candidate for a scheduled cloud run later once the owner is comfortable with unattended AWS
  read calls (see §5).
- **Trigger**: manually today (`/agents infra-drift-auditor` or equivalent), or after any
  session that touches `backend/infra/*.cfn.yaml`, deploys a Lambda, or changes DNS/Cognito/SES
  config. Not needed after a pure `website/` content edit with no infra change.
- **Allowed to touch**: read-only AWS CLI calls under `kcmps-claude-priv`/`kcmps-claude-ro`,
  read any file in the repo, write exactly one new file: `docs/infra-audit-<date>.md`.
- **Must never**: run any `create`/`update`/`delete`/`put`/`sync` AWS command, run
  `aws s3 sync ... s3://kcmps-online-bucket-est-2026/` (even the dev-site prefix — that's a
  write), touch Route 53 in account `260866268499` (standing rule, see memory), send any email,
  edit any file other than the new report.
- **Output**: a markdown report matching the existing two audits' shape (confirmed-live,
  drift-found, undocumented-resources, the five specific questions the prompt file already
  asks) — plus a short chat summary, never silently filed.

### 2.2 `deploy-gate-checker` (skill, invoked at the point of production sync)

- **Job**: before any `aws s3 sync website/ s3://kcmps-online-bucket-est-2026/` (no `dev-site/`
  suffix — i.e. the production target) or any `kcmps-*` (non-`-staging`) Lambda deploy command,
  confirm in the transcript that (1) the equivalent staging/dev command already ran this
  session or a very recent one, (2) the owner gave an explicit go-ahead phrase after seeing the
  staged result, not implied approval. If either is missing, refuse and say so instead of
  running the command.
- **Why this repo needs it**: this is the single most explicit, most-repeated rule in the whole
  `CLAUDE.md` ("staging first... never infer approval from 'looks good' or silence"), and the
  one audit finding that actually blocked a launch (stale prod) is exactly the failure mode this
  catches. A rule stated only in prose is a rule that erodes under time pressure across sessions
  that don't all read it the same way.
- **Mechanism**: a skill (`.claude/skills/deploy-gate-checker/`) rather than a hook, because the
  check is judgment-shaped ("did the owner actually say yes," not a regex) — a `PreToolUse` hook
  on `Bash(aws s3 sync*)` could do a cheaper mechanical version (block if the command targets the
  bucket root with no `dev-site/` in the last N tool calls) as a hard backstop underneath the
  skill. Recommend building the hook too, since it can't be talked past the way a skill
  instruction theoretically could.
- **Trigger**: automatically, the moment a production-targeting deploy command is about to run.
- **Allowed to touch**: nothing by itself — it's a gate, not an actor. It either lets the
  existing command through or blocks it with an explanation.
- **Must never**: approve itself, infer consent from silence, run the production command on the
  user's behalf even when asked to "just ship it" without having shown a staged result first.
- **Output**: pass-through (command runs) or a clear chat block with what's missing.

### 2.3 `pre-dispatch-brief-auditor` (skill, checks a task brief before it's sent to a subagent)

- **Job**: before dispatching any subagent task (via the `Agent` tool) whose brief mentions
  email/SES, Route 53/DNS, or a delete/rm/destructive AWS call, check the brief against the
  three standing hard rules (SES test-recipient allowlist + no-bounce-as-proof, no agent DNS
  changes, no hard-deletes) and flag contradictions before the subagent runs, not after.
- **Why this repo needs it**: this is not hypothetical — it is the literal postmortem written
  into `CLAUDE.md` right now. The 2026-08-06 bounce incident happened because a brief contained
  a self-contradictory instruction and nothing caught it before dispatch. The fix that
  `CLAUDE.md` prescribes ("audit its verification steps against both rules... before
  dispatching") is a checklist step today; making it a mechanical pre-flight check removes the
  single point of failure of a human or a distracted orchestrating session forgetting to do it.
- **Mechanism**: skill, invoked by the orchestrating session itself right before any `Agent`
  tool call whose prompt matches the trigger keywords above — cheap (keyword-gated, not run on
  every dispatch) and stays in the orchestrator's own context rather than spending a subagent
  invocation on it.
- **Trigger**: automatically, pre-dispatch, keyword-gated (mail/SES/email, DNS/Route 53, delete/
  rm/purge/hard-delete) so it doesn't fire on unrelated briefs.
- **Allowed to touch**: nothing — read-only over the brief text, never over AWS or the repo.
- **Must never**: rewrite the brief silently and dispatch anyway — it must surface the
  contradiction to the user/orchestrator and require an explicit resolution.
- **Output**: pass (dispatch proceeds) or a flagged contradiction quoting the offending brief
  text and the rule it conflicts with.

---

## 3. Starting implementation — `infra-drift-auditor`

This is the one to build today; it's copy-pasteable as-is. Save as
`.claude/agents/infra-drift-auditor.md`:

```markdown
---
name: infra-drift-auditor
description: >
  Read-only auditor that compares KCMPS's actual deployed AWS state (and the live
  production website) against what the repo's docs claim is deployed. Use when: infra/backend
  changes just merged, before a production promotion, or on a periodic idle-capacity cadence
  (see docs/ai-employee-proposal-2026-08-06.md §5). Produces docs/infra-audit-<date>.md and a
  short chat summary. Never invoke this to make changes — it is audit-only by construction.
tools: Bash, Read, Grep, Glob, Write
model: sonnet
---

You are KCMPS's infra-drift auditor. Your only job is to find gaps between what AWS actually
has deployed and what this repo's docs claim — plus a separate check of what's actually live
on kcmps.com vs. what's in the repo. You never fix anything you find; you report it.

## Hard rules — read before doing anything

- **Read-only, no exceptions.** Every AWS CLI call you run must be a `describe-*`, `get-*`,
  `list-*`, or `--dryrun` command. Never run `create-*`, `update-*`, `put-*`, `delete-*`, or a
  non-dryrun `aws s3 sync`. If you are unsure whether a command mutates state, don't run it —
  ask instead.
- **Never touch Route 53 in account 260866268499.** `list-hosted-zones`/`list-resource-record-
  sets` (read) are fine; anything else in that account is off-limits even read-adjacent if it's
  ambiguous — stop and ask.
- **Never send email**, under any circumstance, for any reason, as part of this audit.
- **Write exactly one file**: `docs/infra-audit-<YYYY-MM-DD>.md` (today's date). Do not edit
  any other file — not even to fix a typo you notice, not even in a doc you're auditing.
- Use the `kcmps-claude-priv` profile (or `kcmps-claude-ro` if that's what's configured)
  and region `ap-southeast-1` for AWS calls, `default` profile only for the read-only Route 53
  hosted-zone check in the other account.

## Procedure

1. Run `bash docs/infra-audit-script.sh` and capture its full output. This is the same script
   the two prior manual audits (`docs/infra-audit-2026-08-05.md`, `docs/infra-audit-2026-08-06.md`)
   used — don't reinvent the sweep, extend it only if you find a real gap in its coverage.
2. Additionally run `aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile
   kcmps-claude-priv --dryrun` and `... /dev-site/ --dryrun` to check the live site (both prod
   and dev prefixes) against the repo's `website/` — this caught the single biggest finding in
   the 2026-08-06 audit and must not be skipped.
3. Compare the script's output and the sync dry-runs against what these files claim:
   - Root `CLAUDE.md`'s "Key files" table (Cognito pool v2, staging backend, dev domain,
     foundation stack rows especially)
   - `docs/roadmap.md` (Milestone checkboxes, and any section marked shipped/in-progress)
   - `backend/infra/README.md` (stack names, Lambda names/runtimes, routes, legacy Cognito
     group status)
   - `docs/cost-governance.md` (decision log — flag anything that looks like it grew
     unexpectedly, but do not attempt to price it yourself beyond what's already documented)
4. Write `docs/infra-audit-<date>.md` with these sections, matching the shape of the two prior
   audits so a reader can diff across dates:
   - **Confirmed live and matching docs**
   - **Drift found** — quote the doc's claim next to the actual CLI output for each item
   - **Undocumented resources** — anything found that no doc mentions
   - **Live-site-vs-repo check** — the sync --dryrun results, called out as their own section
   - **Answer explicitly**: staging mirrors production Lambda count/routes or has drifted;
     SES production access status; legacy Cognito groups still present or cleaned up;
     CloudFormation stack list matches docs with no orphaned/rolled-back stacks; any Lambda
     still on a retired runtime.
5. Stop. Do not fix anything. Report back in chat: a few sentences — how much drift, answers to
   the explicit questions above, whether the live site matches the repo, and the report's file
   path. If you found nothing wrong, say that plainly too — a clean audit is a useful result,
   not a failure to find something.

## What "done" looks like

One new file (`docs/infra-audit-<date>.md`), zero other file changes, zero AWS mutations, a
short chat summary. If at any point a check would require a mutating call to answer (e.g. "is
this IAM policy actually enforced" sometimes wants a real request) — don't make the call; note
the check as unavailable read-only and let the owner decide whether to run it themselves.
```

Notes on this implementation:
- It's deliberately a thin wrapper around work already proven out by hand twice — the value is
  making the loop restart itself instead of needing a human to remember to re-run it.
- `tools` is scoped to `Bash, Read, Grep, Glob, Write` — no `Edit` (it should never modify an
  existing file, only write the one new report) and no `Agent` (it shouldn't spawn further
  subagents for a bounded, well-understood task).
- The live-site-vs-repo dry-run check is folded in explicitly because it was the single highest-
  value finding in the most recent real audit and is easy to omit if not called out by name.

---

## 4. Rejected candidates and why

- **UAT/regression runner as its own subagent.** Real recurring work (§1e), but almost all of
  it needs a real browser against a real Cognito login to be worth anything (see the "Blocking
  verification gap" in the owner's own open-actions memory — Claude cannot enter passwords, so
  most UAT is either config-level or needs a pasted token). Automating it fully would mean
  either weakening the credential-entry prohibition or accepting a shallow, browser-less
  approximation that wouldn't have caught the bugs `docs/history.md` records (a 45-second
  timeout, a stale-lightbox-design bug — both needed real interaction). Better as a checklist a
  human runs, with Claude driving the browser live in a session when a token is supplied, not
  as a standing unattended job.
- **Security sweeper (CSP/headers/XSS/upload-allowlist).** The repo already has strong
  fail-closed conventions baked into the code (GuardDuty gates, `redactForCustomer()`,
  content-type+extension double-checks) and a `security-review` skill already exists in this
  Claude Code install for on-demand use. A standing agent duplicating that skill's job adds a
  second thing to keep in sync with the first, for no clear gap the skill doesn't already cover.
  Recommend using the existing `security-review` skill before any deploy-affecting merge instead
  of building a parallel role.
- **Cost-governance watchdog as its own agent.** Real and documented, but low-frequency (each
  entry in the decision log corresponds to a deliberate infra change, not a background drift)
  and already requires the change's author to write the justification inline per
  `docs/cost-governance.md`'s own rule. Folded into the infra-drift-auditor's scope (§2.1, step
  3) instead of a fourth standing job — a dedicated watchdog would mostly sit idle between infra
  changes.
- **Convention/code-reviewer trained on the gotchas list.** Tempting given how detailed
  `CLAUDE.md`'s "Conventions and gotchas" section is, but this is exactly what `CLAUDE.md`
  itself already does for every session automatically (it auto-loads at session start) plus
  the existing `code-review`/`simplify` skills for on-demand deep review. A dedicated agent here
  would mostly re-derive context already in front of every session by default — not a gap.
- **General "docs drift" agent broader than infra.** Real pattern (§1d), but the infra-drift-
  auditor already covers the highest-stakes slice (docs claiming AWS state that isn't real).
  Prose drift in `docs/history.md`/`docs/roadmap.md` narrative sections is lower-stakes (nobody
  ships a bug because a history entry's wording is stale) and better caught opportunistically —
  ask a session to sanity-check the relevant roadmap section whenever a feature it describes is
  touched, rather than a standing job scanning ~4,200 lines of prose on a timer.

---

## 5. Using idle capacity safely

The owner's second motivation — not wasting paid idle hours — has a clean split in this repo:
what's safe to run unattended (read-only, no external side effects) vs. what genuinely needs a
human watching (anything that mutates production, sends mail, or deletes data).

**Safe to run unattended, in rough priority order:**

1. **`infra-drift-auditor` (§2.1/§3)** on a schedule — e.g. weekly, or triggered right after any
   merge that touches `backend/infra/`, `backend/*/`, or `.cfn.yaml` files. Fully read-only by
   construction; worst case it's a report nobody needed yet.
2. **Doc/roadmap sanity passes** — pick one roadmap section per idle run and check its
   "done"/"shipped" claims against the actual code (not AWS — just repo-internal consistency,
   e.g. "does `dashboard-shell.js`'s `NAV_ITEMS` really not have `soon: true` on the page this
   section says shipped"). Cheap, read-only, catches the §1d pattern without a 4,200-line sweep.
3. **Research/drafting for the next roadmap milestone** — read `docs/roadmap.md`'s next
   unstarted section plus the relevant `project_knowledge/*.md` file and draft an implementation
   plan (not code) for the owner to review at the start of the next real session. Pure research
   and writing, no repo mutation.
4. **`backend/lib/` test-coverage gap analysis** — the owner's open-actions memory already flags
   this as an owed report ("14 modules, only 2 test files... module → coverage, ranked by blast
   radius"). Reporting-only, explicitly deferred, a good idle-hours candidate that's already
   scoped and waiting.

**Not safe to run unattended, ever, regardless of schedule:**

- Anything invoking the production `aws s3 sync` (no `dev-site/` prefix) or a non-staging Lambda
  deploy — owner-gated by explicit rule, no exception for "it was just docs."
- Anything sending real email, including a "just to verify SES config works" send — the
  permitted-recipient rule has no unattended carve-out, and the one violation on record happened
  under exactly that kind of reasoning.
- Anything touching Route 53 in account `260866268499` — standing rule, hand the owner exact
  steps instead.
- Anything with a delete/purge/hard-delete AWS call in its path, even read-adjacent ones like
  `--dryrun` deletes that could be miscopied into a real one by a later edit to the schedule.

**Concrete cadence proposal:** weekly `infra-drift-auditor` run (Monday, before the owner's
first session of the week) plus opportunistic doc-sanity/research runs filling genuinely idle
gaps between sessions — not a dense schedule, since the repo's actual rate of infra change is
low enough that daily audits would mostly report "no change" and burn tokens finding that out.

---

## 6. Onboarding a future human teammate alongside these

Two things make this easier here than in most repos, and both are already in place:

- **`CLAUDE.md` + `docs/history.md` are already a reasonably complete onboarding doc.** A human
  joining could plausibly read root `CLAUDE.md`, `docs/roadmap.md`, and the last ~10 entries of
  `docs/history.md` and be as oriented as a fresh Claude Code session. Point them there first,
  not at a separate onboarding doc that would just duplicate it and drift.
- **The agent roster above should be introduced as tools the human uses, not replaces.** A human
  teammate should be the one who says "looks good, push it to prod" (the deploy-gate-checker's
  required human signal), the one who supplies a Cognito token for real UAT the AI can't do
  alone, and the one who reads and acts on `infra-drift-auditor` reports rather than being
  bypassed by them. Frame all three roles in this doc explicitly as "does the repetitive
  read-only pass so the human's attention goes to judgment calls," not as autonomous coverage
  for a role a human would otherwise hold.
- **Give the new teammate the same hard-rule list this doc had to internalize** — the SES
  test-recipient rule, the no-agent-DNS rule, the staging-first deploy rule, and the CLAUDE.md
  gotchas section — as their first-day read, since those are exactly the rules that get violated
  under time pressure by someone who hasn't seen the postmortems (`CLAUDE.md`'s own SES incident
  write-up is the best evidence for why these aren't bureaucratic — they're each backed by a
  real, named, dated failure).
