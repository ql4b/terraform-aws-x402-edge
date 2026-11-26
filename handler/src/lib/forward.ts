import type { CloudFrontRequest } from 'aws-lambda';

/**
 * Internal header used to pass verified payment data from origin-request to
 * origin-response. Deferring settlement to origin-response means the client is
 * only charged when the origin actually produced a successful response.
 */
export const PENDING_SETTLEMENT_HEADER = 'x-x402-pending-settlement';

/**
 * Viewer header carrying the signed payment payload. It is read once, during
 * verification in origin-request. Settlement uses the copy carried in
 * PENDING_SETTLEMENT_HEADER, so the origin never needs it.
 */
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';

/**
 * Bytes the headers take on the wire (`name: value\r\n` per value), as far as
 * this function can see them. CloudFront adds its own headers (Via,
 * X-Amz-Cf-Id, ...) after origin-request, so the origin receives a little more.
 */
export function headerBytes(headers: CloudFrontRequest['headers']): number {
  let total = 0;
  for (const [name, values] of Object.entries(headers)) {
    for (const v of values ?? []) {
      total += name.length + 2 + (v.value?.length ?? 0) + 2;
    }
  }
  return total;
}

/**
 * Prepare a verified request for the origin: attach the pending-settlement
 * payload and remove the viewer's PAYMENT-SIGNATURE.
 *
 * Forwarding PAYMENT-SIGNATURE would send the signed payment authorization to
 * the origin twice (once as the viewer header, once inside the pending
 * payload). Together they can exceed the origin's request header limit, for
 * example the ~10 KB a Lambda Function URL accepts, which fails every paid
 * request with 413. It would also hand the origin a signed authorization it has
 * no use for.
 *
 * Returns the header bytes this function forwards, for logging.
 */
export function prepareVerifiedRequestForOrigin(request: CloudFrontRequest, pendingSettlement: string): number {
  delete request.headers[PAYMENT_SIGNATURE_HEADER];
  request.headers[PENDING_SETTLEMENT_HEADER] = [{ key: PENDING_SETTLEMENT_HEADER, value: pendingSettlement }];
  return headerBytes(request.headers);
}
