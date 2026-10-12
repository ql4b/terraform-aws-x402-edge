import { AwsClient } from 'aws4fetch';

/**
 * Facilitator credentials loaded from AWS Secrets Manager.
 *
 * Lambda@Edge has no user-defined environment variables, and baking a key into
 * the deployment zip replicates it to every edge region and exposes it via
 * `lambda:GetFunction`. Instead, the zip carries only the secret ARN; the
 * secret value is fetched on first use, held in module scope for `ttlSeconds`,
 * and re-fetched after that so a rotated key is picked up without a redeploy.
 *
 * The call is a SigV4-signed `GetSecretValue` (aws4fetch) using the execution
 * role's reserved credential environment variables — no AWS SDK in the
 * bundle and no SDK cold-start import cost.
 *
 * v1 reads the secret from the region in its ARN. Reading a nearer replica is
 * a later step; the IAM grant already allows any region for this secret name.
 */

/** Raised when the credentials cannot be loaded. The middleware maps it to 503. */
export class CredentialsUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialsUnavailableError';
  }
}

export interface SecretSourceConfig {
  /** Full Secrets Manager secret ARN. */
  secretArn: string;
  /** How long a fetched value is reused before re-fetching. */
  ttlSeconds: number;
  /** Per-attempt timeout for GetSecretValue. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

/** Region of a secret ARN: arn:aws:secretsmanager:<region>:<account>:secret:<name>. */
export function secretRegion(secretArn: string): string {
  const parts = secretArn.split(':');
  if (parts.length < 7 || parts[2] !== 'secretsmanager' || !parts[3]) {
    throw new CredentialsUnavailableError('facilitator auth: invalid secret ARN');
  }
  return parts[3];
}

/**
 * A cached loader for one secret's `SecretString`. Concurrent callers during a
 * fetch share the same in-flight request. A failed fetch is not cached, and an
 * expired value is not served on failure (fail closed: no stale credentials
 * after a rotation that revoked them).
 */
export function createSecretSource(config: SecretSourceConfig) {
  const region = secretRegion(config.secretArn);
  const endpoint = `https://secretsmanager.${region}.amazonaws.com/`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cached: { value: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchSecret(): Promise<string> {
    const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      throw new CredentialsUnavailableError('facilitator auth: no AWS credentials in the environment');
    }
    const aws = new AwsClient({
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
      service: 'secretsmanager',
      region,
      retries: 0,
    });

    const started = Date.now();
    let response: Response;
    try {
      response = await aws.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'secretsmanager.GetSecretValue',
        },
        body: JSON.stringify({ SecretId: config.secretArn }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CredentialsUnavailableError('facilitator auth: GetSecretValue request failed', { cause: err });
    }
    const latencyMs = Date.now() - started;

    // One structured line per fetch: the data that decides whether nearer
    // replicas are worth adding. Never log the value.
    console.log(
      JSON.stringify({
        msg: 'x402 facilitator secret fetch',
        executionRegion: process.env.AWS_REGION,
        secretRegion: region,
        status: response.status,
        latencyMs,
      })
    );

    if (!response.ok) {
      // The error body carries only the AWS error type/message, not the value.
      const text = await response.text().catch(() => '');
      throw new CredentialsUnavailableError(
        `facilitator auth: GetSecretValue returned ${response.status} ${text.slice(0, 200)}`
      );
    }

    const body = (await response.json()) as { SecretString?: string };
    if (typeof body.SecretString !== 'string' || body.SecretString === '') {
      throw new CredentialsUnavailableError('facilitator auth: secret has no SecretString');
    }
    return body.SecretString;
  }

  return {
    async get(): Promise<string> {
      if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
      }
      if (!inFlight) {
        inFlight = fetchSecret()
          .then((value) => {
            cached = { value, expiresAt: Date.now() + config.ttlSeconds * 1000 };
            return value;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}

export type SecretSource = ReturnType<typeof createSecretSource>;
