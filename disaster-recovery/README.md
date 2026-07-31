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
| CloudFront OAC | shared by both distributions below |
| CloudFront Function — prod | `site-kcmps-redirect`, redirects `site.kcmps.com` → `https://kcmps.com` |
| CloudFront Function — dev | `kcmps-dev-basic-auth`, HTTP basic-auth gate. **Not backed up anywhere in the repo before this folder existed** — its source is now in both IaC sets |
| Response-headers policy | `kcmps-dev-noindex` — sets `X-Robots-Tag` on dev |
| WAFv2 WebACL | attached to the prod distribution only; 3 AWS managed rule groups (IP reputation list, common rule set, known-bad-inputs) |
| Prod CloudFront distribution | `EY6Q5RSWLDCEF` today — aliases `kcmps.com` / `www.kcmps.com` / `site.kcmps.com` |
| Dev CloudFront distribution | `E7PDB5JQRZX0E` today — alias `dev.kcmps.com`, origin path `/dev-site` in the same bucket |
| Cognito | User Pool `kcmps-user-pool` (`ap-southeast-1_iDvAEumNp` today), App Client `kcmps-web-client`, Hosted UI Domain, Google federated IdP, `Staff` group |
| Route 53 records | account `260866268499`, zone `Z06397161LBTJCRTPLL62` — all four hostnames above, pointed at whatever the new distributions' domain names turn out to be |

### NOT covered — handle separately

| Item | Why it's excluded / what to do instead |
|---|---|
| Cognito user accounts | No API exports/restores real user records. A deleted pool comes back with zero users — everyone re-registers. Real user-data DR needs a separate periodic `ListUsers` export job (not built). |
| Google OAuth Client Secret | Lives in Google Cloud Console, not AWS — Cognito stores it write-only, so it can't be read back out. If the pool is lost, pull the secret from Google Cloud Console's Credentials page first, or issue a new OAuth client. |
| Dev basic-auth credential | Live-retrieved for this runbook but deliberately not hardcoded into either IaC set — it's a parameter/variable supplied at deploy time. Save the current value to a password manager now if you want to reuse it, or just set a new one on redeploy. |
| ACM certificate | ACM certs outlive CloudFront/S3 deletions, so both IaC sets default to reusing the existing ARN (`arn:aws:acm:us-east-1:600929977538:certificate/c2758183-3a3a-43b2-bdd6-f6c0848edfb6`, expires 2027-01-30). Only reissue — DNS-validated against the zone in the *other* account, not automated here — if the certificate itself is gone. |
| Route 53 hosted zone + mail records | The zone (`Z06397161LBTJCRTPLL62`) and its MX/SPF/DKIM/autodiscover records for Spacemail aren't something that "goes down" like compute, and recreating a zone changes NS delegation (a registrar-side change). Out of scope on purpose — see root `CLAUDE.md` for why the domain (`260866268499`) and CloudFront (`600929977538`) are split across accounts (a mandatory ~14-day post-registration/transfer lock, not a design flaw to "fix"). |
| Website content | These templates stand up empty buckets. Redeploy from repo root: `aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ --profile kcmps-claude-priv` (see root `CLAUDE.md` "Deploying to production"). |
| DynamoDB / backend foundation / ERP Cognito groups | Already has its own IaC: `backend/infra/foundation.cfn.yaml`. This folder only adds `Staff` (storefront/dashboard auth), separate from that template's five ERP-role groups (Customer/Production/Sales/Finance/Admin). |

## Deploy order (both IaC sets follow the same three phases)

1. **Core** (S3 + Cognito) — must run in **ap-southeast-1**, profile
   `kcmps-claude-priv`.
2. **Edge** (CloudFront/WAF/Functions + the S3 bucket policy) — must run in
   **us-east-1** (CloudFront/ACM/WAFv2 are only manageable from there, even
   though the distribution serves globally and the bucket lives in
   ap-southeast-1), same account/profile. Needs Core's bucket outputs.
3. **DNS** — profile `default` (account `260866268499`, the real
   `kcmps.com` zone). Needs Edge's distribution domain-name outputs.

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

# 2. Edge — us-east-1
aws cloudformation deploy \
  --template-file kcmps-dr-edge.yaml \
  --stack-name kcmps-dr-edge \
  --region us-east-1 \
  --profile kcmps-claude-priv \
  --parameter-overrides BucketName=... BucketRegionalDomainName=... DevBasicAuthCredential=...

# grab ProdDistributionDomainName / DevDistributionDomainName, then:

# 3. DNS — the OTHER account
aws cloudformation deploy \
  --template-file kcmps-dns-records.yaml \
  --stack-name kcmps-dns-records \
  --region us-east-1 \
  --profile default \
  --parameter-overrides CloudFrontDomainName=... DevCloudFrontDomainName=...
```

See `cloudformation/params.example.md` for ready-to-copy `--parameters
file://...` JSON blocks.

### Terraform

```bash
cd disaster-recovery/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in secrets, don't commit
terraform init
terraform plan
terraform apply
```

One `apply` handles all three phases — Terraform resolves the
core → edge → dns dependency graph itself via the resource references
(no manual output-copying between stacks). Set `manage_dns = false` in
`terraform.tfvars` to skip the Route 53 phase entirely (e.g. if you only
have the `kcmps-claude-priv`/`-ro` profiles handy and not `default`).

## What was verified against AWS before writing this (2026-07-31)

Queried live with `kcmps-claude-ro`/`default` profiles rather than trusting
docs alone — this surfaced two things not previously written down anywhere
in the repo: the dev distribution's basic-auth CloudFront Function source,
and that the prod distribution has a WAFv2 WebACL attached. Also confirmed:
cache policy is AWS-managed **CachingDisabled** (not CachingOptimized —
matches what's actually live, don't "improve" it on redeploy), the Cognito
password policy requires symbols, and the real Route 53 zone has no other
CloudFront-facing records beyond the four reproduced here.

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
