# CLAUDE.md — KCMPS

Root orientation for Claude Code sessions in this repo. Keep this file short — it's read on
every session start. Deep history and rationale live in `docs/history.md`; don't load that
file unless you specifically need "why was it built this way."

## What this is

KCMPS: a Manila print/merch shop's marketing site + storefront (custom apparel printing,
design services) with a staff-only ops dashboard. Static site, no backend yet — Cognito auth
and a localStorage-backed cart/dashboard are built to swap to a real API later with minimal
code changes (see "Migration seams" below).

## Hard constraint: what's deployed

**Only `website/` is deployed** — synced verbatim to an S3 bucket, no build step, no
bundler. Never add dev-only files (docs, test scripts, infra code) inside `website/`; they'd
go live. Everything non-deployed has its own top-level sibling folder:
`design-system/`, `ops-dashboard/`, `project_knowledge/`, `docs/`.

Stack: vanilla HTML5, ES6, Tailwind via CDN (storefront) / hand-written `styles.css` (design
system tokens + components, no utility framework). No `package.json`, no npm install, no
build — edits are live on refresh.

## Key files — feature → location

| Need to touch...              | Go to |
|---|---|
| Cart logic, checkout          | `website/store.js` — `addToCart`, `setQty`, `removeItem`, `payNowTotal`, `submitOrder`, public API `window.KCMPS_STORE` |
| Catalog / product data        | `website/products.js` — `window.KCMPS_STORE_DATA = { currency, shirtAddon, leaves, products }` |
| Page structure / copy         | `website/index.html` — value-stack amounts & guarantee wording marked inline as owner-editable |
| Auth (Cognito login/logout)   | `website/index.html` `<script>` block; isolated reference/debug copy at `website/login-test.html` |
| Design tokens / components    | `website/styles.css` (deployed copy) — mirror any change into `design-system/KCMPS Redesign/styles.css` |
| Carousel timing               | `.carousel-track transition` in `styles.css`; `AUTO_MS` in `index.html` |
| Checkout endpoint             | `CHECKOUT_ENDPOINT` constant near top of `website/store.js` (default `mailto:`) |
| Ops dashboard pages           | `website/dashboard/*.html` + shared `dashboard.css`/`dashboard-shell.js` |
| Ops dashboard mock data/API   | `website/dashboard/dashboard-data.js` — `window.KCMPS_DASH.*`; never touch `localStorage` directly outside this file |
| AWS infra plan (not deployed) | `ops-dashboard/infra/backend-infra-to-deploy.md` + `ops-dashboard/infra/logic-inputs/*.js` (Lambda source) |
| Payment/GCash logic spec      | `project_knowledge/Payment_System_Project_Knowledge.md` |
| Design system full reference  | `design-system/KCMPS Redesign/readme.md` (see also its own `CLAUDE.md`) |

Prefer this table + `Grep`/`Glob` over reading whole files or the README for orientation.
Line numbers drift; the function/constant names above are stable anchors — grep for them.

## Conventions and gotchas (learned the hard way — don't regress)

- **Migration seams**: both `store.js` (`window.KCMPS_STORE`) and `dashboard-data.js`
  (`window.KCMPS_DASH`) are the *only* things callers touch — no page reads `localStorage`
  directly. When a backend exists, only these two files' function bodies change to `fetch()`.
  Keep new features behind this same seam.
- **Auth tokens** live in `sessionStorage`, not `localStorage` (deliberate XSS-exposure
  tradeoff — see `docs/history.md#auth-implementation-notes` before changing this).
- **Client-decoded JWT claims are UI-only**, never trust them server-side once a backend
  exists — any future Lambda must re-verify against Cognito's JWKS.
- **Mobile**: `overflow-x: hidden` on `html, body` and the `@media (max-width: 760px)` /
  `(max-width: 480px)` rules in `styles.css` fix specific overlap bugs (nav, cart drawer).
  Don't remove them without re-testing at 375px.
- **Brand system**: navy-dominant, one orange accent reserved for a single CTA per screen,
  rounded/friendly geometry. Build from `styles.css` classes/CSS variables, don't hardcode
  colors — see `design-system/`.
- Editing `website/styles.css`? Also update `design-system/KCMPS Redesign/styles.css` so the
  reference docs don't drift from the live site.

## Git / worktree workflow

- Feature work happens on `claude/<slug>` branches, often in a git worktree under
  `.claude/worktrees/<slug>` for parallel sessions.
- **After a worktree's branch is merged into `main`, remove it**: `git worktree remove
  .claude/worktrees/<slug>`. Stale merged worktrees are full repo copies (100+ files, several
  MB each) that inflate every subsequent glob/grep across the repo — prune them as part of
  finishing a task, don't leave it for later.
- Check `git worktree list` and `git branch --merged main` at the start of a session if
  `.claude/worktrees/` looks stale.

## Local dev

```bash
cd website && python3 -m http.server 5500
```

Cognito needs `http(s)://`, not `file://`. Full setup and testing checklist: `README.md`.

## Where to look next

- Current-state overview, layout diagram, local dev, testing checklist → `README.md`
- Full build log / design rationale / auth implementation notes → `docs/history.md`
- Design-system-specific and ops-dashboard-specific notes → their own `CLAUDE.md` files
