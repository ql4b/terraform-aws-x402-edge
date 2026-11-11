/**
 * x402 edge configuration — loaded at runtime from `config.json`.
 *
 * Lambda@Edge does not support environment variables, so configuration cannot
 * come from the environment. Instead of compiling it into the bundle, the
 * deployment zip carries a `config.json` next to `index.js`: the Terraform
 * module renders it from its inputs (`facilitator_url`, `network`, `pay_to`,
 * `public_host`, `routes`) and adds it to the archive at packaging time. The
 * bundle itself is generic — the same `index.js` serves any facilitator /
 * network / payee / route set.
 *
 * Read with `readFileSync` (not `import`/`require`) on purpose: esbuild would
 * otherwise inline the JSON at build time and re-couple config to the bundle.
 *
 * Shape of config.json:
 *   {
 *     "facilitatorUrl": "https://facilitator.payai.network",
 *     "publicHost":     "pay.example.com",          // optional
 *     "supported":      { kinds, extensions, signers },  // optional (baked /supported)
 *     "facilitatorAuth": { "type": "cdp", "secretArn": "arn:...", "cacheTtlSeconds": 300 },  // optional
 *     "offerReceipt":   { "enabled": true, "format": "eip712", "signingKeySecretArn": "arn:...",
 *                         "signerDid": "did:web:...", "kid": "did:web:...#key-1",
 *                         "includeTxHash": false, "offerValiditySeconds": 300, "cacheTtlSeconds": 300 },  // optional
 *     "routes":         { "<x402 route pattern>": RouteConfig, ... }
 *   }
 *
 * Route keys use x402 RoutesConfig patterns: "/path", "/path/*" (trailing
 * wildcard, also matches "/path"), "/a/[id]" or "/a/:id", optional verb prefix
 * ("GET /path").
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutesConfig } from '@x402/core/server';
import type { FacilitatorAuthConfig, OfferReceiptEdgeConfig, SupportedResponse } from './lib/server';

export interface EdgeConfig {
  /** x402 facilitator base URL. */
  facilitatorUrl: string;
  /**
   * Public host advertised in the challenge `resource.url`. CloudFront's
   * `distributionDomainName` is always the *.cloudfront.net name, even behind a
   * custom alias, so set this when a custom domain is attached.
   */
  publicHost?: string;
  /**
   * Optional pre-fetched facilitator `/supported` response. When present, the
   * handler does not call `GET /supported` on cold start (the Terraform module
   * fetched it at plan time). Omit to keep the live fetch.
   */
  supported?: SupportedResponse;
  /**
   * Optional facilitator authentication. Only the secret's ARN is in the zip;
   * the value is read from Secrets Manager at runtime (see lib/credentials.ts).
   */
  facilitatorAuth?: FacilitatorAuthConfig;
  /**
   * Optional opt-in x402 Signed Offers & Receipts. Only the signing-key secret
   * ARN is in the zip; the hex key is read from Secrets Manager at runtime.
   * Absent ⇒ no offers or receipts are signed (byte-identical to today).
   */
  offerReceipt?: OfferReceiptEdgeConfig;
  /** Payment-gated routes (x402 RoutesConfig). */
  routes: RoutesConfig;
}

const CONFIG_FILE = 'config.json';

function loadConfig(): EdgeConfig {
  const path = join(__dirname, CONFIG_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Fail at cold start, loudly: a missing/invalid config must never degrade
    // into serving the protected origin unpaid.
    throw new Error(`x402 edge: cannot load ${path}: ${(err as Error).message}`);
  }

  const c = parsed as Partial<EdgeConfig>;
  if (typeof c.facilitatorUrl !== 'string' || c.facilitatorUrl === '') {
    throw new Error('x402 edge: config.json missing "facilitatorUrl"');
  }
  if (!c.routes || typeof c.routes !== 'object' || Object.keys(c.routes).length === 0) {
    throw new Error('x402 edge: config.json missing or empty "routes"');
  }
  if (c.publicHost !== undefined && typeof c.publicHost !== 'string') {
    throw new Error('x402 edge: config.json "publicHost" must be a string');
  }
  if (c.supported !== undefined) {
    const s = c.supported as Partial<SupportedResponse>;
    if (!s || typeof s !== 'object' || !Array.isArray(s.kinds) || s.kinds.length === 0) {
      throw new Error('x402 edge: config.json "supported" must have a non-empty "kinds" array');
    }
  }
  if (c.facilitatorAuth !== undefined) {
    const a = c.facilitatorAuth as Partial<FacilitatorAuthConfig>;
    if (!a || a.type !== 'cdp') {
      throw new Error('x402 edge: config.json "facilitatorAuth.type" must be "cdp"');
    }
    if (typeof a.secretArn !== 'string' || !a.secretArn.startsWith('arn:')) {
      throw new Error('x402 edge: config.json "facilitatorAuth.secretArn" must be a secret ARN');
    }
    if (typeof a.cacheTtlSeconds !== 'number' || a.cacheTtlSeconds < 0) {
      throw new Error('x402 edge: config.json "facilitatorAuth.cacheTtlSeconds" must be a non-negative number');
    }
  }
  if (c.offerReceipt !== undefined) {
    const o = c.offerReceipt as Partial<OfferReceiptEdgeConfig>;
    if (!o || typeof o.enabled !== 'boolean') {
      throw new Error('x402 edge: config.json "offerReceipt.enabled" must be a boolean');
    }
    if (o.enabled) {
      if (o.format !== 'eip712') {
        throw new Error('x402 edge: config.json "offerReceipt.format" must be "eip712"');
      }
      if (typeof o.signingKeySecretArn !== 'string' || !o.signingKeySecretArn.startsWith('arn:')) {
        throw new Error('x402 edge: config.json "offerReceipt.signingKeySecretArn" must be a secret ARN');
      }
      if (typeof o.kid !== 'string' || o.kid === '') {
        throw new Error('x402 edge: config.json "offerReceipt.kid" must be a non-empty string');
      }
      if (typeof o.offerValiditySeconds !== 'number' || o.offerValiditySeconds <= 0) {
        throw new Error('x402 edge: config.json "offerReceipt.offerValiditySeconds" must be a positive number');
      }
      if (typeof o.cacheTtlSeconds !== 'number' || o.cacheTtlSeconds < 0) {
        throw new Error('x402 edge: config.json "offerReceipt.cacheTtlSeconds" must be a non-negative number');
      }
    }
  }
  return c as EdgeConfig;
}

export const CONFIG: EdgeConfig = loadConfig();

// Named exports kept stable so the handlers are unchanged.
export const FACILITATOR_URL = CONFIG.facilitatorUrl;
export const PUBLIC_HOST = CONFIG.publicHost;
export const SUPPORTED = CONFIG.supported;
export const FACILITATOR_AUTH = CONFIG.facilitatorAuth;
export const OFFER_RECEIPT = CONFIG.offerReceipt;
export const ROUTES: RoutesConfig = CONFIG.routes;
