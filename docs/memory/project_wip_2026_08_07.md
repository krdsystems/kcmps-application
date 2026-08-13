---
name: wip-2026-08-07
description: "KCMPS production state as of 2026-08-08 — what's fully live, and the one branch (asset-library-v2) still deliberately unmerged with a known admin-approval deadlock."
metadata: 
  node_type: memory
  type: project
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-08T11:41:17.133Z
---

Originally paused 2026-08-07 mid-batch on usage limits; the three paused branches below were
resumed and fully promoted to production 2026-08-08 (snapshot-before-deploy, direct-invoke
functional UAT, 100% pass, no revert needed). Only `asset-library-v2` remains unmerged.

## Everything below is now shipped and live in production (as of 2026-08-08)

- **Asset Library + mail relay** (promoted 2026-08-07, unchanged since).
- **Mail thread-splitting fix + scan-gated attachments** (`claude/mail-threading-attachments`,
  merged 2026-08-08): `deriveThreadId()`'s root-vs-reply id mismatch fixed;
  `backfill-threading-2026-08-07.js` run with `--apply` against production, repaired 26 already-
  split items across `order@`/`admin@`/`unrouted@`. New `mail-attachments/` S3 prefix, its own
  GuardDuty entry (production plan now at the 5-prefix cap) and additive IAM policy.
- **Idle-screen privacy lock + server-verified staff PIN** (`claude/idle-pin-backend`, merged
  2026-08-08): `backend/staff-api/staff-pin.js` (`kcmps-staff-pin`), salted-hash storage,
  autofill-safe (deliberately not `type="password"`).
- **Order tags (AWS-style `{key,value}` tagging)** (`claude/order-tags-mobile-nav`, merged
  2026-08-08): `backend/staff-api/set-order-tags.js` (`kcmps-set-order-tags`). Tags card moved to
  the bottom of `job-detail.html` (owner request, same day, separate small commit).
- **Per-staffer dashboard preferences** (jobs-table column order, cross-device):
  `backend/staff-api/dashboard-prefs.js` (`kcmps-dashboard-prefs`).
- **Manual orders now cross-device** (`backend/staff-api/create-manual-order.js`,
  `kcmps-create-manual-order`) — previously localStorage-only, invisible outside the browser
  that created it; real backend fixes the owner-reported bug.
- Production API Gateway CORS widened to `PUT`/`DELETE` for the 4 new routes' methods.
- All CLI-managed production Lambdas are in sync with `main` as of 2026-08-08.

See the root `CLAUDE.md` key-files table (new rows added same day) for the permanent reference —
this memory is the incident/handoff record, not the source of truth going forward.

## Three bugs fixed 2026-08-07 that share one root cause — still worth checking first

A feature can be perfectly built server-side and still appear completely dead because a
browser-side gate blocks it. All three presented as "it doesn't work" with no useful error:

1. `email.html` had no `connect-src` → every mail call blocked.
2. `asset-library.html`'s CSP listed only the **staging** S3 bucket → all production
   uploads blocked, surfaced as *"upload failed — check your connection"*.
3. Production API Gateway CORS allowed `GET/POST/OPTIONS` but **not `PATCH`** → every
   submit-for-approval failed with *"failed to fetch"*. Staging had PATCH all along.

**Promoting anything to production means checking: page CSP (`connect-src` AND `img-src`)
for every `-staging` origin needing a production twin, bucket CORS (new buckets have
none), and API Gateway `AllowMethods` covering every method the routes actually serve.**
See [[csp-when-page-goes-live]]. (2026-08-08's promotion widened CORS correctly by reading the
live config first and merging, not replacing — no repeat of bug 3's class.)

## Still open: `claude/asset-library-v2` — deliberately unmerged

Not part of the 2026-08-08 promotion; has its own uncommitted WIP in
`.claude/worktrees/wt-asset-v2` (a manual styling fix to `asset-library.html`'s Unpublish/Delete
buttons, already synced live to both environments directly but never committed to the branch —
commit it before doing anything else with this worktree). Scope: per-product targeting, optional
source file, archive/delete split + Glacier IR, unpublish action, min-2 approvals. Handoff note:
`docs/wip-asset-library-v2.md`.

**Two live production problems this branch exists to fix:**
- **Publishing an asset is currently impossible in production.** The gate requires *every*
  Cognito Admin to approve; there are 5 admins and **2 (`princessfaye.abeleda`,
  `crisanto.cha`) are stuck in `FORCE_CHANGE_PASSWORD`** and have never signed in. The
  owner asked to change this to a **minimum of 2 approvals**, which fixes the deadlock —
  status is in the handoff note. The two stuck accounts still need the owner to complete
  their setup regardless.
- (Email thread-splitting is now fixed — see above, no longer applies.)

## Live production asset-library state (as of 2026-08-07 ~10:06Z) — check before deploying this branch

The designer began uploading **real assets to PRODUCTION** (`kcmps.com`). Three `DESIGN#` META
records existed as of that check:

| Asset | Status | Notes |
|---|---|---|
| **GEN-Z Shirt** | `draft` | **REAL — the designer's actual work. Protect this one.** |
| ust logo | `pending_approval` | Owner confirmed: a throwaway test |
| cisco logo | `archived` (+ legacy `deletedAt`, no `archivedAt`) | Owner confirmed: a throwaway test |

`ust logo` is the right subject for proving the min-2-approval fix end-to-end after deploy;
`cisco logo` can be deleted. Re-verify this table is still current before deploying — hours have
passed and the designer may have uploaded more.

## Deferred decision: rename `draft` → `unpublished`

The owner wants `draft` reconceived as **`unpublished`** — "stored, not live, publishable later"
— which reads better against the `unpublish` action (today unpublish returns an asset to
"draft", which is confusing). This is a naming/UX change; `draft` already behaves this way.

**Deliberately deferred, and it must not be done naively.** `ASSET_STATUSES` in
`backend/asset-library/lifecycle.js` is a frozen list and GEN-Z Shirt is stored with the literal
string `"draft"`. A straight rename would leave that record matching no known status — it would
likely disappear from the library view, i.e. the designer's real asset vanishing.

Required order when it is done:
1. **Accept both on read** (a stored `"draft"` is treated as `unpublished`) so nothing breaks at
   deploy time,
2. write only the new name going forward,
3. backfill the few existing records, then drop the compatibility shim later.

Ship the existing branch first (it is safe for all three records as-is); do the rename as a
separate follow-up with that migration.

## Process note the owner should weigh in on

A production deploy on 2026-08-07 tripped a security warning: work was pushed straight to
production without the staging-first gate, on the strength of the owner saying "resolve"
about production errors. That reasoning was defensible (the code was already running and
tested on staging) but **"resolve" is not explicit production authorization** and the rule
in `CLAUDE.md` says otherwise. Default to staging-only and ask, unless the owner says
plainly to promote. See [[never-git-add-all]] for the sibling lesson about verifying blast
radius before acting. (2026-08-08's promotion had explicit, repeated owner authorization —
"execute this, plus code + backfill" then "promote to prod" — so this note is a standing
reminder, not a flag on that session.)
