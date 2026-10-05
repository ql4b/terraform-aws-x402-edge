# terraform-aws-x402-edge

> Add x402 payments to paths of an existing CloudFront distribution

Terraform module that creates a pair of Lambda@Edge functions implementing the
[x402](https://github.com/x402-foundation/x402) payment protocol (v2, EVM
`exact` scheme), plus the cache and origin request policies a paid route needs.
It does not create or own a distribution: you attach its outputs to the cache
behaviors you want to charge for, and the origin behind them (S3, ALB, Lambda
Function URL, anything) stays unaware of payments.

## Features

- **Plugs into any distribution** — outputs `lambda_function_associations` for your own `ordered_cache_behavior` blocks
- **Verify, then settle on success** — origin-request verifies the payment or returns `402`; origin-response settles only when the origin answered `< 400`, so clients are not charged for failures
- **No edge build step** — the handler bundle ships prebuilt; your config is rendered to `config.json` and added to the deployment zip at plan time
- **Config changes are plain applies** — changing a price, payee or route publishes a new function version
- **Safe defaults enforced** — CachingDisabled for paid behaviors and an origin request policy that forwards `payment-signature`
- **Discovery metadata per route** — description, MIME type, service name, tags, icon and x402 extensions (e.g. Bazaar)

## Usage

```hcl
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

module "x402" {
  source  = "ql4b/x402-edge/aws"
  version = "~> 1.0"

  providers = { aws = aws.us_east_1 }

  facilitator_url = "https://facilitator.payai.network"
  network         = "eip155:8453" # Base mainnet
  pay_to          = "0xYourReceivingWallet"
  public_host     = "api.example.com"

  routes = {
    "/api/premium/*" = {
      price       = "$0.01"
      description = "Premium data, paid per request"
      mime_type   = "application/json"
    }
  }

  namespace = "myorg"
  name      = "api"
}
```

Then, in your distribution, add one behavior per paid path:

```hcl
ordered_cache_behavior {
  path_pattern             = "/api/premium/*"
  target_origin_id         = "api"
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
```

> **Tip:** Always pin to a version constraint (e.g. `version = "~> 1.0"`). Browse
> available versions on the [Terraform Registry](https://registry.terraform.io/modules/ql4b/x402-edge/aws/latest) page.

## Requirements

- Terraform `>= 1.4` (uses `terraform_data` for the region guard)
- AWS provider `>= 6.0` (uses `aws_region.region`)
- The module's AWS provider must be in **us-east-1** (Lambda@Edge requirement); the plan fails otherwise
- Your distribution must be managed in Terraform (or you attach the associations yourself)

## How it works

```text
viewer -> CloudFront (paid behavior, CachingDisabled)
            origin-request  : no/invalid payment  -> 402 + PAYMENT-REQUIRED
                              valid payment        -> forward to origin
            origin           : your backend, unchanged
            origin-response : origin < 400         -> settle, add PAYMENT-RESPONSE
                              origin >= 400        -> pass through, no charge
```

A client that already knows the terms may send `PAYMENT-SIGNATURE` on its first
request; the `402` round trip is optional.

Lambda@Edge has no environment variables. The module renders `facilitator_url`,
`network`, `pay_to`, `public_host` and `routes` into `config.json` and zips it
next to the generic handler (`assets/edge/index.js`). The handler fails at cold
start if the config is missing or invalid, rather than serving the origin
unpaid. Inspect the rendered file with the `config_json` output.

## Facilitators

The facilitator must accept **unauthenticated** requests. The handler sends no
auth headers on `verify`, `settle` or `supported`, so facilitators that require
an API key are not supported yet — this includes the Coinbase CDP facilitator.

Unauthenticated facilitators such as `https://facilitator.payai.network` and
`https://x402.org/facilitator` work as-is.

Authenticated facilitators are planned for v1.1.0, tracked in
[#2](https://github.com/ql4b/terraform-aws-x402-edge/issues/2). Lambda@Edge has
no environment variables and `config.json` ends up in state and in the zip, so
credentials will be read at runtime from a referenced secret, never passed by
value.

## Routes

`routes` is keyed by x402 route pattern:

| Pattern | Matches |
| ------- | ------- |
| `/api/data` | exactly `/api/data` |
| `/api/*` | `/api` and anything under it |
| `/items/[id]`, `/items/:id` | one path segment |
| `GET /api/data` | only that verb |

Requests that match no route pass through to the origin. The route decides
which requests require payment; the CloudFront behavior decides which requests
run the functions. Keep them covering the same paths. Note one difference:
x402's `/api/*` also matches `/api`, CloudFront's `/api/*` does not.

Extensions differ in shape between routes, so pass them as a JSON string:

```hcl
routes = {
  "/v1/data" = {
    price = "$0.001"
    extensions_json = jsonencode({
      bazaar = {
        info = {
          input  = { type = "http", method = "GET" }
          output = { example = { ok = true } }
        }
      }
    })
  }
}
```

## Constraints

**Caching must stay disabled on paid behaviors.** The origin-request function
only runs on a cache miss, so a cached paid response would be served without
verification. Use `cache_policy_id`.

**`payment-signature` must reach the function.** The function sees only the
headers the origin request policy forwards. Use `origin_request_policy_id`, or
your own policy that includes `payment-signature`. Add headers your origin needs
with `forwarded_headers`.

**One function per event type.** A behavior that already has origin-request or
origin-response Lambda@Edge associations cannot also take these.

**Behavior order matters.** CloudFront uses the first matching behavior, so
paid patterns must precede broader patterns that match the same paths.

**Settlement costs gas.** The payer only signs (EIP-3009) and needs no ETH; the
facilitator submits the transfer on-chain and fronts the gas. Whether that is
free or billed depends on the facilitator you choose.

**Destroy is slow.** CloudFront must remove the edge replicas before the
functions can be deleted, which can take hours. Retry a destroy that fails on
the functions.

**Logs are regional.** Each replica logs to `/aws/lambda/us-east-1.<function>`
in the region nearest the viewer (see `function_names`).

## Outputs

- `lambda_function_associations` — origin-request and origin-response associations (qualified ARNs) for your paid behaviors
- `cache_policy_id` — managed CachingDisabled policy
- `origin_request_policy_id` — policy forwarding `payment-signature`
- `route_patterns` — configured route keys
- `config_json` — the rendered `config.json`

## Handler

The bundle in `assets/edge/index.js` is built from `handler/` (TypeScript,
adapted from the x402-foundation
[cloudfront-lambda-edge](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/cloudfront-lambda-edge)
example). To rebuild after changing the handler:

```bash
cd handler && npm ci && npm run typecheck && npm run build
```

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.4 |
| <a name="requirement_archive"></a> [archive](#requirement\_archive) | >= 2.4 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 6.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_archive"></a> [archive](#provider\_archive) | >= 2.4 |
| <a name="provider_aws"></a> [aws](#provider\_aws) | >= 6.0 |
| <a name="provider_terraform"></a> [terraform](#provider\_terraform) | n/a |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_this"></a> [this](#module\_this) | cloudposse/label/null | 0.25.0 |

## Resources

| Name | Type |
|------|------|
| [aws_cloudfront_origin_request_policy.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_origin_request_policy) | resource |
| [aws_iam_role.edge](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy_attachment.edge_basic](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_lambda_function.edge](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [terraform_data.region_guard](https://registry.terraform.io/providers/hashicorp/terraform/latest/docs/resources/data) | resource |
| [archive_file.edge](https://registry.terraform.io/providers/hashicorp/archive/latest/docs/data-sources/file) | data source |
| [aws_cloudfront_cache_policy.disabled](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/cloudfront_cache_policy) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_facilitator_url"></a> [facilitator\_url](#input\_facilitator\_url) | Base URL of the x402 facilitator that verifies and settles payments (e.g. https://facilitator.payai.network or https://x402.org/facilitator). The facilitator must advertise the `exact` scheme on `network`. It submits settlements on-chain and fronts the gas; whether that is free or billed depends on the facilitator. | `string` | n/a | yes |
| <a name="input_network"></a> [network](#input\_network) | EVM network for payments, as a CAIP-2 id (e.g. `eip155:8453` for Base mainnet, `eip155:84532` for Base Sepolia). The bundled handler registers only the EVM `exact` scheme, so non-EVM networks are rejected. | `string` | n/a | yes |
| <a name="input_pay_to"></a> [pay\_to](#input\_pay\_to) | Receiving wallet address (the seller). Every paid route settles to this address. | `string` | n/a | yes |
| <a name="input_routes"></a> [routes](#input\_routes) | Payment-gated routes, keyed by x402 route pattern. Patterns are `/path`,<br/>`/path/*` (trailing wildcard; also matches `/path` itself), `/a/[id]` or<br/>`/a/:id`, with an optional verb prefix (`GET /path`). Requests that match no<br/>route pass through to the origin untouched.<br/><br/>Each paid path must also be covered by a CloudFront cache behavior that uses<br/>this module's `lambda_function_associations`, `cache_policy_id` and<br/>`origin_request_policy_id` — the route decides which requests require<br/>payment; the behavior decides which requests run the edge functions.<br/><br/>`extensions_json` is a JSON string (use `jsonencode`) because extension<br/>objects differ in shape between routes, which a Terraform map type cannot<br/>hold. It is emitted verbatim as the challenge `extensions`. | <pre>map(object({<br/>    price               = string                 # e.g. "$0.001" (USD, resolved to the network's USDC)<br/>    description         = optional(string)       # shown in the challenge resource<br/>    mime_type           = optional(string)       # media type of the paid response<br/>    service_name        = optional(string)       # provider metadata for discovery listings<br/>    tags                = optional(list(string)) # provider metadata for discovery listings<br/>    icon_url            = optional(string)       # provider metadata for discovery listings<br/>    max_timeout_seconds = optional(number)       # authorization validity window<br/>    extensions_json     = optional(string)       # jsonencode()d x402 extensions, e.g. { bazaar = {...} }<br/>  }))</pre> | n/a | yes |
| <a name="input_additional_tag_map"></a> [additional\_tag\_map](#input\_additional\_tag\_map) | Additional key-value pairs to add to each map in `tags_as_list_of_maps`. Not added to `tags` or `id`.<br/>This is for some rare cases where resources want additional configuration of tags<br/>and therefore take a list of maps with tag key, value, and additional configuration. | `map(string)` | `{}` | no |
| <a name="input_attributes"></a> [attributes](#input\_attributes) | ID element. Additional attributes (e.g. `workers` or `cluster`) to add to `id`,<br/>in the order they appear in the list. New attributes are appended to the<br/>end of the list. The elements of the list are joined by the `delimiter`<br/>and treated as a single ID element. | `list(string)` | `[]` | no |
| <a name="input_context"></a> [context](#input\_context) | Single object for setting entire context at once.<br/>See description of individual variables for details.<br/>Leave string and numeric variables as `null` to use default value.<br/>Individual variable settings (non-null) override settings in context object,<br/>except for attributes, tags, and additional\_tag\_map, which are merged. | `any` | <pre>{<br/>  "additional_tag_map": {},<br/>  "attributes": [],<br/>  "delimiter": null,<br/>  "descriptor_formats": {},<br/>  "enabled": true,<br/>  "environment": null,<br/>  "id_length_limit": null,<br/>  "label_key_case": null,<br/>  "label_order": [],<br/>  "label_value_case": null,<br/>  "labels_as_tags": [<br/>    "unset"<br/>  ],<br/>  "name": null,<br/>  "namespace": null,<br/>  "regex_replace_chars": null,<br/>  "stage": null,<br/>  "tags": {},<br/>  "tenant": null<br/>}</pre> | no |
| <a name="input_delimiter"></a> [delimiter](#input\_delimiter) | Delimiter to be used between ID elements.<br/>Defaults to `-` (hyphen). Set to `""` to use no delimiter at all. | `string` | `null` | no |
| <a name="input_descriptor_formats"></a> [descriptor\_formats](#input\_descriptor\_formats) | Describe additional descriptors to be output in the `descriptors` output map.<br/>Map of maps. Keys are names of descriptors. Values are maps of the form<br/>`{<br/>   format = string<br/>   labels = list(string)<br/>}`<br/>(Type is `any` so the map values can later be enhanced to provide additional options.)<br/>`format` is a Terraform format string to be passed to the `format()` function.<br/>`labels` is a list of labels, in order, to pass to `format()` function.<br/>Label values will be normalized before being passed to `format()` so they will be<br/>identical to how they appear in `id`.<br/>Default is `{}` (`descriptors` output will be empty). | `any` | `{}` | no |
| <a name="input_enabled"></a> [enabled](#input\_enabled) | Set to false to prevent the module from creating any resources | `bool` | `null` | no |
| <a name="input_environment"></a> [environment](#input\_environment) | ID element. Usually used for region e.g. 'uw2', 'us-west-2', OR role 'prod', 'staging', 'dev', 'UAT' | `string` | `null` | no |
| <a name="input_forward_cookies"></a> [forward\_cookies](#input\_forward\_cookies) | Whether the created origin request policy forwards all cookies to the origin. | `bool` | `false` | no |
| <a name="input_forward_query_strings"></a> [forward\_query\_strings](#input\_forward\_query\_strings) | Whether the created origin request policy forwards all query strings to the origin. | `bool` | `true` | no |
| <a name="input_forwarded_headers"></a> [forwarded\_headers](#input\_forwarded\_headers) | Additional viewer headers the created origin request policy forwards to the origin, on top of `payment-signature` (which the edge function needs and is always included). Leave empty for S3 origins. | `list(string)` | `[]` | no |
| <a name="input_id_length_limit"></a> [id\_length\_limit](#input\_id\_length\_limit) | Limit `id` to this many characters (minimum 6).<br/>Set to `0` for unlimited length.<br/>Set to `null` for keep the existing setting, which defaults to `0`.<br/>Does not affect `id_full`. | `number` | `null` | no |
| <a name="input_label_key_case"></a> [label\_key\_case](#input\_label\_key\_case) | Controls the letter case of the `tags` keys (label names) for tags generated by this module.<br/>Does not affect keys of tags passed in via the `tags` input.<br/>Possible values: `lower`, `title`, `upper`.<br/>Default value: `title`. | `string` | `null` | no |
| <a name="input_label_order"></a> [label\_order](#input\_label\_order) | The order in which the labels (ID elements) appear in the `id`.<br/>Defaults to ["namespace", "environment", "stage", "name", "attributes"].<br/>You can omit any of the 6 labels ("tenant" is the 6th), but at least one must be present. | `list(string)` | `null` | no |
| <a name="input_label_value_case"></a> [label\_value\_case](#input\_label\_value\_case) | Controls the letter case of ID elements (labels) as included in `id`,<br/>set as tag values, and output by this module individually.<br/>Does not affect values of tags passed in via the `tags` input.<br/>Possible values: `lower`, `title`, `upper` and `none` (no transformation).<br/>Set this to `title` and set `delimiter` to `""` to yield Pascal Case IDs.<br/>Default value: `lower`. | `string` | `null` | no |
| <a name="input_labels_as_tags"></a> [labels\_as\_tags](#input\_labels\_as\_tags) | Set of labels (ID elements) to include as tags in the `tags` output.<br/>Default is to include all labels.<br/>Tags with empty values will not be included in the `tags` output.<br/>Set to `[]` to suppress all generated tags.<br/>**Notes:**<br/>  The value of the `name` tag, if included, will be the `id`, not the `name`.<br/>  Unlike other `null-label` inputs, the initial setting of `labels_as_tags` cannot be<br/>  changed in later chained modules. Attempts to change it will be silently ignored. | `set(string)` | <pre>[<br/>  "default"<br/>]</pre> | no |
| <a name="input_memory_size"></a> [memory\_size](#input\_memory\_size) | Memory (MB) for both edge functions. | `number` | `256` | no |
| <a name="input_name"></a> [name](#input\_name) | ID element. Usually the component or solution name, e.g. 'app' or 'jenkins'.<br/>This is the only ID element not also included as a `tag`.<br/>The "name" tag is set to the full `id` string. There is no tag with the value of the `name` input. | `string` | `null` | no |
| <a name="input_namespace"></a> [namespace](#input\_namespace) | ID element. Usually an abbreviation of your organization name, e.g. 'eg' or 'cp', to help ensure generated IDs are globally unique | `string` | `null` | no |
| <a name="input_public_host"></a> [public\_host](#input\_public\_host) | Public host name advertised in the challenge `resource.url` (e.g. `api.example.com`). Lambda@Edge only sees the `*.cloudfront.net` distribution domain, so set this when the distribution has a custom alias. Leave null to advertise the CloudFront domain. | `string` | `null` | no |
| <a name="input_regex_replace_chars"></a> [regex\_replace\_chars](#input\_regex\_replace\_chars) | Terraform regular expression (regex) string.<br/>Characters matching the regex will be removed from the ID elements.<br/>If not set, `"/[^a-zA-Z0-9-]/"` is used to remove all characters other than hyphens, letters and digits. | `string` | `null` | no |
| <a name="input_runtime"></a> [runtime](#input\_runtime) | Node.js runtime for both edge functions. The bundled handler targets Node.js 22. | `string` | `"nodejs22.x"` | no |
| <a name="input_stage"></a> [stage](#input\_stage) | ID element. Usually used to indicate role, e.g. 'prod', 'staging', 'source', 'build', 'test', 'deploy', 'release' | `string` | `null` | no |
| <a name="input_tags"></a> [tags](#input\_tags) | Additional tags (e.g. `{'BusinessUnit': 'XYZ'}`).<br/>Neither the tag keys nor the tag values will be modified by this module. | `map(string)` | `{}` | no |
| <a name="input_tenant"></a> [tenant](#input\_tenant) | ID element \_(Rarely used, not included by default)\_. A customer identifier, indicating who this instance of a resource is for | `string` | `null` | no |
| <a name="input_timeout"></a> [timeout](#input\_timeout) | Timeout (seconds) for both edge functions. Covers the facilitator call on verify and settle. Origin-facing Lambda@Edge events allow up to 30 seconds. | `number` | `5` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_cache_policy_id"></a> [cache\_policy\_id](#output\_cache\_policy\_id) | ID of the managed CachingDisabled cache policy. Paid behaviors must use it: a cache hit skips the origin-request function and would serve paid content unverified. |
| <a name="output_config_json"></a> [config\_json](#output\_config\_json) | The rendered config.json shipped in the edge zip, for inspection and debugging. |
| <a name="output_function_names"></a> [function\_names](#output\_function\_names) | Names of the edge functions, keyed by event type. Logs are written to /aws/lambda/us-east-1.<name> in the region nearest each viewer. |
| <a name="output_lambda_function_associations"></a> [lambda\_function\_associations](#output\_lambda\_function\_associations) | Lambda@Edge associations for each paid cache behavior: origin-request (verify) and origin-response (settle), as qualified (versioned) ARNs. Use with a dynamic lambda\_function\_association block. |
| <a name="output_origin_request_function_qualified_arn"></a> [origin\_request\_function\_qualified\_arn](#output\_origin\_request\_function\_qualified\_arn) | Qualified ARN of the origin-request (verify) function. |
| <a name="output_origin_request_policy_id"></a> [origin\_request\_policy\_id](#output\_origin\_request\_policy\_id) | ID of the origin request policy that forwards payment-signature (plus forwarded\_headers) to the edge function and origin. Paid behaviors must use it or an equivalent that forwards payment-signature. |
| <a name="output_origin_response_function_qualified_arn"></a> [origin\_response\_function\_qualified\_arn](#output\_origin\_response\_function\_qualified\_arn) | Qualified ARN of the origin-response (settle) function. |
| <a name="output_role_arn"></a> [role\_arn](#output\_role\_arn) | ARN of the edge functions' execution role. |
| <a name="output_route_patterns"></a> [route\_patterns](#output\_route\_patterns) | The configured x402 route patterns (keys of var.routes). Each must be covered by a paid cache behavior. |
<!-- END_TF_DOCS -->

## License

Apache 2.0 — see [LICENCE](LICENCE) for details.
