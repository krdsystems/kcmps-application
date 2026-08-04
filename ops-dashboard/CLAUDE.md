# CLAUDE.md — ops-dashboard/

Build-time tooling for `website/dashboard/*`. **Not deployed** — this is planning/infra
material, kept separate so an S3 sync of `website/` never uploads it.

Only loaded when you're actually working in this folder — see the root `CLAUDE.md` for
project-wide orientation.

## Current state: no backend exists yet

`website/dashboard/*` runs entirely on mock data (`website/dashboard/dashboard-data.js`,
backed by `localStorage`). Everything in this folder is the plan/code for making it real —
none of it is deployed or running today.

## What's here

- `infra/backend-infra-to-deploy.md` — the AWS architecture: DynamoDB single-table schema +
  GSI1 sparse status index, Lambda functions, API Gateway routes, EventBridge cron, SES
  digest, IAM, cost impact, phased deployment checklist. Layers on the existing S3 +
  CloudFront + Cognito + API Gateway + Lambda + DynamoDB + SES stack — no new AWS services.
  Cites `project_knowledge/Payment_System_Project_Knowledge.md` as the source for the
  `payment` sub-object shape and GCash verify/on-hold flow.
- `infra/logic-inputs/*.js` — the actual Lambda source to deploy: `streams-handler.js`
  (DynamoDB Streams → derived status + GSI1 + metric rollups), `expire-pending-orders.js`
  (verification/quote-expiry sweep), `daily-digest.js` (SES digest), `api-get-orders.js` /
  `api-advance-line-item.js` / `api-verify-payment.js` (role-filtered, state-machine-
  validated API handlers — **JWT must be verified server-side here**, never trust
  client-decoded claims from the frontend).
- **Queued, not yet written** — the staff email panel's Lambdas (`getInboxMessages`,
  `sendEmail`, `putEmailCredential`) belong in `infra/logic-inputs/` alongside the above when
  they're built. The dashboard's Email page (`website/dashboard/email.html`) already exists on
  mock data with IMAP-shaped return values, so these three only have to match those shapes.
  Same server-side-JWT rule applies, and it bites hardest on `putEmailCredential`: derive the
  staff `sub` from the **verified** token, never from the request body, or any staff member can
  overwrite anyone else's stored mailbox credential. Spec: `docs/roadmap.md`, "Parallel track —
  Staff email panel".
- `user-test/README.md` — a manual test script for a non-technical user to verify the
  dashboard's *design logic* (state transitions, SLA aging, spoilage capture, mixed-cart
  rollup), not just that pages render.

## When you'd touch this folder

- Actually deploying the backend → start with `infra/backend-infra-to-deploy.md`'s phased
  checklist, then wire `infra/logic-inputs/*.js` in as Lambdas.
- Changing the mock data shape in `website/dashboard/dashboard-data.js` → check
  `backend-infra-to-deploy.md` and `project_knowledge/Payment_System_Project_Knowledge.md`
  first so the mock stays in sync with the real schema it's meant to mirror. The mail functions
  (`getMailboxes`/`getMessages`/`getMessage`/`getThread`/`markMessageRead`/`sendReply`) mirror an
  IMAP `FETCH` rather than the DynamoDB schema — the envelope-vs-body split across
  `getMessages()`/`getMessage()` exists because real IMAP needs two round-trips, so don't
  collapse it.
- QA'ing dashboard behavior → follow `user-test/README.md`.
