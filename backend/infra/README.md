# Milestone 1.0 foundation — apply & rollback

`foundation.cfn.yaml` provisions the two pieces every later Lambda in
`ops-dashboard/infra/backend-infra-to-deploy.md` depends on:

- The single DynamoDB table (`PK`/`SK` + `GSI1`), with Streams, PITR, and
  deletion protection on.
- The 5 Cognito staff/customer groups (`Customer`, `Production`, `Sales`,
  `Finance`, `Admin`) in the **existing** User Pool.

It does **not** create a Cognito User Pool, API Gateway, or any Lambda — those
come in later milestones (1.1+), once this foundation exists to build on.

## Prerequisites

- AWS CLI configured with credentials that can create DynamoDB tables and
  Cognito user pool groups in the target account.
- The existing Cognito User Pool ID (default baked into the template:
  `ap-southeast-1_iDvAEumNp` — override with `--parameter-overrides` if this
  ever changes, e.g. a different environment).
- Confirm no DynamoDB table named `kcmps` (or your chosen `TableName`) already
  exists in `ap-southeast-1` in this account — the template will fail to
  create it if one does, rather than silently overwriting it.

## Validate

```bash
aws cloudformation validate-template \
  --template-body file://backend/infra/foundation.cfn.yaml \
  --region ap-southeast-1
```

## Apply

```bash
aws cloudformation deploy \
  --template-file backend/infra/foundation.cfn.yaml \
  --stack-name kcmps-foundation \
  --region ap-southeast-1 \
  --parameter-overrides TableName=kcmps UserPoolId=ap-southeast-1_iDvAEumNp \
  --no-fail-on-empty-changeset
```

Both parameters have the defaults shown above, so `--parameter-overrides` can
be omitted on a first run — it's included here to make the values explicit
and easy to override later.

Watch progress:

```bash
aws cloudformation describe-stack-events \
  --stack-name kcmps-foundation --region ap-southeast-1
```

## Verify

```bash
aws cloudformation describe-stacks \
  --stack-name kcmps-foundation --region ap-southeast-1 \
  --query 'Stacks[0].Outputs'
```

Should print `TableName`, `TableStreamArn`, and `GSI1Name`. Keep the
`TableStreamArn` value — it's the `EventSourceArn` the 1.3 `streams-handler.js`
Lambda's event source mapping will need.

## Add the admin user to the Admin group

The template creates the `Admin` group but doesn't add any users to it (a
CloudFormation stack shouldn't hardcode people). The pool already has a
dedicated admin account, `admin.kcmps.cognito` (email `admin@kcmps.com`) —
use that instead of adding each founder individually:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id ap-southeast-1_LHJsFdCgo \
  --username admin.kcmps.cognito \
  --group-name Admin \
  --region ap-southeast-1
```

Confirm membership:

```bash
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id ap-southeast-1_LHJsFdCgo \
  --username admin.kcmps.cognito \
  --region ap-southeast-1
```

## What later milestones need from this stack

| Value | Where it's used |
|---|---|
| `TableName` output | Every Lambda's `TABLE_NAME` environment variable (1.1 CRUD Lambdas, streams-handler, expire-pending-orders, daily-digest) |
| `TableStreamArn` output | The 1.3 `streams-handler.js` Lambda's DynamoDB Streams event source mapping (`NEW_AND_OLD_IMAGES`, already set on the table) |
| `GSI1Name` output (`GSI1`) | Every Lambda that queries the sparse status index (`api-get-orders.js`, `api-advance-line-item.js`'s queue reads, `expire-pending-orders.js`) |
| Cognito groups (`Customer`/`Production`/`Sales`/`Finance`/`Admin`) | JWT `cognito:groups` claim checks inside every `api-*.js` Lambda and the HTTP API's JWT authorizer setup (§4 of `backend-infra-to-deploy.md`) — `backend/lib/auth.js`'s `isStaff()` now treats `Staff` as a first-class member of `STAFF_ROLES` alongside `Production`/`Sales`/`Finance`/`Admin`, and the dashboard's client-side gate (`dashboard-shell.js`, mirrored in `index.html`) accepts all five staff roles — see "Legacy groups" below |

### Legacy groups — `Customers` retired, `Staff` folded into the role model (2026-08-03)

The pool had two groups from before this stack existed: `Staff` (precedence
10) and `Customers` (precedence 100, plural).

**`Customers` (plural) is now retired** — its one real member (a
Google-federated customer account) was moved into `Customer` (singular) via
`admin-add-user-to-group`/`admin-remove-user-from-group`, confirmed empty via
`list-users-in-group`, then deleted with `aws cognito-idp delete-group`.

**`Staff` is NOT retired — it's a first-class role now, not a fallback.**
The intended model (see root `CLAUDE.md`) is 3 practical tiers: `Customer`
(every self-signup, auto-assigned), `Staff` (dashboard access only), and
`Admin` (founders — dashboard access plus whatever admin-only surface gets
built later). `Production`/`Sales`/`Finance` stay reserved/dormant for the
first non-founder hire. `backend/lib/auth.js`'s `STAFF_ROLES` set includes
`Staff` directly (no more `LEGACY_STAFF_GROUP` OR-fallback in
`get-orders.js`/`advance-line-item.js`/`verify-payment.js`), and
`dashboard-shell.js`'s client-side gate (`requireStaffAuth()`) accepts all
five staff roles — `Staff`, `Admin`, `Production`, `Sales`, `Finance` — via
`COGNITO_CONFIG.dashboardGroupNames` (widened 2026-08-05 on branch
`claude/dashboard-staff-gate`; it previously accepted only `Staff` or
`Admin`, so a hire placed in just `Production`/`Sales`/`Finance` passed every
backend `isStaff()` check but was bounced by the dashboard UI). **That
constant is duplicated in `website/index.html`** (~line 1965, gating whether
the Dashboard nav link renders) — both copies must be kept in sync, and both
were widened together. Founder
accounts (`admin.kcmps.cognito`, `admin.kcmps.cognito.test`,
`admin.kcmps.uat`) no longer need dual `Staff`+`Admin` membership to see the
dashboard — `Admin` alone is sufficient now that both the frontend and
backend gates accept it.

## Rollback

CloudFormation stack deletion **will not** remove the table or its data,
because `DeletionPolicy: Retain` is set on the `AWS::DynamoDB::Table`
resource (on top of `DeletionProtectionEnabled: true`, which independently
blocks deletion while the stack still owns the resource). To roll back:

```bash
aws cloudformation delete-stack \
  --stack-name kcmps-foundation --region ap-southeast-1
```

This removes the 5 Cognito groups from the existing pool (harmless — no
users are deleted, they just lose group membership, so re-running this
template later recreates the groups but does **not** restore prior
memberships) and leaves the DynamoDB table in place, orphaned from the
stack. If you actually want the table gone:

1. Disable deletion protection first (required — AWS will refuse to delete
   otherwise):
   ```bash
   aws dynamodb update-table \
     --table-name kcmps --region ap-southeast-1 \
     --no-deletion-protection-enabled
   ```
2. Delete the orphaned table manually:
   ```bash
   aws dynamodb delete-table --table-name kcmps --region ap-southeast-1
   ```

Do this only if you're certain — there is no CloudFormation undo once the
table is gone, and PITR backups expire per DynamoDB's normal retention
window, not indefinitely.

## Payment uploads bucket (not part of this CloudFormation stack)

`kcmps-payment-uploads-est-2026` — the private S3 bucket
`backend/checkout/submit-payment-proof.js`'s `UPLOADS_BUCKET` env var will point at once that
Lambda is deployed. **Provisioned manually via CLI (2026-07-31), not CloudFormation** — this
is a plain, standalone bucket with no other stack dependencies, so a template felt like
ceremony for one resource; if it ever grows a lifecycle policy tied to other resources
(matching the design-asset-library bucket's planned lifecycle, `docs/roadmap.md` "Parallel
track — Design Asset Library"), reconsider folding it into a template then.

- Region: `ap-southeast-1` (same as the `kcmps` table and the production S3 bucket — no
  cross-region data transfer).
- Public access fully blocked (`BlockPublicAcls`/`IgnorePublicAcls`/`BlockPublicPolicy`/
  `RestrictPublicBuckets`, all `true`) and ACLs disabled entirely
  (`ObjectOwnership: BucketOwnerEnforced`) — screenshots of GCash payment confirmations are
  never public, unlike the storefront's asset bucket.
- Versioning enabled, SSE-S3 default encryption, noncurrent versions expire after 90 days
  (a superseded/re-uploaded screenshot has no reason to live longer than that once its order's
  payment is verified or rejected).
- **No bucket policy or IAM grant applied yet** — that's the Lambda execution role's job at
  actual deploy time (see `backend-infra-to-deploy.md` §7's IAM sketch: `s3:PutObject` scoped
  to this bucket's ARN, presigned-URL generation needs no broader grant than that).
- **CORS (added 2026-07-31, found missing during 1.3 live verification)**: the checkout flow's
  `submit-payment-proof.js` hands the browser a presigned `PUT` URL and the browser uploads
  the screenshot directly to this bucket's S3 origin, cross-origin from the storefront — that
  requires a bucket-level CORS rule, which didn't exist (the DynamoDB write succeeded every
  time; only the direct-to-S3 `PUT` was silently blocked, surfacing to the customer as
  "Failed to fetch" despite their order having actually saved — see `docs/history.md` entry
  51). Rule: `AllowedMethods: ["PUT"]`, `AllowedOrigins` matching the checkout API's own CORS
  origin set (`kcmps.com`/`www.kcmps.com`/`site.kcmps.com`/`dev.kcmps.com`/`localhost:5500`/
  `localhost:5501`), `AllowedHeaders: ["content-type"]`.
  ```bash
  aws s3api put-bucket-cors --bucket kcmps-payment-uploads-est-2026 --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://kcmps.com","https://www.kcmps.com","https://site.kcmps.com","https://dev.kcmps.com","http://localhost:5500","http://localhost:5501"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":300}]}' --profile kcmps-claude-priv
  ```
- **`kcmps-staff-api-lambda-role` also has `s3:GetObject`** on
  `kcmps-payment-uploads-est-2026/payments/*` (added 2026-07-31, inline policy
  `kcmps-staff-api-s3-read`) — `get-orders.js` presigns a 15-minute GET URL for
  `order.payment.screenshotRef` so `job-detail.html` can render the actual screenshot image
  instead of a plain `s3://` string (see `docs/history.md` entry 51).

Verify:

```bash
aws s3api get-bucket-location --bucket kcmps-payment-uploads-est-2026 --profile kcmps-claude-priv
aws s3api get-public-access-block --bucket kcmps-payment-uploads-est-2026 --profile kcmps-claude-priv
aws s3api get-bucket-cors --bucket kcmps-payment-uploads-est-2026 --profile kcmps-claude-priv
```

## Design originals bucket (Design Asset Library, not part of this CloudFormation stack)

`kcmps-design-originals-est-2026` / staging's `kcmps-design-originals-staging` — the private
S3 bucket for Design Asset Library source files (PSD/AI/PDF), per `docs/roadmap.md`'s
"Parallel track — Design Asset Library" architecture. **Deliberately a separate bucket from
`kcmps-payment-uploads-est-2026`**: different access pattern (staff-only, low-frequency, no
public derivative), different lifecycle (long-lived originals with a recycle-bin style
version-retention policy, vs. the payment bucket's 90-day noncurrent-version expiry), and
keeping the two apart means an IAM grant scoped to one can never accidentally reach the
other. Provisioned manually via CLI, same as the payment uploads bucket — see that section's
reasoning for why this isn't a template resource.

**Staging bucket — created 2026-08-05:**
- Region `ap-southeast-1`.
- Versioning enabled, SSE-S3 default encryption, all public access blocked
  (`BlockPublicAcls`/`IgnorePublicAcls`/`BlockPublicPolicy`/`RestrictPublicBuckets`, all
  `true`) — this bucket never serves anything publicly; the web-ready derivative goes to the
  existing `kcmps-online-bucket-est-2026` instead (no new public bucket, no CloudFront in
  front of this one — see the roadmap architecture for why).
- Lifecycle rule `noncurrent-version-glacier-then-expire`: `NoncurrentVersionTransitions` to
  `GLACIER` at 30 days, `NoncurrentVersionExpiration` with `NewerNoncurrentVersions: 5` (S3
  requires a `NoncurrentDays` value alongside `NewerNoncurrentVersions` even though the intent
  here is "keep the 5 most recent regardless of age" — set to 30 to match the transition, it
  has no independent effect while `NewerNoncurrentVersions` is the binding constraint). This
  is the S3-level half of the recycle bin's two independent layers (app-level soft-delete is
  a future `publishDesign`/dashboard concern, not built yet).
- CORS: `AllowedMethods: ["PUT"]`, `AllowedOrigins` scoped to staff-facing origins only
  (`dev.kcmps.com`/`localhost:5500`/`localhost:5501` — no production apex/www, since only the
  staff dashboard ever uploads here, unlike the payment bucket which also serves customer
  checkout uploads).
  ```bash
  aws s3api create-bucket --bucket kcmps-design-originals-staging --region ap-southeast-1 \
    --create-bucket-configuration LocationConstraint=ap-southeast-1 --profile kcmps-claude-priv
  aws s3api put-bucket-versioning --bucket kcmps-design-originals-staging \
    --versioning-configuration Status=Enabled --profile kcmps-claude-priv
  aws s3api put-public-access-block --bucket kcmps-design-originals-staging \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
    --profile kcmps-claude-priv
  aws s3api put-bucket-encryption --bucket kcmps-design-originals-staging \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
    --profile kcmps-claude-priv
  aws s3api put-bucket-lifecycle-configuration --bucket kcmps-design-originals-staging \
    --lifecycle-configuration '{"Rules":[{"ID":"noncurrent-version-glacier-then-expire","Filter":{"Prefix":""},"Status":"Enabled","NoncurrentVersionTransitions":[{"NoncurrentDays":30,"StorageClass":"GLACIER"}],"NoncurrentVersionExpiration":{"NoncurrentDays":30,"NewerNoncurrentVersions":5}}]}' \
    --profile kcmps-claude-priv
  aws s3api put-bucket-cors --bucket kcmps-design-originals-staging --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://dev.kcmps.com","http://localhost:5500","http://localhost:5501"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":300}]}' --profile kcmps-claude-priv
  ```

**Production bucket — equivalent commands, NOT run yet (owner-gated, per this repo's staging-
first rule; production S3 resource creation is also explicitly owner-gated).** When approved,
run the same commands against `kcmps-design-originals-est-2026`, with `AllowedOrigins` widened
to match the payment bucket's production CORS set (`kcmps.com`/`www.kcmps.com`/
`site.kcmps.com`/`dev.kcmps.com`/`localhost:5500`/`localhost:5501` — the dashboard is served
from the apex domain in production, not a `dev.` subdomain):
```bash
aws s3api create-bucket --bucket kcmps-design-originals-est-2026 --region ap-southeast-1 \
  --create-bucket-configuration LocationConstraint=ap-southeast-1 --profile kcmps-claude-priv
aws s3api put-bucket-versioning --bucket kcmps-design-originals-est-2026 \
  --versioning-configuration Status=Enabled --profile kcmps-claude-priv
aws s3api put-public-access-block --bucket kcmps-design-originals-est-2026 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --profile kcmps-claude-priv
aws s3api put-bucket-encryption --bucket kcmps-design-originals-est-2026 \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
  --profile kcmps-claude-priv
aws s3api put-bucket-lifecycle-configuration --bucket kcmps-design-originals-est-2026 \
  --lifecycle-configuration '{"Rules":[{"ID":"noncurrent-version-glacier-then-expire","Filter":{"Prefix":""},"Status":"Enabled","NoncurrentVersionTransitions":[{"NoncurrentDays":30,"StorageClass":"GLACIER"}],"NoncurrentVersionExpiration":{"NoncurrentDays":30,"NewerNoncurrentVersions":5}}]}' \
  --profile kcmps-claude-priv
aws s3api put-bucket-cors --bucket kcmps-design-originals-est-2026 --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://kcmps.com","https://www.kcmps.com","https://site.kcmps.com","https://dev.kcmps.com","http://localhost:5500","http://localhost:5501"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":300}]}' --profile kcmps-claude-priv
```
Production also needs the equivalent GuardDuty Malware Protection plan (below) and the
`kcmps-guardduty-malware-s3` role's third bucket-scoped inline policy — same commands as
staging's, target bucket swapped. Neither has been run.

**GuardDuty Malware Protection — staging plan created 2026-08-05**, plan id
`32cfe94851fa0764a465`, `ACTIVE`, `ObjectPrefixes: ["designs/"]` (the only prefix this bucket
will ever hold — unlike the payment-uploads bucket's four). Reuses the same
`kcmps-guardduty-malware-s3` IAM role as the payment-uploads plans, via a **third**
bucket-scoped inline policy (`kcmps-guardduty-malware-s3-design-originals-staging-inline`) —
identical shape to the existing `-inline` and `-staging-inline` policies on that role (S3
tagging, EventBridge notification enablement, get/list, and a validation-object put/delete),
just re-pointed at `kcmps-design-originals-staging`. Verify:
```bash
aws guardduty get-malware-protection-plan --malware-protection-plan-id 32cfe94851fa0764a465 --region ap-southeast-1 --profile kcmps-claude-priv
aws iam get-role-policy --role-name kcmps-guardduty-malware-s3 --policy-name kcmps-guardduty-malware-s3-design-originals-staging-inline --profile kcmps-claude-priv
```

**EventBridge wiring — a *separate* rule, not a bucket added to the existing
`kcmps-staging-guardduty-scan-result` rule's filter array**, so each GuardDuty plan's rule can
be retired independently and the Description on each stays specific to one bucket:
`GuardDutyDesignOriginalsScanResultRule` in `backend/infra/backend-lambdas.cfn.yaml`, deployed
2026-08-05 as part of `kcmps-backend-staging`, name
`kcmps-staging-guardduty-design-originals-scan-result`, filtered on
`detail.s3ObjectDetails.bucketName: ["kcmps-design-originals-staging"]` — **do not remove that
filter**, same cross-contamination risk as the existing rule (one EventBridge bus for the
whole account, see the "Staging" section below). Targets the same
`kcmps-staging-handle-scan-result` function as every other upload prefix; that function's
`JobsLambdaRole` inline policy (`jobs-s3-quarantine`) was extended with quarantine
(`DeleteObject`/`DeleteObjectVersion`/`ListBucketVersions`) permissions scoped to
`kcmps-design-originals-staging/designs/*` in the same CloudFormation deploy.
`backend/jobs/handle-scan-result.js` routes `designs/` keys to `markDesignLibraryFile()`,
which annotates the `DESIGN#<id>` record's `scanVerdicts.{original,web}` map when that record
exists (a direct `Get` — the designId is *in* the key, unlike `design-uploads/`'s bare uuid).
It usually does not exist yet: the two files are uploaded in step 1 and the record is written
in step 2, so the scan normally finishes first. That is fine — the standalone `SCAN#<ref>`
verdict item is written unconditionally before routing, and it is what the publish gate
actually reads. **The record annotation is a convenience copy for the dashboard; the `SCAN#`
item is the source of truth.**

Production needs the CloudFormation equivalent applied to the production Lambda stack (still
CLI-managed, not this template) once a production `kcmps-design-originals-est-2026` bucket and
GuardDuty plan exist — not done here.

### Design Asset Library Lambdas — staging only (2026-08-06)

Five functions in `backend/design-library/` + `backend/jobs/purge-archived-designs.js`,
deployed as part of `kcmps-backend-staging` (**not** production — production has neither an
originals bucket nor these routes; see the promotion checklist at the end of this subsection).
The first two are the write path (built first); the next two close the read/patch/promote gap
`publish-design.js`'s header originally flagged; the last is the recycle-bin's hard-delete
sweep:

| Function | Route | Purpose |
|---|---|---|
| `kcmps-staging-design-upload-url` | `POST /designs/upload-url` (JWT) | `get-upload-url.js` — presigned PUT URLs for the source file and the web-ready image, both onto the private originals bucket under `designs/<category>/<designId>/{original,web}.<ext>` |
| `kcmps-staging-publish-design` | `POST /designs` (JWT) | `publish-design.js` — writes the `DESIGN#<id>` META record + an `EVENT#` audit item, then (on publish) copies the web-ready image into the public bucket and regenerates `design-manifest.json` |
| `kcmps-staging-list-designs` | `GET /designs` (JWT) | `list-designs.js` — every `DESIGN#<id>` record including archived ones (an `archived` flag lets the dashboard's recycle-bin tab filter client-side), with a presigned original-file download URL gated on the SAME fail-closed scan check as `get-orders.js`'s attachments — no verdict yet or a bad verdict means no url at all |
| `kcmps-staging-patch-design` | `PATCH /designs/{id}` (JWT) | `patch-design.js` — one handler, four `action`s: `update` (name/description/tags), `archive` (soft delete — status flips to `archived`, `deletedAt` stamped, S3 untouched), `restore` (clears the archive back to whatever status — draft or published — it had before), `publish` (the `draft`→`published` promotion `publish-design.js`'s header called out as missing; reuses that Lambda's exact scan-gate + public-bucket-copy logic rather than a second copy of it). Any action that changes what's published ends with `manifest.js`'s `regenerateManifest()` |
| `kcmps-staging-purge-archived-designs` | none (15-min EventBridge cron) | `backend/jobs/purge-archived-designs.js` — the **only** hard-delete path anywhere in this feature. Designs archived >90 days ago get their DynamoDB `DESIGN#<id>` META item AND both private-bucket S3 objects (original + web) permanently deleted. An `EVENT#` audit record is written in the SAME transaction as the DynamoDB item delete — so even a botched sweep leaves proof of what was destroyed. Does NOT touch the public-bucket copy of an archived design's web image (already dropped from `design-manifest.json` the moment it was archived, so it's unreachable — just not yet reclaimed; a follow-up, not done here) |

`list-designs.js` is gated on `isStaff()` (a read — any staff role, including Finance, can
browse the library), while `patch-design.js` is gated on `requireRole(Production/Sales/Admin)`
— same as the two write Lambdas. Verified live for both gates: a `[Customer]` claim gets 403 on
`PATCH /designs/{id}`; `[Production]` succeeds on update/archive/restore/publish.

New IAM role `kcmps-staging-design-library-lambda-role`, separate from the staff-api role
because these Lambdas hold the **only** grant in the account that moves an object from the
private originals bucket into the public site bucket. That grant is scoped to
`designs/*` on the source and to `PublicAssetsKeyPrefix*` on the destination — it can never
overwrite an arbitrary live-site object. `list-designs.js` reuses this same role purely because
it needs the same-scoped `s3:GetObject` for its presigned original-file downloads, not because
it writes anything. `purge-archived-designs.js` instead reuses `JobsLambdaRole` (same role as
`expire-pending-orders.js`), which picked up two additions for this feature: `dynamodb:DeleteItem`
on the table (the only Lambda in the account that ever hard-deletes a table item) and — already
present from the GuardDuty quarantine grant — `s3:DeleteObject` on the originals bucket's
`designs/*` prefix.

**Live end-to-end verification (2026-08-06, direct Lambda invoke with synthetic JWT claims —
no real Cognito login was available in-session):** listed both of B2's UAT test designs
(confirmed `archived: false`, `scanStatus: "NO_THREATS_FOUND"`, clean presigned download URLs);
patched metadata on one; archived it and confirmed `design-manifest.json`'s count dropped from
2 to 1; restored it and confirmed the count went back to 2; uploaded a brand-new design as a
`draft`, confirmed `PATCH .../publish` correctly gated on GuardDuty's verdict then succeeded
once the scan landed (~13s later — real object, real GuardDuty scan, not simulated), confirmed
the manifest and the public S3 copy both picked it up; archived that same design, backdated its
`deletedAt` via a direct table write, and manually invoked `kcmps-staging-purge-archived-designs`
— confirmed exactly the backdated item purged (its META item gone, an `EVENT#...to":"purged"`
audit record present, both private-bucket S3 objects gone), while a second invoke against the
un-backdated UAT designs did nothing until they were archived+backdated too. Confirmed a
`[Customer]` claim gets 403 on `PATCH /designs/{id}`. All 3 UAT/test designs' `DESIGN#` items,
`EVENT#` audit trails, and public-bucket images were deleted afterward — the table and
`dev-site/assets/designs/` are back to holding only the empty manifest.

Three parameters control where a published design lands, and the split between the last two
is load-bearing rather than redundant:
- `PublicAssetsBucket` — `kcmps-online-bucket-est-2026` in **both** environments (same bucket
  the site is served from; there is no second bucket for dev).
- `PublicAssetsKeyPrefix` — the *bucket key* prefix, `dev-site/assets/designs/` on staging and
  `assets/designs/` in production. This is what keeps a staging publish from touching the live
  site's objects, exactly like the frontend's dev-vs-prod `s3 sync` targets.
- `PublicAssetsPath` — the *site-relative* path the manifest's `image` values are built from,
  `assets/designs/` in **both** environments, because `dev.kcmps.com`'s CloudFront serves the
  `dev-site/` prefix as its site root. Deriving this from `PublicAssetsKeyPrefix` would emit
  `dev-site/assets/...` into the dev manifest and 404 every image.

**Two gotchas found by running it, both of which failed silently-ish:**
1. `CopyObject` copies the source object's tags by default, which requires
   `s3:GetObjectTagging` on the source and `s3:PutObjectTagging` on the destination. Missing
   them surfaces as a bare `AccessDenied` that names nothing about tags. `publish-design.js`
   now sets `TaggingDirective: REPLACE` with an empty `Tagging` (the public copy should not
   carry GuardDuty's internal scan-status tag anyway) **and** the role grants both actions.
2. `scan` is a DynamoDB **reserved word**. `handle-scan-result.js`'s design annotation
   originally wrote to an attribute of that name; the resulting `ValidationException` was
   swallowed by the handler's never-throw catch, so it looked exactly like "the update just
   didn't happen." The attribute is `scanVerdicts`.

**Promotion to production — NOT run, owner-gated.** In order: create the production originals
bucket + GuardDuty plan (commands above), then add to whatever manages production's Lambdas
all **five** functions (`design-upload-url`, `publish-design`, `list-designs`, `patch-design`,
`purge-archived-designs`), the `kcmps-design-library-lambda-role`, the `JobsLambdaRole` additions
(`dynamodb:DeleteItem` + the originals-bucket `s3:DeleteObject` grant `purge-archived-designs`
needs), the `GET /designs`/`PATCH /designs/{id}` routes + integrations + invoke permissions, the
`purge-archived-designs` EventBridge schedule, and set `PublicAssetsKeyPrefix=assets/designs/`.
Note that publishing in production writes to the **live site's** asset prefix, so the first
production publish is a real content change to `kcmps.com` — treat it as one. Also note the
purge cron is a genuine hard-delete path once live in production — rehearse it against a
throwaway record there before trusting the 15-minute schedule unattended.

## Checkout Lambdas — deployed (2026-07-31)

`kcmps-create-order` and `kcmps-submit-payment-proof`, both `nodejs24.x`/`arm64` in
`ap-southeast-1`, built from `backend/checkout/*.js` (see that folder's header comments for
what each does). Neither is reachable from the internet yet — no API Gateway route exists, so
they can only be invoked directly (`aws lambda invoke`) or by whatever wires the storefront to
them next.

**Execution role**: `kcmps-checkout-lambda-role`, least-privilege regardless of what the
deploying profile (`kcmps-claude-priv`) itself can do — an inline policy scoped to:
- `dynamodb:GetItem`/`Query`/`PutItem`/`UpdateItem`/`TransactWriteItems` on the `kcmps` table
  and its indexes only (not `*`)
- `s3:PutObject` on `kcmps-payment-uploads-est-2026/payments/*` only
- `ses:SendEmail` on the `kcmps.com` identity only (unused today — no `FROM_EMAIL` env var is
  set on `kcmps-submit-payment-proof` yet, since SES is still sandboxed; the permission is
  there for when it's turned on, not because it's needed now)
- CloudWatch Logs (`CreateLogGroup`/`CreateLogStream`/`PutLogEvents`)

**Packaging**: each function is a self-contained zip — `index.js` (the handler, `require`
rewritten from `../lib` to `./lib` for the packaged layout), a flattened copy of `backend/lib/`
(minus `lib.test.js`), and its own `node_modules` from a small per-function `package.json`. No
Lambda Layer — not worth the setup for two small functions; revisit if a third checkout Lambda
shows up.

**Smoke test performed, then cleaned up**: invoked `kcmps-create-order` with a synthetic guest
cart, confirmed the `ORDER#`/`LINEITEM#`/`EVENT#` items and `GSI1PK`/`GSI1SK` landed correctly
via a live `dynamodb query`, then invoked `kcmps-submit-payment-proof` against that same order
and confirmed the `payment` sub-object and a working presigned S3 URL. Deleted all 3 test items
afterward (`dynamodb delete-item` × 3) — the table's `ItemCount` is back to what it was before.

Redeploy after a code change (no infra change needed — same role, same env vars):

```bash
cd backend/checkout
# rebuild the zip the same way as the first deploy (see git history / this README's own
# packaging notes above), then:
aws lambda update-function-code \
  --function-name kcmps-create-order \
  --zip-file fileb://create-order.zip \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

**Bump the runtime** (e.g. the next Node.js EOL cycle) is a *different* command —
`update-function-code` never touches `Runtime`, and there's no template that holds the
runtime value (all 17 Lambdas were created by CLI, not CloudFormation):

```bash
aws lambda update-function-configuration \
  --function-name kcmps-create-order \
  --runtime nodejs24.x \
  --region ap-southeast-1 --profile kcmps-claude-priv
aws lambda wait function-updated-v2 --function-name kcmps-create-order \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

Rehearse on the staging stack first (see "Staging" below) — this exact command flipped
all 17 functions from `nodejs20.x` to `nodejs24.x` on 2026-08-05 (the Node.js 20.x EOL
migration), one at a time in blast-radius order, verifying `CodeSha256` was unchanged
and `State: Active` after each before moving to the next. Rollback is the same command
with `--runtime nodejs20.x` — available until AWS blocks function updates on the old
runtime (currently Mar 3 2027 for `nodejs20.x`; check
https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html for current dates).

## Staging — kcmps-foundation-staging / kcmps-backend-staging (2026-08-05)

`dev.kcmps.com` used to be S3-content-only, sharing production's Lambdas/API/table —
there was no way to rehearse a backend change before it went live. Built during the
Node.js 20.x EOL migration as the natural place to prove the new runtime before
flipping production, and now stands as a permanent rehearsal environment for any future
backend change:

- **`kcmps-foundation-staging`** — `backend/infra/foundation.cfn.yaml` reused with
  `TableName=kcmps-staging`, `CreateCognitoGroups=false` (staging reuses
  `kcmps-user-pool-v2`'s existing groups), `EnablePitr=false`. Also created by hand:
  S3 bucket `kcmps-payment-uploads-staging` (versioned, SSE, CORS scoped to
  `dev.kcmps.com`/localhost only, no lifecycle rules — disposable data) and
  `kcmps-lambda-artifacts-staging` (holds the deployment zips CloudFormation reads
  `AWS::Lambda::Function.Code` from).
- **`kcmps-backend-staging`** — `backend/infra/backend-lambdas.cfn.yaml` (new,
  first-ever CloudFormation-managed Lambdas in this repo): all 17 functions, 4 IAM
  roles, log groups, the HTTP API + JWT authorizer + 13 routes + CORS, 3 EventBridge
  rules, the DynamoDB Streams trigger, and a DLQ — same shape as production, built
  entirely from parameters (`EnvName`, `Runtime`, `TableName`, `UploadsBucket`,
  `ArtifactsBucket`/`ArtifactsPrefix`). Deploy/update:
  ```bash
  aws cloudformation deploy \
    --stack-name kcmps-backend-staging \
    --template-file backend/infra/backend-lambdas.cfn.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      TableStreamArn=<kcmps-foundation-staging's TableStreamArn output> \
      ArtifactsPrefix=<S3 key prefix under kcmps-lambda-artifacts-staging holding this build's zips> \
    --region ap-southeast-1 --profile kcmps-claude-priv
  ```
  Reuses `kcmps-user-pool-v2` (same pool prod's authorizer validates against), so a
  real logged-in customer/staff JWT works against staging unmodified.
- **Frontend routing**: `website/store.js`'s `CHECKOUT_API_BASE`,
  `website/orders-data.js`'s `API_BASE`, and `website/dashboard/dashboard-data.js`'s
  `API_BASE` all branch on `location.hostname === "dev.kcmps.com"` to point at
  staging's API instead of production's — a runtime check, not build-time, since
  `website/` has no build step. Every page whose CSP `connect-src` lists the
  production API/uploads-bucket host must list the staging equivalents too.
- **Rehearsal workflow for any future backend change**: rebuild the changed
  function's zip, upload it to `kcmps-lambda-artifacts-staging` under a new prefix,
  `aws cloudformation deploy` the updated `ArtifactsPrefix`, sync `website/` to the
  `dev-site/` prefix, exercise it on `dev.kcmps.com`, *then* repeat the change against
  production. `dev.kcmps.com` is Basic-Auth gated — see `storefront-infra/CLAUDE.md`.
- **Cost**: ~₱3/mo (DynamoDB on-demand against ~300 items, near-zero API Gateway/
  Lambda invocations, log storage) — see `docs/cost-governance.md`'s decision log.
- **GuardDuty Malware Protection is enabled on the staging bucket** (plan
  `b2cfe8b34e713cef6b48`, added 2026-08-05 — see `docs/history.md` entry 69), same 4
  prefixes as production, reusing the `kcmps-guardduty-malware-s3` IAM role via a
  second bucket-scoped inline policy. Skipping it was tried first and turned out to be
  a real dead end, not a cosmetic gap: `get-messages.js`'s "fail closed" read rule means
  an attachment with no scan verdict never gets a download link, so any staging
  attachment test would hang at "Scanning…" forever with no GuardDuty plan watching
  that bucket. Both environments' GuardDuty EventBridge rules
  (`kcmps-guardduty-scan-result` / `kcmps-staging-guardduty-scan-result`) filter on
  `detail.s3ObjectDetails.bucketName` — **do not remove that filter**, the account has
  one EventBridge bus and an unfiltered rule matches scan events from *either* bucket,
  as entry 69 found the hard way (a production upload's scan verdict got duplicated
  into the staging table before the filter existed).
- **A separate design-originals bucket + GuardDuty plan exists for the (not-yet-built)
  Design Asset Library** — `kcmps-design-originals-staging`, plan `32cfe94851fa0764a465`,
  its own EventBridge rule (`kcmps-staging-guardduty-design-originals-scan-result`),
  added 2026-08-05. See the "Design originals bucket" section above for the full
  picture — same fail-closed / single-EventBridge-bus reasoning applies.
- **What staging deliberately doesn't have**: PITR, Cognito `PostConfirmation` wiring
  (would displace production's — that Lambda's trigger is tested via direct/synthetic
  invoke instead), and SES sending (`FROM_EMAIL`/`SES_SENDER` env vars are omitted, so
  staging never emails a real customer).

## API Gateway — deployed (2026-07-31)

`kcmps-checkout-api` — an HTTP API (not REST API, per `backend-infra-to-deploy.md` §4's
cheaper-and-sufficient recommendation), id `6msg2uho6c`, `ap-southeast-1`, base URL
`https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com`.

| Method | Route | Integration |
|---|---|---|
| POST | `/orders` | `kcmps-create-order` (payload format 2.0) |
| POST | `/orders/{orderId}/payment-proof` | `kcmps-submit-payment-proof` (payload format 2.0) |

**No JWT authorizer on either route, deliberately** — both must stay publicly callable since
guest checkout is a hard requirement (see `create-order.js`'s header). Each Lambda does its own
*optional* Bearer-token verification internally; API Gateway here is just the public front
door, not an auth gate. (This is different from the dashboard's staff-only routes in
`backend-infra-to-deploy.md` §4, which *do* need a JWT authorizer once built — don't copy this
API's no-authorizer pattern over there.)

**CORS**: `AllowOrigins` covers the production storefront (`kcmps.com`, `www.kcmps.com`,
`site.kcmps.com`), the dev domain (`dev.kcmps.com`), and two local-dev ports —
`localhost:5500` (the port documented in the main `README.md`/`CLAUDE.md` and registered with
Cognito) and `localhost:5501` (this repo's actual `.claude/launch.json` default, which doesn't
match that documentation — a pre-existing inconsistency, not something this change introduced;
worth reconciling those two docs at some point, but out of scope here). `AllowMethods: [POST,
OPTIONS]`, `AllowHeaders: [content-type, authorization]`.

**Stage**: `$default` with auto-deploy — a route change takes effect immediately, no separate
deploy step.

**Lambda invoke permissions**: each function has a `lambda:AddPermission` grant scoped to this
API's ARN + its specific route path (not a wildcard `*` route), so neither Lambda is invocable
via some other API Gateway that happened to get created later.

**index.html's CSP** `connect-src` includes this API's origin (see the `<head>` comment
pointing back here). If this API is ever torn down and recreated, its id changes — update both
the CSP and `store.js`'s `CHECKOUT_API_URL` together, they're documented as a pair in each
file's own comments.

Recreate the API from scratch if needed (routes/integrations/permissions, in order):

```bash
API_ID=$(aws apigatewayv2 create-api --name kcmps-checkout-api --protocol-type HTTP \
  --cors-configuration '{"AllowOrigins":["https://kcmps.com","https://www.kcmps.com","https://site.kcmps.com","https://dev.kcmps.com","http://localhost:5500","http://localhost:5501"],"AllowMethods":["POST","OPTIONS"],"AllowHeaders":["content-type","authorization"],"MaxAge":300}' \
  --region ap-southeast-1 --profile kcmps-claude-priv --query ApiId --output text)

for FN in kcmps-create-order kcmps-submit-payment-proof; do
  aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "arn:aws:lambda:ap-southeast-1:600929977538:function:$FN" \
    --payload-format-version 2.0 --region ap-southeast-1 --profile kcmps-claude-priv
done
# then create-route + add-permission for each (see git history for the exact route keys/ARNs used)
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

## Staff API Lambdas, Streams, cron, and the JWT authorizer — deployed (2026-07-31)

**Execution roles** (least-privilege, independent of each other and of the checkout role):
- `kcmps-staff-api-lambda-role` (`kcmps-get-orders`, `kcmps-advance-line-item`,
  `kcmps-verify-payment`): `dynamodb:{Get,Put,Update}Item`/`Query`/`Scan`/`TransactWriteItems`
  on the `kcmps` table + GSI1, CloudWatch Logs. **`PutItem` is required alongside
  `TransactWriteItems`** — DynamoDB needs the constituent action permission for each operation
  inside a transaction, not just the transact-level action; this was missed on the first pass
  and surfaced as a live `AccessDeniedException` on the first real `verifyPayment` call (it
  writes an `EVENT#` item via `Put` inside its transaction) — fixed by adding `PutItem` to the
  role.
- `kcmps-jobs-lambda-role` (`kcmps-streams-handler`, `kcmps-expire-pending-orders`): same table
  permissions (including `PutItem`) plus `dynamodb:{DescribeStream,GetRecords,GetShardIterator,
  ListStreams}` scoped to the table's stream ARN, and `ses:SendEmail`/`SendRawEmail` scoped to
  the `kcmps.com` identity (unused today, same "sandboxed SES" reasoning as the checkout role).

**DynamoDB Streams**: an event source mapping on `kcmps-streams-handler` against the
foundation stack's `TableStreamArn` output, `STARTING_POSITION=LATEST`, batch size 10, filter
criteria restricting it to records where `SK` begins with `LINEITEM#` (so it never fires on
`META`/`EVENT#` writes).

**EventBridge cron**: `kcmps-expire-pending-orders-schedule`, `rate(15 minutes)`, targets
`kcmps-expire-pending-orders` with a scoped `lambda:AddPermission` grant (`source-arn` = the
rule's ARN, not a wildcard).

**API Gateway**: added to the *same* `kcmps-checkout-api` (`6msg2uho6c`) rather than a new API
— a Cognito JWT authorizer (`kcmps-cognito-jwt`, `Issuer` = the user pool's issuer URL,
`Audience` = the app client id — originally `95rrk0mflffentqdiomg1fipc` on the retired pool,
now `2rsbhkjooja4h5e0ijpl4siuug` on `kcmps-user-pool-v2`, see "User pool v2" below), and 4 new routes, each with that
authorizer attached (unlike the two 1.1/1.2 routes, which stay authorizer-free for guest
checkout):

| Method | Route | Integration |
|---|---|---|
| GET | `/orders` | `kcmps-get-orders` |
| POST | `/line-items/{lineItemId}/advance` | `kcmps-advance-line-item` |
| POST | `/orders/{orderId}/verify-payment` | `kcmps-verify-payment` |
| POST | `/orders/{orderId}/set-on-hold` | `kcmps-verify-payment` |

CORS `AllowMethods` extended to `[GET, POST, OPTIONS]` (was `[POST, OPTIONS]`). Each Lambda got
its own scoped `lambda:AddPermission` (`source-arn` = this API's ARN + the specific route path).

**The JWT authorizer's claims shape is not what the more commonly-documented behavior
suggests.** A multi-value `cognito:groups` claim arrives at
`event.requestContext.authorizer.jwt.claims["cognito:groups"]` as a bracketed,
**space**-separated string — confirmed live: `"[Staff Admin]"` for two groups, `"[Admin]"` for
one. `backend/lib/auth.js`'s `getGroups()` handles this (strips the brackets, splits on
`/[,\s]+/`); if you're debugging a "staff can't see any orders" report, check this first before
assuming an IAM/role problem.

**Dashboard's own client-side gate is separate, and now matches the backend's role set.**
`dashboard-shell.js`'s `mount()` redirects to `index.html?dashboard=forbidden` unless the
caller's `cognito:groups` includes one of the five staff roles — `Staff`, `Admin`,
`Production`, `Sales`, `Finance` (`COGNITO_CONFIG.dashboardGroupNames`, duplicated in
`website/index.html` where it gates the Dashboard nav link; keep both in sync)
— this is a UI convenience gate, not a security boundary (the Lambdas' own `isStaff()` check is
the real one), but it no longer disagrees with it: the frontend list now mirrors
`backend/lib/auth.js`'s `STAFF_ROLES` exactly (see "Legacy groups" above).

Verified end-to-end with a real, throwaway Cognito test user (created via
`admin-create-user`/`admin-set-user-password`/`admin-add-user-to-group`/`admin-initiate-auth`,
deleted after): a real order fetched, its GCash payment verified (`Pending Payment
Verification → Confirmed`), its line item advanced twice more (`→ Scheduled → In Production`),
and `orderStatus`/GSI1 both confirmed to catch up correctly via the Streams handler a few
seconds later.

Redeploy any of the 5 Lambdas after a code change the same way as the checkout Lambdas
(rebuild the zip — `index.js` + a flattened `lib/` copy + `node_modules` from that folder's own
`package.json` — then `aws lambda update-function-code`); no infra change needed unless the
route/role/permission set itself changes.

## Customer chat + operating-hours SLA — deployed 2026-08-04

Two features landed in this pass; only one needed new infra.

**Operating-hours-aware verification SLA** — no new Lambda, no new route. `verify-payment.js`
(existing, `kcmps-verify-payment`) now reads an optional `CONFIG#OPERATING_HOURS`/`META` item
(falls back to a hardcoded default if it doesn't exist — no item needs to be created for this to
work) — covered by the staff-api role's existing `GetItem` grant, no role change needed.
Redeployed via the usual code-only `update-function-code` path.

**Customer chat via order threads** — two new staff-api Lambdas + one new jobs Lambda, all
built against the SAME execution roles/table/API described above (no new role needed):

| Method | Route | Integration |
|---|---|---|
| GET | `/orders/{orderId}/messages` | `kcmps-get-messages` |
| POST | `/orders/{orderId}/messages` | `kcmps-send-message` |
| GET | `/messages/unread` | `kcmps-get-unread-messages` (added 2026-08-04, unread-badge follow-up — see below) |

All three routes have the `kcmps-cognito-jwt` authorizer attached, same as the other staff-api
routes above (chat requires a logged-in account — no guest posting). Each Lambda has its own
scoped `lambda:AddPermission` for this API's ARN + route path. `kcmps-staff-api-lambda-role`'s
existing `dynamodb:{Get,Put,Update,Scan}Item`/`Query` grant on the `kcmps` table already covered
all three (`MSG#` items are new SK values on an existing PK, not a new table/index; `get-orders.js`
already used `Scan` on this same role, so `get-unread-messages.js`'s Scan needed no new grant
either) — no role change needed for any of the three.

Cron: `kcmps-notify-unread-messages-schedule`, `rate(30 minutes)`, targets
`kcmps-notify-unread-messages` (from `backend/jobs/notify-unread-messages.js`) — same scoped
`lambda:AddPermission` pattern as `kcmps-expire-pending-orders-schedule`, plus the same
`MaximumRetryAttempts: 2` + DLQ-on-failure async invoke config as `expire-pending-orders`.
Currently dark — `SES_SENDER` is unset, so it scans and logs but sends zero real customer email
until that env var is set. Added to `kcmps-jobs-lambda-role` (already had `ses:SendEmail`/
`SendRawEmail` scoped to the `kcmps.com` identity + config-set — no new SES grant needed).

**One real gap found during deploy, fixed with explicit approval**: `kcmps-jobs-lambda-role` had
never needed `dynamodb:Scan` before (`expire-pending-orders.js` only ever queries GSI1) —
`notify-unread-messages.js` is the first jobs Lambda to need it (no unread-message index exists
yet, same bounded-Scan tradeoff as `get-orders.js`'s own `CLIENT#`-filtered scan). Added `Scan` to
the `kcmps-jobs-inline` policy's existing `TableReadWrite` statement, same resource scope
(`kcmps` table + indexes) it already covered — nothing broader.

Every new Lambda got its own CloudWatch log group created with `--retention-in-days 30` at
creation time (see `backend/CLAUDE.md`'s cost convention).

**Unread-message sidebar badge (2026-08-04 follow-up)** — `get-unread-messages.js` (table
above) backs `website/dashboard/dashboard-shell.js`'s `refreshUnreadBadge()`, called from every
dashboard page's `mount()`. No new infra beyond the route itself — reuses
`kcmps-staff-api-lambda-role` as noted above.

## Message + correspondence attachments — deployed 2026-08-04

One new Lambda, one new route, and an IAM policy update — everything else reuses existing
infra (same bucket as GCash proof uploads, same `kcmps-staff-api-lambda-role`).

| Method | Route | Integration |
|---|---|---|
| POST | `/orders/{orderId}/correspondence` | `kcmps-add-correspondence` (new) |

`kcmps-add-correspondence` is a new Lambda on `kcmps-staff-api-lambda-role` (nodejs24.x, arm64,
256MB/10s, same shape as its siblings), env vars `TABLE_NAME`/`UPLOADS_BUCKET`
(`kcmps-payment-uploads-est-2026` — same bucket `submit-payment-proof.js` already uses). JWT
authorizer attached, scoped `lambda:AddPermission`, 30-day log retention set at creation.

`kcmps-send-message` also got `UPLOADS_BUCKET` added to its environment (needed it for the
first time — it now presigns PUT urls for message attachments the same way
`add-correspondence.js`/`submit-payment-proof.js` do); `kcmps-get-orders`, `kcmps-send-message`,
`kcmps-get-messages` were all redeployed (code-only, `update-function-code`) for the attachment
read/write logic.

**IAM**: `kcmps-staff-api-lambda-role`'s `kcmps-staff-api-s3-read` inline policy (previously
just `GetObject` on `payments/*`, for the GCash screenshot preview) got two new statements —
`PutObject`+`GetObject` on `kcmps-payment-uploads-est-2026/correspondence/*` and
`.../messages/*`. No CORS change needed: the bucket's existing PUT CORS rule (see "Payment
uploads bucket" above) applies bucket-wide, not scoped by prefix.

Attachments are validated server-side against an allow-list (`image/jpeg|png|webp|gif`,
`application/pdf`, max 5 per note/message) and use the same two-step presigned-upload pattern
as `submit-payment-proof.js`: the Lambda hands back a PUT url per file, the browser uploads
directly to S3, the Lambda never sees file bytes. `get-orders.js`/`get-messages.js` presign a
short-lived GET url per attachment on every read (bucket is private) — see `docs/roadmap.md`'s
2026-08-04 entry for the full design and why `add-correspondence.js` also fixed a pre-existing
bug (the "Log" button previously wrote to a `localStorage` mock that real orders were never in).

`website/dashboard/job-detail.html`'s CSP `connect-src` needed the S3 bucket origin added —
it never uploaded anything directly to S3 before (GCash proof upload is customer-side, in
`store.js`), so this was a real gap caught during testing, not a copy-paste of
`order-detail.html`'s CSP (which already had it).

## Customer design-file uploads + malware scanning — deployed 2026-08-04

Lets a customer attach their actual artwork/print file at checkout instead of pasting a Drive
link (the link textarea stays — see `backend/checkout/upload-design-file.js`'s header). Same
presign → direct-browser-PUT pattern as `submit-payment-proof.js`; no file bytes ever reach a
Lambda.

| Method | Route | Integration | Auth |
|---|---|---|---|
| POST | `/design-uploads` | `kcmps-upload-design-file` (new) | **None** — guest checkout, same as `POST /orders` |

New Lambda `kcmps-upload-design-file` on the existing `kcmps-checkout-lambda-role` (nodejs24.x,
arm64, 256MB/10s), env `UPLOADS_BUCKET=kcmps-payment-uploads-est-2026`, 30-day log retention set
at creation. Route throttled to **10 req/s burst 20**, matching `POST /orders` — it is an
unauthenticated write primitive, so it does not get the default (unlimited) setting.
`kcmps-create-order` and `kcmps-get-orders` were redeployed for the `designFiles` field, and
`create-order` gained `UPLOADS_BUCKET` (used *only* to validate the shape of refs the client
sends back — it never touches S3).

**S3 layout**: new `design-uploads/` prefix on the existing uploads bucket — no new bucket. Keys
are always `design-uploads/<uuid>.<validated-ext>`; the customer's filename is never part of the
key. The bucket's pre-existing bucket-wide PUT CORS rule already covers this prefix, so no CORS
change was needed.

**IAM**, both least-privilege and prefix-scoped:
- `kcmps-checkout-lambda-role` += `s3:PutObject` on `design-uploads/*` (presigning a PUT requires
  the signer to actually hold the permission).
- `kcmps-staff-api-lambda-role` += `s3:GetObject` **and `s3:GetObjectTagging`** on
  `design-uploads/*` — the tagging read is what the scan gate in `get-orders.js` depends on.
  Deliberately no `PutObject`: staff never write into the customer-upload prefix.

**GuardDuty Malware Protection for S3** (plan `7acfe6ba55d9edc67956`, `ACTIVE`) scans every
object written under `design-uploads/` and tags it `GuardDutyMalwareScanStatus`. Scoped to that
one prefix so GCash screenshots aren't rescanned. Assumes a dedicated role,
`kcmps-guardduty-malware-s3`.

Two non-obvious things about that role, both found the hard way — the plan sits at
`Status: WARNING` rather than failing loudly, so check `get-malware-protection-plan` after any
change to it:
1. It needs `s3:PutObject`/`s3:DeleteObject` for a validation probe object, and that object goes
   at the **bucket root** (`malware-protection-resource-validation-object`), *not* under the
   scanned prefix. Granting only the prefix leaves the plan stuck in `WARNING` with
   `INSUFFICIENT_TEST_OBJECT_PERMISSIONS`.
2. IAM propagation lags — creating the role and immediately creating the plan fails validation.
   Re-running `update-malware-protection-plan` after ~20s is what flips it to `ACTIVE`.

Cost (~US$1.30/mo at the current estimate, ~15% of the ₱500/mo cap) is logged in
[docs/cost-governance.md](../../docs/cost-governance.md) — the one genuinely recurring add in
this pass. A lifecycle rule aborts incomplete multipart uploads under the prefix after 7 days.

**Verified live end-to-end** (all test data removed afterward — bucket prefix and table both
back to empty): spoofed `application/pdf` on `payload.exe` rejected 400, SVG/ZIP/HTML rejected,
double-extension and traversal-shaped filenames rejected, 60MB rejected; a clean PDF scanned
`NO_THREATS_FOUND` and came back with a presigned GET carrying
`Content-Disposition: attachment` + `Content-Type: application/octet-stream`; an EICAR test file
scanned `THREATS_FOUND` and `get-orders.js` returned it with **`url: null`**, so the dashboard
has nothing to click. Unauthenticated direct GET on an upload returns 403.

## Malware quarantine across all upload prefixes — deployed 2026-08-05

Extends the 2026-08-04 design-file scanning to **every** upload path, and adds automatic
destruction of infected objects.

**GuardDuty plan `7acfe6ba55d9edc67956`** now covers four prefixes on
`kcmps-payment-uploads-est-2026`: `design-uploads/`, `payments/`, `messages/`,
`correspondence/`. Widened with `update-malware-protection-plan`; status re-checked `ACTIVE`.

**New Lambda `kcmps-handle-scan-result`** (`backend/jobs/handle-scan-result.js`) on the existing
`kcmps-jobs-lambda-role`, nodejs24.x/arm64/256MB/**60s**, `TABLE_NAME=kcmps`, 30-day log
retention. Triggered by EventBridge rule `kcmps-guardduty-scan-result`
(`source: aws.guardduty`, detail-type `GuardDuty Malware Protection Object Scan Result`) with a
scoped `lambda:AddPermission`.

**IAM** — new inline policy `kcmps-jobs-s3-quarantine` on `kcmps-jobs-lambda-role`:
`s3:DeleteObject` + **`s3:DeleteObjectVersion`** on all four prefixes, and `s3:ListBucketVersions`
on the bucket (a bucket-level action, so it cannot be prefix-scoped in the ARN). No `GetObject` —
the quarantine Lambda never needs to read file contents, only delete them.

**Why version-aware deletion matters**: the bucket has versioning enabled, so a plain
`DeleteObject` only writes a delete marker and leaves the malicious bytes retrievable by
versionId until the 90-day `NoncurrentVersionExpiration` rule collects them. The Lambda does
`ListObjectVersions` + `DeleteObjects` with explicit VersionIds instead. Confirmed live: objects
deleted by the Lambda leave **zero** Versions and **zero** DeleteMarkers, whereas the same file
removed with `aws s3 rm` leaves both.

**Read-path change**: `get-orders.js` and `get-messages.js` no longer call `GetObjectTagging` per
attachment (that was an S3 round trip per attachment per order on every staff list load). The
scan verdict is persisted onto the record by the Lambda — for clean files as well as infected
ones — and read from DynamoDB. An attachment with no persisted verdict is `PENDING` and stays
undownloadable, so a scan result that never arrives can never become a download link.

Both read paths now also force `Content-Disposition: attachment` +
`Content-Type: application/octet-stream` on every presigned GET. The only exception is the GCash
screenshot, which staff must view inline to verify a payment — it keeps an inline URL but is
subject to the same scan gate.

**Verified live end-to-end** (all test data purged afterward; bucket back to its pre-test
object count): an EICAR file uploaded via `design-uploads/` and another via `messages/` were both
scanned `THREATS_FOUND`, had **every version purged from S3**, and left a DynamoDB record
carrying filename, size, timestamp, the raw signature (`EICAR-Test-File (not a virus)`) and a
plain-English description — while `get-orders.js` returned them with `url: null`. A clean PDF
uploaded alongside scanned `NO_THREATS_FOUND` and came back downloadable.

## `auth/` — Cognito PostConfirmation trigger (deployed 2026-08-03)

**FLAG (2026-08-05 pool-sweep):** this section predates the pool v2 cutover and still cites
the retired pool's ARN/ID below. The 2026-08-05 infra audit (`docs/infra-audit-2026-08-05.md`)
only checked the two API JWT authorizers and `create-order`/`cancel-order`'s env vars — it did
**not** verify whether `kcmps-post-confirmation-lambda-role`'s IAM policy and the Lambda's
`cognito-idp` invoke permission were re-scoped to `ap-southeast-1_LHJsFdCgo` during the cutover.
If PostConfirmation is still wired to the deleted pool, new self-signups would silently stop
getting added to the `Customer` group (the handler is designed to never throw, so this would
fail silent — see `docs/history.md` entry 62). Needs an AWS-side check before this doc's IDs
below are edited to match.

`kcmps-post-confirmation`, `nodejs24.x`/`arm64`, `ap-southeast-1`, built from
`backend/auth/post-confirmation.js`. Auto-adds every self-signup to the `Customer` Cognito
group — see `docs/history.md` entry 62 for the full trigger, including why the handler
deliberately never throws.

**Execution role**: `kcmps-post-confirmation-lambda-role`, scoped to exactly
`cognito-idp:AdminAddUserToGroup` on the one user pool ARN
(`arn:aws:cognito-idp:ap-southeast-1:600929977538:userpool/ap-southeast-1_iDvAEumNp`), plus
CloudWatch Logs on this function's own log group only.

**Packaging**: same pattern as every other Lambda here — `index.js` (require rewritten from
`../lib` to `./lib`), a flattened copy of `backend/lib/` (minus `lib.test.js`), and
`node_modules` from `backend/auth/package.json`.

**Wiring is different from every other Lambda in this repo**: not an API Gateway route, not an
event source mapping — a Cognito User Pool `LambdaConfig` entry. `lambda:AddPermission` grants
`cognito-idp.amazonaws.com` invoke rights, `source-arn` scoped to the user pool ARN:

```bash
aws lambda add-permission \
  --function-name kcmps-post-confirmation \
  --statement-id kcmps-cognito-post-confirmation \
  --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com \
  --source-arn arn:aws:cognito-idp:ap-southeast-1:600929977538:userpool/ap-southeast-1_iDvAEumNp \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

Then the trigger itself, via `update-user-pool`. **This call is not a partial patch** — treat
it like it might reset any field you don't explicitly pass back. Build the payload from a
fresh `describe-user-pool` rather than hand-writing just the changed field:

```bash
aws cognito-idp describe-user-pool --user-pool-id ap-southeast-1_iDvAEumNp \
  --region ap-southeast-1 --profile kcmps-claude-priv --output json > pool.json
# then construct an update payload carrying every mutable field from pool.json's UserPool
# (Policies, DeletionProtection, AutoVerifiedAttributes, VerificationMessageTemplate,
# UserAttributeUpdateSettings, MfaConfiguration, DeviceConfiguration, EmailConfiguration,
# UserPoolTags, AdminCreateUserConfig, AccountRecoverySetting) forward unchanged, merging in
# only LambdaConfig.PostConfirmation = the function's ARN
aws cognito-idp update-user-pool --cli-input-json file://update-user-pool.json \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

Verify nothing else moved with a before/after `describe-user-pool` diff — entry 62's deploy
confirmed exactly one field changed (`LambdaConfig`).

**Verified**: direct `aws lambda invoke` against a real (admin-created) throwaway Cognito user
with a synthetic `PostConfirmation_ConfirmSignUp` event — `admin-list-groups-for-user` showed
`[]` before, `["Customer"]` after; test user deleted afterward. A genuine self-signup
end-to-end test (via the public `sign-up` API) is still owed — see entry 62's verification
notes for why it wasn't completed in that pass.

Redeploy after a code change (no infra change needed):
```bash
cd backend/auth
# rebuild the zip the same way as the first deploy (index.js + flattened lib/ + node_modules)
aws lambda update-function-code \
  --function-name kcmps-post-confirmation \
  --zip-file fileb://post-confirmation.zip \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

## Observability — Milestone 1.5 (deployed 2026-08-02)

Closes the backend audit's R4/R6/R7 findings: zero alerting, no retry/DLQ policy on the async
Lambdas, no API throttling. New resources are one CloudFormation stack; updates to
resources this repo had already created via plain CLI (the ESM, the API stage, the cron's async
invoke config) stay CLI, matching how the rest of `backend/infra/` is split.

**Stack**: `kcmps-observability`, template
[`observability.cfn.yaml`](observability.cfn.yaml), `ap-southeast-1`. Creates:
- `kcmps-ops-alerts` — SNS topic, one email subscription (`admin@kcmps.com` by default,
  override with `--parameter-overrides AlertEmail=...`). **Subscription status is `Confirmed`
  (as of 2026-08-05).** Historical note: subscriptions initially sit in `PendingConfirmation`
  until someone clicks the link in the confirmation email AWS sends on creation — alarms fire
  silently until confirmed. Check status:
  ```bash
  aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:ap-southeast-1:600929977538:kcmps-ops-alerts --profile kcmps-claude-priv
  ```
- `kcmps-lambda-dlq` — a shared SQS standard queue, the `OnFailure` destination for both
  async-invoked backend Lambdas (see below).
- **37 CloudWatch alarms**, all with `AlarmActions` pointed at the SNS topic:
  - `Errors >= 1`/5min and `Throttles >= 1`/5min on each of the **17 deployed Lambdas**
    (`kcmps-create-order`, `kcmps-submit-payment-proof`, `kcmps-lookup-order`,
    `kcmps-cancel-order`, `kcmps-get-orders`, `kcmps-add-correspondence`, `kcmps-send-message`,
    `kcmps-get-messages`, `kcmps-get-unread-messages`, `kcmps-advance-line-item`,
    `kcmps-verify-payment`, `kcmps-streams-handler`, `kcmps-expire-pending-orders`,
    `kcmps-notify-unread-messages`, plus 3 auth Lambdas `kcmps-post-confirmation` and others) = 34 alarms
  - `kcmps-streams-handler`'s `IteratorAge > 5min` (it's the only place `orderStatus` is
    recomputed — a stall here goes stale silently otherwise) = 1 alarm
  - DLQ's `ApproximateNumberOfMessagesVisible > 0` = 1 alarm
  - `kcmps-checkout-api`'s `5XXError >= 1`/5min = 1 alarm

Deploy/redeploy (idempotent):
```bash
aws cloudformation deploy \
  --template-file backend/infra/observability.cfn.yaml \
  --stack-name kcmps-observability --region ap-southeast-1 \
  --parameter-overrides AlertEmail=admin@kcmps.com \
  --no-fail-on-empty-changeset --profile kcmps-claude-priv
```

**Streams event source mapping** (`37b3956c-187a-4bd1-9a06-16cf30c5cf17`, on
`kcmps-streams-handler`) — was `MaximumRetryAttempts: -1` (retry until the record ages out of
the stream, ~24h, with no bisecting and no failure destination) since 1.3. Updated in place
(same mapping, not recreated — recreating would briefly stop stream processing):
```bash
aws lambda update-event-source-mapping \
  --uuid 37b3956c-187a-4bd1-9a06-16cf30c5cf17 \
  --maximum-retry-attempts 3 --bisect-batch-on-function-error \
  --destination-config '{"OnFailure":{"Destination":"arn:aws:sqs:ap-southeast-1:600929977538:kcmps-lambda-dlq"}}' \
  --region ap-southeast-1 --profile kcmps-claude-priv
```
Bisecting isolates one bad record in a batch of 10 instead of retrying/blocking the whole
batch. Requires `sqs:SendMessage` on the DLQ ARN, granted to `kcmps-jobs-lambda-role` (shared
with `kcmps-expire-pending-orders`) via an inline policy — `kcmps-jobs-dlq-write`:
```bash
aws iam put-role-policy --role-name kcmps-jobs-lambda-role \
  --policy-name kcmps-jobs-dlq-write --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"arn:aws:sqs:ap-southeast-1:600929977538:kcmps-lambda-dlq"}]}' \
  --profile kcmps-claude-priv
```
(Note: this permission needs a few seconds to propagate before `update-event-source-mapping`
will accept the DLQ destination — a fresh `put-role-policy` followed immediately by the ESM
update can 400 with `InvalidParameterValueException`; retry after ~10s if so.)

**`kcmps-expire-pending-orders`'s async invoke config** — EventBridge invokes this Lambda
asynchronously; it had no `EventInvokeConfig` at all before this pass (`aws lambda
get-function-event-invoke-config` 404'd), meaning Lambda's bare default (2 retries, invocation
dropped after that, no DLQ) applied. Now explicit, same DLQ as the Streams handler:
```bash
aws lambda put-function-event-invoke-config \
  --function-name kcmps-expire-pending-orders --maximum-retry-attempts 2 \
  --destination-config '{"OnFailure":{"Destination":"arn:aws:sqs:ap-southeast-1:600929977538:kcmps-lambda-dlq"}}' \
  --region ap-southeast-1 --profile kcmps-claude-priv
```

**API throttling** — `kcmps-checkout-api`'s `$default` stage had no `RouteSettings` at all
(both public checkout routes wide open to whatever volume hit them). Added per-route limits to
just the two unauthenticated routes (10 req/s steady-state, burst 20 — generous headroom over
realistic legitimate checkout volume for a 4-person shop, sized as a starting point, not tuned
against real traffic):
```bash
aws apigatewayv2 update-stage --api-id 6msg2uho6c --stage-name '$default' \
  --route-settings '{"POST /orders":{"ThrottlingRateLimit":10,"ThrottlingBurstLimit":20},"POST /orders/{orderId}/payment-proof":{"ThrottlingRateLimit":10,"ThrottlingBurstLimit":20}}' \
  --region ap-southeast-1 --profile kcmps-claude-priv
```
This is a blunt, account-wide cap — HTTP APIs have no per-IP throttling without WAF in front, so
it protects against a volume spike/bot burst, not per-caller abuse. Revisit if real abuse is
ever observed (add WAF then, not before — same "don't build ahead of the trigger" rule as the
rest of this repo).

## Guest order lookup + self-cancel Lambdas — deployed (2026-08-02)

`kcmps-lookup-order` and `kcmps-cancel-order` (My Orders plan Phase 3), `backend/checkout/
lookup-order.js` / `cancel-order.js`, added to the *same* `kcmps-checkout-api` (`6msg2uho6c`).
Both reuse **`kcmps-checkout-lambda-role`** unchanged — it already had exactly the DynamoDB
permissions (`GetItem`/`Query`/`PutItem`/`UpdateItem`/`TransactWriteItems`) either function
needs, so no new IAM role.

| Method | Route | Integration | Authorizer |
|---|---|---|---|
| POST | `/orders/lookup` | `kcmps-lookup-order` | none — `contactsMatch()` is the real auth boundary |
| POST | `/orders/{orderId}/cancel` | `kcmps-cancel-order` | none — JWT sub-match, or `contactsMatch()` fallback for guests |

Both deliberately **no authorizer**, same reasoning as the 1.1/1.2 routes: guest checkout means
there's no reliable Cognito session to require. `lookup-order.js`'s and `cancel-order.js`'s own
headers explain the two-tier authorization each does internally.

**Route-level throttling** (tighter than the other two no-authorizer routes, since these two are
specifically enumeration-risk — a wrong guess reveals nothing, but repeated guessing should be
slow):
```bash
aws apigatewayv2 update-stage --api-id 6msg2uho6c --stage-name '$default' --route-settings '{
  "POST /orders/lookup": {"ThrottlingBurstLimit": 10, "ThrottlingRateLimit": 5.0},
  "POST /orders/{orderId}/cancel": {"ThrottlingBurstLimit": 10, "ThrottlingRateLimit": 5.0}
}' --region ap-southeast-1 --profile kcmps-claude-priv
```
(That call replaces the whole `RouteSettings` map on the stage — it's an overwrite, not a
merge, so any re-run must include the FULL current map or it silently drops entries. As of
2026-08-05 the live `$default` stage has five throttled routes:
```
"POST /orders":                        {"ThrottlingBurstLimit": 20, "ThrottlingRateLimit": 10.0}
"POST /orders/{orderId}/payment-proof": {"ThrottlingBurstLimit": 20, "ThrottlingRateLimit": 10.0}
"POST /design-uploads":                 {"ThrottlingBurstLimit": 20, "ThrottlingRateLimit": 10.0}
"POST /orders/lookup":                  {"ThrottlingBurstLimit": 10, "ThrottlingRateLimit": 5.0}
"POST /orders/{orderId}/cancel":        {"ThrottlingBurstLimit": 10, "ThrottlingRateLimit": 5.0}
```
Verify with `aws apigatewayv2 get-stage --api-id 6msg2uho6c --stage-name '$default'` before any
`update-stage` call and copy the current map forward, rather than trusting this snapshot to stay
current.)

**Env vars**: `TABLE_NAME=kcmps` on both; `cancel-order.js` also needs `COGNITO_USER_POOL_ID`/
`COGNITO_CLIENT_ID` (same values as `kcmps-create-order`) for its optional JWT verification.

Recreate from scratch (after the Lambdas themselves exist):
```bash
for FN in kcmps-lookup-order kcmps-cancel-order; do
  INTEG=$(aws apigatewayv2 create-integration --api-id 6msg2uho6c --integration-type AWS_PROXY \
    --integration-uri "arn:aws:lambda:ap-southeast-1:600929977538:function:$FN" \
    --payload-format-version 2.0 --integration-method POST \
    --region ap-southeast-1 --profile kcmps-claude-priv --query IntegrationId --output text)
  echo "$FN -> $INTEG"
done
# then create-route (POST /orders/lookup, POST /orders/{orderId}/cancel) + a scoped
# lambda:AddPermission for each, same pattern as every other route in this file.
```

Verified live through the real public HTTPS endpoint (not just direct `lambda invoke`): a real
order created, looked up with the correct contact (200, redacted shape) and an incorrect one
(404, byte-identical to a lookup against a nonexistent order ID), cancelled while pre-production
(200, line item → `Cancelled`, `GSI1PK` removed) and rejected once advanced past `Confirmed`
(409). Throwaway orders deleted afterward, same convention as the smoke tests above.

## SES customer notifications — wired 2026-08-03/04

6 touchpoints across 5 Lambdas send a customer email, all best-effort (a send failure never
fails the underlying staff/customer action — caught and logged, not rethrown) and all `Bcc:
admin@kcmps.com` so the shared shop inbox always has a copy, which is also what makes the
"Order↔email linking" correspondence card's system-generated entries meaningful (see root
`CLAUDE.md`).

| Touchpoint | Lambda | Env var (name inconsistent across files — don't assume) |
|---|---|---|
| Order placed | `create-order.js` | `FROM_EMAIL` |
| Order received / pending verification | `submit-payment-proof.js` | `FROM_EMAIL` |
| Payment confirmed | `verify-payment.js` | `FROM_EMAIL` |
| Payment on hold | `verify-payment.js` | `FROM_EMAIL` |
| Shipped out (`Dispatched`), Ready for pickup (`Ready for Pickup`) | `advance-line-item.js` | `FROM_EMAIL` |
| Auto-cancelled (verification expired), Quote expired | `expire-pending-orders.js` | `SES_SENDER` |

`advance-line-item.js` only emails on those 2 transitions — every other transition it handles
(Scheduled, In Production, QC, Ready for Dispatch, Rework, and the terminal Delivered/Picked Up)
stays silent by design; the customer tracks those via the self-serve order-status progress
page, not a push per stage.

**`Ready for Dispatch` was a 3rd touchpoint here until 2026-08-04** ("Ready to ship out" — passed
QC, staged for courier pickup) — pulled after live testing surfaced it as the wrong moment to
push: it fires the instant QC passes, before the item is actually with a courier, so the
customer can't act on it either way, and the copy leaked an internal QA term ("passed quality
check") into customer-facing email. `Dispatched` ("shipped out, on its way") is the transition
actually meaningful to a delivery customer, so that one stays a push. `Ready for Dispatch` now
only appends an internal `correspondenceLog` note (`actorName: "System"`, not `"System
(auto-email)"` — the tell that nothing was actually emailed) via a separate
`INTERNAL_ONLY_NOTE` map in `advance-line-item.js`, distinct from `SHIP_STAGE_EMAIL` above.

Each send is followed by a best-effort `UpdateItem` appending a `{ at, note, actorName: "System
(auto-email)" }` entry to the order's `correspondenceLog` (`list_append`, no
`if_not_exists` needed — every order gets `correspondenceLog: []` at creation) — a log-write
failure is caught and logged separately from the email send itself, so it can never look like
the notification failed when it actually sent.

**IAM — discovered the hard way, don't re-break this:** `kcmps.com`'s SES identity has a
default configuration set (`my-first-configuration-set`, a leftover from the SES console setup
wizard) attached. Because of that, IAM checks resource-level permissions against **both** the
identity ARN and the configuration-set ARN on every send — granting `ses:SendEmail` scoped only
to `identity/kcmps.com` produces a live `AccessDeniedException` on `configuration-set/my-first-
configuration-set`, not the identity. Every role that sends SES mail needs both resources in
its `Resource` list:
- `kcmps-checkout-lambda-role` (`create-order`, `submit-payment-proof`) — had identity-only,
  fixed to include both.
- `kcmps-staff-api-lambda-role` (`verify-payment`, `advance-line-item`) — had **no** SES
  permission at all before this, added fresh with both resources.
- `kcmps-jobs-lambda-role` (`expire-pending-orders`) — had identity-only, fixed to include both.

**SES account status (checked live, not assumed):** `ProductionAccessEnabled: true` — out of
sandbox already, 50,000/day quota. `kcmps.com` domain identity DKIM `Status: SUCCESS`, MAIL FROM
subdomain `mail.kcmps.com` SPF `Status: SUCCESS`. CloudWatch `AWS/SES` `Delivery` metric confirms
real 250-OK handoffs to recipient mail servers with zero `Bounce`/`Complaint`/`Reject` — verified
via a real cross-provider send (a non-Gmail address received the email correctly). Gmail
specifically not receiving these currently: not a bug on this side — a brand-new sending domain
with no history gets filtered/discarded by Gmail's reputation heuristics regardless of correct
SPF/DKIM/DMARC, and should resolve as the domain sends more real mail and builds reputation.

## User pool v2 — minimal required attributes (cut over 2026-08-05)

`user-pool-v2.cfn.yaml`, stack **`kcmps-user-pool-v2`**. Replaces the original pool
(`ap-southeast-1_iDvAEumNp`) — which is now unused but deliberately left standing.

| | Old pool | New pool |
|---|---|---|
| Pool ID | `ap-southeast-1_iDvAEumNp` | `ap-southeast-1_LHJsFdCgo` |
| Client ID | `95rrk0mflffentqdiomg1fipc` | `2rsbhkjooja4h5e0ijpl4siuug` |
| Hosted UI domain | `ap-southeast-1idvaeumnp.auth…` | `kcmps-auth.auth…` |
| Required attrs | email, given_name, family_name, **middle_name**, **name**, **preferred_username** | email, given_name, family_name |

### Why a whole new pool

A pool's schema `Required` flags are **immutable after creation** — no `update-user-pool`
field, no console toggle (the console's "Required attributes" screen is read-only and says so:
*"When you **create** a user pool, you can choose…"*). The original pool demanded three
attributes this app never reads, which is the entire reason entry 63's custom sign-up form
exists — it filled `middle_name`/`preferred_username` with `"-"` placeholders so a shopper
would never be asked to type them.

Entry 63 chose the custom form over a migration because a migration "needs migrating the 5
existing users including a federated Google identity." By 2026-08-05 the pool held 6 users,
**all of them staff or test accounts and zero real customers**, so that cost had evaporated.

### The trap that made this urgent to get right: `sub` is your customer foreign key

`sub` is pool-scoped. A new pool mints new ones and **no** migration technique preserves them
(a `UserMigration` trigger does not — common misconception). The backend keys customer data on
it: `get-orders.js`'s `getOrdersForSub(claims.sub)`, `send-message.js`/`get-messages.js`'s
`claims.sub !== order.customerSub` ownership check, `get-unread-messages.js`'s
`customerThreads(claims.sub)`. Post-cutover the same human gets a new `sub`, so their order
history returns empty and their own message threads 403.

This was resolved by **clearing the table** (291 items — 29 orders, 176 events, 32 line items,
17 messages, 29 idempotency records, 8 scan verdicts; no `CONFIG#` items existed) rather than
writing a `customerSub` remap, because every order was test data. **If this ever needs doing
again with real orders, the remap is mandatory** — rewrite `customerSub` on each
`ORDER#…/META` matched by `customerEmail`. Staff `sub`s need no remap: they appear only in
`actorSub` audit fields, which are historical records, not lookups.

### Deliberate differences from the old pool

- **`AliasAttributes: [email]`** — kept, not changed. A real Username *plus* email as a
  sign-in alias, so users log in with **either**. This was briefly built as
  `UsernameAttributes: [email]` (email *is* the username, no username sign-in at all); since
  it is create-only, fixing it cost a full pool rebuild. Don't repeat that.
- **Customers now choose their own username.** `generateUsername()` is gone from
  `index.html`; the form has a Username field validated by `USERNAME_RE`. The "@" rejection is
  client-side because Cognito rejects an email-shaped Username with an opaque
  `InvalidParameterException` when aliases are on.
- **`AWS::Cognito::ManagedLoginBranding` is REQUIRED, not cosmetic.** A managed-login (v2)
  domain serves *"Login pages unavailable — please contact an administrator"* for any app
  client with no branding style. The first deploy omitted it and the entire Hosted UI was dead.
- Dropped the `phone` OAuth scope and the `verified_phone_number` recovery mechanism (no phone
  attribute to consent to or recover against).
- Added `http://localhost:5501` callback/logout URLs — this repo's `.claude/launch.json` uses
  5501, which the old client never allowed, so local OAuth had always been broken.

### Why the Hosted UI sign-up link is no longer a problem

The original task here was to *hide* Cognito's "New user? Create an account" link, so shoppers
couldn't reach the 6-attribute Hosted UI signup page. **That is not achievable on this pool
and never was:**

- The domain is **Managed Login v2** (`ManagedLoginVersion: 2`), whose branding is a fixed
  schema of 168 style tokens — colors, radii, logos. Its only visibility toggles are page
  header, page footer, form instructions, language selector, background images and IdP button
  icons. There is **no** sign-up-link control, and no arbitrary CSS. `categories.signUp` holds
  only `acceptanceElements` (terms checkboxes). `componentClasses.link` sets colour globally,
  so dimming it would also hide "Forgot your password?".
- Classic branding's `.redirect-customizable` (which *can* hide it) only renders when the
  domain's branding version is **Hosted UI (classic)** — AWS docs: *"a user pool domain serves
  either managed login or the hosted UI."* Downgrading would swap sign-in/MFA/password-reset to
  the old UI for everyone.
- Disabling self-registration would also remove the link **and break the custom form**, whose
  public secretless `SignUp` call Cognito rejects when `AllowAdminCreateUserOnly: true`.

It is moot now: with a 3-attribute schema the Hosted UI signup page asks for exactly Username,
Email, Given name, Family name, Password — the same list as the custom form. The link is a
fine second front door. **Don't spend time trying to hide it again.**

### The API authorizer is NOT the only place the pool ID lives

Flipping `kcmps-cognito-jwt` covers the 8 authorizer-gated routes, but **two Lambdas verify
JWTs themselves** and read their own env vars — they are unauthenticated routes (guest checkout
must work without a token), so the authorizer never sees those requests:

| Lambda | Env vars | Symptom if left on the old pool |
|---|---|---|
| `kcmps-create-order` | `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | **Silent.** A logged-in customer's token fails verification, the Lambda falls back to guest checkout, `customerSub` is never set — the order never appears in their order history. No error, nothing in the logs. |
| `kcmps-cancel-order` | same | Sub-match always fails; falls back to `contactsMatch()` |

This was missed on the first pass of the 2026-08-05 cutover and produced two orphaned guest
orders before it was caught. Update them alongside the authorizer:

```bash
# get-function-configuration first — --environment REPLACES the whole Variables
# map, so TABLE_NAME/FROM_EMAIL/UPLOADS_BUCKET must be carried forward.
aws lambda update-function-configuration --function-name kcmps-create-order \
  --environment file://env.json --profile kcmps-claude-priv --region ap-southeast-1
```

Verify with a real order from a logged-in account and confirm `customerSub` is populated on the
`ORDER#…/META` item — a smoke test that only checks "the order was created" passes either way.

### Manual steps CloudFormation can't do

The PostConfirmation Lambda lives outside this stack, so both of these are CLI-only:

```bash
aws lambda add-permission --function-name kcmps-post-confirmation \
  --statement-id kcmps-cognito-post-confirmation-v2 --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com \
  --source-arn arn:aws:cognito-idp:ap-southeast-1:600929977538:userpool/ap-southeast-1_LHJsFdCgo \
  --profile kcmps-claude-priv
```

…plus `kcmps-post-confirmation-lambda-role`'s inline policy, whose
`cognito-idp:AdminAddUserToGroup` Resource list now carries **both** pool ARNs.

### Google IdP — still outstanding

The new pool has **no Google IdP**, so "Sign in with Google" is currently unavailable. Cognito
never returns a client secret, so it can't be copied from the old pool — fetch it from the
Google Cloud console and re-run:

```bash
aws cloudformation deploy --template-file backend/infra/user-pool-v2.cfn.yaml \
  --stack-name kcmps-user-pool-v2 --profile kcmps-claude-priv --region ap-southeast-1 \
  --parameter-overrides GoogleClientId=<id> GoogleClientSecret=<secret>
```

Google's own OAuth client also needs `https://kcmps-auth.auth.ap-southeast-1.amazoncognito.com/oauth2/idpresponse`
added to its authorized redirect URIs.

### Accounts (recreated, not migrated — passwords are never exportable)

| Username | Email | Groups |
|---|---|---|
| `admin.kcmps.cognito` | `admin+admin.kcmps.cognito@kcmps.com` | Admin, Staff |
| `admin.kcmps.uat` | `admin+admin.kcmps.uat@kcmps.com` | Staff |
| `testcustomer.kcmps.uat` | `admin+testcustomer.kcmps.uat@kcmps.com` | Customer |

Created with `admin-create-user` (no `--temporary-password`), so Cognito generated and emailed
the temp password and each lands in `FORCE_CHANGE_PASSWORD`. `admin-create-user` does **not**
fire the PostConfirmation trigger, so groups were added manually.

### Old pool — deleted (2026-08-05, once cutover was confirmed working end-to-end)

`ap-southeast-1_iDvAEumNp` and its Hosted UI domain (`ap-southeast-1idvaeumnp`) were kept
standing through the cutover specifically as a rollback path, then deleted once dev.kcmps.com
was smoke-tested (sign-up, sign-in by username AND email, dashboard access, a real order with
`customerSub` populated, and Google federation) and both the API authorizer's JWT config and
`create-order`/`cancel-order`'s own env vars were confirmed pointed at the new pool. The
rollback section below is now **historical** — it describes what was true during the cutover
window, not a live option. `DeletionProtection` on the new pool was flipped to `ACTIVE` in the
same pass, now that it's the only pool in use.

The **already-deployed** `kcmps-foundation` CloudFormation stack still carries
`UserPoolId=ap-southeast-1_iDvAEumNp` as a stack parameter — its 5 `UserPoolGroup` resources
are now dangling references to a deleted pool. See `foundation.cfn.yaml`'s header: do **not**
try to "fix" this by redeploying it against the new pool ID — `user-pool-v2.cfn.yaml` already
owns identically-named groups on that pool, and CloudFormation would hit a same-name conflict
and fail. The table resource in that stack is unaffected and remains authoritative.

### Rollback (historical — describes the cutover window; the old pool no longer exists)

The API authorizer was the switch — flipping it back would have restored the old pool
instantly, while it still existed:

```bash
aws apigatewayv2 update-authorizer --api-id 6msg2uho6c --authorizer-id sboj1n \
  --jwt-configuration 'Audience=95rrk0mflffentqdiomg1fipc,Issuer=https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_iDvAEumNp' \
  --profile kcmps-claude-priv --region ap-southeast-1
```

…then revert the pool/client/domain constants in the 6 frontend files, revert
`create-order`/`cancel-order`'s `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` env vars (see "The
API authorizer is NOT the only place the pool ID lives" above), and re-sync. This command is
kept only as a record of the mechanism — the pool it points at is gone, so running it now would
just break auth entirely rather than roll anything back.

## Re-running / updates

`aws cloudformation deploy` is idempotent — re-running it with the same
parameters against an existing `kcmps-foundation` stack applies only the
diff (e.g. if you edit group `Precedence` values later). It will refuse to
change `TableName` on an existing stack without a replacement, since DynamoDB
table names are immutable post-creation; to rename, deploy a new stack with a
new `TableName` and migrate data separately.

## SES inbound-mail relay — `mirror.kcmps.com` (applied 2026-08-06)

Part of `docs/roadmap.md`'s "Staff email panel" / SES-relay track. Built same-day, resources
created directly via CLI (see `backend/infra/ses-relay.cfn.yaml`'s header for why, and for a
CFN description of the same setup for future rebuilds). All in account `600929977538`
(`kcmps-claude-priv`), region `ap-southeast-1`, except the one DNS change below.

**What exists now:**
- **Bounce/complaint alerting** on the *existing* `kcmps.com` sending identity — an SNS topic
  `kcmps-ses-bounce-complaint`, subscribed to `admin@kcmps.com` (email protocol), wired as an
  event destination (`kcmps-bounce-complaint-sns`, `MatchingEventTypes: [BOUNCE, COMPLAINT]`)
  on the configuration set `my-first-configuration-set` that's already attached to the
  `kcmps.com` identity. **This is purely additive** — verified after applying that the
  identity's DKIM (`SUCCESS`), MAIL FROM (`mail.kcmps.com`, `SUCCESS`), and
  `VerificationStatus` (`SUCCESS`) were all unchanged. **The email subscription is sitting in
  `PendingConfirmation` and needs the owner to click the confirmation link SNS sent to
  `admin@kcmps.com`** — same trap `kcmps-ops-alerts` hit before; nothing auto-confirms it.
- **`mirror.kcmps.com`** verified as an SES receiving identity (`VerificationStatus: SUCCESS`).
  SES email receiving **is available in `ap-southeast-1`** (confirmed via a live
  `aws ses describe-active-receipt-rule-set` call succeeding, `inbound-smtp.ap-southeast-1
  .amazonaws.com` resolving, and an actual end-to-end send/receive test below) — no
  cross-region workaround was needed.
- **DNS**, added via `UPSERT` to the real hosted zone `Z06397161LBTJCRTPLL62` in account
  `260866268499` (`default` profile) — change ID `C10397382N3T7IMLFR6TL`, confirmed `INSYNC`:
  - `MX mirror.kcmps.com` → `10 inbound-smtp.ap-southeast-1.amazonaws.com`
  - 3 DKIM CNAMEs: `<token>._domainkey.mirror.kcmps.com` → `<token>.dkim.amazonses.com`
    (tokens are `mirror.kcmps.com`'s own, distinct from `kcmps.com`'s DKIM tokens)

    No existing `kcmps.com`/`www`/`site`/`dev`/`mail`/`_dmarc`/DKIM record was read, modified,
    or deleted — every change above targets only the new `mirror.kcmps.com` subdomain name.
- **`kcmps-inbound-mail-est-2026`** — private S3 bucket for raw inbound MIME. All public
  access blocked, SSE-S3 default encryption, lifecycle transitions objects to Standard-IA at
  30 days. Bucket policy grants `ses.amazonaws.com` `s3:PutObject` scoped to this account's
  receipt rules only (`aws:SourceAccount`/`aws:SourceArn` conditions).
- **Receipt rule set `kcmps-mirror-inbound`** (active), one rule `mirror-domain-catchall`
  matching all recipients `@mirror.kcmps.com`, delivering to `kcmps-inbound-mail-est-2026`
  under the `inbound/` prefix. **Not split per-mailbox** — a single domain-catchall rule was
  used since the actual list of staff mailboxes that will forward here isn't fixed yet;
  splitting into per-recipient rules (each with its own `ObjectKeyPrefix`) is a cheap follow-up
  once that list exists. **For now, C2's parser Lambda should read the MIME `To:` header to
  determine which staff mailbox a message is for**, not the S3 key.

**Verified end-to-end (2026-08-06):** sent a real email via `aws ses send-email` from
`admin+admin.kcmps.uat@kcmps.com` (the only permitted test address) to `test@mirror.kcmps.com`;
the raw MIME object landed in `s3://kcmps-inbound-mail-est-2026/inbound/<ses-message-id>` within
seconds, `X-SES-Spam-Verdict: PASS` / `X-SES-Virus-Verdict: PASS`, DKIM/SPF/DMARC all `pass`.

**What C2 needs:**
- Bucket: `kcmps-inbound-mail-est-2026`, region `ap-southeast-1`, prefix `inbound/`.
- Object key = the SES-generated message ID (opaque); route by parsing the MIME `To:` header,
  not the key, until/unless per-recipient rules get added.
- Trigger the parser off S3 `ObjectCreated:Put` under `inbound/`, same pattern as the design
  library's GuardDuty-scan-result Lambda (EventBridge) or a direct S3 event notification —
  your call.
- Target shape to write into: `email.html`'s mock `MESSAGE#`/mailbox shape (see
  `docs/roadmap.md`'s "Staff email panel" checklist) — this session didn't touch that file.

**Owner manual step (not attempted — no Spacemail credentials available to this session):**
configure a Spacemail-side forwarding rule from each staff `@kcmps.com` mailbox to its own
address on `mirror.kcmps.com` (e.g. `order@kcmps.com` → `order@mirror.kcmps.com`). Until this
is set up, nothing external will actually land in the inbound bucket — only directly-addressed
test sends like the verification above will.

**Explicitly not built this session (C2/C3 scope):** the MIME parser Lambda, the
`sendReply`-equivalent Lambda over `SES.SendRawEmail`. No production Lambda was touched, and
`notify-unread-messages`'s `SES_SENDER` was left unset as instructed.
