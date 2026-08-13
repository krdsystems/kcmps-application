---
name: open-owner-actions
description: "Outstanding KCMPS items awaiting the owner as of 2026-08-06 — unverified paths, infra-scrub findings, and what production still has not received."
metadata: 
  node_type: memory
  type: project
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-05T19:05:25.624Z
---

State as of **2026-08-06**, after the production-readiness push (plan file:
`~/.claude/plans/kcmps-production-readiness-master-swift-corbato.md`). Everything below is
merged to `main` and pushed to GitHub (`436e1f9`); **nothing has been promoted to production.**

## Blocking verification gap (hit 5+ tasks)

**No staff Cognito login is usable by Claude.** The owner supplied one, but entering a password
to authenticate is a prohibited action, so it cannot be used. Consequence: the Design Library
(5 Lambdas, 4 routes, full dashboard page) and the mail relay have **never been exercised
through a real browser session and API Gateway's JWT authorizer** — all verification used
synthetic JWT claims via direct Lambda invoke. Route/authorizer wiring was confirmed separately
via `apigatewayv2 get-routes`. **The unblock is either the owner running the round trip, or
pasting a short-lived `id_token` from sessionStorage** (see [[ses-test-recipient]] for why
tokens are preferred over credentials).

## Awaiting owner action

1. **One test signup on dev.kcmps.com** to confirm the restored `PostConfirmation` trigger puts
   new users in the `Customer` group — the fix is verified at config level only. See
   [[lambda-migration-open-bugs]] item 3, including the still-open root cause (something ran a
   partial `update-user-pool` at 16:41 on 2026-08-05 and can re-break it).
2. **Design Library round trip** — upload → scan → publish → edit → archive → restore.
3. **Spacemail filter** excluding AWS notification mail from the forward. `no-reply-aws@amazon.com`
   is confirmed; the SNS sender was NOT verifiable — read the real `From:` off an alarm email in
   `admin@kcmps.com`. A code backstop routes both to `unrouted@` if the filter is wrong.
4. **Move the forwarder header to the front of `FORWARDER_HEADERS`** in `ingest-inbound.js` once
   one genuinely forwarded message exists (every message so far is a direct SES send, so
   Spacemail's actual header is unknown). Also set `ExpectedForwarderHost`. Command in
   `backend/infra/README.md`.
5. **SES IP allowlist** (`CreateReceiptFilter`, block `0.0.0.0/0` + allow Spacemail ranges) —
   deliberately NOT applied: no forwarded message has been observed yet, and applying it blind
   could drop the first real mail with no bounce. Ranges + commands are in the README.
6. **Bounce rate** touched ~13% then ~10% (24h) from test sends; AWS warns ~5%, suspends ~10%.
   Enforcement still `HEALTHY`. Should recover on its own — do not add test sends.

## Infra-scrub findings (2026-08-06, read-only, account 260866268499)

- **SPF was broken and is now FIXED** — the root TXT record merged a verification token and the
  SPF policy into one record (two strings concatenate per RFC 7208, so it did not start with
  `v=spf1`). Split into two records, verified on Google/Cloudflare/authoritative NS. **Worth a
  real mail test** (staff Spacemail → Gmail, check for `spf=pass`).
- **No CAA record** — any CA can issue for `kcmps.com`. Suggest `0 issue "amazon.com"`.
- **DMARC is `p=none`** (monitoring only). Safe to tighten to `p=quarantine` **only after** the
  SPF fix is confirmed by a real mail test.
- **Stale IAM users** in that account: `test-user`, `terraform-user`, a never-used break-glass
  user, and `tymn-administrator-aws` (a different project). `krdungca14` is in `admingroup01`
  and holds an **Inactive access key from March** plus the Active one the `default` profile uses.
  Suggest deleting the inactive key, rotating the active one, and auditing the user list.
- Healthy, no action: domain auto-renew ON, transfer lock ACTIVE, privacy ON, expiry 2027-07-16,
  MFA on `krdungca14`, all website/mail records correct.

## Remaining plan tasks

C4 (email seam swap — **merged 2026-08-06**), E2 (accessibility) and A8 (idle privacy screen —
two-stage overlay, opaque backdrop) both in flight 2026-08-06, then E4 (conversion pass), and
Task Z (final integration + `security-review` + staging deploy, stopping before production).

Z also owes the owner a **`backend/lib/` test-coverage map** (14 modules, only 2 test files):
module → direct/incidental/no coverage, ranked by blast radius, weighting money, auth, and
fail-closed-security paths highest. Reporting only — writing the missing tests is a later task.

**Never run `node --test backend/lib/`** — the bare directory form executes nothing and exits 0
even on failure (Node v22.23.2, verified 2026-08-06). Use `node --test backend/lib/*.test.js`;
the real total was 71 passing as of 2026-08-06. The tell is the count — the broken form can only
ever print `# tests 1`.
