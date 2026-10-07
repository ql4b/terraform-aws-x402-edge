import type { RoutesConfig, FacilitatorConfig, FacilitatorClient } from '@x402/core/server';
import { x402ResourceServer, x402HTTPResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

/**
 * Pre-fetched facilitator `/supported` response, typed as exactly what the
 * library's client returns so the baked value drops into `FacilitatorClient`
 * without re-declaring (and risking drift from) the SDK's own types.
 * `@x402/core/server` does not re-export the `SupportedResponse` type name.
 */
export type SupportedResponse = Awaited<ReturnType<HTTPFacilitatorClient['getSupported']>>;

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
  const httpClient = new HTTPFacilitatorClient(
    config.facilitatorConfig ?? { url: config.facilitatorUrl }
  );
  const facilitator: FacilitatorClient = config.supported
    ? new BakedSupportedFacilitatorClient(httpClient, config.supported)
    : httpClient;

  const resourceServer = new x402ResourceServer(facilitator).register(
    'eip155:*',
    new ExactEvmScheme()
  );

  const httpServer = new x402HTTPResourceServer(resourceServer, config.routes);
  await httpServer.initialize();

  return httpServer;
}
