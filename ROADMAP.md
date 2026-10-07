# Roadmap

Direction, not commitments. Items move as the
[x402 Foundation](https://github.com/x402-foundation/x402) working groups
settle their specs.

## Vision

Retrofit x402 onto sites and APIs that **already** sit behind CloudFront,
without changing them. The origin stays unaware of payments; you attach the
module's outputs to cache behaviors you already own.

Principles that follow from that:

- **The edge decides only what it can decide locally.** Anything static (the
  402 challenge, published terms, locally held keys) is answered at the edge
  with no remote call. Only real transactions (verify, settle) touch the
  network.
- **Unpaid traffic is cheap and predictable everywhere.** A request without
  payment must not depend on the distance between an edge location and a
  facilitator.
- **New behaviour lands behind flags; defaults keep current behaviour.**
  Upgrades within a major version are non-breaking.
- **The SDK stays the source of truth.** Challenges are produced by the real
  x402 SDK (at build/plan time or by a refresher), never re-implemented in
  edge code.
- **Mature in step with the Foundation.** The structure — viewer-side
  decision, origin-request check, origin-response settle — is meant to absorb
  the identity, directory and card acceptance work without a redesign.

Out of scope: a payment-aware regional origin (e.g. a function colocated with
the facilitator). That serves a different case — new APIs, not retrofits —
and belongs in a separate module.

## Why the next step is needed

A local trace of the v1.0 bundle (one route, facilitator in us-east-1, client
in Europe):

| Phase | Handler time | Cause |
| --- | --- | --- |
| 402, warm | 0.2–0.8 ms | no network |
| 402, cold | 400–530 ms | `initialize()` → `GET /supported` (~11 KB, ~4 round trips with TLS) |
| paid, `/verify` p50 | ~223 ms | 1 round trip + ~100 ms facilitator processing |

Handler CPU is negligible. With low traffic spread across regional edge
caches, most instances are cold, so the cold 402 is effectively the common
path; from regions far from the facilitator it plausibly approaches ~2 s (to
be confirmed per region from `Init Duration` in CloudWatch REPORT lines).

The `GET /supported` cost is paid more than once, and that compounds the
latency:

- The **origin-request** and **origin-response** functions are separate
  Lambdas, each with its own cold start, so a paid request that lands on two
  cold instances calls `/supported` **twice** — once before `/verify`, once
  before `/settle` — on top of the two transactional round trips.
- Each call is a *cold* HTTPS fetch (DNS + TCP + TLS + request), ~4 round
  trips, and the response is ~11 KB.
- The distance edge→facilitator is paid every time, and it varies by edge
  location: the farther the regional edge cache is from the facilitator, the
  larger every one of these calls — the opposite of predictable.
- The call is also exposed to the facilitator's rate limit and availability:
  a throttled or slow `/supported` stalls even an *unpaid* 402 on a cold
  instance, for a fact that did not need fetching.

For a route, `/supported` contributes one small fact
(`{"x402Version":2,"scheme":"exact","network":"eip155:8453"}`) and does not
change the `exact` challenge — so none of this latency buys anything that
isn't knowable at plan time. v1.1 removes every one of these calls from the
request path.

## Short term

### v1.1 — static challenge

Flag: `static_challenge` (default `false` = current behaviour).

When `true`:

- A **viewer-request CloudFront Function** returns the 402 when
  `payment-signature` is missing. The per-route challenge template is rendered
  by the SDK at build/plan time and embedded in the function code;
  `resource.url` is filled per request (length-capped). No key value store.
- **origin-request / origin-response** skip `/supported`: the supported kind
  is fetched at plan time into `config.json` and served by a stub
  `getSupported()`.
- Verify stays in origin-request (fail fast, origin untouched). Settle stays
  in origin-response — only on origin `< 400`, and able to replace the
  response with a 402 on failure (viewer-response cannot change the status
  code).

Accepted limits: a facilitator dropping the kind between deploys surfaces as
`/verify` failures until the next apply; a handful of routes per function
(10 KB function code limit); no per-parameter pricing.

### v1.2 — facilitator auth (CDP and keyed facilitators)

Needed for the Coinbase CDP facilitator, and for PayAI once its starter
allowance is used up.

- Input: a Secrets Manager ARN (us-east-1). The module grants read access and
  caches the secret per instance — one call on the cold *paid* path only; the
  static 402 never needs it.
- Not the default: baking the key into the deployment zip (replicated to
  every edge region, readable via `lambda:GetFunction`).
- Constraint, documented: **no IP allowlisting.** Lambda@Edge calls out from
  shared AWS ranges across many regions, so facilitator key allowlists and
  per-IP limits cannot be relied on.
- Plan-time `/supported` for CDP needs a JWT-signing step, not a plain
  `data "http"`.

## Follow-up steps

Roughly in order; each its own release.

1. **Networks as a list (EVM).** One `accepts[]` entry per chain, same
   `payTo`. Grows each challenge template (counts against the function code
   limit).
2. **Multiple facilitators with precedence and fallback.** The SDK already
   supports several (earlier ones win). This, not a second network, gives
   resilience against a facilitator outage.
3. **Solana.** Re-add `ExactSvmScheme`; separate Solana `payTo`.
4. **Key value store + refresher.** When templates outgrow the function code
   limit, or facilitator capability changes between deploys start to matter.
   The refresher runs the SDK on a schedule and after apply.
   - Keys by meaning, not by request: `kind:2|exact|eip155:8453`, templates
     under `route:GET /v1/...`. Request parameters never create keys
     (functions are read-only on the store).
   - 1 KB value limit → chunked templates behind a generation pointer
     (`cur:<route>` → `g<n>:<chunks>`), written chunks first, pointer last;
     on a missing chunk fall back to the previous generation or return 503.
   - A deleted `kind:` key acts as a kill switch (503 instead of offering
     terms the facilitator would reject).
   - The same kind is forwarded to origin-request/response in a header the
     function always overwrites.
5. **Dynamic pricing switch.** Per-route opt-out of the static 402 for routes
   whose price depends on request parameters; their 402 is built at
   origin-request.

## Foundation working groups

How each is expected to land in the existing structure — revised as the
groups produce specs.

| Working group | Where it lands | Notes |
| --- | --- | --- |
| Identity | viewer-request, ahead of payment | Web Bot Auth verification against locally held keys is an edge decision. Payment is not authentication; the two gates stay separate and compose. |
| Directory | static terms / discovery | The more terms are published and fixed in advance, the more of the 402 stays at the edge. |
| Card acceptance | origin-request / origin-response | The draft binds cards to `auth-capture` `escrow`: the first `/settle` authorizes (origin-request), then `capture` on origin success or `void` on `>= 400` (origin-response). |
| Tax | — | Not started. |
