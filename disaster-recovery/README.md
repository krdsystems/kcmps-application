# KCMPS disaster-recovery IaC

Not deployed, not run automatically. This folder exists so that if the S3
bucket, CloudFront distributions, or Cognito User Pool are ever deleted or
badly misconfigured, the whole stack can be recreated from a runbook in
minutes instead of by hand from memory. Two equivalent IaC implementations
are provided — pick whichever the responder has tooling for:

- `cloudformation/` — three templates, native AWS, no extra tooling needed.
- `terraform/` — one root module covering the same resources.

Both were reverse-engineered against the **live** resources on 2026-07-31
(`aws cloudformation validate-template` / `terraform validate` both pass),
not just from repo docs — see "What was verified against AWS" below.

## Scope — what this does and does NOT cover

### Covered

All in account `600929977538` unless noted.

| Resource | Detail |
|---|---|
| S3 origin bucket | `kcmps-online-bucket-est-2026` — versioned, SSE-S3, all public access blocked |
| CloudFront OAC | shared — also consumed by dev.kcmps.com's separate stack, see below |
| CloudFront Function — prod | `site-kcmps-redirect`, redirects `site.kcmps.com` → `https://kcmps.com` |
| WAFv2 WebACL | attached to the prod distribution only; 3 AWS managed rule groups (IP reputation list, common rule set, known-bad-inputs) |
| Prod CloudFront distribution | `EY6Q5RSWLDCEF` today — aliases `kcmps.com` / `www.kcmps.com` / `site.kcmps.com` |
| Cognito | User Pool `kcmps-user-pool` (`ap-southeast-1_iDvAEumNp` today), App Client `kcmps-web-client`, Hosted UI Domain, Google federated IdP, `Staff` group |
| Route 53 records | account `260866268499`, zone `Z06397161LBTJCRTPLL62` — `kcmps.com`/`www.kcmps.com`/`site.kcmps.com` (+ `dev.kcmps.com`, see below), pointed at whatever the new distribution domain names turn out to be |

### Related, not duplicated here — dev.kcmps.com

The dev distribution (`E7PDB5JQRZX0E` today), its `kcmps-dev-basic-auth`
CloudFront Function, and its `kcmps-dev-noindex` response-headers policy
already have their own template, **`storefront-infra/dev-domain.cfn.yaml`**
— that's the single source of truth for dev, so this folder deliberately
doesn't recreate any of it (an earlier draft did; it was reconciled out
once `dev-domain.cfn.yaml` turned out to already exist on `main`). See
"Recovering dev.kcmps.com" below for how the two connect.

### NOT covered — handle separately

| Item | Why it's excluded / what to do instead |
|---|---|
| Cognito user accounts | No API exports/restores real user records. A deleted pool comes back with zero users — everyone re-registers. Real user-data DR needs a separate periodic `ListUsers` export job (not built). |
| Google OAuth Client Secret | Lives in Google Cloud Console, not AWS — Cognito stores it write-only, so it can't be read back out. If the pool is lost, pull the secret from Google Cloud Console's Credentials page first, or issue a new OAuth client. |
| Dev basic-auth credential | Owned by `dev-domain.cfn.yaml`'s `BasicAuthPassword` parameter, not this folder — `NoEcho`, not recoverable from AWS after the fact. Save the current value to a password manager if you want to reuse it, or just set a new one on redeploy. |
| ACM certificate | ACM certs outlive CloudFront/S3 deletions, so both IaC sets default to reusing the existing ARN (`arn:aws:acm:us-east-1:600929977538:certificate/c2758183-3a3a-43b2-bdd6-f6c0848edfb6`, expires 2027-01-30). Only reissue — DNS-validated against the zone in the *other* account, not automated here — if the certificate itself is gone. |
| Route 53 hosted zone + mail records | The zone (`Z06397161LBTJCRTPLL62`) and its MX/SPF/DKIM/autodiscover records for Spacemail aren't something that "goes down" like compute, and recreating a zone changes NS delegation (a registrar-side change). Out of scope on purpose — see root `CLAUDE.md` for why the domain (`260866268499`) and CloudFront (`600929977538`) are split across accounts (a mandatory ~14-day post-registration/transfer lock, not a design flaw to "fix"). |
| Website content | These templates stand up empty buckets. Redeploy from repo root: `aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile kcmps-claude-priv` (see root `CLAUDE.md` "Deploying to production"). |
| DynamoDB / backend foundation / ERP Cognito groups | Already has its own IaC: `backend/infra/foundation.cfn.yaml`. This folder only adds `Staff` (storefront/dashboard auth), separate from that template's five ERP-role groups (Customer/Production/Sales/Finance/Admin). |

## Deploy order (both IaC sets follow the same phases)

1. **Core** (S3 + Cognito) — must run in **ap-southeast-1**, profile
   `kcmps-claude-priv`.
2. **Edge** (prod CloudFront/WAF/redirect-Function + the prod statement of
   the S3 bucket policy) — must run in **us-east-1** (CloudFront/ACM/WAFv2
   are only manageable from there, even though the distribution serves
   globally and the bucket lives in ap-southeast-1), same account/profile.
   Needs Core's bucket outputs.
3. **Dev** (only if `dev.kcmps.com` also needs recovering) —
   `storefront-infra/dev-domain.cfn.yaml`, CloudFormation only, us-east-1,
   same account/profile. Needs Core's bucket outputs and Edge's OAC id.
   See "Recovering dev.kcmps.com" below.
4. **DNS** — profile `default` (account `260866268499`, the real
   `kcmps.com` zone). Needs Edge's (and, if run, Dev's) distribution
   domain-name outputs.

### CloudFormation

```bash
cd disaster-recovery/cloudformation

# 1. Core — ap-southeast-1
aws cloudformation deploy \
  --template-file kcmps-dr-core.yaml \
  --stack-name kcmps-dr-core \
  --region ap-southeast-1 \
  --profile kcmps-claude-priv \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GoogleClientId=... GoogleClientSecret=...

# grab BucketName / BucketRegionalDomainName from the stack outputs, then:

# 2. Edge — us-east-1, prod only
aws cloudformation deploy \
  --template-file kcmps-dr-edge.yaml \
  --stack-name kcmps-dr-edge \
  --region us-east-1 \
  --profile kcmps-claude-priv \
  --parameter-overrides BucketName=... BucketRegionalDomainName=...

# grab ProdDistributionDomainName / OriginAccessControlId, then:

# 3. Dev — us-east-1, only if dev.kcmps.com also needs recovering
aws cloudformation deploy \
  --template-file ../../storefront-infra/dev-domain.cfn.yaml \
  --stack-name kcmps-dev-domain \
  --region us-east-1 \
  --profile kcmps-claude-priv \
  --parameter-overrides BucketName=... BucketRegionalDomainName=... \
    OriginAccessControlId=... BasicAuthPassword=...

# grab DevDistributionDomainName, then:

# 4. DNS — the OTHER account
aws cloudformation deploy \
  --template-file kcmps-dns-records.yaml \
  --stack-name kcmps-dns-records \
  --region us-east-1 \
  --profile default \
  --parameter-overrides CloudFrontDomainName=... DevCloudFrontDomainName=...
```

See `cloudformation/params.example.md` for ready-to-copy `--parameters
file://...` JSON blocks (core, edge, and DNS — `dev-domain.cfn.yaml` isn't
part of this folder, so its own params aren't duplicated there).

### Terraform

```bash
cd disaster-recovery/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in secrets, don't commit
terraform init
terraform plan
terraform apply
```

One `apply` handles core + edge + DNS — Terraform resolves that dependency
graph itself via resource references (no manual output-copying between
stacks). Set `manage_dns = false` in `terraform.tfvars` to skip the Route
53 phase entirely (e.g. if you only have the `kcmps-claude-priv`/`-ro`
profiles handy and not `default`). Terraform does **not** cover
`dev.kcmps.com` — deploy `storefront-infra/dev-domain.cfn.yaml` separately
(CloudFormation, see step 3 above) using this module's
`origin_access_control_id` output, then set `dev_distribution_domain_name`
in `terraform.tfvars` to its `DevDistributionDomainName` output and
re-`apply` so the Route 53 CNAME picks it up.

## Recovering dev.kcmps.com

Deliberately a separate deploy from this folder's core/edge (or
core+edge Terraform apply), not a third phase bundled into either IaC set:

1. Deploy/apply this folder's core (+ edge, if using Terraform) as above.
2. Deploy `storefront-infra/dev-domain.cfn.yaml`, passing this stack's
   `BucketName`/`BucketRegionalDomainName` and the edge
   stack/module's `OriginAccessControlId`/`origin_access_control_id`
   output — that template's own `OriginAccessControlId` parameter
   defaults to today's OAC id (`E233V4Y9BPPX6H`), which won't exist if the
   OAC had to be recreated from scratch.
3. Grant the new dev distribution S3 read access — this is a manual step
   in the *original* deploy too, not something either IaC set skips on
   purpose. `dev-domain.cfn.yaml` explains why in its own template
   comments (`AWS::S3::BucketPolicy`'s Create handler refuses to touch a
   bucket with an externally-applied policy): fetch the current policy,
   add a second statement keyed on the new dev distribution's ARN
   alongside prod's, and `put-bucket-policy` the full replacement (see
   `storefront-infra/CLAUDE.md` for the exact command shape).
4. Feed the new dev distribution's `DevDistributionDomainName` output into
   `kcmps-dns-records.yaml`'s `DevCloudFrontDomainName` parameter (or
   Terraform's `dev_distribution_domain_name` variable).

## What was verified against AWS before writing this (2026-07-31)

Queried live with `kcmps-claude-ro`/`default` profiles rather than trusting
docs alone — this surfaced that the prod distribution has a WAFv2 WebACL
attached, which wasn't written down anywhere else in the repo (an initial
draft of this folder also recreated the dev distribution/Function from
live values before `storefront-infra/dev-domain.cfn.yaml` was found
already covering it on `main` — reconciled out, see "Related, not
duplicated here" above). Also confirmed: prod's cache policy is AWS-managed
**CachingDisabled** (not CachingOptimized — matches what's actually live,
don't "improve" it on redeploy), the Cognito password policy requires
symbols, and the real Route 53 zone has no other CloudFront-facing records
beyond the four reproduced here.

## After a real recovery

1. Re-run the website deploy (`aws s3 sync`, see root `CLAUDE.md`).
2. If Cognito had to be recreated from scratch: update
   `website/index.html` and `website/login-test.html`'s `COGNITO_CONFIG`
   (new `userPoolId`, `clientId`, `domain`) — the values are hardcoded
   there, not read from anywhere dynamic.
3. If the Google IdP had to be recreated: update the OAuth client's
   authorized redirect URIs in Google Cloud Console to match the new
   Cognito domain's `/oauth2/idpresponse` callback.
4. Confirm `aws cloudfront get-distribution` shows `Status: Deployed`
   before pointing users at the new domain names (initial propagation can
   take 5–15 minutes even though the API call returns immediately).
