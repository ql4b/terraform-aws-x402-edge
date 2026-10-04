# Basic example — put an x402 paywall on one path of a CloudFront distribution.
#
# The distribution fronts httpbin.org (any origin works: S3, ALB, Function
# URL). Everything is free except /anything/premium/*, which returns 402 until
# paid and settles only after the origin answers < 400.
#
# Lambda@Edge requires the module's provider to be in us-east-1.

provider "aws" {
  region = "us-east-1"
}

variable "pay_to" {
  description = "Receiving wallet address (0x...)."
  type        = string
}

variable "network" {
  description = "EVM CAIP-2 network id. Base Sepolia by default (testnet USDC)."
  type        = string
  default     = "eip155:84532"
}

variable "facilitator_url" {
  description = "x402 facilitator that supports exact on var.network."
  type        = string
  default     = "https://x402.org/facilitator"
}

module "x402" {
  source = "../../"

  facilitator_url = var.facilitator_url
  network         = var.network
  pay_to          = var.pay_to

  routes = {
    "/anything/premium/*" = {
      price       = "$0.001"
      description = "Echoed request, paid per call"
      mime_type   = "application/json"
    }
  }

  namespace = "myorg"
  name      = "paywall"
}

resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_68:Example only; attach a WAF web ACL in real deployments.
  #checkov:skip=CKV_AWS_86:Example only; enable access logging in real deployments.
  #checkov:skip=CKV_AWS_174:Example uses the default *.cloudfront.net certificate.
  #checkov:skip=CKV2_AWS_42:Example uses the default *.cloudfront.net certificate.
  #checkov:skip=CKV_AWS_305:Origin is an API, no default root object.
  #checkov:skip=CKV_AWS_310:Example has a single origin.
  #checkov:skip=CKV_AWS_374:Example has no geo restriction.
  #checkov:skip=CKV2_AWS_32:Example has no response headers policy.
  #checkov:skip=CKV2_AWS_47:Example only; attach a WAF web ACL in real deployments.

  enabled = true
  comment = "x402-edge basic example"

  origin {
    origin_id   = "httpbin"
    domain_name = "httpbin.org"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Free by default.
  default_cache_behavior {
    target_origin_id       = "httpbin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = module.x402.cache_policy_id
  }

  # Paid. One behavior per route pattern, all using the module's outputs.
  dynamic "ordered_cache_behavior" {
    for_each = toset(["/anything/premium/*"])
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "httpbin"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS"]
      cached_methods           = ["GET", "HEAD"]
      cache_policy_id          = module.x402.cache_policy_id
      origin_request_policy_id = module.x402.origin_request_policy_id

      dynamic "lambda_function_association" {
        for_each = module.x402.lambda_function_associations
        content {
          event_type   = lambda_function_association.value.event_type
          lambda_arn   = lambda_function_association.value.lambda_arn
          include_body = lambda_function_association.value.include_body
        }
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "paid_url" {
  description = "Request this without payment to see the 402 challenge."
  value       = "https://${aws_cloudfront_distribution.this.domain_name}/anything/premium/hello"
}

output "free_url" {
  description = "Same origin, no paywall."
  value       = "https://${aws_cloudfront_distribution.this.domain_name}/anything/free"
}
