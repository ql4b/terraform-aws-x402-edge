import type { RoutesConfig, FacilitatorConfig, FacilitatorClient } from '@x402/core/server';
import { x402ResourceServer, x402HTTPResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  createOfferReceiptExtension,
  createEIP712OfferReceiptIssuer,
  declareOfferReceiptExtension,
  type SignTypedDataFn,
} from '@x402/extensions/offer-receipt';
import * as TypedData from 'ox/TypedData';
import * as Secp256k1 from 'ox/Secp256k1';
import * as Signature from 'ox/Signature';
import { createCdpFacilitatorConfig } from './cdp-auth';
import { createSecretSource, CredentialsUnavailableError } from './credentials';

/**
 * Pre-fetched facilitator `/supported` response, typed as exactly what the
 * library's client returns so the baked value drops into `FacilitatorClient`
 * without re-declaring (and risking drift from) the SDK's own types.
 * `@x402/core/server` does not re-export the `SupportedResponse` type name.
 */
export type SupportedResponse = Awaited<ReturnType<HTTPFacilitatorClient['getSupported']>>;

/**
 * Facilitator authentication. Only the secret ARN travels in config.json; the
 * value is read from Secrets Manager at runtime and cached for
 * `cacheTtlSeconds` (see credentials.ts).
 */
export interface FacilitatorAuthConfig {
  /** Auth scheme. `cdp`: Coinbase CDP API key, per-request JWT (see cdp-auth.ts). */
  type: 'cdp';
  /** Full ARN of the Secrets Manager secret holding the API key. */
  secretArn: string;
  /** Seconds a fetched secret value is reused before re-fetching. */
  cacheTtlSeconds: number;
}

/**
 * Opt-in x402 "Signed Offers & Receipts" wiring. Only the signing-key secret
 * ARN travels in config.json; the hex secp256k1 private key is read from
 * Secrets Manager at runtime (same SigV4/aws4fetch mechanism as
 * `FacilitatorAuthConfig`) and never enters the bundle or Terraform state.
 *
 * `kid` is metadata — the EIP-712 verifier recovers the signer ADDRESS from the
 * signature and never resolves the kid — but it MUST equal the did.json
 * verificationMethod id so a client knows which published address to trust.
 * Keep kid / EIP-712 domain+types / signer identity identical to the observers
 * surface so every signature verifies against the one published did.json.
 */
export interface OfferReceiptEdgeConfig {
  /** Master opt-in switch. False ⇒ no extension registered, no key read. */
  enabled: boolean;
  /** Signature format. Only "eip712" is implemented on this surface. */
  format: 'eip712';
  /** Full ARN of the dedicated signing-key secret (SEPARATE from pay_to). */
  signingKeySecretArn: string;
  /** The DID published in /.well-known/did.json that authorizes the signer. */
  signerDid?: string;
  /** verificationMethod id in that DID doc; must match across surfaces. */
  kid: string;
  /** Include the on-chain txHash in the receipt (default false for privacy). */
  includeTxHash: boolean;
  /** Offer validity window in seconds (fresh validUntil per 402). */
  offerValiditySeconds: number;
  /** Seconds the fetched signing key is reused before re-fetching. */
  cacheTtlSeconds: number;
}

/**
 * Configuration for creating an x402 server.
 */
export interface X402ServerConfig {
  /** Facilitator URL (e.g. 'https://x402.org/facilitator') */
  facilitatorUrl: string;
  /** Route configuration defining which paths require payment */
  routes: RoutesConfig;
  /** Optional facilitator config with auth headers (for facilitators that require authentication) */
  facilitatorConfig?: FacilitatorConfig;
  /**
   * Optional facilitator authentication backed by Secrets Manager. Builds the
   * `facilitatorConfig` when that is not given explicitly.
   */
  facilitatorAuth?: FacilitatorAuthConfig;
  /**
   * Optional opt-in x402 Signed Offers & Receipts. When omitted or disabled,
   * no extension is registered and the server is identical to today.
   */
  offerReceipt?: OfferReceiptEdgeConfig;
  /**
   * Optional pre-fetched facilitator `/supported` response, baked into
   * config.json at plan time. When present, the server does not call the
   * facilitator's `GET /supported` on cold start — the single blocking network
   * call that otherwise dominates cold-start latency on Lambda@Edge (verify and
   * settle still reach the facilitator). Omit to keep the live fetch.
   */
  supported?: SupportedResponse;
  /**
   * Optional public host to advertise in the x402 challenge `resource.url`,
   * overriding CloudFront's distribution domain. Set when a custom domain is
   * attached. Not used to build the server; consumed by the middleware when
   * constructing the request adapter.
   */
  publicHost?: string;
}

/**
 * A facilitator client that serves a pre-fetched `/supported` response from
 * config instead of fetching it, while delegating `verify` and `settle` to the
 * real HTTP client unchanged.
 *
 * `initialize()` is the only consumer of `getSupported()`; returning the baked
 * value removes the cold-start `GET /supported` round trip without touching the
 * transactional path. If the facilitator later stops advertising the baked
 * kind, `verify` fails at request time exactly as a live mismatch would — the
 * staleness window is bounded by how often the config is re-rendered.
 */
class BakedSupportedFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly inner: HTTPFacilitatorClient,
    private readonly supported: SupportedResponse
  ) {}

  verify(...args: Parameters<HTTPFacilitatorClient['verify']>) {
    return this.inner.verify(...args);
  }

  settle(...args: Parameters<HTTPFacilitatorClient['settle']>) {
    return this.inner.settle(...args);
  }

  async getSupported(): Promise<SupportedResponse> {
    return this.supported;
  }
}

/**
 * Create and initialize an x402HTTPResourceServer.
 *
 * EVM `exact` only: the one scheme registered is ExactEvmScheme for any
 * `eip155:*` network. The Terraform module validates `network` accordingly.
 * Adapted from the x402-foundation cloudfront-lambda-edge example (Apache-2.0)
 * with the Solana (SVM) scheme removed.
 *
 * When `config.supported` is present the facilitator's `/supported` endpoint is
 * not called during `initialize()`; see BakedSupportedFacilitatorClient.
 */
export async function createX402Server(config: X402ServerConfig): Promise<x402HTTPResourceServer> {
  const httpClient = new HTTPFacilitatorClient(facilitatorConfigFor(config));
  const facilitator: FacilitatorClient = config.supported
    ? new BakedSupportedFacilitatorClient(httpClient, config.supported)
    : httpClient;

  const resourceServer = new x402ResourceServer(facilitator).register(
    'eip155:*',
    new ExactEvmScheme()
  );

  // Offer-receipt extension — OPT-IN (default off), the only wiring change for
  // the feature. The extension's enrichPaymentRequiredResponse /
  // enrichSettlementResponse hooks fire INSIDE the existing processHTTPRequest /
  // processSettlement calls, so the origin-request / origin-response handlers do
  // not change for the OFFER half. EIP-712 (secp256k1): the signer is a LEAN
  // ox-based secp256k1 signer (NOT viem — viem added ~84kb to the x86_64 edge
  // bundle; ox tree-shakes to a small, byte-identical signer — see notes.md)
  // built from the hex key read from Secrets Manager, and its signTypedData is
  // the SignTypedDataFn the issuer calls — the issuer supplies the fixed
  // "x402 offer" / "x402 receipt" EIP-712 domain and types itself. Keep kid /
  // domain / types identical to the observers surface so signatures verify
  // against the one published did.json (the lean signer is verified to produce
  // the SAME signature viem does for identical typed data). When disabled we
  // register nothing and read no key, so the server is identical to today.
  let routes = config.routes;
  if (config.offerReceipt?.enabled) {
    const signingKey = await loadSigningKey(config.offerReceipt);
    const signTypedData: SignTypedDataFn = async (params) => {
      const digest = TypedData.getSignPayload(params as Parameters<typeof TypedData.getSignPayload>[0]);
      const signature = Secp256k1.sign({ payload: digest, privateKey: signingKey });
      return Signature.toHex(signature);
    };
    const issuer = createEIP712OfferReceiptIssuer(config.offerReceipt.kid, signTypedData);
    resourceServer.registerExtension(createOfferReceiptExtension(issuer));

    // The core runs the extension's enrich hooks for a route ONLY when that
    // route declares the extension key (declaredExtensions[key] must be
    // defined), so declare it per route — preserving any existing per-route
    // extensions (e.g. bazaar). Mirrors the observers surface.
    const declaration = declareOfferReceiptExtension({
      includeTxHash: config.offerReceipt.includeTxHash,
      offerValiditySeconds: config.offerReceipt.offerValiditySeconds,
    });
    routes = Object.fromEntries(
      Object.entries(config.routes).map(([pattern, route]) => [
        pattern,
        { ...route, extensions: { ...route.extensions, ...declaration } },
      ])
    ) as RoutesConfig;
  }

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  await httpServer.initialize();

  return httpServer;
}

/**
 * Read the dedicated offer-receipt signing key from Secrets Manager via the
 * existing SigV4/aws4fetch `createSecretSource` (cached for `cacheTtlSeconds`),
 * and normalize it to a 0x-prefixed 32-byte hex private key. Accepts either a
 * raw hex SecretString or a JSON `{privateKey|signingKey|...}` field — mirrors
 * the observers surface's getSigningKey leniency.
 */
async function loadSigningKey(offerReceipt: OfferReceiptEdgeConfig): Promise<`0x${string}`> {
  const source = createSecretSource({
    secretArn: offerReceipt.signingKeySecretArn,
    ttlSeconds: offerReceipt.cacheTtlSeconds,
  });
  const raw = (await source.get()).trim();

  let hex: string | undefined;
  if (raw.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new CredentialsUnavailableError('offer-receipt: signing-key secret is not valid JSON');
    }
    const v = parsed.privateKey ?? parsed.signingKey ?? parsed.PRIVATE_KEY ?? parsed.key;
    if (typeof v === 'string') hex = v.trim();
  } else {
    hex = raw;
  }

  if (!hex) {
    throw new CredentialsUnavailableError('offer-receipt: signing-key secret has no key');
  }
  if (!hex.startsWith('0x')) hex = `0x${hex}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CredentialsUnavailableError('offer-receipt: signing key is not a 32-byte hex private key');
  }
  return hex as `0x${string}`;
}

/** The facilitator client config: explicit, Secrets Manager-backed auth, or plain URL. */
function facilitatorConfigFor(config: X402ServerConfig): FacilitatorConfig {
  if (config.facilitatorConfig) {
    return config.facilitatorConfig;
  }
  if (config.facilitatorAuth) {
    // type is validated as 'cdp' when config.json is loaded.
    const source = createSecretSource({
      secretArn: config.facilitatorAuth.secretArn,
      ttlSeconds: config.facilitatorAuth.cacheTtlSeconds,
    });
    return createCdpFacilitatorConfig(config.facilitatorUrl, source);
  }
  return { url: config.facilitatorUrl };
}
