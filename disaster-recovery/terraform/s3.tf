# Bucket lives in ap-southeast-1 (verified against the deployed resource) —
# uses the "core" provider alias, NOT the default/edge one.

resource "aws_s3_bucket" "site" {
  provider = aws.core
  bucket   = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "site" {
  provider = aws.core
  bucket   = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  provider                = aws.core
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "site" {
  provider = aws.core
  bucket   = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  provider = aws.core
  bucket   = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Bucket policy is declared with the "edge" provider (us-east-1) even
# though the bucket itself is in ap-southeast-1 — S3 bucket-policy PutObject
# calls aren't region-locked to the bucket's home region, and this resource
# needs both CloudFront distributions' ARNs, which only exist in cloudfront.tf.
resource "aws_s3_bucket_policy" "site" {
  provider = aws.edge
  bucket   = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2008-10-17"
    Id      = "PolicyForCloudFrontPrivateContent"
    Statement = [
      {
        Sid       = "AllowCloudFrontServicePrincipalProd"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.prod.arn
          }
        }
      },
      {
        Sid       = "AllowCloudFrontServicePrincipalDev"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.dev.arn
          }
        }
      }
    ]
  })
}
