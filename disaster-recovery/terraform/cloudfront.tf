# CloudFront/ACM/WAFv2 must be managed from us-east-1 — "edge" provider.

resource "aws_cloudfront_origin_access_control" "site" {
  provider                          = aws.edge
  name                              = "kcmps-dr-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "site_redirect" {
  provider = aws.edge
  name     = "site-kcmps-redirect"
  runtime  = "cloudfront-js-2.0"
  comment  = "301-redirects site.kcmps.com to https://kcmps.com, passes every other host through."
  publish  = true
  code     = <<-EOT
    function handler(event) {
        var request = event.request;
        var host = request.headers.host.value;

        if (host === 'site.kcmps.com') {
            var qs = '';
            var keys = Object.keys(request.querystring);
            if (keys.length > 0) {
                var parts = [];
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    var v = request.querystring[k].value;
                    parts.push(v ? k + '=' + v : k);
                }
                qs = '?' + parts.join('&');
            }
            return {
                statusCode: 301,
                statusDescription: 'Moved Permanently',
                headers: {
                    'location': { value: 'https://kcmps.com' + request.uri + qs }
                }
            };
        }

        return request;
    }
  EOT
}

resource "aws_cloudfront_function" "dev_basic_auth" {
  provider = aws.edge
  count    = var.dev_basic_auth_credential != "" ? 1 : 0
  name     = "kcmps-dev-basic-auth"
  runtime  = "cloudfront-js-2.0"
  comment  = "Basic-auth gate for dev.kcmps.com so WIP isn't publicly browsable."
  publish  = true
  code     = <<-EOT
    function handler(event) {
        var request = event.request;
        var headers = request.headers;
        var expected = "Basic ${var.dev_basic_auth_credential}";

        if (
            typeof headers.authorization === "undefined" ||
            headers.authorization.value !== expected
        ) {
            return {
                statusCode: 401,
                statusDescription: "Unauthorized",
                headers: {
                    "www-authenticate": { value: 'Basic realm="KCMPS dev"' }
                }
            };
        }

        return request;
    }
  EOT
}

resource "aws_cloudfront_response_headers_policy" "dev_noindex" {
  provider = aws.edge
  name     = "kcmps-dev-noindex"
  comment  = "Belt-and-suspenders — keeps dev out of search indexes even though it's auth-gated."

  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow, noarchive"
      override = true
    }
  }
}

resource "aws_wafv2_web_acl" "prod" {
  provider    = aws.edge
  name        = "kcmps-prod-managed-protections"
  scope       = "CLOUDFRONT"
  description = "AWS managed rule groups matching what's live on the prod distribution today."

  default_action {
    allow {}
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "kcmps-prod-managed-protections"
  }

  rule {
    name     = "AWS-AWSManagedRulesAmazonIpReputationList"
    priority = 0
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }
    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesAmazonIpReputationList"
    }
  }

  rule {
    name     = "AWS-AWSManagedRulesCommonRuleSet"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesCommonRuleSet"
    }
  }

  rule {
    name     = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
    }
  }
}

resource "aws_cloudfront_distribution" "prod" {
  provider            = aws.edge
  enabled             = true
  comment             = "kcmps web online"
  default_root_object = "index.html"
  aliases             = var.domain_aliases
  http_version        = "http2"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_All"
  web_acl_id          = aws_wafv2_web_acl.prod.arn

  origin {
    origin_id                = "prod-origin"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "prod-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # AWS managed "CachingDisabled" — matches live config

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_redirect.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_cloudfront_distribution" "dev" {
  provider            = aws.edge
  enabled             = true
  comment             = "kcmps dev/staging site"
  default_root_object = "index.html"
  aliases             = [var.dev_domain_alias]
  http_version        = "http2"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"

  origin {
    origin_id                = "dev-origin"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_path              = var.dev_origin_path
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "dev-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # AWS managed "CachingDisabled"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.dev_noindex.id

    dynamic "function_association" {
      for_each = var.dev_basic_auth_credential != "" ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.dev_basic_auth[0].arn
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
