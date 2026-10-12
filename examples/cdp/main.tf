# CDP example — the basic paywall, verified and settled by the Coinbase CDP
# facilitator with an API key held in Secrets Manager.
#
# The CDP Secret API key is created out of band (see README.md) and looked up
# here by name. Only secret metadata is read: the value never enters this
# configuration, the plan or the state. The edge functions read it at runtime
# with the GetSecretValue grant the module adds to their role.
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
  description = "EVM CAIP-2 network id. Base Sepolia by default (testnet USDC); eip155:8453 for Base mainnet."
  type        = string
  default     = "eip155:84532"
}

variable "cdp_secret_name" {
  description = "Name of the Secrets Manager secret holding the CDP key as {\"apiKeyId\": \"...\", \"apiKeySecret\": \"...\"}."
  type        = string
  default     = "x402/cdp-facilitator"
}

# Metadata only (ARN, name); the secret value is not read.
data "aws_secretsmanager_secret" "cdp" {
  name = var.cdp_secret_name
}

module "x402" {
  source = "../../"

  facilitator_url = "https://api.cdp.coinbase.com/platform/v2/x402"
  facilitator_auth = {
    type       = "cdp"
    secret_arn = data.aws_secretsmanager_secret.cdp.arn
    # cache_ttl_seconds = 300 # how long an instance reuses the fetched value
  }
  # bake_supported must stay false (default): CDP's /supported requires auth.

  network = var.network
  pay_to  = var.pay_to

  routes = {
    "/anything/premium/*" = {
      price       = "$0.001"
      description = "Echoed request, paid per call"
      mime_type   = "application/json"
    }
  }

  namespace = "myorg"
  name      = "paywall-cdp"
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
  comment = "x402-edge CDP example"

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

output "edge_function_names" {
  description = "Edge function names; logs (including the secret-fetch line) are in /aws/lambda/us-east-1.<name> in the region nearest the viewer."
  value       = module.x402.function_names
}
