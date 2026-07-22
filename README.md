# KCMPS — Kaalyados Creatives Merchandise and Printing Services

The marketing site and storefront foundation for KCMPS, a Manila-based print-and-hardware
studio: custom apparel printing (DTF/Subli/Hotmelt), design services, and merchandise, moving
toward digital ordering with authenticated accounts and a cart.

This README doubles as a build log — it tracks the project from its first commit through
every structural change, including the mistakes made along the way and what fixed them, so
future work (and future contributors) don't have to reconstruct that history from `git log`.

## Repository layout

```
website/
├── index.html                  Deployed storefront (nav, hero, vision/mission, tabbed catalog)
├── styles.css                  Design-system stylesheet (tokens + components) used by index.html
├── login-test.html             Standalone Cognito Hosted UI login proof-of-concept
├── assets/                     Production images referenced by index.html
└── Claude Design/              Design-system reference docs (not deployed) — see its own readme.md
```

The site is deployed by syncing `website/` directly to an S3 bucket — no build step, no
bundler. Everything is vanilla HTML5, Tailwind via CDN, and ES6.

## Development history

### 1. First commit (2026-07-21)

Repo initialized with a placeholder `README.md`. No site yet.

### 2. Design system generation — "redesign of layout" (2026-07-21)

A full design system was generated (via the Claude design tool) into
`Claude Design/KCMPS Redesign/`: design tokens (`theme.json`), a component library
(buttons, cards, forms, navigation, tables, dialogs), foundation references (color, type,
icons, layout, imagery), and a starting storefront template nested at
`Claude Design/KCMPS Redesign/templates/landing/`.

This established the visual language still in use: navy as the dominant brand color, one
orange accent reserved for a single call-to-action per screen, rounded/friendly geometry
over "industrial" styling. See
[`website/Claude Design/KCMPS Redesign/readme.md`](website/Claude%20Design/KCMPS%20Redesign/readme.md)
for the full system reference.

### 3. Building the real site, and the first structural mistake (2026-07-21)

The landing template was fleshed out into the actual storefront: the full brand name in the
nav (`KCMPS | Kaalyados Creatives Merchandise and Printing Services`, collapsing to `KCMPS`
on narrow screens), a Vision & Mission section, and a nested tab system for the catalog
(Printing & Office Supplies / Design / Merch, with live DTF pricing under
Design → Apparel, other sub-categories stubbed as "coming soon").

**Problem:** the deployable site was still sitting at
`Claude Design/KCMPS Redesign/templates/landing/`, four directories deep. Syncing that path
straight to the S3 bucket would have meant either mirroring the nested structure in the
bucket or writing sync logic to cherry-pick one subfolder out of a design-tool export.

**Fix:** `index.html`, `styles.css`, and `assets/` were moved out to the repo root, so the
bucket could sync from root with no path translation. The design-system reference docs kept
their own copy of `styles.css` so they still render standalone, independent of the deployed
site's copy.

### 4. Two branches diverge (2026-07-22)

Work split into two parallel tracks after step 3:

- **`main`** — reorganized the repo again (commit `e4481ee`, "fix logic"): the design-system
  reference docs and the deployed site both moved one level down, into `website/`, so the
  repo root would hold only project-level files (this README, `.claude/` config) and not mix
  them with deployable site assets.
- **A feature branch** (`claude/kcmps-login-frontend-d718f1`) — added `login-test.html`, a
  standalone proof-of-concept for AWS Cognito Hosted UI login, built and validated against
  the real Cognito app client *before* wiring auth into the actual storefront. This let the
  auth flow (see below) get debugged in isolation, without every fix requiring a redeploy of
  the full site.

**Problem:** the login branch was cut from the repo layout *before* `main`'s `website/`
move landed, so `login-test.html` was built at the repo root and its README pointed at
root-relative paths. Merging as-is would have put the test file at the wrong level and left
its docs describing a layout that no longer existed.

**Fix:** before merging, `login-test.html` (and its README section) was moved into
`website/` to match, and the paths in its instructions were corrected (commit `dd18252`).
The merge (`b9ec0bd`) then combined both tracks cleanly: `main`'s repo reorg and the
feature branch's login POC, both already speaking the same directory layout.

### 5. Where things stand now

`website/index.html` is the deployed storefront. `website/login-test.html` is a working,
manually-verified Cognito login flow that has *not* yet been wired into `index.html` — the
storefront's "Login / Sign-up" button, `Dashboard` nav link for `Staff`-group users, and cart
icon are still stubs pending that integration.

## Errors encountered during the Cognito login POC, and what fixed them

Building `login-test.html` surfaced several non-obvious problems specific to doing OAuth from
a static, serverless SPA. These are documented here (and in comments in the file itself) so
they aren't rediscovered the hard way when auth gets wired into the real storefront.

### Popup detection broke under Cross-Origin-Opener-Policy

**Problem:** the natural way to detect "the login popup finished" is to poll
`popup.closed` or hold a `window.opener` reference back to the main window. Cognito's
Hosted UI sends a `Cross-Origin-Opener-Policy` header, which severs `window.opener` the
moment the login form renders in the popup — and can also make `popup.closed` checks from
the main window unreliable.

**Fix:** the main window instead listens for a `storage` event fired when the popup writes
its result to `localStorage` (with a slow poll kept only as a backup). This is COOP-safe
because it doesn't depend on either window holding a live reference to the other — it's a
same-origin message bus, not a direct handle.

### Public SPA client can't use a client secret

**Problem:** a classic OAuth Authorization Code flow expects a client secret exchanged
server-side. This is a pure static site with no backend to hold one.

**Fix:** the Cognito app client is configured as public (no secret), using Authorization
Code with PKCE instead — the `code_verifier`/`code_challenge` pair proves the token-exchange
request came from the same browser that started the flow, without any secret ever existing.

### Missing `profile` scope silently broke the nav

**Problem:** early testing requested only `email openid`. Login succeeded, but the nav had
no name to display after login — the ID token simply didn't carry a `name` claim.

**Fix:** added `profile` to the requested OAuth scopes (`email openid profile phone`).
That claim is what the nav's "swap the login button for the user's name" behavior depends
on.

### Token storage: tradeoffs, not a fix

Not a bug, but a decision worth recording so it isn't re-litigated as one: ID/access/refresh
tokens are kept in `sessionStorage` rather than `localStorage`. Both are equally readable by
an injected script if the page ever has an XSS bug, but `sessionStorage` is cleared when the
tab closes, capping the exposure window — `localStorage` would persist the tokens
indefinitely across browser restarts. The strictly more secure option (an httpOnly cookie
holding the refresh token via a Backend-for-Frontend) isn't available yet because this is a
static site with no server; worth revisiting once API Gateway/Lambda exist.
`localStorage` *is* still used, briefly, purely as the same-origin message bus described
above — each value is written and deleted within seconds.

### Client-side JWT decoding is for display only

The ID token is decoded in the browser to read `name` and `cognito:groups` for UI purposes
(nav name, showing the Staff `Dashboard` link) — it is never verified client-side. This is a
constraint to carry forward: any backend that later receives a token from this app must
independently verify its signature against Cognito's JWKS. Client-decoded claims must never
be trusted server-side just because the UI already displayed them.

## Running the storefront locally

```bash
cd website
python3 -m http.server 5500
```

Then open `http://localhost:5500/`.

## Running the login proof-of-concept locally

Cognito's OAuth redirect needs an `http(s)://` origin — opening the file directly
(`file://`) will not work.

```bash
cd website
python3 -m http.server 5500
```

Then open `http://localhost:5500/login-test.html`. That exact URL must be registered as an
allowed callback URL and sign-out URL on the Cognito app client (see below).

### Cognito app client requirements

- Public client (no client secret) — this is a browser SPA, no server-side code.
- Authorization Code grant with PKCE.
- OAuth scopes: `email openid profile phone`.
- Callback URLs / sign-out URLs must include the production origin
  (`https://site.kcmps.com/`) and, for local testing, `http://localhost:5500/`.

## Design system

The visual language (tokens, components, do/don't guidance) lives in
[`website/Claude Design/KCMPS Redesign/readme.md`](website/Claude%20Design/KCMPS%20Redesign/readme.md).
Any new page should link `website/styles.css` and build from its existing classes and CSS
variables rather than hard-coding colors, fonts, or spacing.

## Known gaps / next steps

- Wire the validated Cognito login flow from `login-test.html` into `index.html`'s
  "Login / Sign-up" button, `Dashboard` link, and session handling.
- Cart icon in `index.html` is a stub with a marked integration point for a future
  DynamoDB-backed cart.
- Sub-categories beyond DTF pricing (Subli, Hotmelt, and the rest of the catalog) currently
  ship as "coming soon" placeholders.
