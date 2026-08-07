# WIP handoff — idle-screen PIN: autofill fix + server-verified backend

Branch: `claude/idle-pin-backend` (worktree `.claude/worktrees/wt-pin`). Paused 2026-08-07
mid-task on the owner's request. **Nothing on this branch is deployed anywhere** — no zips
built, no `kcmps-backend-staging` deploy, no S3 sync. Staging and production both still run
the pre-branch code, i.e. the owner-reported autofill bug is still live until this ships.
The branch itself is a complete, self-consistent slice: all 126 backend tests pass
(`node --test backend/lib/*.test.js backend/asset-library/*.test.js`).

## 1. The autofill bug — root cause

The idle-lock overlay (`dashboard-shell.js` `renderPinGate()`) rendered the PIN as
`<input type="password">` inside a `<form>`, and `settings.html`'s set-PIN pair
(`#pin-new`/`#pin-confirm`) were also `type="password"`. Browser password managers key on
`type="password"`: Chrome offered to save the "password" when the PIN was set on Settings,
then **autofilled it into the lock screen's password field** when the guard reopened —
`autocomplete="off"` is ignored on password fields by every major manager, so the lock
unlocked itself. Classic, well-documented behavior; the field type was the bug.

### Fix (in `dashboard-shell.js`, `settings.html`, `dashboard.css`)

All three PIN inputs are now:
- `type="text"` + `inputmode="numeric"` + `pattern="[0-9]*"` (digit keypad on phones),
  masked purely by CSS — new `.dash-pin-mask` class in `dashboard.css`
  (`-webkit-text-security: disc; text-security: disc`). Chrome/Edge/Safari support the
  webkit property; Firefox since ~138. On anything older the digits render visibly —
  accepted fallback, documented in the CSS comment; do **not** revert to `type="password"`.
- `autocomplete="one-time-code"`, non-credential `name`s (`kcmps-idle-code*`), plus
  third-party manager opt-outs `data-lpignore="true" data-1p-ignore data-bwignore`.
- The overlay gate is no longer a `<form>` at all (Enter handled via keydown), so nothing
  matches save-a-login heuristics.

Removing `type="password"` removes both halves of the bug: managers won't *offer to save*
the PIN when set, and have no password field to *fill* on the lock screen. Already-saved
PINs from before the fix simply have nowhere to autofill.

### Verification status — IMPORTANT, unverified in any browser

**No browser was actually exercised before the pause.** Evidence so far is code-level only
(field types/attributes, `node --check`, unit tests). Next session must verify in at least
Chromium via the local server (`cd website && python3 -m http.server 5500`, use the
dashboard's localhost test-staff bypass): confirm (a) saving a PIN on Settings produces no
save-password prompt, (b) the lock screen field never autofills, (c) no CSP violations in
the console. Firefox/Safari were not checked either. Do not claim browser coverage that
hasn't been run.

## 2. Related bypass — reload/navigation defeated the lock: FOUND, fixed on branch

Confirmed real: the guard was pure in-memory state, so F5 or navigating to another
dashboard page in the same tab dismissed the privacy screen with no PIN. Fixed in
`dashboard-shell.js`: `openSessionGuard()` persists `kcmps_guard_lock_v1` = stage (`"1"`/
`"2"`) in **sessionStorage** (the flag only — never the PIN or anything derived from it);
`mount()` re-opens the guard from it; it's cleared by `closeSessionGuard()`, by stage-2's
Refresh button (only reachable post-PIN), and by `logout()`. sessionStorage scope matches
the `kcmps_tokens` session itself — a new tab has no tokens and hits the login gate anyway.
While the PIN status is not yet known (prefetch pending/failed), a restored lock **fails
closed** to the PIN gate rather than showing a free Resume button; it self-heals when the
status fetch resolves (repaint) or when verify returns `pinSet:false` (server says no PIN
→ unlock). Note: with **no PIN set**, reload still reopens the guard but its normal
"Resume without a PIN" button dismisses it — same as before; the lock is only as strong as
having a PIN, by design.

## 3. Server-verified PIN backend — design (code-complete on branch, NOT deployed)

- **`backend/lib/pin.js`** (+ `pin.test.js`, 8 tests): pure hashing/lockout logic.
  scrypt (Node built-in, memory-hard — deliberately not bare SHA), N=16384, r=8, p=1,
  keylen 32, fresh 16-byte salt per set; params stored on the record so they can be raised
  later (`verifyPin` uses the record's own params). `timingSafeEqual` compare.
  Lockout math: 4 free wrong attempts; 5th locks 30 s, doubling per subsequent wrong
  attempt, capped 15 min (`lockDurationMs`/`lockoutState`).
- **`backend/staff-api/staff-pin.js`** — ONE Lambda, four routes (precedent:
  `verify-payment.js` serves two routes): `GET /staff/pin` → `{pinSet}`;
  `PUT /staff/pin` `{pin}` (4–6 digits) sets/replaces; `DELETE /staff/pin` soft-deletes
  the item per repo convention but `REMOVE`s salt/hash outright (a hash of a removed PIN
  is pure liability); `POST /staff/pin/verify` `{pin}` → `{ok,...}` / 429
  `{locked, retryAfterSeconds}`. Gate: `extractClaims` + `isStaff` (dashboard-eligibility,
  not a finer role). **Identity is always the verified JWT `claims.sub`** — never a body
  field. Attempt counting lives ON the DynamoDB record (`failedCount`/`lockedUntil`):
  lock checked *before* the scrypt compare; wrong guess = atomic `ADD failedCount 1`
  (`ReturnValues: ALL_NEW`) then a lock write if the new count earns one; success resets
  both. Set/clear each append an inline `EVENT#<ISO>#PIN` audit item (lib's `buildEvent()`
  is order-shaped — requires orderId/lineItemId — so the audit item is built inline with
  the same tenant/schema stamps rather than forcing that helper).
- **Item shape**: `PK: USER#<sub>`, `SK: "PIN"` — new builders `userPk()`/`staffPinSk()`
  in `backend/lib/keys.js`. `baseItem()` stamps. `pin.js` is deliberately NOT spread into
  `lib/index.js` (same precedent as `business-hours.js`) — `require("../lib/pin")`.
- **IAM**: reuses `kcmps-staff-api-lambda-role` (staging: `StaffApiLambdaRole`) — it
  already grants Get/Put/Update on the table; no DeleteItem needed (soft-delete via
  Update).
- **Staging CFN** (`backend/infra/backend-lambdas.cfn.yaml`, edited on branch):
  `StaffPinLogGroup`, `StaffPinFunction` (`kcmps-${EnvName}-staff-pin`, zip key
  `${ArtifactsPrefix}/kcmps-staff-pin.zip`), `StaffPinIntegration`, 4 JWT-authorized
  routes, 2 permissions (`.../staff/pin` and `.../staff/pin/verify`), and **CORS
  `AllowMethods` gained PUT + DELETE** (was GET/POST/PATCH/OPTIONS).
- **Production plan (not started)**: CLI-managed like its siblings — create log group
  (30-day retention per cost convention) + function `kcmps-staff-pin` (nodejs24.x, arm64,
  role `kcmps-staff-api-lambda-role`, env `TABLE_NAME=kcmps`), integration + 4 routes on
  API `6msg2uho6c` with authorizer `sboj1n`, 2 scoped permissions, and
  `aws apigatewayv2 update-api --cors-configuration` to add PUT/DELETE to AllowMethods
  (verified missing in prod, same as staging).

## 4. Frontend seam (`dashboard-data.js`) — rewritten, on branch

- localStorage PIN storage is GONE; legacy `kcmps_pin_v1:*` records (weak salt+SHA-256 of
  a possibly-still-current PIN) are scrubbed on load.
- `hasStaffPin()` stays synchronous per the shell's contract, backed by an in-memory
  `pinStatusCache` warmed by `prefetchStaffPinStatus()` (called from the shell's
  `mount()`). `getStaffPinStatus()` async; `setStaffPin` → PUT; `clearStaffPin` → DELETE;
  `verifyStaffPin` → POST, returning a **structured result**
  (`{ok} | {ok:false} | {ok:false,pinSet:false} | {ok:false,locked,retryAfterSeconds} |
  {ok:false,error}`) — the shell handles each, including a countdown UI for lockout.
- `apiFetch` errors now carry `err.status`/`err.body` (needed for the 429 branch).

## 5. Deploy order — matters

Deploy the **backend first** (or together with the frontend). If the frontend alone
shipped, `/staff/pin` 404s: not a security hole (the guard fails closed; "Log out
instead" always works; Settings shows an error), but PIN set/verify would be dead.
Sequence for next session:
1. Build `kcmps-staff-pin.zip`: `index.js` = `staff-pin.js` **with every
   `require("../lib...")` rewritten to `./lib...`** (three of them: `../lib`,
   `../lib/constants`, `../lib/pin`), flattened `backend/lib/` (minus `*.test.js`),
   `node_modules` from `backend/staff-api/package.json`. Grep the finished zip contents
   for `require("../lib` and assert **zero** before deploying — this trap has shipped
   before (README documents it).
2. Upload zips to `kcmps-lambda-artifacts-staging` under a NEW prefix — **carry all other
   functions' zips forward to that prefix first** (`aws s3 sync` the old prefix), the
   stack-wide `ArtifactsPrefix` means every function reads from it.
3. `aws cloudformation deploy` `kcmps-backend-staging` with the new `ArtifactsPrefix`
   (template now >51,200 bytes for `validate-template` body — validate via `--template-url`
   from S3, or just let `deploy` package it; the earlier "validation error" was the size
   limit, not a template bug).
4. **Invoke after deploying** — deploy status proves nothing. Synthetic JWT-authorizer
   events against `kcmps-staging-staff-pin` covering: set → status → verify-correct →
   5x verify-wrong → expect 429 → verify-correct blocked until lock expiry → delete.
5. Sync `website/` to `s3://kcmps-online-bucket-est-2026/dev-site/`, verify on
   dev.kcmps.com (owner does Basic Auth) or locally. CSP: **no new origins needed** — all
   11 dashboard pages' `connect-src` already list both API hosts (checked), but verify in
   a real browser per the repo's CSP rule, don't trust the read.
6. Production only per the standard gate (owner go-ahead): prod Lambda/routes/CORS per §3,
   then sync `website/` to the bucket root.

## 6. Honest threat model (current branch state)

- **Protects against**: a passer-by at an unattended, still-logged-in screen (including
  via reload/navigation, which used to bypass the lock); the browser unlocking the screen
  itself via password-manager autofill; and — once the backend is deployed — learning or
  online-brute-forcing the PIN (server-side exponential lockout; the old localStorage
  salt+SHA-256 fell to offline brute force in <1 s and is now scrubbed).
- **Does NOT protect against**: the authenticated staff member themselves — they hold the
  Cognito session, which is the real boundary every backend route re-verifies. Someone
  with devtools can still delete the overlay DOM and read whatever the page had already
  loaded. A correct PIN at stage 2 still never skips the real session-expiry check.
- **As deployed today (nothing from this branch shipped)**: the live dashboard still has
  the autofill bug, the reload bypass, and the offline-crackable localStorage hash.

## 7. Traps hit / notes for the resuming session

- `require("../lib")` zip rewrite: applies to the handler AND any bundled sibling —
  `staff-pin.js` has three distinct `../lib*` requires (see §5.1).
- CFN template now exceeds `validate-template`'s 51,200-byte body cap — not an error in
  the template.
- localhost test-bypass (`seedLocalStaffSession`): its fake token fails the real JWT
  authorizer, so on localhost all `/staff/pin` calls fail → status cache stays null →
  the guard fails closed to the PIN gate on the restored-lock path. For local UI testing
  of the gate itself, stub `KCMPS_DASH.verifyStaffPin`/`getStaffPinStatus` in the console
  rather than weakening the fail-closed default.
- `git add` by explicit path only (repo rule); tests must name files
  (`node --test backend/lib/*.test.js ...`), the bare directory form is a false green.
