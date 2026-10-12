# CDP example

The [basic example](../basic/) with the Coinbase CDP facilitator: payments on
`/anything/premium/*` are verified and settled by CDP, authenticated with a CDP
Secret API key that lives in AWS Secrets Manager. The key is passed to the
module by ARN only; its value never appears in Terraform variables, plan or
state.

## 1. Create a CDP Secret API key

In the [CDP portal](https://portal.cdp.coinbase.com), under API keys, Secret
API keys, create a key:

- **Signature algorithm:** Ed25519 (recommended) or ECDSA; both work.
- **IP allowlist:** allow requests from any IP address. Lambda@Edge calls out
  from shared AWS ranges in many regions, so an allowlist cannot match.
- **Permissions:** the defaults (View) are enough for verify and settle.
  Leave trade, transfer and wallet export/manage unticked.

Download the key file (`cdp_api_key.json`, fields `id` and `privateKey`). Keep
it out of any repository.

## 2. Store it in Secrets Manager

The handler expects `{"apiKeyId": "...", "apiKeySecret": "..."}`. Map the
downloaded file into that shape and pipe it straight in, then delete the file:

```bash
jq '{apiKeyId: .id, apiKeySecret: .privateKey}' cdp_api_key.json \
  | aws secretsmanager create-secret --region us-east-1 \
      --name x402/cdp-facilitator \
      --secret-string file:///dev/stdin \
      --query ARN --output text
rm -P cdp_api_key.json
```

Any region works; the edge functions read the secret from the region in its
ARN. us-east-1 keeps it next to the functions' home region. A secret encrypted
with a customer managed KMS key also needs `kms:Decrypt` on that key, attached
to the module's `role_arn`.

## 3. Deploy

```bash
terraform init
terraform apply -var 'pay_to=0xYourWallet'
```

Defaults use Base Sepolia (`eip155:84532`, testnet USDC), which CDP supports.
For mainnet add `-var 'network=eip155:8453'`. Use `-var cdp_secret_name=...` if
you named the secret differently.

## 4. Check it

Once the distribution has deployed:

```bash
curl -i "$(terraform output -raw paid_url)"   # 402 + PAYMENT-REQUIRED
```

A `402` means the edge function read the secret and made an authenticated
`GET /supported` to CDP on its cold start. Each fetch logs one line, without
the value:

```json
{"msg":"x402 facilitator secret fetch","executionRegion":"eu-central-1","secretRegion":"us-east-1","status":200,"latencyMs":1189}
```

Find it in `/aws/lambda/us-east-1.<function>` in the region nearest you (see
the `edge_function_names` output). Then pay with any x402 v2 client; the
`PAYMENT-RESPONSE` header carries the CDP settlement transaction.

If the secret cannot be read or parsed, the paid path answers `503` with
`Retry-After` and never reaches the origin. The usual causes are a wrong
secret name, a customer managed KMS key without `kms:Decrypt`, or a secret
value that is not the JSON shape above.

## Rotation

Put a new value on the same secret (`aws secretsmanager put-secret-value`).
Instances pick it up once their cached copy is older than
`cache_ttl_seconds` (default 300); no apply is needed. Revoke the old key in
CDP after that window.

Destroying takes a while: CloudFront has to remove the Lambda@Edge replicas
before the functions can be deleted. See the [module README](../../) for
inputs and constraints.
