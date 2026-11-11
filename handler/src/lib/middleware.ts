import type { CloudFrontRequest, CloudFrontResponse } from 'aws-lambda';
import type { x402HTTPResourceServer } from '@x402/core/server';
import { CloudFrontHTTPAdapter } from './adapter';
import { toLambdaResponse, LambdaEdgeResponse } from './responses';
import { createX402Server, type X402ServerConfig } from './server';
import { CredentialsUnavailableError } from './credentials';

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

/** True when `error` (or anything in its `cause` chain) is a credentials failure. */
function isCredentialsError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof CredentialsUnavailableError) return true;
  }
  return false;
}

export function createX402Middleware(config: X402ServerConfig) {
  let serverPromise: Promise<x402HTTPResourceServer> | null = null;

  const getServer = async (): Promise<x402HTTPResourceServer> => {
    if (!serverPromise) {
      // Do not cache a failed initialization (e.g. facilitator or Secrets
      // Manager briefly unreachable): the next request retries instead of the
      // container failing every request until it is recycled.
      serverPromise = createX402Server(config).catch((error) => {
        serverPromise = null;
        throw error;
      });
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

          // Base payload carries what origin-response needs to settle. When
          // offer-receipt is enabled we also forward result.declaredExtensions
          // (the core runs the receipt settlement hook only for declared keys)
          // and the distributionDomain, so origin-response can rebuild the SAME
          // adapter/URL the offer used (origin-response events do not carry
          // distributionDomainName). When disabled we carry only the original
          // two fields, byte-identical to today.
          const paymentData = JSON.stringify(
            config.offerReceipt?.enabled
              ? {
                  payload: result.paymentPayload,
                  requirements: result.paymentRequirements,
                  declaredExtensions: result.declaredExtensions,
                  distributionDomain,
                }
              : {
                  payload: result.paymentPayload,
                  requirements: result.paymentRequirements,
                }
          );

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
      // Fail closed. Missing facilitator credentials are an availability
      // problem on our side, not a payment problem: 503, never a 402 the
      // client could act on, and never a pass-through to the origin.
      if (isCredentialsError(error)) {
        return {
          type: MiddlewareResultType.RESPOND,
          response: toLambdaResponse(
            503,
            { 'Content-Type': 'application/json', 'Retry-After': '5' },
            { error: 'Payment service temporarily unavailable' }
          ),
        };
      }
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

      // Receipt half (opt-in). The offer-receipt enrichSettlementResponse hook
      // signs a receipt into PAYMENT-RESPONSE only when settlement is called
      // with declaredExtensions AND a transport context carrying an adapter
      // whose getUrl() yields the resourceUrl — there is no fallback (unlike the
      // offer hook). Rebuild the adapter here from the forwarded distributionDomain
      // (origin-response events lack distributionDomainName) and config.publicHost,
      // so the receipt's resourceUrl matches the offer's exactly. When disabled
      // we make the plain 2-arg call, byte-identical to today.
      let settlement;
      if (config.offerReceipt?.enabled) {
        const adapter = new CloudFrontHTTPAdapter(
          request,
          paymentData.distributionDomain ?? '',
          config.publicHost
        );
        settlement = await server.processSettlement(
          paymentData.payload,
          paymentData.requirements,
          paymentData.declaredExtensions,
          { request: { adapter, path: adapter.getPath(), method: adapter.getMethod() } }
        );
      } else {
        settlement = await server.processSettlement(
          paymentData.payload,
          paymentData.requirements
        );
      }

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
