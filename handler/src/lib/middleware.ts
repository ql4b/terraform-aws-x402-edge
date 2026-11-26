import type { CloudFrontRequest, CloudFrontResponse } from 'aws-lambda';
import type { x402HTTPResourceServer } from '@x402/core/server';
import { CloudFrontHTTPAdapter } from './adapter';
import { toLambdaResponse, LambdaEdgeResponse } from './responses';
import { createX402Server, type X402ServerConfig } from './server';
import { CredentialsUnavailableError } from './credentials';
import { isUndecodablePayment, withErrorMessage, UNDECODABLE_PAYMENT_ERROR } from './payment-errors';
import { isCanonicalRequestPath } from './request-path';
import { PENDING_SETTLEMENT_HEADER, prepareVerifiedRequestForOrigin } from './forward';
import { buildPendingSettlement, settlementDeclaredExtensions } from './settlement-context';

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

    // Route matching below uses the URI exactly as received, while CloudFront
    // and the origin may interpret an unusual path differently. Only match and
    // forward canonical paths; see request-path.ts.
    if (!isCanonicalRequestPath(request.uri)) {
      console.log('x402 origin-request: non-canonical path rejected');
      return {
        type: MiddlewareResultType.RESPOND,
        response: toLambdaResponse(
          400,
          { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          { error: 'Bad request' }
        ),
      };
    }

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

        case HTTPProcessResultType.PAYMENT_ERROR: {
          // The core reports an undecodable PAYMENT-SIGNATURE as "Payment
          // required" (it drops the decode error). Say what is actually wrong.
          const undecodable =
            result.response.status === 402 && isUndecodablePayment(context.paymentHeader);
          console.log(
            undecodable
              ? 'Payment signature header could not be decoded'
              : context.paymentHeader
                ? 'Payment invalid'
                : 'Payment required'
          );
          return {
            type: MiddlewareResultType.RESPOND,
            response: toLambdaResponse(
              result.response.status,
              undecodable
                ? withErrorMessage(result.response.headers, UNDECODABLE_PAYMENT_ERROR)
                : result.response.headers,
              result.response.body
            ),
          };
        }

        case HTTPProcessResultType.PAYMENT_VERIFIED:
          console.log('Payment verified, forwarding to origin (settlement deferred)');

          // What origin-response needs to settle, all from verify time (see
          // buildPendingSettlement): payload and matched requirements, plus with
          // offer-receipt the receipt declaration from this config and the
          // distributionDomain (origin-response events do not carry it).
          const paymentData = JSON.stringify(
            buildPendingSettlement(result, config.offerReceipt, distributionDomain)
          );

          const pendingSettlement = Buffer.from(paymentData).toString('base64');
          const forwardedHeaderBytes = prepareVerifiedRequestForOrigin(request, pendingSettlement);
          console.log(
            JSON.stringify({
              msg: 'x402 forwarding to origin',
              forwardedHeaderBytes,
              pendingSettlementBytes: pendingSettlement.length,
            })
          );

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

      // Receipt half (opt-in, best effort; see settlementDeclaredExtensions):
      // the declaration carried from verify, else this function's own when
      // offer-receipt is on here. The offer-receipt hook signs a receipt into
      // PAYMENT-RESPONSE only when settlement gets a declaration AND a transport
      // context whose adapter yields the resourceUrl. Rebuild the adapter from the
      // forwarded distributionDomain (origin-response events lack it) and
      // config.publicHost, so the receipt's resourceUrl matches the offer's.
      const declaredExtensions = settlementDeclaredExtensions(paymentData, config.offerReceipt);
      let settlement;
      if (declaredExtensions) {
        const adapter = new CloudFrontHTTPAdapter(
          request,
          paymentData.distributionDomain ?? '',
          config.publicHost
        );
        settlement = await server.processSettlement(
          paymentData.payload,
          paymentData.requirements,
          declaredExtensions,
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
