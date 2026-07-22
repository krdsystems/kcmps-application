# kcmps-application

## Login flow test (`login-test.html`)

Standalone proof-of-concept for the Cognito Hosted UI login flow, built before
wiring auth into the real storefront (`index.html`). Vanilla HTML5 + Tailwind
(CDN) + ES6, no build step, matching the rest of this project.

### What it proves out

- Clicking "Login / Sign-up" opens Cognito's Hosted UI in a popup (email/password
  or "Continue with Google") instead of a full-page redirect.
- On success, the popup shows a brief "Login successful!" confirmation and
  closes itself; the main page updates without a reload, swapping the button
  for the user's name (from the ID token's `name` claim).
- Users in the `Staff` Cognito group see a "Dashboard" nav link (stubbed —
  `/dashboard/*` doesn't exist yet).
- Logout clears the local session and also ends the Cognito Hosted UI session
  (via a small popup), so a subsequent login shows the form again instead of
  silently re-authenticating the same user.
- Cart icon is a stub with a marked integration point for the real
  DynamoDB-backed cart later.

### Running it locally

Cognito's OAuth redirect needs an `http(s)://` origin — opening the file
directly (`file://`) won't work. Serve it with anything simple, e.g.:

```bash
python3 -m http.server 5500
```

Then open `http://localhost:5500/login-test.html`. `http://localhost:5500/`
(and the trailing-path variant) must be registered as allowed callback/sign-out
URLs on the Cognito app client for this to work — see below.

### Cognito app client requirements

- Public client (no client secret) — this is a browser SPA, no server-side code.
- Authorization Code grant with PKCE (no client secret is sent; the
  `code_verifier`/`code_challenge` pair proves the token exchange request came
  from the same browser that started the flow).
- OAuth scopes: `email openid profile phone` — `profile` specifically, since
  that's what puts the `name` claim on the ID token (without it, the nav has
  nothing to display).
- Callback URLs / sign-out URLs must include the exact production origin
  (`https://site.kcmps.com/`) and, for local testing, `http://localhost:5500/`.

### Known constraints, deliberately accepted for a static SPA

- **Token storage**: ID/access/refresh tokens are kept in `sessionStorage`
  (survives a page refresh, cleared when the tab closes). This is readable by
  any injected script if the page ever has an XSS bug — same exposure as
  `localStorage`, just shorter-lived. `localStorage` was deliberately avoided
  for the tokens themselves (it persists indefinitely across browser
  restarts, maximizing exposure). `localStorage` *is* used, briefly, as a
  same-origin message bus between the main window and the login popup (PKCE
  values and the auth result, each written and deleted within seconds) — see
  the comments in `login-test.html`. The strictly more secure option
  (httpOnly cookie holding the refresh token, via a Backend-for-Frontend)
  isn't available here since this is a pure static site with no server.
  Worth revisiting once API Gateway/Lambda exist.
- **No signature verification client-side**: the ID token is decoded to read
  claims (`name`, `cognito:groups`) for UI purposes only, not verified. Any
  backend that receives a token from this app must independently verify its
  signature against Cognito's JWKS — never trust client-decoded claims
  server-side.
- **Popup detection doesn't use `window.opener`**: Cognito's Hosted UI sends a
  `Cross-Origin-Opener-Policy` header, which severs the popup's `window.opener`
  reference once the login form renders, and can also make the main window's
  `popup.closed` check unreliable. The main window instead learns the login
  outcome via a `storage` event fired when the popup writes its result to
  `localStorage` (with a slow poll as backup) — this is COOP-safe since it
  doesn't depend on either window holding a reference to the other.
