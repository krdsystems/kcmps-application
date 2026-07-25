# Milestone 1.0 — Platform Foundation: build prompts

Companion to [`docs/roadmap.md`](../roadmap.md) → Milestone 1, step 1.0. These are the
buildable ("my end") tasks for the foundation, written as **self-contained prompts** — each can
be pasted into a fresh Claude Code session and executed without the rest of this conversation.

Architecture reference: [`project_knowledge/ERP_System_Project_Knowledge.md`](../../project_knowledge/ERP_System_Project_Knowledge.md)
(launch-blocking conventions = §2.3). Schema reference:
[`ops-dashboard/infra/backend-infra-to-deploy.md`](../../ops-dashboard/infra/backend-infra-to-deploy.md)
(§2.1 key patterns, §2.2 event + payment shapes, §2.3 GSI1).

---

## Division of labor for 1.0

**Your end (AWS provisioning — I can't do these from the repo):**
1. Apply the CloudFormation template from **Prompt 2** (or click-ops the equivalent) to create:
   the DynamoDB single table (Streams + PITR on), GSI1, and the 5 Cognito groups in the
   **existing** user pool `ap-southeast-1_iDvAEumNp`.
2. Add the 4 founders to the `Admin` group.
3. Send me back: the **table name** and confirmation the 5 groups exist. (Nothing else in 1.0
   needs live AWS — the API/routes come in 1.3.)

**My end (repo/code — the prompts below):**
- Prompt 1: shared conventions library (`backend/lib/`) — the foundation everything imports.
- Prompt 2: the foundation IaC template you apply (I author, you run).
- Prompt 3: migrate the client role model Customer/Staff → 5 ERP roles.
- Prompt 4 (optional, foundation-adjacent): align the dashboard mock to the conventions so the
  1.3 mock→real swap is body-only.

**Run order:** Prompt 1 → Prompt 2 (can go in parallel) → Prompt 3 → Prompt 4. Prompt 2's
template is what unblocks *your* end.

**Conventions all prompts must honor (ERP §2.3 — cannot be retrofitted):**
`tenantId`/`siteId` = `SITE#MNL` on every item · money as **integer centavos** + explicit
`currency: "PHP"` · `schemaVersion` on every item · immutable `EVENT#` log, never
mutate/delete · soft-delete + `status`, never hard-delete. Runtime for all Lambda code:
**Node.js 20.x, ARM64**, AWS SDK **v3** only (no other runtime deps).

---

## Prompt 1 — Shared conventions library (`backend/lib/`)

```text
Create a new NON-DEPLOYED top-level folder `backend/` (a sibling of `ops-dashboard/` and
`storefront-infra/` — NOT inside `website/`, which is the only deployed folder). This is the
future single home for all server-side code (modular-monolith thesis in
project_knowledge/ERP_System_Project_Knowledge.md). For 1.0, build only the shared library.

Create `backend/lib/` — the conventions module every future Lambda (checkout + dashboard)
imports so the launch-blocking data conventions are applied identically everywhere. Node.js
20.x, AWS SDK v3 only, CommonJS to match the existing drafts in
ops-dashboard/infra/logic-inputs/. Files:

- `constants.js` — exports: SITE_ID = "SITE#MNL", CURRENCY = "PHP", SCHEMA_VERSION = 1, and the
  canonical STATUS vocabulary (Quoted, Priced, Pending Payment Verification, Confirmed,
  Payment Rejected, Scheduled, In Production, QC, Dispatch, Delivered, Cancelled, Auto-Cancelled,
  Quote Expired) plus the ACTIVE_STATUSES set (statuses that keep an item in the GSI1 sparse
  index — everything except Delivered/Cancelled/Auto-Cancelled/Quote Expired). Source of truth:
  Payment_System_Project_Knowledge.md and backend-infra-to-deploy.md §2.1/§2.6.

- `money.js` — money is INTEGER CENTAVOS. Export: toCentavos(pesos), toPesos(centavos),
  formatPeso(centavos) → "₱1,500.07", and assertCentavos(n) that throws on non-integers.
  No floats stored, ever (ERP §2.3.4).

- `keys.js` — PK/SK builders matching backend-infra-to-deploy.md §2.1 EXACTLY:
  orderPk(orderId)="ORDER#<id>", metaSk()="META", lineItemSk(lid)="LINEITEM#<lid>",
  eventSk(isoTs,lid)="EVENT#<ts>#<lid>", and gsi1 helpers statusPk(status)="STATUS#<status>".
  Also client/inventory/metric key builders per the same table.

- `item.js` — baseItem({ ... }) that stamps EVERY item with tenantId/siteId=SITE_ID,
  schemaVersion=SCHEMA_VERSION, createdAt (ISO), updatedAt, status, and soft-delete fields
  (deleted:false). Callers spread their own fields on top. This is how "never hard-delete" and
  the reserved multi-site/schema dims get enforced by construction.

- `events.js` — buildEvent({ orderId, lineItemId, from, to, actorSub, actorName, station, meta })
  returning the append-only record shaped EXACTLY like backend-infra-to-deploy.md §2.2
  (PK=ORDER#<id>, SK=EVENT#<iso>#<lid>, plus from/to/actorSub/at/meta). Pure function; the
  DynamoDB write is the caller's job (so it composes into TransactWriteItems).

- `auth.js` — the 5-role model (Customer, Production, Sales, Finance, Admin). Export:
  extractClaims(event) (reads event.requestContext.authorizer.jwt.claims), getGroups(claims)
  (handles both the comma-string and array forms of cognito:groups, like
  api-verify-payment.js already does), hasRole(claims, role), isStaff(claims) (any of
  Production/Sales/Finance/Admin — the Customer-excluded set), and requireRole(claims, roles)
  that returns a 403-style error object if absent. Include a comment: client-decoded claims are
  UI-only; these run server-side where the JWT is already authorizer-verified.

- `gsi.js` — sparse-index hygiene helpers for GSI1 (backend-infra-to-deploy.md §2.3/§2.6):
  activeStatusAttrs(status, enteredAtIso) returning {GSI1PK, GSI1SK} ONLY when status is in
  ACTIVE_STATUSES, and a note/helper for the REMOVE-on-terminal pattern (return the attribute
  names to REMOVE when a status is terminal, so callers build the right UpdateExpression).

- `index.js` — re-export all of the above.

Add `backend/CLAUDE.md` (short, following the repo's other CLAUDE.md files): what backend/ is,
that it's not deployed, that lib/ is the shared conventions everything imports, and that the
ops-dashboard/infra/logic-inputs drafts will migrate to import it later (not now).

Add `backend/lib/lib.test.js` — a plain `node:test` file (no test-framework dep) covering the
pure functions: money round-trips + integer assertion, key builders match the §2.1 strings,
buildEvent shape, ACTIVE_STATUSES membership, and hasRole/isStaff on both cognito:groups forms.
Runnable with `node --test`.

Do NOT build any actual Lambda handlers, DynamoDB clients, or API routes here — foundation
only. Acceptance: `node --test backend/lib/` passes; field names/strings match §2.1/§2.2
verbatim; money is integer centavos throughout; no dependency beyond @aws-sdk/* (and lib.test
uses only node:test).
```

---

## Prompt 2 — Foundation infrastructure-as-code (you apply this)

```text
Author `backend/infra/foundation.cfn.yaml` — a single AWS CloudFormation template that
provisions Milestone 1.0's foundation, plus `backend/infra/README.md` with apply + rollback
instructions. This is applied by the repo owner; it must be safe to run against the EXISTING
account and must NOT create a second Cognito user pool.

The template must create, matching backend-infra-to-deploy.md §2.1/§2.3:
- A DynamoDB single table (parameter: TableName, default "kcmps"):
  PK (S, HASH) + SK (S, RANGE); BillingMode PAY_PER_REQUEST; PointInTimeRecoverySpecification
  enabled; StreamSpecification NEW_AND_OLD_IMAGES (needed by streams-handler.js later);
  DeletionProtectionEnabled true.
- GSI1: GSI1PK (S, HASH) + GSI1SK (S, RANGE), Projection ALL — exactly §2.3.
- The 5 Cognito groups (AWS::Cognito::UserPoolGroup) in the EXISTING pool
  (parameter: UserPoolId, default ap-southeast-1_iDvAEumNp): Customer, Production, Sales,
  Finance, Admin, with a Precedence ordering (Admin lowest number = highest priority).

Parameterize TableName and UserPoolId. Add Outputs: TableName, TableStreamArn, GSI1 name.
The README must cover: `aws cloudformation deploy` command (region ap-southeast-1), how to add
the 4 founders to the Admin group afterward
(`aws cognito-idp admin-add-user-to-group ...`), and how the values map to what the 1.1/1.3
Lambdas will need (TableName env var, StreamArn for the streams-handler event source).

Cross-check every attribute/index name against backend-infra-to-deploy.md §2 so the template
and that doc can't drift. Acceptance: `aws cloudformation validate-template` passes; template
adds groups to the existing pool (does not declare an AWS::Cognito::UserPool); table has
Streams + PITR + deletion protection on.
```

---

## Prompt 3 — Migrate client role model: Customer/Staff → 5 ERP roles

```text
The Cognito user pool is gaining 5 groups (Customer, Production, Sales, Finance, Admin) in place
of the old Customer/Staff split (see docs/roadmap.md 1.0 and ERP file Part 5). Update the
CLIENT-SIDE role handling so it matches, WITHOUT changing current behavior: the four founders
are all Admin, so anyone who could see the dashboard before still can, and Customers still
can't.

Find every client-side place that reads cognito:groups or branches on "Staff"/"Customer":
- website/dashboard/dashboard-shell.js (the dashboard gate — search for the group check near
  TOKEN_STORAGE_KEY = "kcmps_tokens").
- website/index.html (the auth <script> block — search for cognito:groups / group-based UI).
Grep the whole website/ for "Staff" and "cognito:groups" to be sure you catch all of them.

Change the gate from "is in Staff" to "is staff-equivalent" = is in ANY of
{Production, Sales, Finance, Admin} (Customer excluded). Introduce a small shared client helper
(e.g. an isStaffRole(groups) function) rather than repeating the array inline, and mirror the
role names from backend/lib/auth.js so client and server can't drift (client copy, with a
comment pointing at backend/lib/auth.js as the source of truth). Keep the existing
"client-decoded JWT claims are UI-only, never trust them server-side" comment intact — this is
display gating only.

Do NOT add any new server calls or change the auth/token flow. Acceptance: a user in Admin (or
any staff role) still reaches website/dashboard/*; a Customer-only user is still redirected/
blocked exactly as before; no remaining hardcoded lone "Staff" group string in website/.
Test by editing the decoded-group value locally (or note the manual test steps) since there's
no backend yet.
```

---

## Prompt 4 — (Optional) Align the dashboard mock to the conventions

```text
So that Milestone 1.3's mock→real swap is a body-only change, bring the dashboard mock in line
with the shared conventions from backend/lib/ (built in Prompt 1). Touch ONLY
website/dashboard/dashboard-data.js (the single seam behind window.KCMPS_DASH — no .html file
reads localStorage directly, keep it that way).

Make the mock data match the real schema it mirrors (backend-infra-to-deploy.md §2.1/§2.2 and
Payment_System_Project_Knowledge.md):
- Money stored as INTEGER CENTAVOS with currency "PHP" (convert any peso-float seed values);
  keep the displayed pesos identical by formatting at render time.
- Event records in the §2.2 EVENT# shape (from/to/actorSub/at/meta).
- Status strings drawn from the same vocabulary as backend/lib/constants.js STATUS (Pending
  Payment Verification, Confirmed, Payment Rejected, etc.) — no ad-hoc variants.
- The order-level `payment` sub-object in the exact shape from
  Payment_System_Project_Knowledge.md "Data Model Addition".

Since website/ can't import from backend/ (different deploy roots — website/ is synced to S3
alone), DUPLICATE the needed constants/helpers inline in dashboard-data.js with a comment
citing backend/lib/ as the source of truth, rather than a cross-folder import. Keep every
KCMPS_DASH function's RETURN shape unchanged so the .html pages render identically.

Acceptance: run the dashboard locally (python3 -m http.server in website/) and confirm
Today/Jobs/Clients render exactly as before; verify seed money is centavos in localStorage but
pesos on screen; verify verify/reject still flip the mocked payment object. Re-run
ops-dashboard/user-test/README.md if anything in the payment flow changed.
```

---

## After 1.0

Once your end confirms the table + groups exist and Prompts 1–3 land, the roadmap moves to
**1.1 (order creation on checkout)** and **1.2 (`submitPaymentProof`)** — the first prompts of
which will import `backend/lib/` directly. The one decision to settle before 1.2 is the **GCash
matching mechanism** (unique-centavo variance vs. Order-ID-as-note) — noted in
[`docs/roadmap.md`](../roadmap.md#open-decisions-that-gate-milestone-1).
