# CLAUDE.md — storefront-infra/

Build-time tooling for the storefront: the **product-image asset bucket** (private S3 bucket
+ CloudFront/OAC pair that serves catalog and hero photography) and the **dev/staging domain**
(`dev.kcmps.com`). Not deployed itself — this is planning/infra material, kept separate so an
S3 sync of `website/` never uploads it.

Only loaded when you're actually working in this folder — see the root `CLAUDE.md` for
project-wide orientation.

## Current state: bucket convention defined, manifest Lambda not yet deployed

The frontend (`website/index.html` hero carousel) already knows how to consume
`manifest.json` — see `HERO_MANIFEST_URL` near the carousel script. Until the real Lambda
below is deployed, `website/assets/manifest.json` is a hand-maintained sample so local dev
and the hero rotation work end-to-end without AWS.

## What's here

- `assets-bucket-structure.md` — the S3 folder convention (one prefix per shop category),
  the primary/gallery image naming convention, the manifest JSON shape, and the
  S3-event-triggered Lambda plan that regenerates it.
- `logic-inputs/generate-asset-manifest.js` — the actual Lambda source to deploy.
- `logic-inputs/site-kcmps-redirect.function.js` — the CloudFront Function (viewer-request,
  301-redirects `site.kcmps.com` → `https://kcmps.com`) live on distribution `EY6Q5RSWLDCEF`
  in account `600929977538`. Unrelated to the asset bucket, kept here only because this is
  where other non-deployed infra source lives; there's no CLI/IaC deploy path for CloudFront
  Functions in this repo, so this file is the copy of record — edit it, then re-paste into the
  console's Functions editor. See `docs/history.md` step 41 and the root `CLAUDE.md`'s
  "Deploying to production" section for the full domain/DNS picture.

## When you'd touch this folder

- Actually deploying the manifest Lambda → follow `assets-bucket-structure.md`.
- Adding a new shop category or changing the primary-image naming rule → update
  `assets-bucket-structure.md` first, then `generate-asset-manifest.js`'s parsing logic,
  then confirm `website/index.html`'s hero carousel still degrades gracefully if the
  manifest shape changes.
- Changing how the hero carousel consumes the manifest → that's frontend work in
  `website/index.html`, not this folder; this folder only owns what produces
  `manifest.json`.

## dev.kcmps.com — the dev/staging domain

`dev-domain.cfn.yaml` provisions a **second CloudFront distribution** aliased to
`dev.kcmps.com`, reusing the same production S3 bucket (`kcmps-online-bucket-est-2026`) and
the same wildcard ACM cert (`*.kcmps.com`, already issued — no new cert needed), but reading
from a `dev-site/` origin path instead of the bucket root. Prod's distribution
(`EY6Q5RSWLDCEF`) is never modified by this stack. Deployed as stack `kcmps-dev-domain` in
**`us-east-1`** (required — that's where the ACM cert lives and where CloudFront's control
plane operates from), applied with the `kcmps-claude-priv` profile.

**Content sync** (same idea as the root `CLAUDE.md`'s prod deploy, different prefix):
```bash
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/ --profile kcmps-claude-priv
```
Uses `CachingDisabled` (matches prod) so a sync shows up instantly, no invalidation needed.

**Basic auth**: a CloudFront Function (`kcmps-dev-basic-auth`) gates every request behind
HTTP Basic Auth so work-in-progress isn't publicly browsable/indexable (paired with an
`X-Robots-Tag: noindex` response header as a second layer). The username/password are baked
into the function's JS source at deploy time via the `BasicAuthUser`/`BasicAuthPassword`
CloudFormation parameters (`NoEcho`, no default — must be passed via
`--parameter-overrides`, never committed). **Credentials aren't recoverable from AWS after
the fact** (`NoEcho` params are masked in `describe-stacks` forever) — whoever sets the
password needs to save it themselves (password manager, etc.). To rotate it, redeploy:
```bash
aws cloudformation deploy \
  --template-file storefront-infra/dev-domain.cfn.yaml \
  --stack-name kcmps-dev-domain \
  --region us-east-1 \
  --parameter-overrides BasicAuthPassword='<new password>' \
  --profile kcmps-claude-priv \
  --no-fail-on-empty-changeset
```

**IAM**: `kcmps-claude-priv` needs a dedicated inline policy beyond what prod's plain
`s3 sync` requires — `cloudformation:*` scoped to the `kcmps-dev-domain` stack/changesets,
`cloudfront:Create*` (Resource `"*"` — distribution/response-headers-policy IDs don't exist
until after creation, so they can't be pre-scoped), `cloudfront:Get/Update/Delete*` scoped to
the created distribution/function/policy ARNs, and `s3:GetBucketPolicy`/`PutBucketPolicy` on
the bucket (see below). Two non-obvious additions that CloudFormation's "early validation"
and rollback path need but aren't obvious from the template alone:
`cloudformation:ListHookResults`/`DescribeChangeSetHooks` (to see *why* a changeset failed
property validation) and `cloudfront:ListTagsForResource` (CloudFormation calls this
internally to resolve a `!GetAtt Function.FunctionMetadata.FunctionARN` reference).

**Bucket policy is NOT CloudFormation-managed.** `AWS::S3::BucketPolicy`'s create handler
refuses to touch a bucket that already has a policy applied outside CloudFormation (safety
guard against clobbering unmanaged resources — fails with "The bucket policy already exists
on bucket \<name\>"). Since `kcmps-online-bucket-est-2026`'s policy predates this stack,
granting the dev distribution S3 read access is a manual `aws s3api put-bucket-policy` step
run once after the stack's first deploy, adding a second statement (keyed on the dev
distribution's ARN) alongside prod's existing one — full replace, not an append, so both
statements must be present or prod loses read access. Don't try to bring
`AWS::S3::BucketPolicy` back into the template without first importing the existing policy
resource into the stack.

**Gotcha for anyone editing the template**: the CloudFormation resource property is
`IPV6Enabled`, not `IsIPV6Enabled` — that's the raw CloudFront *API's* field name, and using
it in the CFN template silently fails the (undocumented-in-the-error) "early validation"
property-schema check with `additionalProperties: false`, no matter which resource you'd
guess is at fault. If a future property-validation failure doesn't give a useful error via
`describe-stack-events`/`list-hook-results`, cross-check the exact property names against
AWS's published schema (`https://schema.cloudformation.<region>.amazonaws.com/aws-<service>-
<resourcetype>.json`) rather than the CloudFront API docs — the two naming conventions
diverge in a few places.

**DNS is NOT in this AWS account.** `kcmps.com`'s real authoritative nameservers don't match
the Route53 hosted zone visible from this account's profiles — DNS lives elsewhere (different
AWS account or the registrar directly). The stack's `DevDistributionDomainName` output is
what gets pointed to from wherever that actually is; this repo/stack has no way to create
that record itself.
