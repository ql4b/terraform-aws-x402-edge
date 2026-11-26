import { declareOfferReceiptExtension } from '@x402/extensions/offer-receipt';
import type { OfferReceiptEdgeConfig } from './server';

/**
 * The offer-receipt declaration for this function's config, or undefined when
 * the feature is off. createX402Server declares it on every route; origin-request
 * also carries it to origin-response for settlement (see buildPendingSettlement).
 */
export function offerReceiptDeclaration(
  offerReceipt: OfferReceiptEdgeConfig | undefined
): Record<string, unknown> | undefined {
  if (!offerReceipt?.enabled) return undefined;
  return declareOfferReceiptExtension({
    includeTxHash: offerReceipt.includeTxHash,
    offerValiditySeconds: offerReceipt.offerValiditySeconds,
  });
}

/** What origin-request carries to origin-response in the pending-settlement header. */
export interface PendingSettlement {
  payload: unknown;
  requirements: unknown;
  /** Only with offer-receipt: the declarations settlement acts on. */
  declaredExtensions?: Record<string, unknown>;
  /** Lets origin-response rebuild the resource URL for a receipt (its events lack it). */
  distributionDomain: string;
}

/**
 * Build the pending-settlement payload from a verified request. See
 * settlementDeclaredExtensions for how origin-response uses it.
 *
 * Settlement must use the terms the payment was verified under, so everything
 * comes from origin-request: origin-response can run a different function
 * version (and config.json) if a deploy lands between verify and settle.
 *
 * Declared extensions: only the ones this server registers hooks for are
 * carried, which is offer-receipt. The core selects extension hooks by the keys
 * of the declared extensions, and the facilitator's settle call receives only
 * the payload and the requirements, so the others (e.g. bazaar's info and
 * schemas) only cost header bytes. The offer-receipt declaration is taken from
 * this function's config rather than from processHTTPRequest's
 * declaredExtensions: in @x402/core < 2.29 the 402 builder writes each
 * extension's response data (the signed offers) into that object, replacing the
 * declaration, which dropped includeTxHash and left receipts without the
 * transaction hash.
 */
export function buildPendingSettlement(
  verified: { paymentPayload: unknown; paymentRequirements: unknown },
  offerReceipt: OfferReceiptEdgeConfig | undefined,
  distributionDomain: string
): PendingSettlement {
  const declaredExtensions = offerReceiptDeclaration(offerReceipt);
  return declaredExtensions
    ? {
        payload: verified.paymentPayload,
        requirements: verified.paymentRequirements,
        declaredExtensions,
        distributionDomain,
      }
    : { payload: verified.paymentPayload, requirements: verified.paymentRequirements, distributionDomain };
}

/**
 * The declared extensions to settle with, in origin-response.
 *
 * A paid exchange spans three invocations that can run different function
 * versions (and config.json) if a deploy lands in between: the 402 that issued
 * the signed offer, the verify of the paid retry (origin-request), and settle
 * (origin-response). Receipts are therefore issued on a best-effort basis:
 *
 * - declaration carried from verify: settle with it, so includeTxHash and the
 *   validity window are the ones in force when the payment was verified;
 * - nothing carried but offer-receipt on here: settle with this function's own
 *   declaration, so a client still gets a receipt whenever this function can sign;
 * - offer-receipt off here: the extension is not registered, so no hook runs and
 *   no receipt is signed, whatever was carried. The signing key and its grant
 *   exist only where the feature is on.
 *
 * Payment and the resource never depend on the receipt.
 */
export function settlementDeclaredExtensions(
  carried: Pick<PendingSettlement, 'declaredExtensions'>,
  localOfferReceipt: OfferReceiptEdgeConfig | undefined
): Record<string, unknown> | undefined {
  return carried.declaredExtensions ?? offerReceiptDeclaration(localOfferReceipt);
}
