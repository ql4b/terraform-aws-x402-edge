/**
 * Origin Response Lambda@Edge handler.
 *
 * Settles the x402 payment only if the origin returned success (status < 400),
 * so the client is not charged for failed requests.
 */

import type { CloudFrontResponseEvent, CloudFrontResponseResult } from 'aws-lambda';
import { createX402Middleware, MiddlewareResultType, type LambdaEdgeResponse } from './lib';
import { FACILITATOR_URL, ROUTES, SUPPORTED } from './config';

const x402 = createX402Middleware({
  facilitatorUrl: FACILITATOR_URL,
  routes: ROUTES,
  supported: SUPPORTED,
});

export const handler = async (
  event: CloudFrontResponseEvent
): Promise<CloudFrontResponseResult | LambdaEdgeResponse> => {
  const request = event.Records[0].cf.request;
  const response = event.Records[0].cf.response;

  const result = await x402.processOriginResponse(request, response);

  if (result.type === MiddlewareResultType.RESPOND) {
    return result.response; // Settlement failed — 402 error
  }

  return result.response;
};
