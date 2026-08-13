---
name: never-metadata-directive-replace
description: Never use aws s3 cp --metadata-directive REPLACE to retrofit one header — it wipes Content-Type and takes the site down by making browsers download .html instead of rendering it.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-08T06:02:57.929Z
---

**`aws s3 cp --metadata-directive REPLACE` does not merge metadata — it replaces the whole
set.** Any header not re-specified in that same command is discarded, including
`Content-Type`. Objects come back as `binary/octet-stream`, and browsers then **download**
`.html` instead of rendering it. Every page on the affected prefix is dead while the AWS
CLI still exits 0 and reports success.

**Why:** on 2026-08-08 this took `dev.kcmps.com` down. The goal was trivial — retrofit
`Cache-Control: no-cache` onto 8 already-uploaded dashboard files rather than re-syncing
them. The loop passed `--cache-control` and nothing else, so all 8 lost `Content-Type`.
The owner hit a completely broken site ("nothing loads, instead .html files are
downloaded! escalating"). Production survived **only** by luck of prefix scoping — the
identical command one prefix higher would have downed the live storefront.

**How to apply:**
- To change object metadata in this repo, **re-run `aws s3 sync` from `website/`**. Sync
  infers `Content-Type` from the file extension and applies `--cache-control` in the same
  pass. Both documented deploy commands in `CLAUDE.md` already carry the flag inline —
  that is exactly so no metadata-only rewrite is ever needed.
- If a metadata-only rewrite is genuinely unavoidable: pass `--content-type` **explicitly
  per file** (a single value across a loop is wrong by construction, since extensions
  differ), then verify with `head-object` on every key touched. A zero exit code proves
  nothing here; only the response header does.
- Detection when pages download instead of render:
  `aws s3api head-object --bucket <b> --key <k> --query '[ContentType,CacheControl]'`
  — `binary/octet-stream` on `.html`/`.css`/`.js` is the smoking gun.

**The wider lesson, beyond S3:** a flag that means "replace" on an API that *looks*
field-scoped is a whole-object operation. The same trap already exists elsewhere in this
project — `aws lambda update-function-configuration` replaces the entire `Environment` map
(noted in the mail-threading handoff), and `cognito-idp update-user-pool` is not a partial
patch (noted in `backend/CLAUDE.md`). Before any "just update one field" AWS call, confirm
whether the API merges or replaces, and if it replaces, read the current state first and
pass it back in full. See [[never-git-add-all]] — same class of error: a convenient
one-liner with a blast radius much wider than intended.
