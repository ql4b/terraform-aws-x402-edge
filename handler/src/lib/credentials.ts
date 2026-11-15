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
 * By default the secret is read from the region in its ARN. With
 * `readReplicas` on, the execution region is tried first (a Secrets Manager
 * replica has the same name and ARN suffix, only the region differs) and the
 * home region is the fallback. A cross-region read from a far edge location
 * costs ~1.2 s on a cold container versus ~0.5 s in-region.
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
  /**
   * Try a replica in the execution region (`AWS_REGION`) before the ARN's home
   * region. Falls back to the home region on any failure of the replica read.
   * Off by default: without a replica the extra attempt only adds latency.
   */
  readReplicas?: boolean;
}

const DEFAULT_TIMEOUT_MS = 2000;
/** A replica that is absent fails fast; do not let a slow one eat the budget. */
const REPLICA_TIMEOUT_MS = 1000;
/** After a failed replica read, skip the replica for this long (per container). */
const REPLICA_BACKOFF_MS = 15 * 60 * 1000;

/** The secret ARN with its region swapped (a replica shares name and suffix). */
export function arnInRegion(secretArn: string, region: string): string {
  const parts = secretArn.split(':');
  parts[3] = region;
  return parts.join(':');
}

/**
 * Regions to read from, in order: the execution region first when replica reads
 * are on and it differs from the ARN's region, then the home region.
 */
export function readRegions(homeRegion: string, executionRegion: string | undefined, readReplicas: boolean): string[] {
  if (readReplicas && executionRegion && executionRegion !== homeRegion) {
    return [executionRegion, homeRegion];
  }
  return [homeRegion];
}

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
  const homeRegion = secretRegion(config.secretArn);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cached: { value: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;
  // Negative cache: when a replica read fails, go straight to the home region
  // until this time, so a missing replica costs one failed call per container
  // (per backoff window) rather than one per TTL refresh.
  let replicaRetryAt = 0;

  async function fetchFrom(region: string, timeout: number): Promise<string> {
    const endpoint = `https://secretsmanager.${region}.amazonaws.com/`;
    const secretId = arnInRegion(config.secretArn, region);
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
        body: JSON.stringify({ SecretId: secretId }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      // Timeouts and network errors never reach the status log below; record
      // them here so a bad replica is visible rather than a silent slow start.
      console.log(
        JSON.stringify({
          msg: 'x402 facilitator secret fetch failed',
          executionRegion: process.env.AWS_REGION,
          secretRegion: region,
          homeRegion,
          error: err instanceof Error ? err.name : 'unknown',
          latencyMs: Date.now() - started,
        })
      );
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
        homeRegion,
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

  async function fetchSecret(): Promise<string> {
    let regions = readRegions(homeRegion, process.env.AWS_REGION, config.readReplicas === true);
    if (regions.length > 1 && Date.now() < replicaRetryAt) {
      regions = [homeRegion];
    }
    let lastError: unknown;
    for (const region of regions) {
      const isReplica = region !== homeRegion;
      try {
        return await fetchFrom(region, isReplica ? Math.min(timeoutMs, REPLICA_TIMEOUT_MS) : timeoutMs);
      } catch (err) {
        lastError = err;
        if (isReplica) {
          replicaRetryAt = Date.now() + REPLICA_BACKOFF_MS;
          console.log(
            JSON.stringify({
              msg: 'x402 secret replica unavailable, falling back to home region',
              executionRegion: process.env.AWS_REGION,
              replicaRegion: region,
              homeRegion,
              retryAfterMs: REPLICA_BACKOFF_MS,
            })
          );
        }
        // Replica miss: fall through to the home region. A home-region failure
        // is final (fail closed).
      }
    }
    throw lastError;
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
