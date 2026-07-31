# Route 53 records only — the real kcmps.com zone (Z06397161LBTJCRTPLL62)
# already exists in the 260866268499 account and is out of scope to
# recreate here (it also holds mail MX/SPF/DKIM records this repo doesn't
# own). This only asserts the three CloudFront-facing alias records + the
# dev CNAME, using the "dns" provider (a different profile/account than
# core/edge).

locals {
  cloudfront_hosted_zone_id = "Z2FDTNDATAQYW2" # fixed for every CloudFront distribution
}

resource "aws_route53_record" "apex" {
  count    = var.manage_dns ? 1 : 0
  provider = aws.dns
  zone_id  = var.hosted_zone_id
  name     = "kcmps.com"
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.prod.domain_name
    zone_id                = local.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www" {
  count    = var.manage_dns ? 1 : 0
  provider = aws.dns
  zone_id  = var.hosted_zone_id
  name     = "www.kcmps.com"
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.prod.domain_name
    zone_id                = local.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site" {
  count    = var.manage_dns ? 1 : 0
  provider = aws.dns
  zone_id  = var.hosted_zone_id
  name     = "site.kcmps.com"
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.prod.domain_name
    zone_id                = local.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "dev" {
  count    = var.manage_dns && var.dev_distribution_domain_name != "" ? 1 : 0
  provider = aws.dns
  zone_id  = var.hosted_zone_id
  name     = "dev.kcmps.com"
  type     = "CNAME"
  ttl      = 300
  records  = [var.dev_distribution_domain_name]
}
