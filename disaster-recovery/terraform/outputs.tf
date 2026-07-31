output "bucket_name" {
  value = aws_s3_bucket.site.id
}

output "prod_distribution_id" {
  value = aws_cloudfront_distribution.prod.id
}

output "prod_distribution_domain_name" {
  value = aws_cloudfront_distribution.prod.domain_name
}

output "dev_distribution_id" {
  value = aws_cloudfront_distribution.dev.id
}

output "dev_distribution_domain_name" {
  value = aws_cloudfront_distribution.dev.domain_name
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
