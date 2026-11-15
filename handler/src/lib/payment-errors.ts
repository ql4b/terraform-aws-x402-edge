import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';

/**
 * `@x402/core` treats an undecodable PAYMENT-SIGNATURE header as if no header
 * had been sent (extractPayment swallows the decode error), so the client gets
 * the same generic "Payment required" for a malformed payment as for none.
 * Every later failure is already distinct (no matching requirements, the
 * facilitator's invalidReason, a thrown error), so this is the only case to fix.
 */
export const UNDECODABLE_PAYMENT_ERROR =
  'Invalid PAYMENT-SIGNATURE header: it must be a base64-encoded JSON x402 payment payload. Build one from an entry in accepts[] and retry.';

/** True when a PAYMENT-SIGNATURE header is present but cannot be decoded. */
export function isUndecodablePayment(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  try {
    decodePaymentSignatureHeader(headerValue);
    return false;
  } catch {
    return true;
  }
}

/**
 * Replace the generic `error` in a 402's PAYMENT-REQUIRED header. The response
 * body is derived from that header, so one change covers both. Returns the
 * headers unchanged if the header is absent or cannot be re-encoded.
 */
export function withErrorMessage(headers: Record<string, string>, message: string): Record<string, string> {
  const encoded = headers['PAYMENT-REQUIRED'];
  if (!encoded) return headers;
  try {
    const paymentRequired = decodePaymentRequiredHeader(encoded);
    return { ...headers, 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ ...paymentRequired, error: message }) };
  } catch {
    return headers;
  }
}
