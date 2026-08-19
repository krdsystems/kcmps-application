/* ============================================================
   KCMPS Ops Dashboard — SHELL (auth gate + sidebar/topbar chrome)
   ============================================================
   Reuses the exact Cognito config, JWT-decode, and sessionStorage
   token keys already validated in ../index.html so a logged-in
   staff session carries straight over when the user clicks
   "Dashboard" — no second login. See ../../README.md for the full
   auth write-up.

   Every dashboard page loads this script and calls
   KCMPS_DASH_SHELL.mount("today") once, near the bottom of <body>.
   mount() gates the page (redirects non-staff back to the
   storefront), then paints the sidebar + topbar chrome.
   ============================================================ */

(function (global) {
  const COGNITO_CONFIG = {
    domain: "https://kcmps-auth.auth.ap-southeast-1.amazoncognito.com",
    clientId: "2rsbhkjooja4h5e0ijpl4siuug",
    redirectUri: window.location.origin + "/",
    staffGroupName: "Staff",
    // Any of these groups unlocks the dashboard. This list must mirror
    // backend/lib/auth.js's STAFF_ROLES exactly — a hire placed only in
    // Production/Sales/Finance passes every backend API, so a shorter list
    // here bounces them from the UI while the data layer says yes.
    // Tiers: Staff (dashboard-only), Admin (founders — dashboard plus any
    // admin-only surface built later), and the three department roles held
    // in reserve for the first non-founder hire.
    // Keep in sync with ../index.html's copy.
    // NOTE: these claims are client-decoded and UI-only — every backend
    // route re-verifies the JWT against Cognito. Don't add verification here.
    dashboardGroupNames: ["Staff", "Admin", "Production", "Sales", "Finance"],
  };
  const TOKEN_STORAGE_KEY = "kcmps_tokens";

  /* ---- idle privacy screen / session-staleness overlay config ----
     Both values are recommended defaults, not settled requirements — retune
     freely here, nothing else in this file needs to change. LOCK_MS (stage
     1, privacy screen) is the one most likely to need adjusting against
     real staff workflow: too short reads as annoying, too long leaves
     customer data on an unattended screen for anyone walking past. */
  const SESSION_GUARD = {
    LOCK_MS: 30 * 60 * 1000, // stage 1: privacy lock — nobody walking past can read the screen
    /* stage 2: a genuine IDLE TIMEOUT, no longer a proxy for token expiry.
       Before refresh tokens existed (auth-refresh.js) this sat at 60 min
       because that is when the id token died and the session ended with it;
       stage 2 was really announcing "your token is gone". Now the token
       refreshes itself for up to the refresh token's 5-day life, so 60 min
       would have been an arbitrary interruption of a perfectly live session.
       4h is the deliberate idle policy instead: long enough to cover a shift
       with meetings/lunch in it, short enough that an unattended terminal
       does not stay usable overnight. */
    SESSION_MS: 4 * 60 * 60 * 1000,
    ACTIVITY_DEBOUNCE_MS: 1000, // coalesce bursts of pointer/key events into one timestamp write
    CHECK_INTERVAL_MS: 15 * 1000, // how often the idle clock is polled
    EXP_SKEW_MS: 0, // no grace period — an expired token is treated as expired immediately
  };

  function decodeJwt(token) {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    );
    return JSON.parse(json);
  }
  function loadTokens() {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  /* "Have we already auto-opened the nav drawer this session?" — see the
     auto-open block in mount(). Lives at module scope, not inside mount(),
     because clearTokens() below has to release it too. */
  const SIDEBAR_AUTO_OPEN_KEY = "kcmps_sidebar_auto_opened";

  /* Clearing tokens ends the session, so it must ALSO release the
     auto-open flag. sessionStorage is scoped to the TAB, not to the login:
     without this line, logging out and back in inside the same tab left
     the flag set, so the drawer auto-opened exactly once per tab, ever,
     and never again for any subsequent login. Reported 2026-08-19 as
     "the auto-open feature is still not working" after a logout/login
     cycle — the preference was fine and reads ON by default; the gate in
     front of it had already been consumed. This runs on every session-end
     path (explicit logout, expired `exp`, undecodable token), which is
     exactly when re-arming is correct. */
  function clearTokens() {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(SIDEBAR_AUTO_OPEN_KEY);
  }

  /* ---- local-only test bypass ----
     No backend/Cognito Staff account is needed to test this mock-data
     build (see ../../ops-dashboard/infra/backend-infra-to-deploy.md — the dashboard runs
     entirely on localStorage right now). Real Cognito auth is unchanged
     and still enforced everywhere except when both of these hold:
       1. The page is being served from localhost/127.0.0.1/::1/file: —
          this can NEVER be true on the deployed CloudFront domain, so
          there is no way to trigger this path in production.
       2. The tester explicitly clicks the bypass button on
          dashboard/index.html — it is never triggered automatically. ---- */
  function isLocalHost() {
    return ["localhost", "127.0.0.1", "::1", ""].includes(window.location.hostname) || window.location.protocol === "file:";
  }
  function base64UrlEncodeString(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function seedLocalStaffSession(name) {
    if (!isLocalHost()) throw new Error("The local test-staff bypass only works when running on localhost — it is disabled on any real domain.");
    const header = base64UrlEncodeString(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = base64UrlEncodeString(JSON.stringify({
      name: name || "Test Staff", email: "test-staff@local.dev", sub: "local-dev-sub",
      "cognito:groups": [COGNITO_CONFIG.staffGroupName],
    }));
    const fakeIdToken = header + "." + payload + ".devsig";
    sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ id_token: fakeIdToken, access_token: "local-dev-token", expires_in: 3600 }));
  }

  // `soon: true` renders a "Soon" badge and dims the link, but still points at
  // a real placeholder page — a dead/disabled nav item reads as a bug, and the
  // placeholder becomes the real page's shell later (only <main> changes).
  //
  // ORDER IS DERIVED, NOT HAND-MAINTAINED. Do not reorder this array to move a
  // page up when it goes live: navOrdered() below sorts live items above
  // previews and pins Settings last. Deleting a page's `soon: true` is the ONE
  // edit needed to promote it — it moves itself. Keeping the array in feature
  // order (rather than display order) means the two can never drift apart,
  // which is exactly what went wrong before: the previews were interleaved
  // with the working pages and dimming was the only signal that half the nav
  // did nothing yet.
  const NAV_ITEMS = [
    { key: "today", href: "today.html", label: "Today", hint: "Daily control" },
    { key: "week", href: "week.html", label: "This Week", hint: "Capacity & scheduling", soon: true },
    { key: "month", href: "month.html", label: "This Month", hint: "Trends & margin", soon: true },
    { key: "jobs", href: "jobs.html", label: "Jobs", hint: "All tickets" },
    { key: "cashbook", href: "cashbook.html", label: "Cash Book", hint: "Money in, money out, job profit" },
    { key: "clients", href: "clients.html", label: "Clients", hint: "CRM", soon: true },
    { key: "email", href: "email.html", label: "Email", hint: "Shop mailboxes" },
    { key: "inventory", href: "inventory.html", label: "Inventory", hint: "Stock levels", soon: true },
    { key: "design", href: "asset-library.html", label: "Asset Library", hint: "Files, designs & approvals" },
    { key: "settings", href: "settings.html", label: "Settings", hint: "Idle-screen PIN & navigation" },
  ];

  /* Display order for the sidebar: working pages first, previews below them,
     Settings always last (it is the least-used page whether or not it is live,
     and a bottom-pinned Settings is the convention users expect).
     Within each group the NAV_ITEMS order above is preserved — Array.prototype
     .sort is stable per spec, so equal-rank items keep their relative order and
     no tiebreaker index is needed. */
  const NAV_RANK_LIVE = 0, NAV_RANK_SOON = 1, NAV_RANK_LAST = 2;
  function navRank(item) {
    if (item.key === "settings") return NAV_RANK_LAST;
    return item.soon ? NAV_RANK_SOON : NAV_RANK_LIVE;
  }
  function navOrdered() {
    return NAV_ITEMS.slice().sort((a, b) => navRank(a) - navRank(b));
  }

  function svgIcon(key) {
    const icons = {
      today: '<path d="M128,24a104,104,0,1,0,104,104A104.11,104.11,0,0,0,128,24Zm8,104a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h40V72a8,8,0,0,1,16,0Z"/>',
      week: '<path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Z"/>',
      month: '<path d="M224,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H32a16,16,0,0,0-16,16V192a16,16,0,0,0,16,16H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h64a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Z"/>',
      jobs: '<path d="M216,72H180.94l-9.83-19.66A16,16,0,0,0,156.78,44H99.22a16,16,0,0,0-14.33,8.34L75.06,72H40A24,24,0,0,0,16,96V192a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24V96A24,24,0,0,0,216,72Z"/>',
      // Phosphor "notebook" (regular), copied verbatim from
      // phosphor-icons/core assets/regular/notebook.svg — never hand-write
      // path data.
      cashbook: '<path d="M184,112a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h64A8,8,0,0,1,184,112Zm-8,24H112a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Zm48-88V208a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48ZM48,208H72V48H48Zm160,0V48H88V208H208Z"/>',
      clients: '<path d="M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92Z"/>',
      // Phosphor "envelope-simple" / "images-square" (regular), copied verbatim
      // from phosphor-icons/core assets/regular/*.svg — never hand-write path data.
      email: '<path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/>',
      design: '<path d="M208,32H80A16,16,0,0,0,64,48V64H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V192h16a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM80,48H208v69.38l-16.7-16.7a16,16,0,0,0-22.62,0L93.37,176H80Zm96,160H48V80H64v96a16,16,0,0,0,16,16h96Zm32-32H116l64-64,28,28v36Zm-88-64A24,24,0,1,0,96,88,24,24,0,0,0,120,112Zm0-32a8,8,0,1,1-8,8A8,8,0,0,1,120,80Z"/>',
      inventory: '<path d="M223.68,66.15,135.68,18a15.94,15.94,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.94,15.94,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15Z" opacity="0.35"/>',
      settings: '<path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Z" opacity="0.35"/><path d="M128,176a48,48,0,1,1,48-48A48.05,48.05,0,0,1,128,176Zm0-80a32,32,0,1,0,32,32A32,32,0,0,0,128,96Z"/>',
    };
    return icons[key] || "";
  }

  function requireStaffAuth() {
    const tokens = loadTokens();
    if (!tokens) {
      // On localhost, send them to the dashboard's own landing page — it
      // offers the local test-staff bypass instead of just bouncing them
      // to the storefront with nothing they can do about it.
      window.location.replace(isLocalHost() ? "index.html" : "../index.html?login=required");
      return null;
    }
    let claims;
    try { claims = decodeJwt(tokens.id_token); } catch { clearTokens(); window.location.replace("../index.html?login=required"); return null; }
    // The local test-bypass token (seedLocalStaffSession) has no `exp` claim
    // at all — only real Cognito-issued tokens do — so a missing `exp` is
    // treated as valid rather than expired, which keeps that bypass working.
    if (typeof claims.exp === "number" && claims.exp * 1000 + SESSION_GUARD.EXP_SKEW_MS <= Date.now()) {
      /* Expired id token is no longer automatically the end of the session:
         if a refresh token is on hand, try to trade it in rather than
         bouncing staff to login. This stays SYNCHRONOUS on purpose —
         requireStaffAuth() has many callers that expect claims back
         immediately — so it starts the refresh and lets the page continue on
         the just-expired claims, which are UI-only anyway (every backend
         route re-verifies, and dashboard-data.js's apiFetch awaits
         ensureFresh() before it sends anything). If the refresh fails, THAT
         is when we clear and redirect. canRefresh() is false for the
         local-dev bypass token (no exp, no refresh token) and for any
         pre-refresh-feature blob, both of which fall through to the original
         behaviour below. */
      if (global.KCMPS_AUTH && global.KCMPS_AUTH.canRefresh()) {
        global.KCMPS_AUTH.refresh().catch(() => {
          clearTokens();
          window.location.replace(isLocalHost() ? "index.html" : "../index.html?login=required");
        });
        return claims;
      }
      clearTokens();
      window.location.replace(isLocalHost() ? "index.html" : "../index.html?login=required");
      return null;
    }
    const groups = claims["cognito:groups"] || [];
    if (!COGNITO_CONFIG.dashboardGroupNames.some((g) => groups.includes(g))) {
      window.location.replace("../index.html?dashboard=forbidden");
      return null;
    }
    return claims;
  }

  function logout() {
    // A deliberate identity change — the lock flag shouldn't survive into
    // the next person's fresh login in this tab.
    try { sessionStorage.removeItem("kcmps_guard_lock_v1"); } catch { /* ignore */ }
    // Best-effort refresh-token revocation before the local clear, so a
    // stolen copy dies with the session instead of outliving it by days.
    // Not awaited — a failed/slow revoke must never block logging out.
    try { global.KCMPS_AUTH && global.KCMPS_AUTH.revoke(); } catch (e) { /* ignore */ }
    clearTokens();
    const logoutUrl = `${COGNITO_CONFIG.domain}/logout?${new URLSearchParams({
      client_id: COGNITO_CONFIG.clientId,
      logout_uri: COGNITO_CONFIG.redirectUri,
    }).toString()}`;
    window.location.href = logoutUrl;
  }

  /* ---- idle privacy screen / session-staleness overlay ----
     One overlay, two stages, driven off a single timestamp (lastActivityAt)
     rather than a countdown — so it survives laptop sleep / a backgrounded
     tab correctly (a running setTimeout would not). Stage 1 fires at
     SESSION_GUARD.LOCK_MS idle (privacy — obscure the screen). Stage 2
     fires at SESSION_GUARD.SESSION_MS idle OR immediately when
     escalateSessionGuard() is called from a 401 (see dashboard-data.js's
     apiFetch) — whichever happens first. If stage 1 is already showing when
     stage 2's condition is met, the SAME element is upgraded in place
     (data-stage swapped, content rewritten) rather than stacking a second
     overlay. Dismissal is explicit-button-only by design — no outside-click,
     no Escape — so a stray click/keypress from a passer-by can't reopen the
     obscured content; the keydown handler below only traps Tab. */
  let lastActivityAt = Date.now();
  let activityListenersAttached = false;
  let guardStage = 0; // 0 = closed, 1 = privacy lock, 2 = session/staleness
  let guardEl = null;
  let guardFocusReturnEl = null;
  // The signed-in staffer's Cognito `sub` (set from mount()'s claims) — the
  // key setStaffPin()/verifyStaffPin() store/check the PIN under, so a
  // shared browser can't let one staffer's PIN unlock another's session.
  let guardUserKey = null;

  function debounceLeading(fn, ms) {
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      fn.apply(this, args);
    };
  }

  function attachActivityListeners() {
    if (activityListenersAttached) return;
    activityListenersAttached = true;
    const bump = debounceLeading(() => { lastActivityAt = Date.now(); }, SESSION_GUARD.ACTIVITY_DEBOUNCE_MS);
    // One listener set per page load (not per-component), passive so it
    // never competes with scroll/touch performance.
    ["pointerdown", "keydown", "touchstart"].forEach((evt) => document.addEventListener(evt, bump, { passive: true }));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) bump(); });
    setInterval(checkIdle, SESSION_GUARD.CHECK_INTERVAL_MS);
  }

  function checkIdle() {
    if (guardStage === 2) return; // already at the max stage — nothing further to raise
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs >= SESSION_GUARD.SESSION_MS) openSessionGuard(2);
    else if (idleMs >= SESSION_GUARD.LOCK_MS && guardStage !== 1) openSessionGuard(1);
  }

  function ensureGuardEl() {
    if (guardEl) return guardEl;
    const backdrop = document.createElement("div");
    backdrop.className = "session-guard-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "session-guard-title");
    backdrop.setAttribute("aria-describedby", "session-guard-desc");
    backdrop.innerHTML =
      '<div class="session-guard-box" id="session-guard-box">' +
      '<div class="session-guard-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 256 256" fill="currentColor"><path d="M208,80H184V56a56,56,0,0,0-112,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM88,56a40,40,0,0,1,80,0V80H88Z"/></svg></div>' +
      '<h3 id="session-guard-title"></h3>' +
      '<p id="session-guard-desc"></p>' +
      '<div class="session-guard-actions" id="session-guard-actions"></div>' +
      "</div>";
    // Tab-trap: the only keyboard behavior this overlay allows. No Escape
    // handler on purpose (dismissal is explicit-button-only, see above).
    backdrop.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      // Includes text inputs now — the PIN-gated states below put a
      // CSS-masked text <input> before the buttons (deliberately NOT
      // type="password" — see renderPinGate's autofill note), and it needs
      // to be part of the trap's first/last boundary like everything else.
      const focusables = backdrop.querySelectorAll("button, input");
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(backdrop);
    guardEl = backdrop;
    return backdrop;
  }

  // Renders the stage-2 (session/staleness) Refresh/Log out controls into
  // `actions` — unchanged from before the PIN feature. Split out so the
  // PIN gate below (renderPinGate) can reveal this same pair once the PIN
  // checks out, instead of duplicating it.
  function renderStage2Actions(actions) {
    actions.innerHTML =
      '<button type="button" class="btn btn-secondary" id="session-guard-logout">Log out</button>' +
      '<button type="button" class="btn btn-primary" id="session-guard-refresh">Refresh</button>';
    actions.querySelector("#session-guard-logout").addEventListener("click", logout);
    actions.querySelector("#session-guard-refresh").addEventListener("click", () => {
      // Re-run the current page's data load. requireStaffAuth() (called
      // again on load, via mount()) falls through to the login gate if
      // the session is genuinely expired — this button doesn't need to
      // know which case it is. Entering the right PIN never skips this:
      // the PIN only unlocked the CONTROLS, Refresh still does the real
      // expiry check it always did. Clearing the persisted lock here is
      // legitimate: this button is only reachable after the PIN checked
      // out (or when no PIN exists) — without clearing it, the reload
      // would restore the lock and Refresh could never succeed.
      clearPersistedLock();
      window.location.reload();
    });
    const primary = actions.querySelector(".btn-primary");
    if (primary) primary.focus();
  }

  /* The PIN entry step, used at both overlay stages when the signed-in
     staffer has one set. Verification is SERVER-SIDE since 2026-08-07
     (backend/staff-api/staff-pin.js, via dashboard-data.js's
     verifyStaffPin) — wrong attempts are counted on the backend record
     and lock out with exponential backoff (5 free, then 30s doubling to
     15min), so a 4-digit code can't be brute-forced from this field OR
     from curl. "Log out instead" never needs the PIN: logging out can't
     leak anything and is the recovery path for a forgotten PIN (log back
     in, then set a new one in Settings — no old PIN required there,
     because a live Cognito login is a stronger check than the PIN).

     AUTOFILL: this input must NEVER be type="password", and must never
     sit in a password-manager-recognizable form. The original
     implementation used type="password" (+ a same-shaped pair on
     settings.html), and Chrome's password manager offered to save the
     "password" — then AUTO-FILLED IT INTO THIS LOCK SCREEN when it
     reopened, unlocking it for anyone who walked past. autocomplete="off"
     did not stop it (password managers famously ignore it on password
     fields). The fix: type="text" + inputmode="numeric" (so phones still
     get a digit pad) masked purely by CSS (.dash-pin-mask,
     -webkit-text-security in dashboard.css), autocomplete="one-time-code"
     (the strongest "this is not a credential" signal), a name that
     matches no login heuristic, and opt-out attributes for the big
     third-party managers (data-lpignore/data-1p-ignore/data-bwignore).
     No surrounding <form> — Enter is handled on keydown — so nothing
     here matches the save-a-login heuristics either. */
  function renderPinGate(actions, opts) {
    actions.innerHTML =
      '<div id="session-guard-pin-form" style="display:flex;flex-direction:column;gap:8px;align-items:center;width:100%">' +
      '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" ' +
      'autocomplete="one-time-code" name="kcmps-idle-code" spellcheck="false" ' +
      'data-lpignore="true" data-1p-ignore data-bwignore ' +
      'class="input dash-pin-mask" id="session-guard-pin-input" placeholder="PIN" aria-label="Idle-screen PIN" ' +
      'style="text-align:center;letter-spacing:8px;font-size:18px;max-width:150px" />' +
      '<p id="session-guard-pin-error" role="alert" style="display:none;color:#b91c1c;font-size:12.5px;margin:0"></p>' +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-ghost" id="session-guard-pin-logout">Log out instead</button>' +
      `<button type="button" class="btn btn-primary" id="session-guard-pin-submit">${opts.continueLabel}</button>` +
      '</div></div>';
    const input = actions.querySelector("#session-guard-pin-input");
    const errorEl = actions.querySelector("#session-guard-pin-error");
    const submitBtn = actions.querySelector("#session-guard-pin-submit");
    actions.querySelector("#session-guard-pin-logout").addEventListener("click", logout);

    let busy = false;
    let lockTimer = null;
    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = ""; }
    function lockCountdown(seconds) {
      // Server said "locked out" — disable the field and count down so
      // the staffer isn't left mashing a dead button. The server is the
      // authority; this timer is presentation only.
      if (lockTimer) clearInterval(lockTimer);
      let left = seconds;
      input.disabled = true;
      submitBtn.disabled = true;
      const paint = () => showError("Too many wrong attempts — locked for " + left + "s. You can always log out instead.");
      paint();
      lockTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(lockTimer); lockTimer = null;
          input.disabled = false; submitBtn.disabled = false;
          errorEl.style.display = "none";
          input.focus();
        } else paint();
      }, 1000);
    }
    async function submit() {
      if (busy || input.disabled) return;
      const pin = input.value.trim();
      if (!pin) { input.focus(); return; }
      errorEl.style.display = "none";
      busy = true; submitBtn.disabled = true;
      let result = { ok: false, error: "PIN check unavailable." };
      try {
        if (global.KCMPS_DASH && global.KCMPS_DASH.verifyStaffPin) {
          result = await global.KCMPS_DASH.verifyStaffPin(guardUserKey, pin);
        }
      } finally { busy = false; submitBtn.disabled = false; }
      // Back-compat: a bare boolean still means ok/not-ok.
      if (result === true) result = { ok: true };
      if (!result || typeof result !== "object") result = { ok: false };
      if (result.ok || result.pinSet === false) {
        // pinSet === false: server says there is no PIN on file (e.g. it
        // was removed on another device) — nothing to gate on, unlock.
        opts.onSuccess();
        return;
      }
      input.value = "";
      if (result.locked) { lockCountdown(result.retryAfterSeconds || 30); return; }
      showError(result.error ? result.error : "Incorrect PIN — try again, or log out.");
      input.focus();
    }
    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    input.focus();
  }

  /* ---- lock persistence (anti reload-bypass) ----
     The overlay used to be pure in-memory state, so F5 (or typing another
     dashboard page's URL into the same tab) dismissed the privacy screen
     with no PIN at all — an unattended locked screen was one keystroke
     from unlocked. A flag in sessionStorage (NOT the PIN, not anything
     derived from it — just "this tab is locked at stage N") survives
     reload/navigation within the tab, and mount() re-opens the guard
     from it. sessionStorage is the right scope: it's per-tab, exactly
     like the kcmps_tokens session itself — a NEW tab has no tokens and
     lands on the login gate anyway, so it needs no flag. */
  const GUARD_LOCK_KEY = "kcmps_guard_lock_v1";
  function persistLock(stage) {
    try { sessionStorage.setItem(GUARD_LOCK_KEY, String(stage)); } catch { /* ignore */ }
  }
  function clearPersistedLock() {
    try { sessionStorage.removeItem(GUARD_LOCK_KEY); } catch { /* ignore */ }
  }
  function persistedLockStage() {
    try {
      const raw = sessionStorage.getItem(GUARD_LOCK_KEY);
      return raw === "1" || raw === "2" ? Number(raw) : 0;
    } catch { return 0; }
  }

  function openSessionGuard(stage) {
    const wasOpen = guardStage !== 0;
    guardStage = stage;
    persistLock(stage);
    const el = ensureGuardEl();
    const box = el.querySelector("#session-guard-box");
    const actions = el.querySelector("#session-guard-actions");
    box.dataset.stage = String(stage);

    /* PIN-status source: dashboard-data.js's in-memory cache, prefetched
       by mount(). If the prefetch hasn't resolved yet (or failed —
       offline), FAIL CLOSED: render the PIN gate rather than a free
       Resume button, otherwise "reload before the status query lands"
       would be a lock bypass. The closed stance self-heals both ways:
       when the prefetch resolves, the re-render below repaints the
       correct variant, and if the server says no PIN is on file, the
       gate's verify path unlocks on that answer (pinSet === false). */
    const dash = global.KCMPS_DASH || {};
    const statusKnown = !(dash.staffPinStatusKnown) || dash.staffPinStatusKnown();
    const pinSet = statusKnown
      ? !!(dash.hasStaffPin && dash.hasStaffPin(guardUserKey))
      : true;
    if (!statusKnown && dash.getStaffPinStatus) {
      dash.getStaffPinStatus().then(() => {
        // Still open at the same stage? Repaint with the real answer.
        if (guardStage === stage) openSessionGuard(stage);
      }).catch(() => { /* stay failed-closed on the PIN gate */ });
    }

    if (stage === 1) {
      el.querySelector("#session-guard-title").textContent = "Screen locked while you were away";
      el.querySelector("#session-guard-desc").textContent = pinSet
        ? "For privacy, this stayed open longer than usual, so it's been hidden. Enter your PIN to resume — nothing was lost."
        : "For privacy, this stayed open longer than usual, so it's been hidden. Nothing was lost. Set a 4-digit PIN and only you can bring this screen back.";
      if (pinSet) {
        // A correct PIN at stage 1 is a real "resume" — the session itself
        // is not in question here, only whether the right person is
        // looking at the screen.
        renderPinGate(actions, {
          continueLabel: "Unlock",
          onSuccess: () => { lastActivityAt = Date.now(); closeSessionGuard(); },
        });
      } else {
        // No PIN on file — this is the moment the feature is most obviously
        // useful, so the primary action sends them to Settings to set one
        // (deep-linked to #idle-pin) rather than just letting them dismiss.
        //
        // "Resume without a PIN" stays as a deliberate second option, and
        // that is NOT a half-measure: this overlay is a shoulder-surfing
        // deterrent, not an auth boundary (the Cognito JWT every backend
        // route re-verifies is the real one), so a hard gate here would buy
        // no actual security while creating a genuine way to strand a
        // staffer out of their own dashboard mid-job — exactly the failure
        // this codebase avoids elsewhere. Nudge, don't trap.
        actions.innerHTML =
          '<button type="button" class="btn btn-primary" id="session-guard-setpin">Set up a PIN</button>' +
          '<button type="button" class="btn btn-ghost" id="session-guard-resume">Resume without a PIN</button>';
        el.querySelector("#session-guard-setpin").addEventListener("click", () => {
          // Close first so the overlay isn't left painted over the page we
          // are navigating to if the browser restores this view from bfcache.
          lastActivityAt = Date.now();
          closeSessionGuard();
          global.location.href = "settings.html#idle-pin";
        });
        el.querySelector("#session-guard-resume").addEventListener("click", () => {
          lastActivityAt = Date.now();
          closeSessionGuard();
        });
        actions.querySelector(".btn-primary").focus();
      }
    } else {
      el.querySelector("#session-guard-title").textContent = "Signed out for inactivity";
      el.querySelector("#session-guard-desc").textContent = pinSet
        ? "This screen has been idle for a while. Enter your PIN to see the Refresh/Log out options — the data here may be out of date."
        : "This screen has been idle for a while, so the data here may be out of date. Refresh to continue, or log out.";
      if (pinSet) {
        // IMPORTANT: a correct PIN here does NOT dismiss the overlay or
        // resume the page — it only reveals the Refresh/Log out controls
        // (renderStage2Actions), which still run the real
        // requireStaffAuth()/reload expiry check exactly as before this
        // feature existed. Stage 2 now means a long IDLE period (tokens
        // refresh themselves — see auth-refresh.js), and the PIN is still
        // not allowed to become a way to wave that away and "just carry
        // on" with data that may be hours stale.
        renderPinGate(actions, {
          continueLabel: "Continue",
          onSuccess: () => { renderStage2Actions(actions); },
        });
      } else {
        // Deliberately NO "set up a PIN" nudge at stage 2, unlike stage 1.
        // Stage 2 follows hours of inactivity, and the underlying session
        // may or may not still be refreshable — sending them to
        // settings.html risks a prompt that cannot succeed, which is worse
        // than no prompt. They get the nudge next time stage 1 fires on a
        // live session.
        renderStage2Actions(actions);
      }
    }

    if (!wasOpen) {
      guardFocusReturnEl = document.activeElement;
      el.style.display = "flex";
    }
  }

  function closeSessionGuard() {
    clearPersistedLock();
    if (!guardEl) return;
    guardStage = 0;
    guardEl.style.display = "none";
    if (guardFocusReturnEl && typeof guardFocusReturnEl.focus === "function") {
      guardFocusReturnEl.focus();
    }
    guardFocusReturnEl = null;
  }

  // Called from dashboard-data.js's apiFetch on a 401 that SURVIVED a
  // refresh-and-retry (see its 401 branch) — jumps straight to stage 2
  // regardless of idle time, since at that point the 401 is direct evidence
  // the session is genuinely unrecoverable, not merely an aged-out token.
  function escalateSessionGuard() {
    openSessionGuard(2);
  }

  function mount(activeKey) {
    const claims = requireStaffAuth();
    if (!claims) return null; // redirecting away

    guardUserKey = claims.sub || null;
    lastActivityAt = Date.now();
    attachActivityListeners();
    document.documentElement.classList.add("dash-ready");

    // Warm the PIN-status cache (hasStaffPin is synchronous by contract —
    // see dashboard-data.js). Best-effort: a failed fetch leaves the cache
    // unknown and the guard fails closed on the PIN gate.
    if (global.KCMPS_DASH && global.KCMPS_DASH.prefetchStaffPinStatus) {
      global.KCMPS_DASH.prefetchStaffPinStatus();
    }
    // Re-arm a lock that was active before a reload / same-tab navigation
    // (the anti reload-bypass flag — see persistLock's comment). Restored
    // BEFORE first paint of any data below the overlay would matter, but
    // the overlay covers the page either way.
    const restoredStage = persistedLockStage();
    if (restoredStage) openSessionGuard(restoredStage);

    const navMount = document.getElementById("dash-nav");
    const topbarMount = document.getElementById("dash-topbar-content");
    const active = NAV_ITEMS.find((n) => n.key === activeKey);

    if (navMount) {
      navMount.innerHTML =
        '<div class="dash-brand"><img src="../assets/logo-mark.png" alt="" /><span>KCMPS <em>Ops</em></span></div>' +
        '<nav class="dash-navlinks">' +
        navOrdered().map((n) =>
          `<a href="${n.href}" class="dash-navlink${n.key === activeKey ? " is-active" : ""}${n.soon ? " is-soon" : ""}">` +
          `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${svgIcon(n.key)}</svg>` +
          `<span class="lbl">${n.label}</span>` +
          (n.soon ? '<span class="badge-soon">Soon</span>' : "") + '</a>'
        ).join("") +
        '</nav>' +
        '<a href="../index.html" class="dash-navlink dash-back"><svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z"/></svg><span class="lbl">Back to site</span></a>';
    }

    if (topbarMount) {
      const name = claims.name || claims.email || "Staff";
      topbarMount.innerHTML =
        `<div class="dash-topbar-title"><h1>${active ? active.label : "Dashboard"}</h1>` +
        `<p>${active ? active.hint : ""}</p></div>` +
        '<div class="dash-topbar-user">' +
        `<span class="dash-user-name">${escapeHtml(name)}</span>` +
        '<button type="button" class="btn btn-ghost" id="dash-logout-btn">Logout</button>' +
        '</div>';
      const logoutBtn = document.getElementById("dash-logout-btn");
      if (logoutBtn) logoutBtn.addEventListener("click", logout);
    }

    refreshUnreadBadge();
    if (!unreadBadgeTimer) unreadBadgeTimer = setInterval(refreshUnreadBadge, 45000);

    // mobile nav toggle — a backdrop covers the content area behind the
    // sidebar so a tap out there closes it; visibility:hidden (not just
    // opacity:0) keeps it out of the hit-test when closed, matching
    // store.js's .cart-overlay pattern.
    const toggle = document.getElementById("dash-nav-toggle");
    const sidebar = document.getElementById("dash-sidebar");
    if (toggle && sidebar) {
      const backdrop = document.createElement("div");
      backdrop.className = "dash-sidebar-backdrop";
      document.body.appendChild(backdrop);
      const closeSidebar = () => { sidebar.classList.remove("is-open"); backdrop.classList.remove("is-open"); };
      toggle.addEventListener("click", () => {
        sidebar.classList.toggle("is-open");
        backdrop.classList.toggle("is-open", sidebar.classList.contains("is-open"));
      });
      backdrop.addEventListener("click", closeSidebar);

      // Auto-open the nav drawer the FIRST time a mobile session enters
      // the dashboard (2026-08-19; made a per-staffer, Settings-toggled
      // preference the same day per owner revision — see settings.html's
      // "Navigation" section) — reuses this exact open path (the same
      // is-open classes toggle() sets above), never a second one, so
      // there's only ever one way this drawer opens or closes. Gated on:
      //   - the "autoOpenNavOnMobile" dashboard pref (default ON — see
      //     below), fetched off the SAME GET/PATCH /staff/prefs seam
      //     jobs.html's column order already uses. No key allowlist on
      //     that endpoint (CLAUDE.md), so this needed no backend change;
      //   - mobile only (same ≤760px breakpoint dashboard.css's .dash-
      //     sidebar off-canvas rules use — desktop's sidebar is already
      //     permanently visible and untouched by any of this);
      //   - once per SESSION, not once per page load — otherwise every
      //     tap-through to another dashboard page reopens the drawer over
      //     the page the staffer just asked for. The session flag is
      //     claimed BEFORE the prefs fetch (not after it resolves) so two
      //     pages loaded back-to-back before the first fetch lands can't
      //     both decide to open it;
      //   - never while the idle-privacy-lock/session-guard overlay is up
      //     (guardStage !== 0) — opening a nav drawer behind or over a
      //     privacy lock defeats the point of the lock. Checked twice:
      //     once now (restoredStage above has already set guardStage by
      //     the time this runs) and again after the prefs fetch resolves,
      //     since the guard can also raise itself asynchronously while
      //     that fetch is in flight.
      // NEVER awaited — a slow/failed prefs fetch must not block or delay
      // rendering the rest of the dashboard shell.
      // SIDEBAR_AUTO_OPEN_KEY is module-scope (next to TOKEN_STORAGE_KEY) —
      // clearTokens() releases it on logout so a fresh login re-arms this.
      const isMobileWidth = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
      if (isMobileWidth && guardStage === 0 && !sessionStorage.getItem(SIDEBAR_AUTO_OPEN_KEY)) {
        sessionStorage.setItem(SIDEBAR_AUTO_OPEN_KEY, "1");
        Promise.resolve()
          .then(() => (global.KCMPS_DASH && global.KCMPS_DASH.getDashboardPrefs
            ? global.KCMPS_DASH.getDashboardPrefs() : { data: {} }))
          .then((res) => {
            const data = (res && res.data) || {};
            // Missing/undefined reads as ON — default ON per owner request;
            // a staffer has to explicitly turn it off in Settings.
            const enabled = data.autoOpenNavOnMobile !== false;
            if (!enabled || guardStage !== 0) return;
            sidebar.classList.add("is-open");
            backdrop.classList.add("is-open");
            // No focus() call anywhere in this block, deliberately —
            // opening must not steal focus from wherever the page would
            // otherwise put it. Dismissal (backdrop tap, hamburger
            // toggle) is the SAME closeSidebar()/toggle listener wired
            // above; nothing here bypasses or duplicates it.
          })
          .catch(() => {
            // Fetch failed — fall back to the default (ON) rather than
            // silently doing nothing; a broken prefs endpoint shouldn't
            // also silently disable a feature the staffer never turned off.
            if (guardStage !== 0) return;
            sidebar.classList.add("is-open");
            backdrop.classList.add("is-open");
          });
      }
    }

    return claims;
  }

  // Unread-message count on the "Jobs" nav link — the cheap first step
  // toward a real Messages tab (see docs/roadmap.md): reads the exact
  // same `{ threads, totalUnread }` shape that tab's inbox list will
  // render as full rows, but today only paints a badge with the total.
  // Every dashboard page shows this (called from mount(), not
  // per-page), not just jobs.html, since an unread reply can sit on any
  // ticket regardless of which page staff happen to be looking at.
  let unreadBadgeTimer = null;
  function refreshUnreadBadge() {
    if (!global.KCMPS_DASH || !global.KCMPS_DASH.getUnreadMessageSummary) return;
    global.KCMPS_DASH.getUnreadMessageSummary().then((summary) => {
      const jobsLink = document.querySelector('.dash-navlink[href="jobs.html"]');
      if (!jobsLink) return;
      let badge = jobsLink.querySelector(".badge-unread");
      const count = (summary && summary.totalUnread) || 0;
      if (!count) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "badge-unread";
        jobsLink.appendChild(badge);
      }
      badge.textContent = count > 99 ? "99+" : String(count);
    }).catch((err) => {
      // Best-effort — a badge that fails to load shouldn't break the rest
      // of the dashboard shell, and staff still see unread messages the
      // moment they open the actual ticket regardless.
      console.warn("[dashboard-shell] unread badge refresh failed:", err.message);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Disables the clicked button and swaps its label to a spinner while an
  // API call is in flight, so a slow verify/reject/advance/create/send can't
  // be double-clicked into firing twice. Always restores on completion, even
  // on error (callers usually re-render anyway, but the restore still
  // matters for the brief window before that happens). Shared by every page
  // that calls into a real backend action — see dashboard.css's .btn-spinner.
  async function withBusy(btn, fn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Working&hellip;';
    try { await fn(); }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  }

  // Inline, non-blocking error banner — the replacement for alert() across
  // the dashboard. `host` is emptied and given the message; pass a fresh
  // host each time (callers already have a dedicated slot per form).
  function showInlineError(host, message) {
    if (!host) return;
    host.innerHTML = '<div class="dash-inline-error">' + escapeHtml(message) + "</div>";
  }

  /* ---- searchable combobox (2026-08-19) ----
     Shared picker for "type to filter a list of options" — first built for
     the Cash Book's category→subcategory picker and the order-id-by-name
     lookup, kept here (not page-local) so any future picker can reuse it
     rather than growing a second, differently-behaving control.

     Mirrors ../store.js's `.design-subcatalog` full-screen-sheet pattern
     for mobile (≤760px, the primary target) and adds a desktop dropdown
     anchored to the trigger. One overlay element is built lazily and
     reused across opens, same as store.js's popup/subcatalog builders.

     Options API (see cashbook.html for real call sites):
       trigger        — the element that opens the picker; focus returns
                        here on close (Escape or selection).
       title          — sheet/panel header text.
       searchPlaceholder
       getItems()     — () => [{ key, primary, secondary, searchText,
                        disabled }, ...], called fresh on every open (or
                        query change) so callers can serve a live list.
       getRecentKeys()— optional () => [key, ...], most-used-first, shown
                        pinned above the full list when the search box is
                        empty. Ignored once the staffer types anything.
       onSelect(item) — called with the matched item.
       allowFreeText  — if true, Enter with no exact-key match calls
                        onFreeText(rawText) instead of doing nothing; used
                        by the order-id field so a pasted raw id still
                        works even though it won't appear in the fetched
                        list (an order made after page-load, for example).
       onFreeText(text)
       emptyMessage   — shown when the filtered list is empty.
       banner         — optional string shown above the list (e.g. "Order
                        search unavailable — type an order ID directly.")
                        for a degraded-mode notice; never blocks input.
     Returns { open(query), close(), setBanner(text) }.

     A11y: role="combobox" on the visible search input, aria-expanded,
     aria-controls -> the listbox, aria-activedescendant tracks the
     highlighted option; the list itself is role="listbox" of
     role="option" children. ↑/↓ moves, Enter selects, Escape closes and
     returns focus to `trigger`. Every label is escapeHtml'd — list items
     render server-approved category/order text, but an order's client
     name is staffer-typed data that reaches this DOM same as anywhere
     else on the page. */
  let cbxSeq = 0;
  function createCombobox(opts) {
    const id = "cbx" + (++cbxSeq);
    let root = null, input = null, list = null, banner = null;
    let items = [];
    let activeIndex = -1;
    let isMobile = false;

    function mq() {
      return window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
    }

    function build() {
      root = document.createElement("div");
      root.className = "cbx-root";
      root.innerHTML =
        `<div class="cbx-scrim"></div>` +
        `<div class="cbx-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title || "Choose")}">` +
          `<div class="cbx-head">` +
            `<span class="cbx-title">${escapeHtml(opts.title || "")}</span>` +
            `<button type="button" class="cbx-close" aria-label="Close">&times;</button>` +
          `</div>` +
          `<div class="cbx-search-wrap">` +
            `<input type="text" class="input cbx-input" role="combobox" aria-expanded="true" ` +
              `aria-controls="${id}-list" aria-autocomplete="list" autocomplete="off" ` +
              `placeholder="${escapeHtml(opts.searchPlaceholder || "Type to search…")}" />` +
          `</div>` +
          `<div class="cbx-banner" id="${id}-banner" hidden></div>` +
          `<div class="cbx-list" id="${id}-list" role="listbox"></div>` +
        `</div>`;
      document.body.appendChild(root);

      input = root.querySelector(".cbx-input");
      list = root.querySelector(".cbx-list");
      banner = root.querySelector(".cbx-banner");
      const closeBtn = root.querySelector(".cbx-close");
      const scrim = root.querySelector(".cbx-scrim");

      closeBtn.addEventListener("click", close);
      scrim.addEventListener("click", close);
      input.addEventListener("input", () => renderList(input.value));
      input.addEventListener("keydown", onKeydown);
      list.addEventListener("click", (e) => {
        const row = e.target.closest(".cbx-opt");
        if (row && !row.classList.contains("is-disabled")) select(Number(row.dataset.idx));
      });
    }

    /* Desktop placement. The panel stays position:fixed (so it can never be
       clipped by an ancestor), which means it must be RE-placed whenever the
       page moves — the original positioned once on open and then visibly
       detached from its field on the first scroll. Reposition was chosen
       over close-on-scroll: the list can be longer than the viewport, and
       losing a half-typed search to a stray wheel tick is worse than a panel
       that follows.

       top must be the plain viewport-relative rect.bottom, never
       window.scrollY + rect.bottom (that math is only correct for
       position:absolute; see CLAUDE.md's .design-popup gotcha — adding
       scrollY here would put the panel offscreen on any page scrolled past
       the top). */
    function positionDesktop() {
      if (!opts.trigger || !root) return;
      const rect = opts.trigger.getBoundingClientRect();
      const panel = root.querySelector(".cbx-panel");
      panel.style.position = "fixed";
      // Width matches the field it belongs to — it is a dropdown, not a
      // dialog. The 220px floor only engages on an unusually narrow field,
      // where matching exactly would truncate every option.
      const w = Math.max(220, Math.round(rect.width));
      panel.style.width = w + "px";
      panel.style.left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))) + "px";

      // Flip above the field when there isn't room beneath it.
      const panelH = panel.offsetHeight || 320;
      const below = window.innerHeight - rect.bottom - 6;
      if (below < panelH && rect.top - 6 > below) {
        panel.style.top = Math.round(Math.max(8, rect.top - 6 - panelH)) + "px";
      } else {
        panel.style.top = Math.round(rect.bottom + 6) + "px";
      }
    }

    /* Desktop-only listeners, attached on open and removed on close so a
       closed picker costs nothing. Capture-phase scroll catches scrolling
       ancestors, not just the window; capture-phase pointerdown is what
       replaces the old full-viewport scrim as the click-away affordance
       (the scrim made the whole page feel modal even though it was
       transparent). */
    function onReposition() { if (!isMobile) positionDesktop(); }
    function onOutsidePointer(e) {
      if (!root || !root.classList.contains("is-open")) return;
      const panel = root.querySelector(".cbx-panel");
      if (panel.contains(e.target)) return;
      if (opts.trigger && opts.trigger.contains(e.target)) return;
      close();
    }
    function bindDesktopListeners() {
      window.addEventListener("scroll", onReposition, true);
      window.addEventListener("resize", onReposition);
      document.addEventListener("pointerdown", onOutsidePointer, true);
    }
    function unbindDesktopListeners() {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("pointerdown", onOutsidePointer, true);
    }

    function renderList(query) {
      const q = (query || "").trim().toLowerCase();
      const all = (opts.getItems ? opts.getItems() : []) || [];
      let shown;
      if (!q) {
        const recentKeys = (opts.getRecentKeys ? opts.getRecentKeys() : []) || [];
        const byKey = new Map(all.map((it) => [it.key, it]));
        const recent = recentKeys.map((k) => byKey.get(k)).filter(Boolean);
        const rest = all.filter((it) => !recentKeys.includes(it.key));
        shown = recent.length
          ? recent.map((it) => Object.assign({}, it, { isRecent: true })).concat(rest)
          : all;
      } else {
        shown = all.filter((it) => (it.searchText || (it.primary + " " + (it.secondary || ""))).toLowerCase().includes(q));
      }
      items = shown;
      activeIndex = shown.length ? 0 : -1;

      if (!shown.length) {
        list.innerHTML = `<p class="cbx-empty">${escapeHtml(opts.emptyMessage || "No match.")}</p>`;
      } else {
        list.innerHTML = shown.map((it, i) => (
          `<div class="cbx-opt${it.disabled ? " is-disabled" : ""}${it.isRecent ? " is-recent" : ""}" ` +
            `role="option" id="${id}-opt-${i}" data-idx="${i}" aria-selected="${i === activeIndex}">` +
            `<span class="cbx-opt-primary">${escapeHtml(it.primary)}</span>` +
            (it.secondary ? `<span class="cbx-opt-secondary">${escapeHtml(it.secondary)}</span>` : "") +
            (it.isRecent ? `<span class="cbx-opt-flag">Recent</span>` : "") +
          `</div>`
        )).join("");
      }
      updateActiveDescendant();
    }

    function updateActiveDescendant() {
      list.querySelectorAll(".cbx-opt").forEach((el, i) => el.setAttribute("aria-selected", String(i === activeIndex)));
      if (activeIndex >= 0) {
        input.setAttribute("aria-activedescendant", `${id}-opt-${activeIndex}`);
        const el = list.querySelector(`#${id}-opt-${activeIndex}`);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function select(idx) {
      const it = items[idx];
      if (!it || it.disabled) return;
      close();
      opts.onSelect && opts.onSelect(it);
    }

    function onKeydown(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length) { activeIndex = Math.min(items.length - 1, activeIndex + 1); updateActiveDescendant(); }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) { activeIndex = Math.max(0, activeIndex - 1); updateActiveDescendant(); }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIndex >= 0 && items[activeIndex] && !items[activeIndex].disabled) {
          select(activeIndex);
        } else if (opts.allowFreeText) {
          const raw = input.value.trim();
          if (raw) { close(); opts.onFreeText && opts.onFreeText(raw); }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }

    function setBanner(text) {
      if (!banner) return;
      if (text) { banner.textContent = text; banner.hidden = false; }
      else { banner.hidden = true; banner.textContent = ""; }
    }

    function open(initialQuery) {
      if (!root) build();
      isMobile = mq();
      root.className = "cbx-root is-open" + (isMobile ? " is-mobile" : " is-desktop");
      const panelEl = root.querySelector(".cbx-panel");
      /* Mobile is a real full-screen sheet, so it stays a modal dialog and
         keeps the body scroll lock. Desktop is a dropdown attached to a
         field: locking the page's scroll and claiming aria-modal there is
         what made it read as a blocking panel. */
      if (isMobile) {
        panelEl.setAttribute("role", "dialog");
        panelEl.setAttribute("aria-modal", "true");
      } else {
        // No dialog role on desktop — the inner .cbx-list is already the
        // listbox the combobox input owns; a wrapping dialog would only add
        // a second, misleading landmark.
        panelEl.removeAttribute("role");
        panelEl.removeAttribute("aria-modal");
      }
      document.body.style.overflow = isMobile ? "hidden" : "";
      if (opts.banner) setBanner(opts.banner);
      input.value = initialQuery || "";
      renderList(input.value);
      if (!isMobile) {
        positionDesktop();
        bindDesktopListeners();
      } else {
        /* Clear any inline placement left by a previous desktop open —
           the sheet's `inset: 0` loses to an inline top/left/width, so a
           window resized from desktop to phone width would otherwise show
           the sheet still pinned at the old dropdown's coordinates. */
        panelEl.style.top = panelEl.style.left = panelEl.style.width = panelEl.style.position = "";
      }
      /* Mobile: do NOT focus the search input at all. Deferring the focus
         by two frames (what this did originally) still ends with the
         keyboard open, just slightly later — and the keyboard then covers
         the list the staffer opened this picker to READ. Most selections
         are a tap on a visible row (recent jobs, or one of a dozen
         categories), not a search; typing is the exception, and tapping
         the search box first is a fair price for it. Owner reported the
         same complaint about the amount field on 2026-08-19 — see
         cashbook.html's openSheet(); both are the same mistake, which was
         optimising for keystrokes on a device where the keyboard is the
         thing in the way.
         Desktop: focus immediately. There's no on-screen keyboard to
         occlude anything, and type-to-filter is the point of the control. */
      if (!isMobile) input.focus({ preventScroll: true });
    }

    function close() {
      if (!root) return;
      root.classList.remove("is-open");
      unbindDesktopListeners();
      document.body.style.overflow = "";
      if (opts.trigger) opts.trigger.focus();
    }

    document.addEventListener("keydown", (e) => {
      // Global fallback close — belt-and-braces alongside the input's own
      // Escape handler, in case focus ever lands somewhere else inside
      // the panel.
      if (e.key === "Escape" && root && root.classList.contains("is-open")) close();
    });

    return { open, close, setBanner };
  }

  function fmtPeso(n) {
    return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtHours(h) {
    if (h < 1) return Math.round(h * 60) + "m";
    return (Math.round(h * 10) / 10) + "h";
  }

  global.KCMPS_DASH_SHELL = { mount, requireStaffAuth, logout, escapeHtml, fmtPeso, fmtDate, fmtDateTime, fmtHours, NAV_ITEMS, isLocalHost, seedLocalStaffSession, withBusy, showInlineError, refreshUnreadBadge, escalateSessionGuard, createCombobox };
})(window);
