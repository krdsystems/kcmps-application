# Asset Library rebuild plan — 2026-08-06

The Design Library (to be renamed **Asset Library**) failed UAT: *"clunky, unaesthetic,
difficult to navigate or find purpose, majority nonfunctional."* This document diagnoses the
failures with evidence from code, CloudWatch, DynamoDB (`kcmps-staging`), and S3, then lays
out an opinionated rebuild: purpose, IA/UX, the new all-Admin approval workflow, the rename,
and a phased plan.

Everything here respects the repo's hard constraints: no build step, `styles.css` tokens,
navy-dominant with one orange CTA per screen, the `KCMPS_DASH` seam, `requireRole()` for
writes, the fail-closed GuardDuty scan gate, and the ~₱500/mo soft cap.

---

## 1. Root-cause diagnosis

Verdict up front: **the backend pipeline works end to end** — a design was uploaded,
published, copied to the public bucket, written into `design-manifest.json`, then archived
(manifest regenerated to `count: 0`), all traceable in the staging table's `EVENT#` trail
between `2026-08-05T20:26Z` and `20:27:22Z`. The UAT failures are one already-fixed IAM bug,
two real frontend bugs, and — the largest share — a UI that hides every state the system
moves through, so correct behavior *reads* as broken.

### FAIL — "Upload → draft → publish end-to-end: nonfunctional"

**Actually broken (historical, now fixed in code):** the first live publish crashed with a
500. CloudWatch (`/aws/lambda/kcmps-staging-publish-design`, `2026-08-05T16:40:00Z`):
`ERROR Invoke Error {"errorType":"AccessDenied"...}` — the `CopyObject` tagging-permission
403 that `backend/design-library/publish-design.js:251-259` now documents and defends
against (`TaggingDirective: "REPLACE"`). Evidence it's fixed: the `20:27:06Z` publish
succeeded. But if the owner's "nonfunctional" verdict formed during that first run, it was
accurate at the time.

**Actually broken (still in the shipped page):** the stillScanning-retry flow in
`website/dashboard/design-library.html`.

- Line 374 attaches the upload handler with `form.addEventListener("submit", ...)`; line 427
  then tries to disarm it with `form.onsubmit = null` — which clears a property that was
  never set and **leaves the original listener attached**. After a 409, pressing Enter in
  any field (or any submit-event path that isn't a click on the mutated button) re-runs the
  *entire* upload: new presign, new `designId`, both files re-PUT.
- Live evidence this bit someone: `designs/print-office/c0f30396.../` uploaded
  `04:26:29+08` (9,055,488 + 40,770 bytes), and byte-identical files re-uploaded 31 seconds
  later as `designs/print-office/9977124c.../`. `c0f30396` has clean `SCAN#` verdicts but
  **no `DESIGN#` record** — an abandoned orphan pair. Three more orphan uploads
  (`712ade31` dtf, `2cfdc595` subli, `fad9b7a1` storage — the last with only *one* of its
  two files ever landing) tell the same story: the upload→publish coupling failed or
  confused the user often enough that half the attempts were abandoned mid-flow.
- The mutate-the-submit-button-into-"Retry publish" pattern (lines 426-451) is a hand-rolled
  state machine held together by an in-memory `lastPublishMeta` that a page refresh silently
  destroys — after which the only path forward is re-uploading everything.

**Working as designed, but feels broken:**

- The fail-closed scan gate (`publish-design.js:177-195`, `scan-verdict.js`) is a security
  property and must stay. But GuardDuty verdict latency is **variable by two orders of
  magnitude**: most staging scans landed in ~2 seconds, while `712ade31/web.png` was
  verdicted **11 minutes** after its pair (`16:39:45Z` vs `16:50:00Z`). The UI's "try again
  in a moment" copy plus a manual retry button is the wrong shape for a wait that can be
  2 s or 11 min — there is no polling, no per-file status, no automatic unlock.
- Draft cards render **no image at all** ("No preview yet — draft",
  `design-library.html:208`) because `list-designs.js` deliberately presigns only the
  original, never the web-ready file. A library of grey placeholder boxes is the single
  biggest contributor to "unaesthetic."
- The card's status chip is computed from the **original file's verdict only**
  (`list-designs.js:98-100`), so a card can read "Draft" (looks ready) while publish 409s on
  the web file — the "connected issues with other features" the UAT noted.

**Environment trap:** the backend exists only on `kcmps-backend-staging`, but
`design-library.html` is synced to the *production* frontend too, where every call hits the
production API (`6msg2uho6c`, no `/designs` routes) and fails with a bare "Could not load
designs — Not Found." Nothing on the page or in the nav says "staging only." Any UAT step
performed on `kcmps.com` instead of `dev.kcmps.com` reads as 100% nonfunctional — correctly.

### FAIL — "Published design appears on storefront: doesn't show"

Three stacked causes, all confirmed:

1. **The category black hole (the big one).** The upload form's category `<select>`
   (`design-library.html:137-141`) lists **all 8** catalog leaves from
   `KCMPS_STORE_DATA.leaves` — including 5 `comingSoon` leaves — and defaults to the first
   key, `print-office`. But the storefront merge (`store.js:716-723`) only grows designs
   onto products that already opt into a picker via `Array.isArray(p.images)`, and **only 4
   products do, all under `dtf` and `subli`** (`products.js:397,451,487,522`). The one
   design ever successfully published ("test uploaded") was category **`print-office`** —
   it merged into *nothing*, silently, exactly as the merge's own gotcha documentation says
   it should. Six of the eight categories the UI offers are guaranteed-invisible on the
   storefront, and the UI never says so.
2. **It was archived 15 seconds after publishing** (EVENT# trail: published `20:27:06Z`,
   archived `20:27:21Z` — presumably the archive UAT step ran on the only published item).
   `design-manifest.json` on the bucket is currently `{"count": 0, "designs": []}` — so even
   a dtf design would show nothing today.
3. **Staging writes under `dev-site/`** (`PUBLIC_ASSETS_KEY_PREFIX =
   dev-site/assets/designs/`, `backend-lambdas.cfn.yaml`), so only the `dev.kcmps.com`
   storefront can ever see it. Checking `kcmps.com` shows nothing, forever, by design.

**Verified NOT broken:** the manifest contract itself. The published image object exists at
`dev-site/assets/designs/9977124c....png`, the manifest entry shape matches
`store.js`'s consumer, `assets/designs/<uuid>.png` passes `SAFE_IMAGE_RE` (`store.js:687`),
and the category ids match `leaves` keys. Publish a **dtf** design and don't archive it, and
it appears in the dev storefront's DTF pickers.

### FAIL — "Publishing before scan finishes fails kindly"

Covered above: the 409 handling exists and the copy is friendly, but the retry mechanism is
the buggy button-mutation flow, the wait is unbounded and invisible, and the status chip
disagrees with the publish gate. "Fails kindly" needs to become "never fails — just unlocks
when ready," without weakening the server-side gate one bit.

### PASS — Archive → Recycle Bin → Restore

Genuinely works: `PATCH /designs/{id}` deployed, `PATCH` present in the API's CORS
`AllowMethods` (verified live), transactional EVENT# audit on both transitions, manifest
regenerated on archive. The one thing it proved by passing: the *pipeline* is fine; the
*surface* is what failed.

---

## 2. What the feature is FOR

> **The Asset Library is the shop's single, safe home for every reusable piece of creative
> work — the designer's source files and their sellable web-ready versions — and the
> one-click, founder-approved pipe that puts a finished design in front of shoppers without
> touching code, S3, or a deploy.**

For this specific 4-person shop, it does three jobs, in priority order:

1. **Never lose source art again.** Before this, PSD/AI files lived on whoever's machine
   made them. Uploading here gives them versioned, scanned, private S3 storage with a
   recycle bin. Even an asset that never gets published earns its keep as the archive.
2. **Answer "do we already have a design like X?"** Sales, mid-conversation with a customer,
   searches/filters the library instead of asking the designer. This is why browse/search
   quality matters more than the upload form.
3. **Grow the storefront catalog without an engineer.** Publish = the design appears in the
   right product's picker on the next page load, gated by malware scanning and (new) founder
   approval. This is the only job the current page even attempted — and the UI must now be
   honest about *where* a published asset will appear (see the category fix).

The current page fails the purpose test because it leads with job 3's form and renders jobs
1 and 2 as an afterthought grid of grey boxes. The rebuild inverts that.

---

## 3. Proposed IA + UX

### Principles

- **The library is the page; upload is a modal.** Today a ~10-field form permanently
  occupies the top half of the screen. Move it into a 2-step modal behind the page's single
  orange CTA ("Upload asset"). The default view becomes the thing staff actually do daily:
  browse.
- **Every asset always has a picture.** Drafts get a scan-gated presigned thumbnail of the
  web-ready file (backend change, below). During upload, the browser previews the picked
  web file instantly via `URL.createObjectURL` — zero backend, zero cost. SVG (new
  original type) and PSD/AI/PDF never render inline — they get a labeled file-type tile
  ("PSD · 240 MB") and a download-only affordance.
- **States are a visible pipeline, not error messages.** Uploading → Scanning → Draft →
  Awaiting approval → Published (→ Archived). Scanning is a progress state that resolves
  itself via polling; it is never presented as a failure and never bypassable.
- **Decouple upload from publish.** Upload always produces a draft. "Submit for approval"
  is a separate, later action, available only once the scan is clean. This deletes the
  entire retry-hack code path — there is nothing left to retry.
- **Be honest about reach.** Category selection shows exactly where the asset will (or
  won't) appear on the storefront.

### Screen: Library (default view)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [!] 2 assets awaiting your approval  →  Review        (Admin only bar)  │
├──────────────────────────────────────────────────────────────────────────┤
│  Asset Library                                        [ Upload asset ]   │  ← the ONE orange CTA
│  Source files + storefront designs, in one place.                        │
│                                                                          │
│  [Search…            ]  Category ▾   Status ▾        Library|Approvals|Bin│  ← tabs
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                          │
│  │ ▓▓thumb▓│ │ ▓▓thumb▓│ │ ⣿shimmer│ │ ▓▓thumb▓│                          │
│  │Published│ │ Draft   │ │Scanning…│ │Awaiting │                          │
│  │Retro Sun│ │BTS Vari…│ │Team Logo│ │approval │                          │
│  │DTF·Aug 5│ │Subli·…  │ │DTF·now  │ │1 of 2 ✓ │                          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                          │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Cards**: thumbnail (always), status chip, name, category · date, tags. Click anywhere
  on the card opens the **detail drawer** — no more 4 tiny buttons crammed under each card.
  Chips reuse token colors: Published = `--color-green` tint, Draft = neutral,
  Scanning = accent-100 amber-free (stay in navy/neutral family per brand; the current
  hardcoded `#16a34a`/`#f59e0b`/`#dc2626` hexes violate the "don't hardcode colors" rule
  and should move to tokens).
- **Search** filters name/tags/description client-side (the whole library is already in
  memory from `getDesigns()` — no backend change). **Category** and **Status** filter chips
  likewise.
- **Scanning cards** show a subtle shimmer over the (client-known or gated) thumbnail area
  and the copy *"Scanning for malware — actions unlock automatically."* While any asset is
  pending, the page polls `getDesigns()` every 10 s and stops when nothing is pending. No
  user-initiated retry exists anywhere.
- **Empty state** (first-run): not "No designs uploaded yet." Instead a short purpose card:
  *"This is the shop's home for source art and storefront designs. Upload your first asset —
  it's stored privately, scanned, and only goes live once it's approved."* + the CTA.
- **Error state** (e.g. the production-hostname 404): a full-width notice, not a dead grid:
  *"The Asset Library backend runs on staging (dev.kcmps.com) only — open this page there."*
  Detect via the same hostname branch `dashboard-data.js` already has; don't let the page
  pretend it might work.

### Screen: Upload modal (2 steps)

```
Step 1 — Files                          Step 2 — Details
┌───────────────────────────────┐       ┌───────────────────────────────┐
│ Upload asset            ✕     │       │ Upload asset            ✕     │
│                               │       │  ┌────────┐ Name  [________]  │
│ ┌───────────┐ ┌───────────┐   │       │  │preview │ Category ▾        │
│ │ Drag or   │ │ Drag or   │   │       │  │(local) │  DTF — appears in │
│ │ browse    │ │ browse    │   │       │  └────────┘  4 storefront     │
│ │ SOURCE    │ │ WEB-READY │   │       │              product pickers  │
│ │ PSD AI PDF│ │ JPG PNG   │   │       │ Description [______________]  │
│ │ SVG ·300MB│ │ WEBP·300MB│   │       │ Tags [retro, summer        ]  │
│ └───────────┘ └───────────┘   │       │                               │
│  original.psd ▓▓▓▓▓░░ 62%     │       │        [ Back ] [ Save draft ]│
│  web.png      ▓▓▓▓▓▓▓ 100%    │       └───────────────────────────────┘
│              [ Next → ]       │
└───────────────────────────────┘
```

- Step 1: two drop zones (reuse `store.js`'s `.upload-drop` pattern/classes), instant local
  preview for the web-ready image, per-file progress bars (keep the existing
  `putWithProgress` XHR). Uploads start immediately on drop so the scan clock starts as
  early as possible — by the time the user finishes Step 2, short scans are already done.
- Step 2: metadata. The **category select is grouped and annotated**:
  - *"Shown on the storefront"* group: `dtf`, `subli` — with a live line under the select:
    *"Appears in the design picker of N products"* (computed from `KCMPS_STORE_DATA`
    exactly as the merge does: leaves whose products have `images[]`).
  - *"Library only (not on the storefront yet)"* group: everything else, each labeled so.
    Keep them selectable — the library's archival job is real — but no one can ever again
    publish into the void without being told.
- **The only submit action is "Save draft."** No "publish immediately" checkbox. Publishing
  is a deliberate second act, which is also what the approval workflow requires anyway.
- Success closes the modal and drops the new card into the grid in its Scanning/Draft state
  — the user sees their asset exist immediately.

### Screen: Asset detail drawer

Right-side drawer (mirrors the cart-drawer pattern the codebase already has), opened by
clicking any card:

```
┌───────────────────────────────┐
│ ✕  Retro Sunset       [Draft] │
│ ┌───────────────────────────┐ │
│ │        large preview      │ │   (web-ready image; PSD/SVG etc. shown
│ └───────────────────────────┘ │    as file-type tile, download only)
│ DTF · uploaded Aug 5 by Ana   │
│ retro · summer                │
│ ─────────────────────────────│
│ Files                         │
│  original.psd  240 MB  [↓]    │   (scan-gated presigned download)
│  web.png       1.2 MB  [↓]    │
│  Malware scan: ✓ clean (both) │
│ ─────────────────────────────│
│ [ Submit for approval ]       │   ← primary action for a clean draft
│ [ Edit details ] [ Archive ]  │
│ ─────────────────────────────│
│ History                       │
│  Aug 5 20:27  Published — Ana │   (rendered from EVENT# items)
│  Aug 5 20:26  Uploaded — Ana  │
└───────────────────────────────┘
```

- Per-file scan status shown explicitly (fixes the chip-vs-gate disagreement: the UI reads
  the same two verdicts the server gates on — `list-designs.js` must return both, see
  backend changes).
- The primary action is state-dependent and **disabled with a reason** rather than
  click-to-fail: a still-scanning draft shows "Submit for approval" greyed with *"unlocks
  when scanning finishes."*
- History = the asset's `EVENT#` items (new lightweight include on the list/detail read) —
  this is the audit trail made visible, and it's what makes the approval workflow legible.

### Screen: Approvals tab  — see §4.

### Screen: Recycle bin tab

Keep what passed UAT, plus: each card shows *"Purges in N days"* (computed from
`deletedAt` + 90), and Restore is the card's single action. Restoring a
previously-published asset notes *"will return to the storefront immediately"* — because it
does (`patch-design.js:178-212` regenerates the manifest).

### Backend changes this UX needs (small, surgical)

1. `list-designs.js`: also return `webThumbUrl` — a presigned GET for the **web-ready**
   private object, gated on the *web file's* clean verdict (same fail-closed rule; for
   published assets keep using the public URL). Return `scanStatusOriginal` and
   `scanStatusWeb` separately.
2. `list-designs.js` (or a tiny `GET /designs/{id}/events`): include each design's `EVENT#`
   items for the history panel. At current volume, folding them into the existing scan is
   fine.
3. `design-types.js`: add `svg` to the **original** allowlist only (owner decision).
   `list-designs.js` already forces `Content-Disposition: attachment` +
   `application/octet-stream` on original downloads — exactly right for SVG's
   script-carrying risk. SVG stays out of the web-ready allowlist and out of
   `SAFE_IMAGE_RE`; it must never reach an `<img>`/inline render anywhere.
4. Remove the `publish` path from the upload flow entirely (frontend); `POST /designs`
   keeps accepting `status` for API compatibility but the dashboard only ever sends
   `draft`.

---

## 4. The Admin approval workflow

**Owner requirement:** an asset goes live only after **every user in the Admin group**
(currently the two founders) approves it. Surfaced like the customer "new message" banner.

### State machine

```
                 upload (P/S/A)         submit (P/S/A,        all admins
   ┌────────┐   ─────────────►  ┌───────┐ scan-clean only) ┌────────────────┐ approved ┌───────────┐
   │(no rec)│                   │ draft │ ───────────────► │pending_approval│ ───────► │ published │
   └────────┘                   └───────┘                  └────────────────┘          └───────────┘
                                    ▲                            │    ▲                      │
                                    │  reject (any single Admin, │    │ resubmit             │
                                    │  reason required; approvals│    │ (edits allowed       │
                                    └────────── cleared) ────────┘    │  while draft)        │
                                                                      │                      │
                                 archive (from draft/pending/published; pending loses its    ▼
                                 queue slot; approvals cleared) ────────────────────► ┌──────────┐
                                                                                      │ archived │──90d──► purged
                                                                                      └──────────┘
```

Rules, opinionated:

- **Scan-clean is a precondition of entering the queue.** "Submit for approval" runs the
  same `checkVerdict` pair the publish path runs, and refuses (409, same friendly shape)
  until both files are clean. Rationale: an admin must never approve something the scanner
  could still veto — approval should be the *last* gate, and the publish that fires on the
  final approval should never fail. (The publish still re-checks the verdicts — defense in
  depth, the gate is never bypassed — but by construction it can't be surprised.)
- **Approval is per-asset.** The queue UI offers multi-select for convenience, but each
  approval is its own `PATCH` + its own `EVENT#` — batched clicks, never batched audit.
- **Any single admin can reject (veto).** Rejection requires a reason (free text, stored on
  the record and in the event), immediately returns the asset to `draft`, and **clears all
  collected approvals** — an edit after a rejection means everyone re-reviews. The designer
  sees the reason on the card/drawer.
- **The approver set is "all current members of the Admin group," evaluated at each
  approval, not snapshotted at submission.** On every `approve` action the Lambda calls
  Cognito `ListUsersInGroup(Admin)` (needs `cognito-idp:ListUsersInGroup` on the
  design-library role — free API, one call per approval click) and compares the set of
  approving `sub`s against current membership. This handles the edge cases honestly:
  - **Only one admin exists** → their single approval publishes immediately.
  - **Admin added mid-queue** → pending assets now also need the new admin. Correct: the
    requirement is "all founders sign off," not "all founders as of last Tuesday."
  - **Admin removed mid-queue** → their recorded approval is ignored in the count (kept in
    the audit trail); the remaining set decides.
- **Submitter who is an Admin auto-approves their own submission.** Submitting *is* their
  sign-off; recording it explicitly (as an `approve` event stamped `via: "submit"`) means
  with two founders, one other click publishes. Without this, a founder would approve their
  own upload twice, which is ceremony without meaning.
- **Idempotency/concurrency:** `approve` writes into an `approvals` map on the META item
  (`approvals.<sub> = {name, at}`) with a `ConditionExpression` on
  `#status = :pending_approval`; a second click by the same admin is a no-op (200, current
  state). The **final** approval — the one that completes the set — performs the publish
  inline: scan re-check → public-bucket copy → transactional status flip + `EVENT#` →
  `regenerateManifest()`, i.e. exactly `patch-design.js`'s existing `handlePublish` with
  the approval count as an extra condition. Two admins approving simultaneously race on the
  conditional update; the loser retries its read and finds the set complete or the status
  already `published` — either way one publish, one event.

### Audit trail (the `EVENT#` convention, extended)

Every transition already writes a `buildEvent()` record with `PK: DESIGN#<id>`; the new
actions add:

| action | from → to | meta |
|---|---|---|
| submit | draft → pending_approval | `{}` (auto-approve event follows if submitter is Admin) |
| approve | pending_approval → pending_approval | `{approvedCount, requiredCount}` |
| approve (final) | pending_approval → published | `{approvedCount, requiredCount}` |
| reject | pending_approval → draft | `{reason}` |

The detail drawer's History panel renders these verbatim — *"Aug 7 · Approved by Ken (1 of
2)"* — which is the audit trail doing double duty as UX.

### Surfacing it: the approval banner

Mirrors the two existing patterns exactly:

- **Shell banner** (all dashboard pages, Admin claims only — client-gated for display,
  server-gated for action): `dashboard-shell.js` grows a sibling of `refreshUnreadBadge()`
  that calls a new `KCMPS_DASH.getPendingApprovalSummary()` → light `GET
  /designs/pending-approvals` returning `{count, items:[{designId, name, category,
  submittedBy, submittedAt}]}` (bounded scan, same tradeoff as `get-unread-messages.js`).
  Non-zero → a top-of-content banner styled like `orders.html`'s `.new-message-banner`
  (navy surface, count pill — **not** orange; the banner is a notification, not the page's
  CTA): *"2 assets awaiting your approval → Review"*, linking to the Asset Library's
  Approvals tab. Poll on the same 45 s cadence as the unread badge; skip the call entirely
  when the decoded claims lack the Admin group (UI-only optimization — the Lambda still
  `requireRole([ADMIN])`s).
- **Approvals tab** on the Asset Library page:

```
│ Approvals (2)                                                      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ ▓thumb▓  Retro Sunset          DTF · by Ana · Aug 7            │ │
│ │          ✓ Ana (submitted)  ○ Ken — waiting on you             │ │
│ │          [ Approve ]  [ Reject… ]            [ Open preview ]  │ │
│ └────────────────────────────────────────────────────────────────┘ │
```

  Each row shows the thumbnail (the approver must see what they're approving — clicking it
  opens the full detail drawer with the large preview and both file downloads), who has
  approved, who's outstanding. `Reject…` opens a small dialog demanding the reason.
  Non-admin staff see the tab read-only ("waiting on Ken · Ana") so the designer knows
  where their asset is stuck.

### API surface

Extend `patch-design.js`'s `ACTIONS` with `submit`, `approve`, `reject`:

- `submit`: `requireRole(Production/Sales/Admin)` (same as today's writes) + scan gate.
- `approve` / `reject`: `requireRole([ADMIN])` **only** — the first Admin-exclusive write
  in this feature, and the point of the whole workflow. Never `isStaff()`.
- `GET /designs/pending-approvals`: `requireRole([ADMIN])` for the actionable payload
  (staff read-only view can reuse `GET /designs`, which already carries status).

The direct `draft → published` promotion (`action: "publish"`) is **removed from the
dashboard UI** and the Lambda rejects it once approvals ship (or is kept Admin-only as a
break-glass with a mandatory-reason event — recommended: keep it, Admin-only, evented, for
the day one founder is unreachable and stock needs to move; a 2-person shop needs an
escape hatch more than it needs process purity. The event trail keeps it honest).

**Cost:** one Cognito `ListUsersInGroup` per approval click (free), one bounded scan per
45 s per open Admin dashboard session (~2 sessions × ~1 rph… well under API Gateway/Lambda
free-tier noise; ballpark <₱5/mo even with all-day dashboards). No new infrastructure.

---

## 5. The rename — "Design Library" → "Asset Library"

Honest split between *labels* (rename freely), *repo files* (rename cheaply), and *deployed
contracts* (a migration, mostly not worth it):

| Where it appears | What | Recommendation |
|---|---|---|
| `dashboard-shell.js:111` `NAV_ITEMS` label "Design Library" / hint | Label | **Rename** → `label: "Asset Library"`, hint "Files, designs & approvals" |
| `website/dashboard/design-library.html` — `<title>`, `<h2>`, all copy | Label | **Rename** in the rebuild ("Asset Library", "Upload asset", "asset" throughout copy) |
| `design-library.html` filename + `NAV_ITEMS` href | Repo file | **Rename** to `asset-library.html` in the same commit as the nav href (no build step, nothing else links it; the old URL 404s for anyone with a bookmark — acceptable on a staff tool this young). CSP/CSS class prefixes (`.design-card` etc.) → `.asset-*` while rebuilding anyway |
| `dashboard-data.js` `getDesigns`/`publishDesign`/… function names | Seam API | **Rename to `getAssets`/`submitAsset`/…** during the rebuild — this page is their only caller, the seam is the right place for the new vocabulary |
| `backend/design-library/` folder + file names | Repo source | **Rename folder** to `backend/asset-library/` (grep-and-fix `require` paths + CFN `Code.S3Key` zip names + `backend/infra/README.md`) — cheap, do it with the backend pass, not as a standalone commit |
| API routes `POST/GET /designs*`, `PATCH /designs/{id}` | Deployed contract (staging only!) | **Rename to `/assets*` now.** This is the one-time window: production has **no** `/designs` routes yet, and staging is CloudFormation-managed — changing the route keys in `backend-lambdas.cfn.yaml` + the seam's paths is one coordinated deploy with zero external consumers. After production promotion this becomes a real migration; before it, it's a find-and-replace |
| Lambda function names `kcmps-staging-*-design*` | Deployed (CFN) | **Rename with the route pass** — CFN replaces the functions (new names = new resources); staging redeploys are the rehearsed workflow this stack exists for |
| DynamoDB `DESIGN#<id>` PK prefix, `keys.js`'s `designPk()` | Deployed data | **Leave.** Renaming a key prefix = rewriting every item + every `SCAN#`/`EVENT#` reference, for zero user-visible benefit. `designPk()` stays; a code comment notes the label/DB-prefix divergence |
| S3 `designs/<category>/<id>/…` private keys; GuardDuty prefix filter; IAM resource ARNs | Deployed data + security config | **Leave.** Same migration math, plus touching the GuardDuty `ObjectPrefixes` and IAM policies for a cosmetic rename is risk with no reward |
| Public `assets/designs/` prefix + `design-manifest.json` name + manifest field names | Contract with `store.js` (both ends ours) | **Leave.** It already reads naturally under "Asset Library" ("assets/designs" — these *are* designs), the storefront consumer only ever shows designs, and the contract's own docs say "change both ends or neither." Nothing to gain |
| Docs (`roadmap.md`, `CLAUDE.md` rows, `infra/README.md`) | Labels | **Rename** headings to "Asset Library," keeping one parenthetical "(formerly Design Library)" per doc so history stays greppable |

Net: everything a human sees says **Asset Library**; the storage layer keeps its
design-flavored keys, documented once. The only genuinely time-sensitive item is the API
route rename — do it before production promotion or accept `/designs` forever.

---

## 6. Prioritized build plan

Each phase independently shippable to staging; production promotion stays owner-gated.

**Phase 0 — Stop the bleeding (S · low risk · frontend + data hygiene)**
- Production-hostname guard: on `kcmps.com`, the page renders the "staging only" notice
  instead of a dead grid (one hostname check, mirrors `dashboard-data.js:68`).
- Category honesty: annotate the existing select with the "shown on storefront / library
  only" grouping (pure client-side, computed from `KCMPS_STORE_DATA`).
- Kill the `form.onsubmit = null` bug the minimal way: track the retry state inside the one
  `submit` listener instead of swapping handlers.
- Housekeeping: delete the 4 orphan upload pairs from `kcmps-design-originals-staging` and
  their stray `SCAN#` items; delete the two `wave2-*-test.png` leftovers under
  `dev-site/assets/designs/`.
- *Ships alone; makes UAT re-runnable honestly while the rebuild happens.*

**Phase 1 — The rebuilt page (M · low-medium risk)**
- New `asset-library.html` per §3: library-first layout, upload modal (2 steps, drop zones,
  local previews, upload-on-drop), card grid with universal thumbnails, search/filter,
  detail drawer, scanning-state polling, recycle-bin purge countdown, rename throughout.
- Backend surgical changes: `webThumbUrl` + split scan statuses + events in
  `list-designs.js`; SVG into the originals allowlist (download-only); dashboard sends
  `draft` only.
- Effort: the largest single phase (~1 focused session frontend, ~half backend). Risk:
  low — no state-machine changes, the pipeline underneath is proven.

**Phase 2 — Admin approval workflow (M · medium risk)**
- `submit`/`approve`/`reject` actions in the patch Lambda, `ListUsersInGroup` IAM grant,
  `GET /assets/pending-approvals`, shell banner + Approvals tab, break-glass direct publish
  (Admin-only, evented). Route/function/folder rename rides along here (one CFN deploy).
- Risk: the final-approval publish race — mitigated by the conditional-update design in §4;
  unit-test the approval-set math as a pure module (`approval.js` in the Lambda folder,
  `node --test`, named files per `backend/CLAUDE.md`).
- Cost: <₱5/mo polling, ₱0 Cognito.

**Phase 3 — Storefront reach (S · needs an owner decision)**
- The category black hole's *real* fix is a catalog decision: which products beyond the 4
  dtf/subli SKUs should carry a design picker (`images: []` in `products.js`)? Present the
  owner the list; adding `images: []` to a product is a one-line opt-in. Until then, Phase
  0/1's labeling keeps it honest.
- Add "View on the storefront" deep-link on published cards (`../index.html#storefront` +
  the leaf tab), closing the publish→verify loop that UAT had no way to perform.

**Phase 4 — Production promotion (S-M · owner-gated, explicitly out of this pass)**
- Follow `backend/infra/README.md`'s existing checklist: `kcmps-design-originals-est-2026`
  bucket + GuardDuty plan (~₱0-10/mo per `docs/cost-governance.md`), production routes
  (under the new `/assets` names), env vars (`PUBLIC_ASSETS_KEY_PREFIX=assets/designs/`),
  **and the production page's CSP `connect-src`** for the production originals bucket — the
  exact silent-CSP-block failure mode this repo has been burned by before.

**Recurring-cost summary:** everything above sits inside existing free tiers; the only new
recurring line is approval polling (<₱5/mo). The standing "no server-side image processing"
decision is **upheld**: client-side `createObjectURL` previews + presigned/public web-ready
files deliver the aesthetic fix for ₱0. (Challenged and priced for completeness: a
Lambda-side thumbnail resize would itself be ~₱0/mo at this volume, but adds a native
`sharp` dependency to a repo with no build tooling and a second derived artifact to keep
consistent — cost isn't the objection, complexity is. Revisit only if 300 MB-adjacent
web-ready files ever make the grid slow.)

---

## 7. Explicit non-goals

- **Rendering SVG inline, ever** — download-only, generic tile thumbnail, excluded from the
  web-ready allowlist and `SAFE_IMAGE_RE`. Not negotiable; an SVG can carry script.
- **Weakening or adding a bypass to the fail-closed scan gate.** The UX makes waiting
  pleasant; it never makes it optional. "Break-glass" publish still passes the scan gate.
- **Server-side image processing** (resize/transcode/thumbnail pipeline) — standing
  decision upheld, see Phase costs.
- **DynamoDB `DESIGN#` / S3 `designs/` key migrations** for the rename — labels change,
  storage doesn't.
- **A customer-facing library or design browsing outside the existing product pickers** —
  the storefront consumer contract is untouched.
- **Asset versioning UI** (upload-a-new-revision flows) — S3 versioning already protects
  the bytes; a revisions UI is a later feature with its own design.
- **New GSIs, pagination, or search infrastructure** — client-side filtering over the
  bounded scan holds until ~500 assets, per the roadmap's existing decision.
- **Production deployment in this pass** — Phase 4 exists as a checklist only; every deploy
  in Phases 0-3 targets `kcmps-backend-staging` / `dev-site/`.
- **Approval workflows for anything other than Asset Library publishing** (orders, mail,
  etc.) — the banner pattern is reusable by design, but building a generic approvals
  engine for one consumer is exactly the altitude this repo avoids.
