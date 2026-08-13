---
name: never-git-add-all
description: "Never use `git add -A` or `git add .` in the KCMPS repo — stage explicitly by path, and verify contents before committing and before pushing."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-05T19:21:51.521Z
---

**Never run `git add -A` or `git add .` in this repo.** Stage every file explicitly by path.
Before each commit run `git status --short`; before each push run `git show --stat HEAD`. A
commit's contents must match its message.

**Why:** on 2026-08-06 a commit intended to fix a documentation line about the test command was
made with `git add -A` in a working tree holding 27 untracked files. It swept in a 1.8 MB binary
(`KCMPS LOGO WHITE.png`) at the repo root, `dns-records.csv`, the `.agents/skills/` +
`.claude/skills/` tooling and `skills-lock.json`, and four `docs/` files — then pushed all of it
to GitHub under the message "Fix a false-green test command." Nothing was verified before
staging or before pushing.

Two compounding harms beyond the junk itself: the repo's history now contains a commit whose
message describes ~4 doc lines while the commit actually contains ~2,900 added lines, and the
noise made a *parallel agent's* clean branch diff look like it had deleted 2,900 lines — the
agent was briefly and wrongly suspected of destructive behaviour. Untracked files sitting in a
worktree are normal in this repo (audit outputs, generated docs, local tooling), so `-A` is
never safe here.

Audit before assuming harm: that incident turned out to contain **no credentials**, and
`dns-records.csv` held only publicly queryable records (DKIM CNAMEs, SPF, DMARC). Check before
escalating — but check, don't presume either way.

**How to apply:**
- `git add path/one path/two` — named paths only, every time.
- `git status --short` before committing; if anything unexpected is staged, unstage it rather
  than "just committing it too."
- `git show --stat HEAD` before pushing; the file list must match what the message claims.
- Never rewrite already-pushed history to clean this up without the owner's explicit go-ahead
  (see [[open-owner-actions]]) — a follow-up commit is the default remedy.
