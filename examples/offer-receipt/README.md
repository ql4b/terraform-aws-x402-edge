# Offer-receipt example

The [CDP example](../cdp/) plus the opt-in x402
[Signed Offers & Receipts](https://docs.x402.org/extensions/offer-receipt)
extension. Everything from the CDP example still holds — the paywall on
`/anything/premium/*`, verified and settled by the Coinbase CDP facilitator with
a Secret API key in Secrets Manager. On top of that, enabling `offer_receipt`
makes the edge functions sign:

- an **offer** into the `402` body under `extensions["offer-receipt"]`, one per
  `accepts[]` entry; and
- a **receipt** into the `PAYMENT-RESPONSE` header on a settled `200`.

The module **signs only**. It does not host a DID document and it does not emit
`/.well-known/did.json` — you do that yourself (step 4), because the signature
is only trustworthy once clients can resolve the signer address from a DID doc
you publish.

## 1. Create a CDP Secret API key

As in the [CDP example](../cdp/). In the
[CDP portal](https://portal.cdp.coinbase.com), under API keys, Secret API keys,
create a key:

- **Signature algorithm:** Ed25519 (recommended) or ECDSA; both work.
- **IP allowlist:** allow requests from any IP address. Lambda@Edge calls out
  from shared AWS ranges in many regions, so an allowlist cannot match.
- **Permissions:** the defaults (View) are enough for verify and settle.

Store it (the handler expects `{"apiKeyId": "...", "apiKeySecret": "..."}`),
then delete the downloaded file:

```bash
jq '{apiKeyId: .id, apiKeySecret: .privateKey}' cdp_api_key.json \
  | aws secretsmanager create-secret --region us-east-1 \
      --name x402/cdp-facilitator \
      --secret-string file:///dev/stdin \
      --query ARN --output text
rm -P cdp_api_key.json
```

## 2. Create a dedicated signing key

The offers and receipts are signed with a **dedicated signing key** that is
**not** your `pay_to` wallet. It is the **same kind** of key as the payment
wallet — a secp256k1 EVM key, because EIP-712 signing is secp256k1 — so the
separation here is **key custody, not a different curve**: keep the funds wallet
and the signing key in different secrets so compromising one does not expose the
other.

Generate a fresh secp256k1 private key (any EVM keygen — for example
`cast wallet new` from Foundry, or `viem`'s `generatePrivateKey()`), take its
address for step 4, and store the **hex private key** in Secrets Manager in
`us-east-1`:

```bash
aws secretsmanager create-secret --region us-east-1 \
  --name x402/offer-receipt-signing-key \
  --secret-string '0x<DEDICATED_SIGNING_PRIVATE_KEY>'
```

The module accepts either a bare `0x...` hex string or a JSON
`{"privateKey": "0x..."}`. The secret **must pre-exist before `terraform apply`**
— the example looks it up with a `data` source, so a missing secret fails at
plan time. Its value is read from Secrets Manager only at runtime and is
**never written to Terraform state**, exactly like the CDP key.

## 3. Host `/.well-known/did.json` (did:web)

A client only trusts an offer or receipt once it can confirm which address
signed it. The x402 verifier recovers the signer **address** from the EIP-712
signature and checks it against the address authorized in your DID document; so
you must host a `did:web` document on the **consumer domain** that authorizes
the signing key's address. Without a hosted, authorizing `did.json`, the
signatures are unverifiable and clients cannot trust the offers or receipts.

Serve this at `https://example.com/.well-known/did.json` (replace `example.com`
with your domain, and the address with your signer address from step 2):

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/secp256k1recovery-2020/v2"
  ],
  "id": "did:web:example.com",
  "verificationMethod": [
    {
      "id": "did:web:example.com#key-1",
      "type": "EcdsaSecp256k1RecoveryMethod2020",
      "controller": "did:web:example.com",
      "blockchainAccountId": "eip155:84532:0x<CHECKSUMMED_SIGNER_ADDRESS>"
    }
  ],
  "assertionMethod": ["did:web:example.com#key-1"]
}
```

Notes:

- `blockchainAccountId` is [CAIP-10](https://chainagnostic.org/CAIPs/caip-10):
  `eip155:<chainId>:<checksummed address>`. Use the chain id that matches your
  `network` (`84532` for Base Sepolia, `8453` for Base mainnet) and the
  address of the dedicated signing key from step 2.
- `id` and `controller` are the `did:web` of the domain hosting the file.
- The `verificationMethod` `id` is the **kid**, and it **must match** the
  `signer_kid` you pass to the module (`did:web:example.com#key-1` here). It is
  listed under `assertionMethod` so clients accept it for signed assertions.

## 4. Deploy

```bash
terraform init
terraform apply -var 'pay_to=0xYourWallet'
```

Defaults use Base Sepolia (`eip155:84532`, testnet USDC), which CDP supports.
For mainnet add `-var 'network=eip155:8453'` (and match the `eip155:` chain id
in the DID doc above). Use `-var cdp_secret_name=...` or
`-var signing_key_secret_name=...` if you named the secrets differently.

Remember the `signer_did` / `signer_kid` in `main.tf` use `example.com`
placeholders — point them at the domain where you actually host `did.json`.

## 5. Check it

Once the distribution has deployed:

```bash
curl -i "$(terraform output -raw paid_url)"   # 402 + PAYMENT-REQUIRED
```

The `402` body now carries `extensions["offer-receipt"]` with a signed offer
for each `accepts[]` entry (an `eip712` `format`, the offer `payload`, and the
`signature`). Pay with any x402 v2 client; on a settled payment the
`PAYMENT-RESPONSE` header carries a signed receipt.

A client can verify the signatures with
[`@x402/extensions`](https://docs.x402.org/extensions/offer-receipt)
(`extractOffersFromPaymentRequired` then `verifyOfferSignatureEIP712`),
resolving your hosted `did.json` to recover and trust the signer address. If the
signing-key secret cannot be read, the paid path answers `503` with
`Retry-After` and never reaches the origin — see the `edge_function_names`
output for where the logs are.

## Rotation

Rotating the signing key means updating **two** things together: put the new key
on the secret (`aws secretsmanager put-secret-value`), and update the address in
your hosted `did.json`. Instances pick up the new secret once their cached copy
is older than `cache_ttl_seconds` (default 300); no apply is needed.

Note that `did.json` is **mutable, current-state only** — it says who signs
*now*, not who signed historically. For durable trust across a rotation (so a
client can still verify an offer signed under the previous key), the spec points
to a signer-authorization service rather than the DID doc alone; the DID doc by
itself cannot vouch for a retired key.

## Destroy

Destroying takes a while: CloudFront has to remove the Lambda@Edge replicas
before the functions can be deleted. See the [module README](../../) for inputs
and constraints.
