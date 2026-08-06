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
    LOCK_MS: 15 * 60 * 1000, // stage 1: privacy lock — nobody walking past can read the screen
    SESSION_MS: 60 * 60 * 1000, // stage 2: session/staleness — token has likely expired
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
  function clearTokens() { sessionStorage.removeItem(TOKEN_STORAGE_KEY); }

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
    { key: "clients", href: "clients.html", label: "Clients", hint: "CRM", soon: true },
    { key: "email", href: "email.html", label: "Email", hint: "Shop mailboxes" },
    { key: "inventory", href: "inventory.html", label: "Inventory", hint: "Stock levels", soon: true },
    { key: "design", href: "design-library.html", label: "Design Library", hint: "Asset library" },
    { key: "settings", href: "settings.html", label: "Settings", hint: "Rates & SLAs", soon: true },
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
      // password-type <input> before the buttons, and it needs to be part
      // of the trap's first/last boundary like everything else in here.
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
      // expiry check it always did.
      window.location.reload();
    });
    const primary = actions.querySelector(".btn-primary");
    if (primary) primary.focus();
  }

  // A 4-digit PIN entry step, used at both overlay stages when the signed-in
  // staffer has one set (see dashboard-data.js's setStaffPin() header for
  // the full "privacy deterrent, not a security boundary" rationale). There
  // is no lockout/attempt counter — a wrong PIN just re-prompts — since that
  // would turn a convenience feature into its own support burden for no real
  // security gain. "Log out instead" never needs the PIN: logging out can't
  // leak anything and is the documented recovery path for a forgotten PIN.
  function renderPinGate(actions, opts) {
    actions.innerHTML =
      '<form id="session-guard-pin-form" style="display:flex;flex-direction:column;gap:8px;align-items:center;width:100%">' +
      '<input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" ' +
      'class="input" id="session-guard-pin-input" placeholder="4-digit PIN" ' +
      'style="text-align:center;letter-spacing:8px;font-size:18px;max-width:150px" />' +
      '<p id="session-guard-pin-error" role="alert" style="display:none;color:#b91c1c;font-size:12.5px;margin:0"></p>' +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-ghost" id="session-guard-pin-logout">Log out instead</button>' +
      `<button type="submit" class="btn btn-primary" id="session-guard-pin-submit">${opts.continueLabel}</button>` +
      '</div></form>';
    const form = actions.querySelector("#session-guard-pin-form");
    const input = actions.querySelector("#session-guard-pin-input");
    const errorEl = actions.querySelector("#session-guard-pin-error");
    actions.querySelector("#session-guard-pin-logout").addEventListener("click", logout);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pin = input.value.trim();
      errorEl.style.display = "none";
      const ok = pin && global.KCMPS_DASH && global.KCMPS_DASH.verifyStaffPin && await global.KCMPS_DASH.verifyStaffPin(guardUserKey, pin);
      if (ok) { opts.onSuccess(); return; }
      errorEl.textContent = "Incorrect PIN — try again, or log out.";
      errorEl.style.display = "";
      input.value = "";
      input.focus();
    });
    input.focus();
  }

  function openSessionGuard(stage) {
    const wasOpen = guardStage !== 0;
    guardStage = stage;
    const el = ensureGuardEl();
    const box = el.querySelector("#session-guard-box");
    const actions = el.querySelector("#session-guard-actions");
    box.dataset.stage = String(stage);

    const pinSet = !!(global.KCMPS_DASH && global.KCMPS_DASH.hasStaffPin && global.KCMPS_DASH.hasStaffPin(guardUserKey));

    if (stage === 1) {
      el.querySelector("#session-guard-title").textContent = "Screen locked while you were away";
      el.querySelector("#session-guard-desc").textContent = pinSet
        ? "For privacy, this stayed open longer than usual, so it's been hidden. Enter your PIN to resume — nothing was lost."
        : "For privacy, this stayed open longer than usual, so it's been hidden. Nothing was lost.";
      if (pinSet) {
        // A correct PIN at stage 1 is a real "resume" — the session itself
        // is not in question here, only whether the right person is
        // looking at the screen.
        renderPinGate(actions, {
          continueLabel: "Unlock",
          onSuccess: () => { lastActivityAt = Date.now(); closeSessionGuard(); },
        });
      } else {
        // No PIN on file for this staffer — sensible fallback so nobody is
        // ever locked out of their own dashboard for not having opted in.
        // Settings has the "set a PIN" UI; this plain Resume is the default
        // until they do.
        actions.innerHTML = '<button type="button" class="btn btn-primary" id="session-guard-resume">Resume</button>';
        el.querySelector("#session-guard-resume").addEventListener("click", () => {
          lastActivityAt = Date.now();
          closeSessionGuard();
        });
        actions.querySelector(".btn-primary").focus();
      }
    } else {
      el.querySelector("#session-guard-title").textContent = "Your session may have expired";
      el.querySelector("#session-guard-desc").textContent = pinSet
        ? "Enter your PIN to see the Refresh/Log out options. The data on this screen may be out of date."
        : "The data on this screen may be out of date. Refresh to continue, or log out.";
      if (pinSet) {
        // IMPORTANT: a correct PIN here does NOT dismiss the overlay or
        // resume the page — it only reveals the Refresh/Log out controls
        // (renderStage2Actions), which still run the real
        // requireStaffAuth()/reload expiry check exactly as before this
        // feature existed. Stage 2 means the token has likely actually
        // expired; the PIN is not allowed to become a way to wave that
        // away and "just carry on" with a stale session — see the task
        // brief's explicit warning about this.
        renderPinGate(actions, {
          continueLabel: "Continue",
          onSuccess: () => { renderStage2Actions(actions); },
        });
      } else {
        renderStage2Actions(actions);
      }
    }

    if (!wasOpen) {
      guardFocusReturnEl = document.activeElement;
      el.style.display = "flex";
    }
  }

  function closeSessionGuard() {
    if (!guardEl) return;
    guardStage = 0;
    guardEl.style.display = "none";
    if (guardFocusReturnEl && typeof guardFocusReturnEl.focus === "function") {
      guardFocusReturnEl.focus();
    }
    guardFocusReturnEl = null;
  }

  // Called from dashboard-data.js's apiFetch on a 401 — jumps straight to
  // stage 2 regardless of idle time, since a 401 is direct evidence the
  // session is no longer valid (vs. stage 1's idle-time guess).
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

  global.KCMPS_DASH_SHELL = { mount, requireStaffAuth, logout, escapeHtml, fmtPeso, fmtDate, fmtDateTime, fmtHours, NAV_ITEMS, isLocalHost, seedLocalStaffSession, withBusy, showInlineError, refreshUnreadBadge, escalateSessionGuard };
})(window);
