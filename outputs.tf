# Behavior wiring outputs

output "lambda_function_associations" {
  description = "Lambda@Edge associations for each paid cache behavior: origin-request (verify) and origin-response (settle), as qualified (versioned) ARNs. Use with a dynamic lambda_function_association block."
  value = [
    for event in ["origin-request", "origin-response"] : {
      event_type   = event
      lambda_arn   = aws_lambda_function.edge[event].qualified_arn
      include_body = false
    }
  ]
}

output "cache_policy_id" {
  description = "ID of the managed CachingDisabled cache policy. Paid behaviors must use it: a cache hit skips the origin-request function and would serve paid content unverified."
  value       = data.aws_cloudfront_cache_policy.disabled.id
}

output "origin_request_policy_id" {
  description = "ID of the origin request policy that forwards payment-signature (plus forwarded_headers) to the edge function and origin. Paid behaviors must use it or an equivalent that forwards payment-signature."
  value       = aws_cloudfront_origin_request_policy.this.id
}

output "route_patterns" {
  description = "The configured x402 route patterns (keys of var.routes). Each must be covered by a paid cache behavior."
  value       = keys(var.routes)
}

# Function outputs

output "origin_request_function_qualified_arn" {
  description = "Qualified ARN of the origin-request (verify) function."
  value       = aws_lambda_function.edge["origin-request"].qualified_arn
}

output "origin_response_function_qualified_arn" {
  description = "Qualified ARN of the origin-response (settle) function."
  value       = aws_lambda_function.edge["origin-response"].qualified_arn
}

output "function_names" {
  description = "Names of the edge functions, keyed by event type. Logs are written to /aws/lambda/us-east-1.<name> in the region nearest each viewer."
  value       = { for k, f in aws_lambda_function.edge : k => f.function_name }
}

output "role_arn" {
  description = "ARN of the edge functions' execution role."
  value       = aws_iam_role.edge.arn
}

# Config output

output "config_json" {
  description = "The rendered config.json shipped in the edge zip, for inspection and debugging."
  value       = local.edge_config_json
}
