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

### Legacy groups — deprecate, don't reuse

The pool already had two groups from before this stack existed:
`Staff` (precedence 10 — what `dashboard-shell.js` currently checks
client-side) and `Customers` (precedence 100, plural). Both are superseded
by this template's groups (`Admin` and `Customer` respectively) and should
be **retired, not built on** — don't add new users to `Staff`/`Customers`,
and don't design new authorization logic around them. Migration is two
steps, done once real users are already sorted into the new groups:

1. Move any users still in `Staff` into the appropriate new group
   (`Admin`/`Production`/`Sales`/`Finance` — `Staff` doesn't distinguish
   role, so this requires a human decision per user) and any users in
   `Customers` into `Customer`.
2. Update `dashboard-shell.js`'s client-side gate (see root `CLAUDE.md`'s
   Cognito row) to check the new group set, then delete the `Staff` and
   `Customers` groups from the pool (`aws cognito-idp delete-group`) —
   outside this template's scope since it never created them.

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

## Re-running / updates

`aws cloudformation deploy` is idempotent — re-running it with the same
parameters against an existing `kcmps-foundation` stack applies only the
diff (e.g. if you edit group `Precedence` values later). It will refuse to
change `TableName` on an existing stack without a replacement, since DynamoDB
table names are immutable post-creation; to rename, deploy a new stack with a
new `TableName` and migrate data separately.
