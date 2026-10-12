# Unit tests for terraform-aws-x402-edge.
# These run with `command = plan` — no real resources are created.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }
}

mock_provider "archive" {}

mock_provider "http" {}

variables {
  namespace       = "test"
  name            = "shop"
  facilitator_url = "https://facilitator.example"
  network         = "eip155:8453"
  pay_to          = "0x61A87C2387c249840610bccB40253DbD411AD572"
  routes = {
    "/api/premium/*" = {
      price       = "$0.01"
      description = "Premium data"
      mime_type   = "application/json"
    }
  }
}

# --- Edge functions ---

run "defaults_create_two_published_edge_functions" {
  command = plan

  assert {
    condition     = length(aws_lambda_function.edge) == 2
    error_message = "Expected one origin-request and one origin-response function."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.edge : f.publish && f.runtime == "nodejs22.x" && f.architectures == tolist(["x86_64"])])
    error_message = "Edge functions must be published, nodejs22.x and x86_64."
  }

  assert {
    condition     = aws_lambda_function.edge["origin-request"].handler == "index.originRequestHandler" && aws_lambda_function.edge["origin-response"].handler == "index.originResponseHandler"
    error_message = "Each function must point at its handler export."
  }

  assert {
    condition     = aws_lambda_function.edge["origin-request"].function_name == "test-shop-x402-origin-request"
    error_message = "Function names must derive from module.this.id."
  }
}

run "role_trusts_lambda_and_edgelambda" {
  command = plan

  assert {
    condition     = toset(jsondecode(aws_iam_role.edge.assume_role_policy).Statement[0].Principal.Service) == toset(["lambda.amazonaws.com", "edgelambda.amazonaws.com"])
    error_message = "The role must trust both lambda and edgelambda."
  }
}

# --- Rendered config.json ---

run "config_renders_routes_in_x402_shape" {
  command = plan

  assert {
    condition     = jsondecode(output.config_json).facilitatorUrl == "https://facilitator.example"
    error_message = "facilitatorUrl missing from config."
  }

  assert {
    condition = jsondecode(output.config_json).routes["/api/premium/*"].accepts[0] == {
      scheme  = "exact"
      network = "eip155:8453"
      payTo   = "0x61A87C2387c249840610bccB40253DbD411AD572"
      price   = "$0.01"
    }
    error_message = "accepts must be rendered as a single exact/network/payTo/price entry."
  }

  assert {
    condition     = jsondecode(output.config_json).routes["/api/premium/*"].mimeType == "application/json"
    error_message = "mime_type must be rendered as mimeType."
  }
}

run "unset_optionals_are_omitted" {
  command = plan

  assert {
    condition     = !contains(keys(jsondecode(output.config_json)), "publicHost")
    error_message = "publicHost must be omitted when public_host is null."
  }

  assert {
    condition     = !contains(keys(jsondecode(output.config_json).routes["/api/premium/*"]), "extensions")
    error_message = "extensions must be omitted when extensions_json is null."
  }

  assert {
    condition     = !contains(keys(jsondecode(output.config_json)), "supported")
    error_message = "supported must be omitted when bake_supported is false (default)."
  }
}

run "bake_supported_fetches_and_embeds_supported" {
  command = plan

  variables {
    bake_supported = true
  }

  # Stand in for the facilitator's /supported response so the plan does not
  # reach the network. The handler reads config.supported verbatim.
  override_data {
    target = data.http.supported[0]
    values = {
      status_code   = 200
      response_body = "{\"kinds\":[{\"x402Version\":2,\"scheme\":\"exact\",\"network\":\"eip155:8453\"}],\"extensions\":[\"bazaar\"],\"signers\":{\"eip155:*\":[\"0xabc\"]}}"
    }
  }

  assert {
    condition     = jsondecode(output.config_json).supported.kinds[0].network == "eip155:8453"
    error_message = "bake_supported must embed the fetched /supported kinds into config.json."
  }

  assert {
    condition     = contains(jsondecode(output.config_json).supported.extensions, "bazaar")
    error_message = "bake_supported must embed the facilitator extensions."
  }
}

run "public_host_and_extensions_rendered_when_set" {
  command = plan

  variables {
    public_host = "api.example.com"
    routes = {
      "GET /v1/data" = {
        price           = "$0.001"
        extensions_json = jsonencode({ bazaar = { info = { name = "data" } } })
      }
    }
  }

  assert {
    condition     = jsondecode(output.config_json).publicHost == "api.example.com"
    error_message = "publicHost must be rendered when set."
  }

  assert {
    condition     = jsondecode(output.config_json).routes["GET /v1/data"].extensions.bazaar.info.name == "data"
    error_message = "extensions_json must be decoded into the route's extensions."
  }
}

# --- Facilitator auth (facilitator_auth) ---

run "no_facilitator_auth_by_default" {
  command = plan

  assert {
    condition     = !contains(keys(jsondecode(output.config_json)), "facilitatorAuth")
    error_message = "facilitatorAuth must be omitted when facilitator_auth is null."
  }

  assert {
    condition     = length(aws_iam_role_policy.facilitator_secret) == 0
    error_message = "No secret grant without facilitator_auth."
  }
}

run "cdp_facilitator_auth_renders_arn_and_grants_read" {
  command = plan

  variables {
    facilitator_url = "https://api.cdp.coinbase.com/platform/v2/x402"
    facilitator_auth = {
      type       = "cdp"
      secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x402/cdp-AbCdEf"
    }
  }

  assert {
    condition = jsondecode(output.config_json).facilitatorAuth == {
      type            = "cdp"
      secretArn       = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x402/cdp-AbCdEf"
      cacheTtlSeconds = 300
    }
    error_message = "facilitatorAuth must carry type, the secret ARN and the default 300 s TTL."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.facilitator_secret[0].policy).Statement[0].Action == "secretsmanager:GetSecretValue"
    error_message = "The grant must be GetSecretValue only."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.facilitator_secret[0].policy).Statement[0].Resource == "arn:aws:secretsmanager:*:123456789012:secret:x402/cdp-AbCdEf"
    error_message = "The grant must cover exactly this secret, in any region (replicas)."
  }
}

run "facilitator_auth_unknown_type_fails" {
  command = plan

  variables {
    facilitator_auth = {
      type       = "bearer"
      secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x402/cdp-AbCdEf"
    }
  }

  expect_failures = [var.facilitator_auth]
}

run "facilitator_auth_partial_arn_fails" {
  command = plan

  variables {
    facilitator_auth = {
      type       = "cdp"
      secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x402/cdp"
    }
  }

  expect_failures = [var.facilitator_auth]
}

run "facilitator_auth_with_bake_supported_fails" {
  command = plan

  variables {
    bake_supported = true
    facilitator_auth = {
      type       = "cdp"
      secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x402/cdp-AbCdEf"
    }
  }

  override_data {
    target = data.http.supported[0]
    values = {
      status_code   = 200
      response_body = "{\"kinds\":[{\"x402Version\":2,\"scheme\":\"exact\",\"network\":\"eip155:8453\"}]}"
    }
  }

  expect_failures = [data.http.supported]
}

# --- Policies and associations ---

run "origin_request_policy_forwards_payment_signature" {
  command = plan

  variables {
    forwarded_headers = ["Authorization"]
  }

  assert {
    condition     = toset(aws_cloudfront_origin_request_policy.this.headers_config[0].headers[0].items) == toset(["payment-signature", "authorization"])
    error_message = "The policy must forward payment-signature plus forwarded_headers (lowercased)."
  }

  assert {
    condition     = aws_cloudfront_origin_request_policy.this.cookies_config[0].cookie_behavior == "none" && aws_cloudfront_origin_request_policy.this.query_strings_config[0].query_string_behavior == "all"
    error_message = "Defaults: cookies none, query strings all."
  }
}

run "associations_cover_both_origin_events" {
  command = plan

  assert {
    condition     = [for a in output.lambda_function_associations : a.event_type] == ["origin-request", "origin-response"]
    error_message = "Associations must cover origin-request then origin-response."
  }

  assert {
    condition     = data.aws_cloudfront_cache_policy.disabled.name == "Managed-CachingDisabled"
    error_message = "Paid behaviors must use the managed CachingDisabled cache policy."
  }
}

# --- Guards and validation ---

run "non_us_east_1_provider_fails" {
  command = plan

  override_data {
    target = data.aws_region.current
    values = {
      region = "eu-west-1"
    }
  }

  expect_failures = [terraform_data.region_guard]
}

run "non_evm_network_fails" {
  command = plan

  variables {
    network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  }

  expect_failures = [var.network]
}

run "route_key_without_leading_slash_fails" {
  command = plan

  variables {
    routes = {
      "api/premium" = { price = "$0.01" }
    }
  }

  expect_failures = [var.routes]
}

run "invalid_extensions_json_fails" {
  command = plan

  variables {
    routes = {
      "/api" = { price = "$0.01", extensions_json = "{not json" }
    }
  }

  expect_failures = [var.routes]
}

run "empty_routes_fails" {
  command = plan

  variables {
    routes = {}
  }

  expect_failures = [var.routes]
}
