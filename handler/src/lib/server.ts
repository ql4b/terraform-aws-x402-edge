import type { RoutesConfig, FacilitatorConfig } from '@x402/core/server';
import { x402ResourceServer, x402HTTPResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

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
   * Optional public host to advertise in the x402 challenge `resource.url`,
   * overriding CloudFront's distribution domain. Set when a custom domain is
   * attached. Not used to build the server; consumed by the middleware when
   * constructing the request adapter.
   */
  publicHost?: string;
}

/**
 * Create and initialize an x402HTTPResourceServer.
 *
 * EVM `exact` only: the one scheme registered is ExactEvmScheme for any
 * `eip155:*` network. The Terraform module validates `network` accordingly.
 * Adapted from the x402-foundation cloudfront-lambda-edge example (Apache-2.0)
 * with the Solana (SVM) scheme removed.
 */
export async function createX402Server(config: X402ServerConfig): Promise<x402HTTPResourceServer> {
  const facilitator = new HTTPFacilitatorClient(
    config.facilitatorConfig ?? { url: config.facilitatorUrl }
  );
  const resourceServer = new x402ResourceServer(facilitator).register(
    'eip155:*',
    new ExactEvmScheme()
  );

  const httpServer = new x402HTTPResourceServer(resourceServer, config.routes);
  await httpServer.initialize();

  return httpServer;
}
