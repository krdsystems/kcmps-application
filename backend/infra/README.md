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
  --user-pool-id ap-southeast-1_iDvAEumNp \
  --username admin.kcmps.cognito \
  --group-name Admin \
  --region ap-southeast-1
```

Confirm membership:

```bash
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id ap-southeast-1_iDvAEumNp \
  --username admin.kcmps.cognito \
  --region ap-southeast-1
```

## What later milestones need from this stack

| Value | Where it's used |
|---|---|
| `TableName` output | Every Lambda's `TABLE_NAME` environment variable (1.1 CRUD Lambdas, streams-handler, expire-pending-orders, daily-digest) |
| `TableStreamArn` output | The 1.3 `streams-handler.js` Lambda's DynamoDB Streams event source mapping (`NEW_AND_OLD_IMAGES`, already set on the table) |
| `GSI1Name` output (`GSI1`) | Every Lambda that queries the sparse status index (`api-get-orders.js`, `api-advance-line-item.js`'s queue reads, `expire-pending-orders.js`) |
| Cognito groups (`Customer`/`Production`/`Sales`/`Finance`/`Admin`) | JWT `cognito:groups` claim checks inside every `api-*.js` Lambda and the HTTP API's JWT authorizer setup (§4 of `backend-infra-to-deploy.md`) — dashboard routes currently gate on `Staff`-shaped access; map that check to "any of Production/Sales/Finance/Admin" when wiring the authorizer |

### Legacy groups — `Customers` retired, `Staff` still vital (2026-07-31)

The pool had two groups from before this stack existed: `Staff` (precedence
10) and `Customers` (precedence 100, plural).

**`Customers` (plural) is now retired** — its one real member (a
Google-federated customer account) was moved into `Customer` (singular) via
`admin-add-user-to-group`/`admin-remove-user-from-group`, confirmed empty via
`list-users-in-group`, then deleted with `aws cognito-idp delete-group`.

**`Staff` is NOT retired — it's still load-bearing, do not delete it.**
Two things depend on it today: `dashboard-shell.js`'s client-side gate
(`requireStaffAuth()`) checks for the literal `"Staff"` group and redirects
non-members to `?dashboard=forbidden`, and every Milestone 1.3 Lambda
(`backend/lib/auth.js`'s `isStaff()` check, OR'd with the legacy group — see
`get-orders.js`/`advance-line-item.js`/`verify-payment.js`) accepts it as a
fallback. Both real staff accounts (`admin.kcmps.cognito`,
`admin.kcmps.cognito.test`) are correctly in **both** `Staff` and `Admin` —
that dual membership is the deliberate transitional state, not a mistake to
"fix" by removing one. Only retire `Staff` once `dashboard-shell.js`'s gate
is rewritten to check the new role set instead, and every account that needs
dashboard access has been confirmed to already hold one of
`Admin`/`Production`/`Sales`/`Finance`.

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

## Checkout Lambdas — deployed (2026-07-31)

`kcmps-create-order` and `kcmps-submit-payment-proof`, both `nodejs20.x`/`arm64` in
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
`Audience` = the app client id `95rrk0mflffentqdiomg1fipc`), and 4 new routes, each with that
authorizer attached (unlike the two 1.1/1.2 routes, which stay authorizer-free for guest
checkout):

| Method | Route | Integration |
|---|---|---|
| GET | `/orders` | `kcmps-get-orders` |
| POST | `/line-items/{lineItemId}/advance` | `kcmps-advance-line-item` |
| POST | `/orders/{orderId}/verify-payment` | `kcmps-verify-payment` |
| POST | `/orders/{orderId}/reject-payment` | `kcmps-verify-payment` |

CORS `AllowMethods` extended to `[GET, POST, OPTIONS]` (was `[POST, OPTIONS]`). Each Lambda got
its own scoped `lambda:AddPermission` (`source-arn` = this API's ARN + the specific route path).

**The JWT authorizer's claims shape is not what the more commonly-documented behavior
suggests.** A multi-value `cognito:groups` claim arrives at
`event.requestContext.authorizer.jwt.claims["cognito:groups"]` as a bracketed,
**space**-separated string — confirmed live: `"[Staff Admin]"` for two groups, `"[Admin]"` for
one. `backend/lib/auth.js`'s `getGroups()` handles this (strips the brackets, splits on
`/[,\s]+/`); if you're debugging a "staff can't see any orders" report, check this first before
assuming an IAM/role problem.

**Dashboard's own client-side gate is separate and still checks the legacy group.**
`dashboard-shell.js`'s `mount()` redirects to `index.html?dashboard=forbidden` unless the
caller's `cognito:groups` includes the literal string `"Staff"` — this is a UI convenience
gate, not a security boundary (the Lambdas' own `isStaff()`/legacy-group check is the real
one), but a test/staff account needs to be in **both** `Staff` (dashboard UI gate) and one of
`Production`/`Sales`/`Finance`/`Admin` (if you want `isStaff()` to pass without relying on the
legacy-group fallback) until `Staff` is formally retired (see "Legacy groups" above).

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

## Observability — Milestone 1.5 (deployed 2026-08-02)

Closes the backend audit's R4/R6/R7 findings: zero alerting, no retry/DLQ policy on the async
Lambdas, no API throttling. New resources are one CloudFormation stack; updates to
resources this repo had already created via plain CLI (the ESM, the API stage, the cron's async
invoke config) stay CLI, matching how the rest of `backend/infra/` is split.

**Stack**: `kcmps-observability`, template
[`observability.cfn.yaml`](observability.cfn.yaml), `ap-southeast-1`. Creates:
- `kcmps-ops-alerts` — SNS topic, one email subscription (`admin@kcmps.com` by default,
  override with `--parameter-overrides AlertEmail=...`). **The subscription sits in
  `PendingConfirmation` until someone clicks the link in the confirmation email AWS sends on
  creation — alarms fire silently into nothing until then.** Check with:
  ```bash
  aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:ap-southeast-1:600929977538:kcmps-ops-alerts --profile kcmps-claude-priv
  ```
- `kcmps-lambda-dlq` — a shared SQS standard queue, the `OnFailure` destination for both
  async-invoked backend Lambdas (see below).
- 17 CloudWatch alarms, all with `AlarmActions` pointed at the SNS topic: `Errors >= 1`/5min and
  `Throttles >= 1`/5min on each of the 7 deployed Lambdas (`kcmps-create-order`,
  `kcmps-submit-payment-proof`, `kcmps-get-orders`, `kcmps-advance-line-item`,
  `kcmps-verify-payment`, `kcmps-streams-handler`, `kcmps-expire-pending-orders`), plus
  `kcmps-streams-handler`'s `IteratorAge > 5min` (it's the only place `orderStatus` is
  recomputed — a stall here goes stale silently otherwise), the DLQ's
  `ApproximateNumberOfMessagesVisible > 0`, and `kcmps-checkout-api`'s `5XXError >= 1`/5min.

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

## Re-running / updates

`aws cloudformation deploy` is idempotent — re-running it with the same
parameters against an existing `kcmps-foundation` stack applies only the
diff (e.g. if you edit group `Precedence` values later). It will refuse to
change `TableName` on an existing stack without a replacement, since DynamoDB
table names are immutable post-creation; to rename, deploy a new stack with a
new `TableName` and migrate data separately.
