import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { FacilitatorConfig } from '@x402/core/server';
import { CredentialsUnavailableError, type SecretSource } from './credentials';

/**
 * Coinbase CDP facilitator authentication.
 *
 * Every CDP facilitator call carries `Authorization: Bearer <JWT>`, where the
 * JWT is signed with the CDP API key secret and bound to one request
 * (`uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]`), valid for
 * 120 s. This reproduces `generateJwt` from `@coinbase/cdp-sdk/auth` (as used
 * by `@coinbase/x402`'s `createCdpAuthHeaders`) with `node:crypto` only, so the
 * edge bundle does not pull in the CDP SDK, jose and their dependency tree.
 *
 * Supported key formats, as issued by CDP:
 *   - Ed25519: base64 of 64 bytes (32-byte seed + 32-byte public key) -> EdDSA
 *   - EC P-256: PEM private key (SEC1 or PKCS#8)                       -> ES256
 *
 * The secret is stored in Secrets Manager as JSON:
 *   { "apiKeyId": "<key id or organizations/.../apiKeys/...>", "apiKeySecret": "<secret>" }
 */

const JWT_TTL_SECONDS = 120;

export interface CdpApiKey {
  apiKeyId: string;
  apiKeySecret: string;
}

interface SigningKey {
  alg: 'EdDSA' | 'ES256';
  key: KeyObject;
}

export function parseCdpSecret(secretString: string): CdpApiKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new CredentialsUnavailableError('facilitator auth: CDP secret is not JSON');
  }
  const s = parsed as Partial<CdpApiKey>;
  if (typeof s.apiKeyId !== 'string' || s.apiKeyId === '') {
    throw new CredentialsUnavailableError('facilitator auth: CDP secret missing "apiKeyId"');
  }
  if (typeof s.apiKeySecret !== 'string' || s.apiKeySecret === '') {
    throw new CredentialsUnavailableError('facilitator auth: CDP secret missing "apiKeySecret"');
  }
  return { apiKeyId: s.apiKeyId, apiKeySecret: s.apiKeySecret };
}

/** Import a CDP API key secret. Error messages never include key material. */
export function importCdpKey(apiKeySecret: string): SigningKey {
  if (apiKeySecret.includes('-----BEGIN')) {
    let key: KeyObject;
    try {
      key = createPrivateKey(apiKeySecret);
    } catch {
      throw new CredentialsUnavailableError('facilitator auth: CDP EC key is not a valid PEM private key');
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new CredentialsUnavailableError('facilitator auth: CDP EC key must be P-256');
    }
    return { alg: 'ES256', key };
  }

  const raw = Buffer.from(apiKeySecret, 'base64');
  if (raw.length !== 64) {
    throw new CredentialsUnavailableError(
      'facilitator auth: CDP key must be a PEM EC key or a base64 Ed25519 key (64 bytes)'
    );
  }
  try {
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: raw.subarray(0, 32).toString('base64url'),
        x: raw.subarray(32).toString('base64url'),
      },
    });
    return { alg: 'EdDSA', key };
  } catch {
    throw new CredentialsUnavailableError('facilitator auth: CDP Ed25519 key is invalid');
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Sign a CDP REST JWT for one request (`METHOD host/path`). */
export function signCdpJwt(
  apiKeyId: string,
  signingKey: SigningKey,
  requestMethod: string,
  requestHost: string,
  requestPath: string,
  now: number = Math.floor(Date.now() / 1000)
): string {
  const header = {
    alg: signingKey.alg,
    kid: apiKeyId,
    typ: 'JWT',
    nonce: randomBytes(16).toString('hex'),
  };
  const claims = {
    sub: apiKeyId,
    iss: 'cdp',
    uris: [`${requestMethod} ${requestHost}${requestPath}`],
    iat: now,
    nbf: now,
    exp: now + JWT_TTL_SECONDS,
  };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const signature =
    signingKey.alg === 'EdDSA'
      ? sign(null, Buffer.from(signingInput), signingKey.key)
      : // JWS ES256 wants the raw r||s form, not DER.
        sign('sha256', Buffer.from(signingInput), { key: signingKey.key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Build the x402 `FacilitatorConfig` for a CDP facilitator whose API key lives
 * in Secrets Manager. The secret is read through `source` (cached with a TTL);
 * the imported key is reused until the secret value changes.
 *
 * JWT `uris` are derived from `facilitatorUrl`, so they always match the URL
 * the client actually calls (e.g. https://api.cdp.coinbase.com/platform/v2/x402).
 */
export function createCdpFacilitatorConfig(facilitatorUrl: string, source: SecretSource): FacilitatorConfig {
  const url = new URL(facilitatorUrl);
  const host = url.host;
  const basePath = url.pathname.replace(/\/+$/, '');

  let imported: { secretString: string; apiKeyId: string; signingKey: SigningKey } | null = null;

  async function currentKey() {
    const secretString = await source.get();
    if (!imported || imported.secretString !== secretString) {
      const { apiKeyId, apiKeySecret } = parseCdpSecret(secretString);
      imported = { secretString, apiKeyId, signingKey: importCdpKey(apiKeySecret) };
    }
    return imported;
  }

  // Informational client tag CDP's own helper sends; carries no auth meaning.
  const correlation = 'sdk_language=typescript,source=x402';

  return {
    url: facilitatorUrl.replace(/\/+$/, ''),
    createAuthHeaders: async () => {
      const { apiKeyId, signingKey } = await currentKey();
      const bearer = (method: string, path: string) =>
        `Bearer ${signCdpJwt(apiKeyId, signingKey, method, host, `${basePath}${path}`)}`;
      return {
        verify: { Authorization: bearer('POST', '/verify'), 'Correlation-Context': correlation },
        settle: { Authorization: bearer('POST', '/settle'), 'Correlation-Context': correlation },
        supported: { Authorization: bearer('GET', '/supported'), 'Correlation-Context': correlation },
      };
    },
  };
}
