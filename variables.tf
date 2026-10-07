# ---------------------------------------------------------------------------
# Payment configuration
# ---------------------------------------------------------------------------

variable "facilitator_url" {
  type        = string
  description = "Base URL of the x402 facilitator that verifies and settles payments (e.g. https://facilitator.payai.network or https://x402.org/facilitator). The facilitator must advertise the `exact` scheme on `network` and must accept unauthenticated requests: facilitators that require an API key (e.g. Coinbase CDP) are not supported yet (see issue #2). It submits settlements on-chain and fronts the gas; whether that is free or billed depends on the facilitator."

  validation {
    condition     = can(regex("^https://[^/]+", var.facilitator_url))
    error_message = "facilitator_url must be an https:// URL."
  }
}

variable "network" {
  type        = string
  description = "EVM network for payments, as a CAIP-2 id (e.g. `eip155:8453` for Base mainnet, `eip155:84532` for Base Sepolia). The bundled handler registers only the EVM `exact` scheme, so non-EVM networks are rejected."

  validation {
    condition     = can(regex("^eip155:[0-9]+$", var.network))
    error_message = "network must be an EVM CAIP-2 id of the form 'eip155:<chainId>'. Only the EVM exact scheme is supported by the bundled handler."
  }
}

variable "pay_to" {
  type        = string
  description = "Receiving wallet address (the seller). Every paid route settles to this address."

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.pay_to))
    error_message = "pay_to must be a 0x-prefixed 20-byte EVM address."
  }
}

variable "public_host" {
  type        = string
  description = "Public host name advertised in the challenge `resource.url` (e.g. `api.example.com`). Lambda@Edge only sees the `*.cloudfront.net` distribution domain, so set this when the distribution has a custom alias. Leave null to advertise the CloudFront domain."
  default     = null

  validation {
    condition     = var.public_host == null || can(regex("^[A-Za-z0-9.-]+$", var.public_host))
    error_message = "public_host must be a bare host name (no scheme, path or port), e.g. 'api.example.com'."
  }
}

variable "routes" {
  type = map(object({
    price               = string                 # e.g. "$0.001" (USD, resolved to the network's USDC)
    description         = optional(string)       # shown in the challenge resource
    mime_type           = optional(string)       # media type of the paid response
    service_name        = optional(string)       # provider metadata for discovery listings
    tags                = optional(list(string)) # provider metadata for discovery listings
    icon_url            = optional(string)       # provider metadata for discovery listings
    max_timeout_seconds = optional(number)       # authorization validity window
    extensions_json     = optional(string)       # jsonencode()d x402 extensions, e.g. { bazaar = {...} }
  }))
  description = <<-EOT
    Payment-gated routes, keyed by x402 route pattern. Patterns are `/path`,
    `/path/*` (trailing wildcard; also matches `/path` itself), `/a/[id]` or
    `/a/:id`, with an optional verb prefix (`GET /path`). Requests that match no
    route pass through to the origin untouched.

    Each paid path must also be covered by a CloudFront cache behavior that uses
    this module's `lambda_function_associations`, `cache_policy_id` and
    `origin_request_policy_id` — the route decides which requests require
    payment; the behavior decides which requests run the edge functions.

    `extensions_json` is a JSON string (use `jsonencode`) because extension
    objects differ in shape between routes, which a Terraform map type cannot
    hold. It is emitted verbatim as the challenge `extensions`.
  EOT

  validation {
    condition     = length(var.routes) > 0
    error_message = "routes must contain at least one route."
  }

  validation {
    condition     = alltrue([for k in keys(var.routes) : can(regex("^([A-Za-z]+ )?/", k))])
    error_message = "Each routes key must be an x402 route pattern starting with '/', optionally prefixed by an HTTP verb (e.g. 'GET /api/premium')."
  }

  validation {
    condition     = alltrue([for r in values(var.routes) : r.extensions_json == null || can(jsondecode(r.extensions_json))])
    error_message = "routes[*].extensions_json must be valid JSON (build it with jsonencode)."
  }
}

# ---------------------------------------------------------------------------
# Cold-start optimization
# ---------------------------------------------------------------------------

variable "bake_supported" {
  type        = bool
  description = <<-EOT
    Fetch the facilitator's `/supported` response at plan time and bake it into
    config.json, so the edge functions do not call `GET /supported` on cold
    start. That call is the single blocking network round trip that dominates
    Lambda@Edge cold-start latency; verify and settle still reach the
    facilitator at request time.

    Default false keeps the live fetch (current behaviour). When true, the
    plan performs an HTTP GET to the facilitator's `/supported` endpoint, so it
    must be reachable and unauthenticated at plan time (the same constraint the
    handler already has). If the facilitator later stops advertising the
    configured network/scheme, verify fails at request time until the next
    apply re-bakes the value — the 402 challenge is unaffected.
  EOT
  default     = false
}

variable "forwarded_headers" {
  type        = list(string)
  description = "Additional viewer headers the created origin request policy forwards to the origin, on top of `payment-signature` (which the edge function needs and is always included). Leave empty for S3 origins."
  default     = []

  validation {
    condition     = length(var.forwarded_headers) <= 9
    error_message = "CloudFront origin request policies allow 10 headers; payment-signature uses one, so at most 9 forwarded_headers."
  }
}

variable "forward_query_strings" {
  type        = bool
  description = "Whether the created origin request policy forwards all query strings to the origin."
  default     = true
}

variable "forward_cookies" {
  type        = bool
  description = "Whether the created origin request policy forwards all cookies to the origin."
  default     = false
}

# ---------------------------------------------------------------------------
# Edge functions
# ---------------------------------------------------------------------------

variable "runtime" {
  type        = string
  description = "Node.js runtime for both edge functions. The bundled handler targets Node.js 22."
  default     = "nodejs22.x"

  validation {
    condition     = can(regex("^nodejs(2[2-9]|[3-9][0-9])\\.x$", var.runtime))
    error_message = "runtime must be nodejs22.x or newer; the bundle is built for Node.js 22."
  }
}

variable "memory_size" {
  type        = number
  description = "Memory (MB) for both edge functions."
  default     = 256
}

variable "timeout" {
  type        = number
  description = "Timeout (seconds) for both edge functions. Covers the facilitator call on verify and settle. Origin-facing Lambda@Edge events allow up to 30 seconds."
  default     = 5

  validation {
    condition     = var.timeout >= 1 && var.timeout <= 30
    error_message = "timeout must be between 1 and 30 seconds for origin-request/origin-response Lambda@Edge functions."
  }
}
