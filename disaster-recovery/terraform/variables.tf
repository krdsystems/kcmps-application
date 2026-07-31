variable "primary_profile" {
  description = "AWS CLI profile for the 600929977538 account (S3/CloudFront/Cognito)."
  type        = string
  default     = "kcmps-claude-priv"
}

variable "dns_profile" {
  description = "AWS CLI profile for the 260866268499 account (Route 53)."
  type        = string
  default     = "default"
}

variable "bucket_name" {
  type    = string
  default = "kcmps-online-bucket-est-2026"
}

variable "acm_certificate_arn" {
  description = <<-EOT
    ARN of an existing ACM cert in us-east-1 covering kcmps.com + *.kcmps.com.
    ACM certs survive independently of CloudFront/S3 — reuse the existing
    ARN (default is the real one, expires 2027-01-30). Only reissue
    (DNS-validated against the zone in the dns account) if the certificate
    itself was deleted.
  EOT
  type        = string
  default     = "arn:aws:acm:us-east-1:600929977538:certificate/c2758183-3a3a-43b2-bdd6-f6c0848edfb6"
}

variable "domain_aliases" {
  type    = list(string)
  default = ["kcmps.com", "www.kcmps.com", "site.kcmps.com"]
}

variable "dev_distribution_domain_name" {
  description = <<-EOT
    dev.kcmps.com is NOT managed by this module — it's
    storefront-infra/dev-domain.cfn.yaml (CloudFormation), the single
    source of truth for that distribution, its basic-auth Function, and its
    response-headers policy. This variable only exists to feed that
    template's DevDistributionDomainName *output* into this module's
    Route 53 dev CNAME (route53.tf). Leave blank to skip the dev record —
    e.g. if dev.kcmps.com doesn't need recovering right now.
  EOT
  type        = string
  default     = ""
}

variable "cognito_user_pool_name" {
  type    = string
  default = "kcmps-user-pool"
}

variable "cognito_domain_prefix" {
  description = <<-EOT
    Cognito Hosted UI domain prefix. If the original pool
    (ap-southeast-1_iDvAEumNp, prefix "ap-southeast-1idvaeumnp") still
    exists, this variable doesn't matter. If recreating from scratch, pick a
    NEW globally-unique prefix and update website/index.html +
    website/login-test.html's COGNITO_CONFIG afterward — the pool ID,
    client ID, and domain will all be new.
  EOT
  type        = string
  default     = "kcmps-storefront-auth"
}

variable "callback_urls" {
  type    = list(string)
  default = ["https://kcmps.com/", "https://www.kcmps.com/", "https://site.kcmps.com/", "http://localhost:5500/"]
}

variable "logout_urls" {
  type    = list(string)
  default = ["https://kcmps.com/", "https://www.kcmps.com/", "https://site.kcmps.com/", "http://localhost:5500/"]
}

variable "google_client_id" {
  description = "OAuth 2.0 Web Client ID from the Google Cloud Console project backing \"Continue with Google\". Leave blank to skip the Google IdP."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "OAuth 2.0 Client Secret from the same Google Cloud Console project. Pass via -var-file/env var, never commit the real value."
  type        = string
  default     = ""
  sensitive   = true
}

variable "manage_dns" {
  description = "Whether this apply should also (re)create the Route 53 alias records in the dns account."
  type        = bool
  default     = true
}

variable "hosted_zone_id" {
  description = "The REAL kcmps.com hosted zone (not the decoy zone that also exists in the primary account)."
  type        = string
  default     = "Z06397161LBTJCRTPLL62"
}
