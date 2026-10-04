# Basic example

Puts an x402 paywall on one path of a CloudFront distribution that fronts
`httpbin.org`. `/anything/premium/*` returns `402 Payment Required` until a
valid payment is attached; everything else is free.

```bash
terraform init
terraform apply -var 'pay_to=0xYourWallet'
```

Defaults use Base Sepolia (`eip155:84532`) with the public
`https://x402.org/facilitator`, so payments are testnet USDC. For mainnet,
set `network` and a facilitator that supports it.

Check the challenge once the distribution has deployed:

```bash
curl -i "$(terraform output -raw paid_url)"   # 402 + PAYMENT-REQUIRED
curl -i "$(terraform output -raw free_url)"   # 200 from httpbin
```

The paid behavior uses the module's `cache_policy_id` (CachingDisabled) and
`origin_request_policy_id` (forwards `payment-signature`). Both are required:
a cached response would skip the verify function.

Destroying takes a while: CloudFront has to remove the Lambda@Edge replicas
before the functions can be deleted, which can take hours. Retry the destroy
if it fails on the functions.

See the [module README](../../) for inputs and constraints.
