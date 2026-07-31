# Core account (600929977538), core region — S3 bucket + Cognito actually
# live in ap-southeast-1 (verified against the deployed resources).
provider "aws" {
  alias   = "core"
  region  = "ap-southeast-1"
  profile = var.primary_profile
}

# Same account, but CloudFront/ACM/WAFv2 resources can only be managed from
# us-east-1, regardless of where the distribution's origin/pool live.
provider "aws" {
  alias   = "edge"
  region  = "us-east-1"
  profile = var.primary_profile
}

# DNS account (260866268499) — Route 53 only. Deliberately a separate
# provider/profile: this repo's real kcmps.com zone lives in a different
# account than the CloudFront distribution/S3 origin (see root CLAUDE.md
# "Deploying to production" for why the split exists — a mandatory ~14-day
# post-registration/transfer lock is why the domain hasn't been moved into
# the CloudFront account — and why the decoy zone in the primary account
# must never be used).
provider "aws" {
  alias   = "dns"
  region  = "us-east-1"
  profile = var.dns_profile
}
