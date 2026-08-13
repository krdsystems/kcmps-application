# docs/memory — GitHub mirror of Claude's auto-memory

This folder is a **read-mostly mirror**, committed to git, of Claude Code's real auto-memory
store for this project:

```
~/.claude/projects/-home-kennethdungca-Documents-Business-kcmps/memory/
```

That local path is the **source of truth** — it's what Claude actually reads/writes every
session. This copy exists so the memory content also lives on GitHub: readable from any
machine, diffable in PRs, and not lost if the local `~/.claude` state ever gets wiped.

## Keeping it in sync

Nothing pushes automatically. After a session where memory changed (new feedback/project/user
memory saved, or `MEMORY.md` edited), run:

```bash
docs/memory/sync-from-local.sh
git status --short docs/memory/
git add docs/memory/<changed files>
git commit -m "docs/memory: sync from local auto-memory"
git push
```

The script does a one-way `rsync --delete` from the local memory dir into `docs/memory/`
(minus this README and the script itself) — it never writes back to
`~/.claude/.../memory/`, and it never stages, commits, or pushes on its own.

## If you're a Claude Code session reading this

- Treat this folder as **documentation of past memory state**, not the live memory system —
  keep reading/writing real memories via the local path as usual.
- If the user asks you to "sync memory to GitHub" or similar, run
  `docs/memory/sync-from-local.sh`, then stage the changed files **explicitly by path** (never
  `git add -A` — see [feedback_never_git_add_all.md](feedback_never_git_add_all.md)), and
  confirm with the user before pushing.
