# Working with Claude Code on KCMPS

A practical guide to running Claude Code sessions in this repo — quick fixes, revisions to
existing features, and new features — matched to the structure set up in `CLAUDE.md` and
`.claude/`. Read this once; day to day, `CLAUDE.md` is what Claude actually loads.

## Why this works the way it does

Every session, Claude Code auto-loads the root `CLAUDE.md` — that's where the deploy
constraint, the key-files table, and the "don't regress this" gotchas live, so you don't
have to re-explain the project each time. `design-system/CLAUDE.md` and
`ops-dashboard/CLAUDE.md` only load when Claude actually opens a file in those folders — you
don't pay for that context on a session that never touches them. `docs/history.md` never
auto-loads; pull it in explicitly when you need the *why* behind something.

The practical upshot: the more precisely you point Claude at a file (ideally via the
`CLAUDE.md` table), the less it has to explore the repo to find its footing, and the fewer
tokens the session burns before it starts doing useful work.

## Quick fix or small edit

Use this for anything scoped to one file or one clearly-described bug — a copy change, a CSS
tweak, a small logic fix.

1. Work directly on `main`, no branch or worktree needed.
2. Name the file (and function, if you know it) instead of describing the feature area.
   Compare:
   - Vague: *"the cart total looks wrong"*
   - Precise: *"in `website/store.js`, `payNowTotal()` is including custom-request items
     that should show ₱0 now — fix it"*

   Precise prompts let Claude skip straight to the relevant code instead of grepping the
   repo to figure out what you mean.
3. Ask Claude to run through the relevant part of the testing checklist in `README.md`
   before you consider it done (e.g. "add a custom request, confirm the drawer still reads
   ₱0 now / Pending approval").
4. Commit directly: `git add -A && git commit -m "..."`, then `git push origin main`.

## Revising an existing feature

Use this when you're changing behavior that already works a certain way for a reason — auth,
the mobile layout fixes, the cart/dashboard data seam, checkout.

1. Check `CLAUDE.md`'s "Conventions and gotchas" section first — it exists specifically to
   flag the traps in these areas (e.g. don't read `localStorage` outside `store.js`/
   `dashboard-data.js`, don't remove the `overflow-x: hidden` mobile fix, keep tokens in
   `sessionStorage`).
2. If the area is genuinely tricky (auth flow, mixed-cart payment logic), ask Claude to read
   the relevant section of `docs/history.md` first — e.g. "read the Auth implementation
   notes in docs/history.md, then fix X." That's exactly what that file is for; it's fine to
   pull it in on demand even though it doesn't auto-load.
3. For anything touching `website/styles.css`, remind Claude (or let `CLAUDE.md` remind it)
   to mirror the change into `design-system/KCMPS Redesign/styles.css` so the two don't
   drift.
4. Same commit/push flow as a quick fix, unless the change is large enough to want review
   before it lands on `main` — in that case use a branch (see below).

## Building a new feature

Use a branch — and a worktree if you want to keep working on `main` (or another feature)
at the same time without the two interfering.

**Branch naming:** this repo's convention is `claude/<slug>`, e.g.
`claude/ops-dashboard-frontend-879bff` — descriptive slug, optionally suffixed with a short
hash if Claude Code generated it for you.

**Without a worktree** (simplest — fine if you're not running anything else in parallel):

```bash
git checkout -b claude/<slug>
# do the work
git add -A && git commit -m "..."
git checkout main
git merge --no-ff claude/<slug> -m "Merge <slug>"
git push origin main
git branch -d claude/<slug>
```

**With a worktree** (for parallel sessions — e.g. Claude builds a feature while you keep
using `main` yourself, or you run two Claude sessions on unrelated features at once):

```bash
git worktree add .claude/worktrees/<slug> -b claude/<slug>
```

Point that session at the worktree path instead of the repo root. It's a full working copy
with its own checkout, so edits there don't touch `main` until you merge.

## After a feature lands

**Always clean up the worktree once its branch is merged** — this is called out in
`CLAUDE.md` for a reason: a stale worktree is a full repo copy (currently ~70 files) sitting
under `.claude/worktrees/`, and every one left behind makes every subsequent repo-wide
search in *any* session slower and more expensive. Before this cleanup, five stale worktrees
had inflated the repo to 284 files; pruning them cut it back to ~70.

```bash
git checkout main
git merge --no-ff claude/<slug> -m "Merge <slug>"
git push origin main
git worktree remove .claude/worktrees/<slug>
git branch -d claude/<slug>
```

If a session ever finds a worktree it didn't expect, `git worktree list` shows what's
checked out where, and `git branch --merged main` shows which branches are safe to remove.

## Deploying — frontend (`website/`)

`website/` is the only folder that goes live, synced verbatim to S3 — no build step.
**Always stage on `dev.kcmps.com` first**, per `CLAUDE.md`'s "Standard deploy workflow":

```bash
# 1. Stage — check it on https://dev.kcmps.com (Basic Auth; ask Claude or check your
#    password manager for credentials) before anyone else sees it
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ --profile kcmps-claude-priv

# 2. Promote — once it looks right on dev.kcmps.com
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile kcmps-claude-priv
```

No `--delete` on either — they only upload new/changed files, never remove bucket content
the sync didn't put there (the bucket has some pre-existing content outside `website/`'s
scope). Both are `CachingDisabled`, so either sync is live within seconds — no invalidation
step, no wait. Skipping straight to step 2 still works technically, but defeats the point of
having a staging domain.

## Deploying — backend (Lambdas, `backend/`)

As of 2026-08-05, `dev.kcmps.com` has its **own real backend** — its own 17 Lambdas, its own
HTTP API, its own DynamoDB table (`kcmps-staging`), its own S3 uploads bucket, its own
GuardDuty malware scanning. It is not a toy: it is wired identically to production and
reuses the same Cognito pool, so a real login/JWT works against it unmodified. This exists
because prior to that date, `dev.kcmps.com` was frontend-only and every backend change went
straight to production with zero rehearsal — which is exactly how a routine Node.js runtime
bump on Lambda would otherwise have been done blind. Full architecture and the exact deploy
commands are in `backend/infra/README.md`'s "Staging" section; this is the *when and why*.

**Use staging for:** any change to a Lambda's code, its IAM permissions, its environment
variables, a new API route, a new EventBridge rule, or infrastructure changes to
`backend/infra/*.cfn.yaml`. In practice: anything where "it worked when I tested it
manually" isn't good enough evidence, because the failure mode is silent (a presigned URL
that 403s, an IAM permission gap, a EventBridge rule that fires on the wrong bucket — none
of these throw an error a customer sees immediately; they show up later as "why didn't this
work").

**Skip staging for:** pure documentation edits, comment changes, or anything that doesn't
touch a deployed Lambda's actual behavior.

**The workflow:**
1. Make the code change in `backend/<module>/`.
2. Rebuild that function's zip and upload it to
   `s3://kcmps-lambda-artifacts-staging/<a-new-prefix>/`.
3. `aws cloudformation deploy` `backend/infra/backend-lambdas.cfn.yaml` against
   `kcmps-backend-staging` with the new `ArtifactsPrefix` — see `backend/infra/README.md`
   for the exact parameters.
4. Sync `website/` to `dev-site/` (frontend routing to staging is automatic by hostname —
   nothing to configure) and exercise the change for real on `dev.kcmps.com`: click through
   it, don't just read the code.
5. **Stop and report what was tested on `dev.kcmps.com` and how.** Only repeat the change
   against production once you've explicitly said to — same gate as the frontend workflow
   above, no exceptions for "it's a small change" or "I already tested it once before." For
   a Lambda **code** change that's the existing `aws lambda update-function-code` pattern
   (`backend/infra/README.md`'s "Redeploy after a code change"); for a **runtime** bump it's
   `aws lambda update-function-configuration --runtime`, never `update-function-code`.

**Why this is worth the extra step as a solo dev, not just process for its own sake:**
staging isn't there to slow you down — it's there because you're the only line of defense
between a bug and a real customer, and it turns "found by a customer, hours later, with no
context" into "found by you, in the same minute, with full logs open." That's not
hypothetical: this exact backend build caught two real, silent regressions within hours of
shipping — a GuardDuty scanning gap that would have permanently broken every future
attachment upload with no error message anywhere, and an unfiltered EventBridge rule
quietly writing production scan data into the wrong table. Neither would have thrown until
someone tried to open a "stuck" attachment days later and had no idea why. Staging turned
both into same-session fixes instead of a future debugging session starting from "a customer
says their file won't load."

**Cost is not a reason to skip this** — the whole staging environment runs at ~₱3/mo, well
under the ₱500/mo soft cap (see `docs/cost-governance.md`). The reason to skip it is only
ever "this change doesn't touch a deployed Lambda," never "it's probably fine."

## Getting good results from a session

- Reference `CLAUDE.md`'s key-files table by name rather than describing what you want in
  general terms — "fix X in `store.js`" beats "fix the cart."
- If you don't know which file owns something, ask Claude to check the table and grep first
  rather than reading whole files — that's the default behavior `CLAUDE.md` already asks
  for, but it helps to say so explicitly if a session seems to be reading more than it needs.
- For anything that touches a documented gotcha (auth, mobile CSS, the cart/dashboard data
  seam), say so up front — it prompts Claude to actually check `CLAUDE.md`'s gotchas section
  instead of relying on it being loaded silently.
- Keep `CLAUDE.md` itself short. If you add a new gotcha or key file, add one line to the
  existing table/list rather than a new paragraph — it's re-read on every session, so its
  size is a permanent tax on every future conversation.
