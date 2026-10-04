/**
 * Origin Request Lambda@Edge handler.
 *
 * Verifies the x402 payment and forwards valid requests to the origin.
 * Settlement is deferred to the origin-response handler so the client is only
 * charged when the origin actually produced a successful response.
 */

import type { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import { createX402Middleware, MiddlewareResultType, type LambdaEdgeResponse } from './lib';
import { FACILITATOR_URL, ROUTES, PUBLIC_HOST } from './config';

const x402 = createX402Middleware({
  facilitatorUrl: FACILITATOR_URL,
  routes: ROUTES,
  publicHost: PUBLIC_HOST,
});

export const handler = async (
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequestResult | LambdaEdgeResponse> => {
  const request = event.Records[0].cf.request;
  const distributionDomain = event.Records[0].cf.config.distributionDomainName;

  const result = await x402.processOriginRequest(request, distributionDomain);

  if (result.type === MiddlewareResultType.RESPOND) {
    return result.response; // 402 Payment Required or error
  }

  return result.request;
};
