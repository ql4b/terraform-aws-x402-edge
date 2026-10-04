import type { CloudFrontRequest, CloudFrontResponse } from 'aws-lambda';
import type { x402HTTPResourceServer } from '@x402/core/server';
import { CloudFrontHTTPAdapter } from './adapter';
import { toLambdaResponse, LambdaEdgeResponse } from './responses';
import { createX402Server, type X402ServerConfig } from './server';

/**
 * x402 middleware for Lambda@Edge — verify on origin-request, settle on
 * origin-response (only when the origin succeeded). Adapted verbatim from the
 * x402-foundation cloudfront-lambda-edge example; this is the protocol-correct
 * "verify -> forward -> settle-only-on-success" flow (verify is a read-only
 * preflight; the response is released only after settlement).
 */

/** Result types for middleware processing. */
export const MiddlewareResultType = {
  /** Continue processing — forward request/response to next step. */
  CONTINUE: 'continue',
  /** Respond immediately — return response to client. */
  RESPOND: 'respond',
} as const;

export type MiddlewareResultType =
  (typeof MiddlewareResultType)[keyof typeof MiddlewareResultType];

/** x402 HTTP process result types (from @x402/core). */
export const HTTPProcessResultType = {
  NO_PAYMENT_REQUIRED: 'no-payment-required',
  PAYMENT_VERIFIED: 'payment-verified',
  PAYMENT_ERROR: 'payment-error',
} as const;

export type HTTPProcessResultType =
  (typeof HTTPProcessResultType)[keyof typeof HTTPProcessResultType];

export type OriginRequestResult =
  | { type: typeof MiddlewareResultType.CONTINUE; request: CloudFrontRequest }
  | { type: typeof MiddlewareResultType.RESPOND; response: LambdaEdgeResponse };

export type OriginResponseResult =
  | { type: typeof MiddlewareResultType.CONTINUE; response: CloudFrontResponse }
  | { type: typeof MiddlewareResultType.RESPOND; response: LambdaEdgeResponse };

/**
 * Internal header used to pass verified payment data from origin-request to
 * origin-response. Deferring settlement to origin-response means the client is
 * only charged when the origin actually produced a successful response.
 */
const PENDING_SETTLEMENT_HEADER = 'x-x402-pending-settlement';

export function createX402Middleware(config: X402ServerConfig) {
  let serverPromise: Promise<x402HTTPResourceServer> | null = null;

  const getServer = async (): Promise<x402HTTPResourceServer> => {
    if (!serverPromise) {
      serverPromise = createX402Server(config);
    }
    return serverPromise;
  };

  async function processOriginRequest(
    request: CloudFrontRequest,
    distributionDomain: string
  ): Promise<OriginRequestResult> {
    console.log('x402 origin-request:', request.uri);

    // Security: strip any pre-existing settlement header to prevent a client
    // from injecting a "already-verified" marker and bypassing payment.
    delete request.headers[PENDING_SETTLEMENT_HEADER];

    try {
      const server = await getServer();
      const adapter = new CloudFrontHTTPAdapter(request, distributionDomain, config.publicHost);

      const context = {
        adapter,
        path: adapter.getPath(),
        method: adapter.getMethod(),
        paymentHeader: adapter.getHeader('payment-signature'),
      };

      const result = await server.processHTTPRequest(context);

      switch (result.type) {
        case HTTPProcessResultType.NO_PAYMENT_REQUIRED:
          return { type: MiddlewareResultType.CONTINUE, request };

        case HTTPProcessResultType.PAYMENT_ERROR:
          console.log('Payment required or invalid');
          return {
            type: MiddlewareResultType.RESPOND,
            response: toLambdaResponse(
              result.response.status,
              result.response.headers,
              result.response.body
            ),
          };

        case HTTPProcessResultType.PAYMENT_VERIFIED:
          console.log('Payment verified, forwarding to origin (settlement deferred)');

          const paymentData = JSON.stringify({
            payload: result.paymentPayload,
            requirements: result.paymentRequirements,
          });

          request.headers[PENDING_SETTLEMENT_HEADER] = [
            {
              key: PENDING_SETTLEMENT_HEADER,
              value: Buffer.from(paymentData).toString('base64'),
            },
          ];

          return { type: MiddlewareResultType.CONTINUE, request };
      }

      throw new Error('Unexpected result type');
    } catch (error) {
      console.error('x402 origin-request error:', error);
      return {
        type: MiddlewareResultType.RESPOND,
        response: toLambdaResponse(
          500,
          { 'Content-Type': 'application/json' },
          { error: 'Internal server error' }
        ),
      };
    }
  }

  async function processOriginResponse(
    request: CloudFrontRequest,
    response: CloudFrontResponse
  ): Promise<OriginResponseResult> {
    const pendingSettlement = request.headers[PENDING_SETTLEMENT_HEADER]?.[0]?.value;

    if (!pendingSettlement) {
      return { type: MiddlewareResultType.CONTINUE, response };
    }

    const status = parseInt(response.status, 10);
    console.log('x402 origin-response:', request.uri, 'status:', status);

    // Only settle if the origin succeeded — customer not charged for failures.
    if (status >= 400) {
      console.log('Origin failed, skipping settlement - customer not charged');
      return { type: MiddlewareResultType.CONTINUE, response };
    }

    try {
      const paymentData = JSON.parse(
        Buffer.from(pendingSettlement, 'base64').toString('utf-8')
      );

      const server = await getServer();
      const settlement = await server.processSettlement(
        paymentData.payload,
        paymentData.requirements
      );

      if (settlement.success) {
        console.log('Payment settled successfully');
        for (const [key, value] of Object.entries(settlement.headers)) {
          response.headers[key.toLowerCase()] = [{ key, value: String(value) }];
        }
        return { type: MiddlewareResultType.CONTINUE, response };
      } else {
        console.error('Settlement failed:', settlement.errorReason);
        return {
          type: MiddlewareResultType.RESPOND,
          response: toLambdaResponse(
            402,
            { 'Content-Type': 'application/json' },
            { error: 'Settlement failed', details: settlement.errorReason }
          ),
        };
      }
    } catch (error) {
      console.error('x402 origin-response settlement error:', error);
      return {
        type: MiddlewareResultType.RESPOND,
        response: toLambdaResponse(
          402,
          { 'Content-Type': 'application/json' },
          {
            error: 'Settlement failed',
            details: error instanceof Error ? error.message : 'Unknown error',
          }
        ),
      };
    }
  }

  return {
    processOriginRequest,
    processOriginResponse,
  };
}

export type X402Middleware = ReturnType<typeof createX402Middleware>;
