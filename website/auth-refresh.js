/* ==========================================================================
   KCMPS — shared Cognito refresh-token handling  (window.KCMPS_AUTH)
   --------------------------------------------------------------------------
   Cognito issues id/access tokens valid 60 minutes and a refresh token valid
   5 days. Before this file existed the refresh token was thrown away at
   exchange time, so every session hard-ended at 60 minutes and staff had to
   re-login all day. This is the ONE place that knows how to trade a refresh
   token for a fresh id/access pair; store.js, orders-data.js,
   dashboard-data.js, dashboard-shell.js and index.html all route through it.

   Three things here are load-bearing, not incidental:

   1. COGNITO DOES NOT RETURN A NEW refresh_token ON REFRESH. saveTokens()
      below therefore MERGES onto the stored blob and explicitly preserves
      `refresh_token` when the response omits it. Overwrite the blob wholesale
      and the FIRST refresh appears to work while the SECOND has nothing to
      use — the session still dies at ~60 minutes, silently, and only for
      users who stayed logged in long enough to need a second refresh.

   2. SINGLE-FLIGHT. Concurrent 401s (several dashboard cards load at once)
      and the proactive expiry poll must share ONE in-flight request. Several
      parallel refreshes against the same token is a race with no upside.

   3. NO TOKEN => NO TRAFFIC. Anonymous storefront visitors (guest checkout)
      must never trigger an auth request. Every entry point returns early on
      a missing token rather than attempting anything.

   Tokens stay in sessionStorage, NOT localStorage — a deliberate XSS
   tradeoff recorded in docs/history.md#auth-implementation-notes. A 5-day
   refresh token is a far bigger prize than a 1-hour id token, so it gets the
   safer of the two stores even though that means closing the tab requires a
   re-login.

   APP MODE (IS_KCMPS_APP): the staff Android app (android-app/, a WebView
   wrapper whose User-Agent ends in " KCMPSApp/<ver>") gets Messenger-style
   persistent sign-in instead. Detected once here off the UA and exposed on
   KCMPS_AUTH so no other file re-derives it. In app mode ONLY:
     - tokens live in localStorage (tokenStore below), so they survive app
       restarts. That is acceptable there and not in a browser because the
       WebView's storage is app-private inside the Android sandbox — there
       is no shared browser profile, no other sites, no extensions.
     - the client id is the dedicated app client (30-day refresh tokens);
       browsers keep the web client (5-day). Both are public/secretless on
       the same pool + Hosted UI domain; the API's JWT authorizer accepts
       both audiences.
     - a transient refresh failure (offline phone at cold start) never
       clears the store — only a fatal 4xx (revoked/expired grant) or the
       user's own Logout tap ends the session. In a browser the stricter
       original behaviour is unchanged.
   Browser behaviour must stay byte-identical: every IS_KCMPS_APP branch
   in this codebase is additive and false in any real browser.

   The Cognito app clients are public — no client secret — so the browser
   may call /oauth2/token's grant_type=refresh_token directly and no
   backend is involved.

   CSP: every page that loads this file must allow
   https://kcmps-auth.auth.ap-southeast-1.amazoncognito.com in connect-src.
   A blocked refresh is silent and looks exactly like a dead feature.
   ========================================================================== */
(function (global) {
  "use strict";

  var DOMAIN = "https://kcmps-auth.auth.ap-southeast-1.amazoncognito.com";

  /* ---- app-mode detection + client/store selection (see header) ----
     The ONE place the "am I inside the staff Android app?" question is
     answered. index.html, dashboard-shell.js and orders-data.js consume
     CLIENT_ID/IS_KCMPS_APP from KCMPS_AUTH rather than re-deriving. */
  var IS_KCMPS_APP = /KCMPSApp\//.test((global.navigator && global.navigator.userAgent) || "");
  var WEB_CLIENT_ID = "2rsbhkjooja4h5e0ijpl4siuug"; // kcmps-web-client, 5-day refresh
  var APP_CLIENT_ID = "44m8ihv638uupblm8dscurgu7g"; // kcmps-app-client, 30-day refresh
  var CLIENT_ID = IS_KCMPS_APP ? APP_CLIENT_ID : WEB_CLIENT_ID;

  /* The token store: localStorage in the app (persists across app
     restarts), sessionStorage in every browser (unchanged stance — see
     header). Same key either way. Guarded because storage access can throw
     under exotic privacy settings; every read/write below is ALSO wrapped,
     matching the original code. */
  var tokenStore = (function () {
    try { return IS_KCMPS_APP ? global.localStorage : global.sessionStorage; }
    catch (e) { return global.sessionStorage; }
  })();

  var TOKEN_STORAGE_KEY = "kcmps_tokens";
  // Released alongside the tokens on every session-end path — see the
  // identical lines in dashboard-shell.js / index.html / dashboard-data.js.
  var SIDEBAR_AUTO_OPEN_KEY = "kcmps_sidebar_auto_opened";

  // Refresh this long before `exp` so ordinary requests never fail first.
  var REFRESH_SKEW_MS = 5 * 60 * 1000;

  function loadTokens() {
    try {
      var raw = tokenStore.getItem(TOKEN_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* Merge-and-save. `next` may omit refresh_token (Cognito always does on a
     refresh) — the stored one is carried forward. See note 1 in the header. */
  function saveTokens(next) {
    var current = loadTokens() || {};
    var merged = {};
    var k;
    for (k in current) if (Object.prototype.hasOwnProperty.call(current, k)) merged[k] = current[k];
    for (k in next) if (Object.prototype.hasOwnProperty.call(next, k)) merged[k] = next[k];
    if (!next.refresh_token && current.refresh_token) merged.refresh_token = current.refresh_token;
    try { tokenStore.setItem(TOKEN_STORAGE_KEY, JSON.stringify(merged)); } catch (e) { /* ignore */ }
    return merged;
  }

  function clearTokens() {
    try { tokenStore.removeItem(TOKEN_STORAGE_KEY); } catch (e) { /* ignore */ }
    // App mode: also sweep the sessionStorage copy. A pre-update app
    // session (web client, sessionStorage) may still hold a stale blob in
    // the same WebView process; the direct-read fallbacks in other files
    // must never resurrect it after a logout. No-op in a browser, where
    // tokenStore IS sessionStorage.
    if (IS_KCMPS_APP) {
      try { global.sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch (e) { /* ignore */ }
    }
    // The sidebar auto-open flag is per-tab/per-launch state, not a token —
    // it stays in sessionStorage in BOTH modes.
    try { global.sessionStorage.removeItem(SIDEBAR_AUTO_OPEN_KEY); } catch (e) { /* ignore */ }
  }

  function idToken() {
    var t = loadTokens();
    return t && t.id_token ? t.id_token : null;
  }

  /* Expiry in ms, or null when the token carries no `exp`. A missing `exp`
     is NOT an error: dashboard-shell.js's seedLocalStaffSession() mints a
     local-dev token without one, and that bypass must keep working. */
  function expiresAtMs(token) {
    if (!token) return null;
    try {
      var part = token.split(".")[1];
      if (!part) return null;
      var b64 = part.replace(/-/g, "+").replace(/_/g, "/");
      var claims = JSON.parse(global.atob(b64));
      return typeof claims.exp === "number" ? claims.exp * 1000 : null;
    } catch (e) { return null; }
  }

  function isExpired(token) {
    var at = expiresAtMs(token);
    return at !== null && at <= Date.now();
  }

  /* Refreshable = we hold both a refresh token and a token that actually has
     an expiry to refresh against. The local-dev bypass fails this and is
     correctly treated as "not refreshable" rather than as an error. */
  function canRefresh() {
    var t = loadTokens();
    return !!(t && t.refresh_token && t.id_token && expiresAtMs(t.id_token) !== null);
  }

  var inflight = null; // single-flight promise — see note 2 in the header.
  var requestCount = 0; // test/observability hook: how many network calls went out

  function refresh() {
    if (inflight) return inflight;

    var tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) {
      // Not an error state worth clearing anything over — an anonymous
      // visitor or the local-dev bypass simply has nothing to refresh.
      return Promise.reject(mkError("no_refresh_token", false));
    }
    var wasExpired = isExpired(tokens.id_token);

    var body = new global.URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });

    requestCount += 1;
    inflight = global.fetch(DOMAIN + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }).then(function (res) {
      if (!res.ok) {
        // 4xx = invalid_grant / revoked / expired refresh token. The session
        // is genuinely over: fail closed.
        return res.text().catch(function () { return ""; }).then(function (text) {
          throw mkError("refresh_rejected_" + res.status + (text ? ": " + text : ""), res.status >= 400 && res.status < 500);
        });
      }
      return res.json();
    }).then(function (json) {
      if (!json || !json.id_token) throw mkError("refresh_response_missing_id_token", true);
      return saveTokens(json); // preserves refresh_token — see note 1
    }).catch(function (err) {
      // Fail closed when the session is unusable: an explicitly rejected
      // grant, or a transient failure on an ALREADY-expired token (there is
      // no half-authenticated state to keep). A network blip while the
      // current token is still valid is left alone so the next attempt can
      // retry — clearing there would log people out over a dropped packet.
      //
      // App mode: only a FATAL rejection clears. The whole point of the
      // persistent store is that a cold app start on a dead connection
      // (the id token is always expired by then) keeps the session and
      // retries later — wiping a 30-day refresh token over a dropped
      // packet would be a silent logout Messenger would never do. Browser
      // behaviour (the wasExpired clause) is unchanged.
      if ((err && err.fatal) || (wasExpired && !IS_KCMPS_APP)) clearTokens();
      throw err;
    }).then(function (merged) {
      inflight = null;
      return merged;
    }, function (err) {
      inflight = null;
      throw err;
    });

    return inflight;
  }

  function mkError(message, fatal) {
    var err = new Error(message);
    err.name = "AuthRefreshError";
    err.fatal = !!fatal;
    return err;
  }

  /* Proactive path. Resolves with the token blob (possibly unchanged), or
     null when there is nothing to do — never rejects on the "no session"
     and "not refreshable" cases, so callers don't need to special-case
     anonymous visitors or the local-dev bypass. */
  function ensureFresh(opts) {
    var skew = (opts && typeof opts.skewMs === "number") ? opts.skewMs : REFRESH_SKEW_MS;
    var tokens = loadTokens();
    if (!tokens || !tokens.id_token) return Promise.resolve(null); // note 3: no token, no traffic
    var at = expiresAtMs(tokens.id_token);
    if (at === null) return Promise.resolve(tokens); // local-dev bypass: nothing to refresh
    if (at - Date.now() > skew) return Promise.resolve(tokens);
    if (!tokens.refresh_token) return Promise.resolve(tokens); // legacy blob from a pre-refresh login
    return refresh().catch(function () { return null; });
  }

  /* Reactive path, for a 401. Resolves true when a usable token is now in
     storage and the caller should retry ONCE; false when it should fall
     through to its existing session-ended handling. Never throws. */
  function refreshForRetry() {
    if (!canRefresh()) return Promise.resolve(false);
    return refresh().then(function (t) { return !!(t && t.id_token); }, function () { return false; });
  }

  /* Best-effort token revocation on logout, so a stolen refresh token dies
     with the session. EnableTokenRevocation is true on the app client. A
     failed revoke must never block logout — callers ignore the result. */
  function revoke() {
    var tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) return Promise.resolve(false);
    var body = new global.URLSearchParams({ token: tokens.refresh_token, client_id: CLIENT_ID });
    return global.fetch(DOMAIN + "/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      keepalive: true, // survives the navigation logout() kicks off right after
    }).then(function (res) { return res.ok; }, function () { return false; });
  }

  /* ---- proactive refresh ----
     Poll the clock rather than setTimeout(exp - now): a backgrounded tab or
     a sleeping laptop makes a long timer wildly wrong, and this file has to
     be correct across both. ensureFresh() is a no-op without a session, so
     an anonymous storefront visitor generates no traffic and no timers'
     worth of work beyond a sessionStorage read. Single-flight means this
     poll and a concurrent 401 retry share one request. */
  var POLL_MS = 60 * 1000;
  function tick() { ensureFresh().catch(function () { /* fail-closed handled in refresh() */ }); }
  if (global.setInterval) {
    // One check at startup too: a page loaded from a tab that sat idle past
    // `exp` would otherwise render a logged-in shell for up to POLL_MS.
    global.setTimeout(tick, 0);
    global.setInterval(tick, POLL_MS);
    if (global.document && global.document.addEventListener) {
      // Coming back to a tab that slept through its expiry: check immediately
      // instead of waiting up to a full poll interval.
      global.document.addEventListener("visibilitychange", function () {
        if (!global.document.hidden) tick();
      });
    }
  }

  global.KCMPS_AUTH = {
    TOKEN_STORAGE_KEY: TOKEN_STORAGE_KEY,
    SIDEBAR_AUTO_OPEN_KEY: SIDEBAR_AUTO_OPEN_KEY,
    REFRESH_SKEW_MS: REFRESH_SKEW_MS,
    // App-mode facts, exposed so index.html / dashboard-shell.js /
    // orders-data.js select the SAME client id and never re-derive the UA
    // sniff. CLIENT_ID is already app-vs-web selected (see top of file).
    IS_KCMPS_APP: IS_KCMPS_APP,
    CLIENT_ID: CLIENT_ID,
    loadTokens: loadTokens,
    saveTokens: saveTokens,
    clearTokens: clearTokens,
    idToken: idToken,
    expiresAtMs: expiresAtMs,
    isExpired: isExpired,
    canRefresh: canRefresh,
    refresh: refresh,
    ensureFresh: ensureFresh,
    refreshForRetry: refreshForRetry,
    revoke: revoke,
    _requestCount: function () { return requestCount; },
    _inflight: function () { return inflight; },
  };
})(typeof window !== "undefined" ? window : globalThis);
