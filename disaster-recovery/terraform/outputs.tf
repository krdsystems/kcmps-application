output "bucket_name" {
  value = aws_s3_bucket.site.id
}

output "prod_distribution_id" {
  value = aws_cloudfront_distribution.prod.id
}

output "prod_distribution_domain_name" {
  value = aws_cloudfront_distribution.prod.domain_name
}

output "origin_access_control_id" {
  description = <<-EOT
    Feed into storefront-infra/dev-domain.cfn.yaml's OriginAccessControlId
    parameter when recreating dev.kcmps.com after a full recovery — that
    template defaults to today's OAC id (E233V4Y9BPPX6H), which won't exist
    anymore if this module had to recreate the OAC from scratch.
  EOT
  value       = aws_cloudfront_origin_access_control.site.id
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_user_pool_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_hosted_ui_domain" {
  value = "https://${var.cognito_domain_prefix}.auth.ap-southeast-1.amazoncognito.com"
}
