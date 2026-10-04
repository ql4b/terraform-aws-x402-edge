/**
 * x402 Lambda@Edge exports.
 *
 * Two separate handlers for CloudFront events:
 * - origin-request:  payment verification (before the origin is reached)
 * - origin-response: payment settlement (only when the origin succeeded)
 */

export { handler as originRequestHandler } from './origin-request';
export { handler as originResponseHandler } from './origin-response';

export * from './lib';
