# WIP — mobile nav layout + order tagging (paused for usage limits)

Branch: `claude/order-tags-mobile-nav`, worktree `.claude/worktrees/wt-tags-nav`.
Paused mid-session on explicit instruction to stop expanding scope and land a clean,
consistent state. This note is written so a fresh session with no memory of this work can
resume without re-deriving anything.

## 1. Mobile nav — DONE and verified, safe to ship as-is

**What actually differed from the owner's sketch vs. what was already correct:**

The previous session (`45b1fc2`, "Nav: revert icon-only mobile collapse for a second row, per
owner spec") had already built almost the whole target layout in `website/index.html`'s inline
`<style>`/markup:
- Row 1: logo + "KCMPS" + full brand name on its own line below (2 lines total) — already
  matched the sketch's "logo, then wrapping brand name, two lines."
- Row 2: Track (magnifier icon + "Track" label), cart icon button, "Login / Sign-up" — already
  exactly the sketch's row 2, confirmed by reading rendered `getBoundingClientRect()` for each
  element at 375px before touching anything.

**The one real gap**: `.nav-brand` had `justify-content: center` inside the `@media
(max-width: 1200px)` block (line ~105 in `website/index.html`), which centered the logo+text
block in the row instead of left-aligning it. The sketch says "logo on the left." Changed to
`justify-content: flex-start`. This is the **only** functional change made for this task.

**What was checked and left alone**: the logo mark itself (`website/assets/logo-mark.png`) is
a gear/circular composed graphic already — read as "circular logo mark," not re-cropped. Did
not touch the pipe-separator-vs-line-break decision (the prior session deliberately dropped
`.brand-sep` in favor of a line break — re-reintroducing the pipe would contradict that
explicit "per owner spec" revert; see `git show 45b1fc2` for the full reasoning if this comes
up again).

**Verified**: via `mcp__Claude_Browser__javascript_tool` (the `computer` screenshot tool was
timing out in this environment — used `getBoundingClientRect()`/`getComputedStyle()` reads
instead, which is equally reliable for layout verification):
- 375px, logged-out: logo `x=20` (flush with the nav's own edge padding), row 2 shows exactly
  Track / cart / Login-Sign-up, no horizontal overflow (`document.body.scrollWidth ===
  window.innerWidth`).
- 320px, simulated logged-in-staff (widest row 2 case — Orders + Dashboard + cart + auth all
  visible): still no horizontal overflow.
- Confirmed **no change needed** to `website/styles.css` — the mobile nav rules live entirely
  in `index.html`'s inline `<style>`, so the "mirror into `design-system/KCMPS Redesign/
  styles.css`" rule doesn't apply here. `design-system/` is untouched and correctly so.

**Not deployed anywhere yet** — only verified against a local `python3 -m http.server 5500`.
Per the repo's standard deploy workflow, next step is `aws s3 sync website/
s3://kcmps-online-bucket-est-2026/dev-site/ --profile kcmps-claude-priv`, then a real look at
`https://dev.kcmps.com`, then stop and report before any production sync.

**Next steps, in order:**
1. Sync to `dev-site/` and eyeball it on `dev.kcmps.com` (Basic Auth creds not in this repo).
2. Report back, wait for explicit "promote it" before touching production.

## 2. Order tagging (AWS-style key/value chips) — backend written, NOT deployed; frontend UI reverted to inert

**Current state, precisely:**
- Backend Lambda source (`backend/staff-api/set-order-tags.js`) and its shared validation
  module (`backend/lib/tags.js`, unit-tested) are **written and tested locally** (132/132
  passing via `node --test backend/lib/*.test.js backend/asset-library/*.test.js`) but **not
  deployed** to `kcmps-backend-staging` or production. No Lambda function, no API route exists
  in AWS yet.
- `backend/infra/backend-lambdas.cfn.yaml` has the new resources added (LogGroup, Function,
  Integration, Route `POST /orders/{orderId}/tags`, Permission) but the template has **not been
  applied** — `aws cloudformation deploy` was never run against `kcmps-backend-staging`.
- `website/dashboard/dashboard-data.js` has `setOrderTags()`/`getDefaultOrderTags()` (plus a
  `setOrderTagsMock()` fallback for manual/mock-only orders) added and exported on
  `KCMPS_DASH`, but **nothing calls `setOrderTags()` for real orders yet** — it's dead code
  from the UI's perspective, which is deliberately safe/inert (mirrors how a deployed-but-
  uncalled route is safe; this is the inverse — a written-but-uncalled function).
- `website/dashboard/job-detail.html` has `renderTags(order)`/`wireTags(order)` fully built
  (chip display, remove button, suggested-tag quick-add buttons, freeform add form) but **the
  call sites were deliberately removed** from `render()` before pausing — search for
  "intentionally not called yet" in that file. The tags card does not currently render on the
  page at all. This was the fix applied when the coordinator flagged the risk of the UI calling
  a route that doesn't exist yet (would 404 for every real order the moment "Add tag" was
  clicked).
- `backend/lib/customer-view.js`'s `redactForCustomer()` was updated to strip `order.tags` and
  filter out `meta.via === "setTags"` audit events from the customer-facing view — this part is
  safe to ship regardless of deploy state, since it only ever runs on a real order object if
  one is ever handed to it with a `tags` field, which won't happen until the write path exists.

**Verified**: `node -c website/dashboard/dashboard-data.js` and a `new Function(...)` syntax
check over every `<script>` block in both `job-detail.html` and `index.html` — all clean, no
syntax errors introduced by the revert. Did **not** verify job-detail.html rendering in an
actual browser this session (ran out of time after the revert) — worth a quick real-browser
smoke test next session even though the tags UI is currently unreachable code, just to confirm
nothing else on the page broke.

### Proposed default tag set — STILL NEEDS OWNER APPROVAL, do not treat as final

Defined in `website/dashboard/dashboard-data.js` as `DEFAULT_ORDER_TAGS` (one array, easy to
edit in one place, purely a client-side "quick add" suggestion list — the backend doesn't know
or care what the defaults are, it validates any key/value against the general rules below):

| Key | Value | Why |
|---|---|---|
| Environment | Test | Synthetic/internal order — the owner explicitly mentioned "testing" as a use case; lets staff exclude these from real metrics |
| Priority | Rush | Needs expedited turnaround |
| Type | Reprint | Remake/redo of a prior job, not new revenue — distinguishes from an original order |
| Channel | Walk-in | Order taken in person/phone/DM rather than through online checkout |
| Client | VIP | Repeat/high-value client — handle with extra care |

Reasoning for this specific 5: thought about what a 4-person print shop would actually filter
job lists by, not generic cloud-resource tags — test/internal record, urgency, original-vs-
redo, order channel, and client tier came up as the concrete, recurring distinctions staff would
want to slice by. **Present this list to the owner explicitly before it ships** — the brief was
clear this needs approval, not just a plausible-sounding default.

### Validation rules (backend/lib/tags.js, unit-tested)

- Full-set PUT, not incremental add/remove: `POST /orders/{orderId}/tags` with body
  `{tags: [{key, value}]}` always sends the **complete** desired tag list. Chosen because the
  editor is a small form a single staff member fills out and saves — no meaningful concurrent-
  edit case, and a full-set PUT avoids partial-failure reconciliation.
- `MAX_TAGS_PER_ORDER = 20`, `MAX_KEY_LENGTH = 40`, `MAX_VALUE_LENGTH = 120`.
- Character allowlist (both key and value): `/^[A-Za-z0-9 _.:/=+-]+$/` — matches AWS's own tag
  charset (minus `@`), blocks HTML-special characters as defense in depth (the real XSS
  boundary is `escapeHtml()` at render time, same stance as `correspondenceLog`).
- Empty value allowed (boolean-style flag tag, e.g. `Test` with no value) — AWS permits this
  too.
- Duplicate keys rejected, **case-insensitively** (`Type` and `type` collide).
- Every tag change writes an `EVENT#` audit item via `buildEvent()`, using the synthetic
  `lineItemId: "ORDER"` sentinel (not a real line item) and `to: "Tags updated"`, with the
  before/after diff in `meta: {via: "setTags", added, removed, changed}` — `diffTags()` in the
  same file computes this. This event is **staff-only**: `redactForCustomer()` filters it out
  entirely (not just redacts its meta) so a customer never sees that staff have been tagging
  their order.
- `set-order-tags.js` is `isStaff()`-gated (any staff role, not `requireRole()`-restricted) —
  matches `add-correspondence.js`'s access level, since tagging an order "rush" or "test" isn't
  a sensitive action worth restricting to specific roles.

### Route + Lambda naming (for when this actually gets deployed)

- Lambda: `kcmps-${EnvName}-set-order-tags` (so `kcmps-staging-set-order-tags` /
  `kcmps-set-order-tags`), on the existing `StaffApiLambdaRole` (already has the
  `GetItem`/`UpdateItem`/`PutItem`/`TransactWriteItems` permissions this Lambda needs — no IAM
  change required, confirmed by reading the role's inline policy).
- Route: `POST /orders/{orderId}/tags`, JWT-authorized, same authorizer as every other
  staff-api route.
- No S3/UPLOADS_BUCKET env var needed — tags carry no attachments.

### Concrete next steps, in priority order

1. **Get the owner to approve or edit the `DEFAULT_ORDER_TAGS` list above** before wiring
   anything live — this is a product decision, not just an implementation detail.
2. **Build the Lambda zip and deploy to staging first**:
   ```bash
   cd backend/staff-api
   npm install   # node_modules doesn't exist in this checkout yet — first-time install needed
   mkdir -p /tmp/build-set-order-tags
   cp set-order-tags.js /tmp/build-set-order-tags/index.js
   sed -i 's/require("\.\.\/lib")/require(".\/lib")/' /tmp/build-set-order-tags/index.js
   # ^ CHECK for any OTHER require("../lib...") in this file before trusting one sed pass —
   #   set-order-tags.js only has the one require("../lib") at the top, verified when it was
   #   written, but re-verify with: grep -n 'require("\.\./lib' /tmp/build-set-order-tags/index.js
   #   must return ZERO matches before zipping (the root CLAUDE.md's exact warning about this).
   cp -r ../lib /tmp/build-set-order-tags/lib
   rm /tmp/build-set-order-tags/lib/*.test.js
   cp -r node_modules /tmp/build-set-order-tags/node_modules
   cd /tmp/build-set-order-tags && zip -r kcmps-set-order-tags.zip . -x '*.git*'
   aws s3 cp kcmps-set-order-tags.zip \
     s3://kcmps-lambda-artifacts-staging/asset-publish-gate-2026-08-07/kcmps-set-order-tags.zip \
     --profile kcmps-claude-priv
   # ^ "asset-publish-gate-2026-08-07" is the CURRENT ArtifactsPrefix on the deployed
   #   kcmps-backend-staging stack as of this session — verify it's still current with:
   #   aws cloudformation describe-stacks --stack-name kcmps-backend-staging --region ap-southeast-1
   #     --profile kcmps-claude-priv --query 'Stacks[0].Parameters'
   #   before uploading, in case a later session bumped it.
   aws cloudformation deploy \
     --stack-name kcmps-backend-staging \
     --template-file backend/infra/backend-lambdas.cfn.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --region ap-southeast-1 --profile kcmps-claude-priv
   # ^ no --parameter-overrides needed — `aws cloudformation deploy` reuses the stack's
   #   existing parameter values for anything not explicitly overridden.
   ```
3. **Invoke it directly with a synthetic event** (not just "deploy succeeded") to confirm the
   require-path rewrite actually worked and the handler runs — the root CLAUDE.md is explicit
   that deploy status alone proves nothing.
4. **Re-add the two call sites in `website/dashboard/job-detail.html`** — search for
   "intentionally not called yet" (two spots: the `renderTags(order) +` line in the template,
   commented out where the ticket-meta card starts, and the `wireTags(order);` call right after
   `wireMessages(order);`). Both are ready to uncomment/restore verbatim.
5. **Sync frontend to `dev-site/`**, exercise the tag editor for real on `dev.kcmps.com`
   against a real staging order (add, remove, suggested-tag quick-add, duplicate-key rejection,
   the 20-tag cap) — this hasn't been browser-tested at all yet, only syntax-checked.
6. Check `job-detail.html`'s CSP `connect-src` — it already lists both the production and
   staging API hosts (`6msg2uho6c...`/`162ufc121j...execute-api...`), so the new `/tags` route
   on the *same* API doesn't need a CSP change. Re-verify this is still true after any API
   Gateway changes, per the root CLAUDE.md's standing "CSP when a page goes live" reminder.
7. Only after staging is proven, repeat steps 2–3 against production's Lambda role/stack, then
   redeploy the frontend to production S3.
8. **Optional, not blocking**: `backend/infra/observability.cfn.yaml`'s 34 alarms don't cover
   `kcmps-set-order-tags` yet — add `Errors`/`Throttles` alarms for it alongside the other 17
   deployed Lambdas' entries, matching the existing pattern, once the function is actually live.

### Traps hit / to remember

- The `computer` screenshot tool timed out repeatedly in this environment (30s timeout, no
  visible cause) — `javascript_tool` with `getBoundingClientRect()`/`getComputedStyle()` reads
  worked fine and is what was actually used to verify the nav. Try screenshot again next
  session in case it was transient, but don't block on it.
- `buildEvent()` (`backend/lib/events.js`) requires `lineItemId` and `to` — it's designed for
  per-line-item transitions. Order-level events (tags) reuse it with a synthetic
  `lineItemId: "ORDER"` sentinel rather than hand-rolling a second event builder — this keeps
  one `EVENT#` construction path in the codebase, but means any code that assumes every
  `EVENT#`'s `lineItemId` is a real `LINEITEM#` (there wasn't any found, but double-check if
  something new reads `order.events` and joins it against `order.lineItems`) needs to tolerate
  the sentinel.
- Per the root CLAUDE.md: never deploy production in the same turn as staging, always name test
  files explicitly for `node --test` (the bare-directory form is a false green in this repo),
  and the only permitted SES test recipient is `admin+admin.kcmps.uat@kcmps.com` — none of this
  session's work sent email, so no SES exposure here, just flagging for whoever deploys next.

## Everything else in this branch's diff

`git status --short` at pause time:
```
 M backend/infra/backend-lambdas.cfn.yaml
 M backend/lib/customer-view.js
 M backend/lib/index.js
 M backend/lib/lib.test.js
 M website/dashboard/dashboard-data.js
 M website/dashboard/job-detail.html
 M website/index.html
?? backend/lib/tags.js
?? backend/lib/tags.test.js
?? backend/staff-api/set-order-tags.js
```
All of the above is committed on this branch as of this note. `node --test backend/lib/*.test.js
backend/asset-library/*.test.js` passes 132/132 at pause time.
