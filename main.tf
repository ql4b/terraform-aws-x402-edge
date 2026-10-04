# ---------------------------------------------------------------------------
# x402 payment gate for an existing CloudFront distribution.
#
# Two Lambda@Edge functions from one generic bundle (assets/edge/index.js):
#   - origin-request:  verify the payment, or return a 402 challenge
#   - origin-response: settle only if the origin returned < 400
#
# The module does not own a distribution. It outputs the associations and
# policies a consumer attaches to its own cache behaviors, so the origin
# (S3, ALB, Function URL, ...) stays unaware of payments.
#
# Lambda@Edge has no environment variables, so the deployment-specific config
# is rendered from the inputs and added to the zip as config.json next to the
# bundle. A config change is a new zip hash -> new published version -> new
# qualified ARN for the consumer's behaviors.
# ---------------------------------------------------------------------------

data "aws_region" "current" {}

# Lambda@Edge functions must live in us-east-1. Pass a us-east-1 provider
# (`providers = { aws = aws.us_east_1 }`) when the caller's default is elsewhere.
resource "terraform_data" "region_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_region.current.region == "us-east-1"
      error_message = "terraform-aws-x402-edge must be instantiated with a us-east-1 AWS provider (Lambda@Edge requirement). Pass providers = { aws = aws.us_east_1 }."
    }
  }
}

# ---------------------------------------------------------------------------
# Rendered handler config (config.json)
# ---------------------------------------------------------------------------

locals {
  # Translate the snake_case route inputs into the x402 RoutesConfig shape the
  # handler expects. Unset optional attributes are omitted, not sent as null.
  x402_routes = {
    for pattern, r in var.routes : pattern => merge(
      {
        accepts = [merge(
          {
            scheme  = "exact"
            network = var.network
            payTo   = var.pay_to
            price   = r.price
          },
          r.max_timeout_seconds == null ? {} : { maxTimeoutSeconds = r.max_timeout_seconds },
        )]
      },
      r.description == null ? {} : { description = r.description },
      r.mime_type == null ? {} : { mimeType = r.mime_type },
      r.service_name == null ? {} : { serviceName = r.service_name },
      r.tags == null ? {} : { tags = r.tags },
      r.icon_url == null ? {} : { iconUrl = r.icon_url },
      r.extensions_json == null ? {} : { extensions = jsondecode(r.extensions_json) },
    )
  }

  edge_config = merge(
    {
      facilitatorUrl = var.facilitator_url
      routes         = local.x402_routes
    },
    var.public_host == null ? {} : { publicHost = var.public_host },
  )

  edge_config_json = jsonencode(local.edge_config)
}

data "archive_file" "edge" {
  type        = "zip"
  output_path = "${path.module}/.terraform/tmp/${module.this.id}-x402-edge.zip"

  source {
    content  = file("${path.module}/assets/edge/index.js")
    filename = "index.js"
  }

  source {
    content  = local.edge_config_json
    filename = "config.json"
  }
}

# ---------------------------------------------------------------------------
# Execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "edge" {
  name = "${module.this.id}-x402-edge"

  # Lambda@Edge needs both principals: lambda for the us-east-1 function,
  # edgelambda for the replicas CloudFront runs in edge locations.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] }
    }]
  })

  tags = module.this.tags
}

# Replica logs land in the region nearest the viewer, so the managed basic
# execution policy (CreateLogGroup/Stream + PutLogEvents in any region) is the
# right scope here.
resource "aws_iam_role_policy_attachment" "edge_basic" {
  role       = aws_iam_role.edge.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---------------------------------------------------------------------------
# Edge functions
# ---------------------------------------------------------------------------

locals {
  edge_functions = {
    origin-request  = "index.originRequestHandler"
    origin-response = "index.originResponseHandler"
  }
}

resource "aws_lambda_function" "edge" {
  for_each = local.edge_functions

  #checkov:skip=CKV_AWS_50:X-Ray tracing is not supported by Lambda@Edge.
  #checkov:skip=CKV_AWS_115:Concurrency for Lambda@Edge replicas is governed by regional quotas, not a per-function reservation.
  #checkov:skip=CKV_AWS_116:Dead letter queues are not supported by Lambda@Edge.
  #checkov:skip=CKV_AWS_117:VPC configuration is not supported by Lambda@Edge.
  #checkov:skip=CKV_AWS_173:Lambda@Edge has no environment variables to encrypt.
  #checkov:skip=CKV_AWS_272:Code signing is out of scope; the bundle ships in this module and is pinned by source_code_hash.

  function_name    = "${module.this.id}-x402-${each.key}"
  description      = "x402 ${each.key == "origin-request" ? "payment verification" : "payment settlement"} (${each.key}) - ${module.this.id}"
  role             = aws_iam_role.edge.arn
  runtime          = var.runtime
  handler          = each.value
  architectures    = ["x86_64"] # Lambda@Edge does not support arm64
  filename         = data.archive_file.edge.output_path
  source_code_hash = data.archive_file.edge.output_base64sha256
  publish          = true # CloudFront requires a numbered version
  timeout          = var.timeout
  memory_size      = var.memory_size

  tags = module.this.tags

  depends_on = [terraform_data.region_guard]
}

# ---------------------------------------------------------------------------
# Policies for the consumer's paid cache behaviors
# ---------------------------------------------------------------------------

# Caching must be disabled on paid behaviors: origin-request only runs on a
# cache miss, so a cached paid response would be served without verification.
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# The origin-request function only sees headers the origin request policy
# forwards, so payment-signature must be in it. Kept minimal (no Host header),
# which is safe for S3 + OAC origins.
resource "aws_cloudfront_origin_request_policy" "this" {
  name    = "${module.this.id}-x402"
  comment = "x402 paid routes: forwards payment-signature to the origin-request edge function"

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = distinct(concat(["payment-signature"], [for h in var.forwarded_headers : lower(h)]))
    }
  }

  query_strings_config {
    query_string_behavior = var.forward_query_strings ? "all" : "none"
  }

  cookies_config {
    cookie_behavior = var.forward_cookies ? "all" : "none"
  }
}
