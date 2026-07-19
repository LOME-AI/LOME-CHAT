import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { signRs256Jwt } from '@hushbox/crypto';
import { fromPromise } from '../../../lib/result/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { PushDelivery, PushMessage, PushRecipient, PushSender } from '../ports/index.js';

const FCM_SEND_URL = 'https://fcm.googleapis.com/v1/projects';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const JWT_LIFETIME_SECONDS = 3600;

interface ServiceAccountConfig {
  clientEmail: string;
  privateKeyPem: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

/**
 * Module-level OAuth token cache — survives across requests inside a Workers
 * isolate, so the JWT exchange runs once per token lifetime instead of once
 * per push. Eviction is harmless (the next send re-exchanges), which keeps
 * this within the serverless no-persistent-state rule's spirit: it is a
 * recoverable optimization, never a source of truth.
 */
let tokenCache: TokenCache | null = null;

/** @internal Test-only: resets the module-level token cache between tests. */
export function _resetTokenCache(): void {
  tokenCache = null;
}

function parseServiceAccountConfig(json: string): ServiceAccountConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  if (typeof parsed['client_email'] !== 'string' || parsed['client_email'].length === 0) {
    throw new Error('Service account JSON missing required field: client_email');
  }

  if (typeof parsed['private_key'] !== 'string' || parsed['private_key'].length === 0) {
    throw new Error('Service account JSON missing required field: private_key');
  }

  return {
    clientEmail: parsed['client_email'],
    privateKeyPem: parsed['private_key'],
  };
}

/**
 * Build the Google OAuth JWT claim set and sign it with RS256. The keyed
 * asymmetric signing lives in `@hushbox/crypto` (crypto-segregation doctrine);
 * this adapter only assembles the FCM-specific claims.
 */
function createSignedJwt(privateKeyPem: string, clientEmail: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signRs256Jwt({
    privateKeyPem,
    claims: {
      iss: clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + JWT_LIFETIME_SECONDS,
    },
  });
}

async function getAccessToken(
  config: ServiceAccountConfig,
  fetchImpl: typeof fetch
): Promise<string> {
  if (tokenCache !== null && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const jwt = await createSignedJwt(config.privateKeyPem, config.clientEmail);

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${String(response.status)}`);
  }

  const data: { access_token: string; expires_in: number } = await response.json();

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };

  return data.access_token;
}

/**
 * FCM error codes that mean the token is permanently gone and must be pruned.
 * `UNREGISTERED` is the app-uninstalled/token-rotated signal; `NOT_FOUND` is
 * the HTTP-status form of the same condition.
 */
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(['UNREGISTERED', 'NOT_FOUND']);

/**
 * Collects every error code an FCM v1 error object exposes: a bare `error`
 * string (the shape a simplified mock may send), the `error.status`, and each
 * `error.details[].errorCode`.
 */
function collectFcmErrorCodes(error: unknown): string[] {
  if (typeof error === 'string') {
    return [error];
  }
  if (typeof error !== 'object' || error === null) {
    return [];
  }
  const codes: string[] = [];
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'string') {
    codes.push(status);
  }
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const errorCode = (detail as { errorCode?: unknown }).errorCode;
      if (typeof errorCode === 'string') {
        codes.push(errorCode);
      }
    }
  }
  return codes;
}

/**
 * Reads the dead-token signal from an FCM v1 per-message error body. A body we
 * cannot interpret yields no codes, so an unparseable failure never prunes a
 * token — pruning is only ever driven by an explicit dead-token signal.
 */
function fcmBodyIsDeadToken(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const error = (body as { error?: unknown }).error;
  return collectFcmErrorCodes(error).some((code) => DEAD_TOKEN_CODES.has(code));
}

/**
 * Parses a failed FCM response body without letting a non-JSON body throw —
 * an error response that is not JSON simply cannot signal a dead token.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
    // A non-JSON error body carries no dead-token signal, so the safe read is
    // "unknown ⇒ never prune"; this is a deliberate no-op, not a hidden error.
    // eslint-disable-next-line catch-swallow/no-silent-catch -- unparseable body yields no dead-token verdict by design
  } catch {
    return undefined;
  }
}

export interface FcmPushSenderConfig {
  readonly projectId: string;
  readonly serviceAccountJson: string;
  readonly fetchImpl?: typeof fetch;
  /** Evidence writes go through `recordServiceEvidence` (CI-only inside). */
  readonly db?: Database;
  readonly isCI?: boolean;
}

/**
 * The real FCM adapter (HTTP v1 API). Construction fails fast on a malformed
 * service account; delivery counts per-token failures instead of failing the
 * whole send. Error messages never carry device tokens — tokens are
 * credentials and stay out of every log and error channel.
 *
 * After a send that reached FCM (at least one token delivered) it records a
 * `push-fcm` service-evidence row (a no-op outside CI, and skipped entirely
 * when no db is wired), so CI's `verify:evidence` step can prove the real seam
 * was exercised — the same parity the Resend and R2 adapters carry.
 */
export function createFcmPushSender(config: FcmPushSenderConfig): PushSender {
  const account = parseServiceAccountConfig(config.serviceAccountJson);
  const fetchImpl = config.fetchImpl ?? fetch;

  async function deliver(message: PushMessage): Promise<PushDelivery> {
    const accessToken = await getAccessToken(account, fetchImpl);
    const url = `${FCM_SEND_URL}/${config.projectId}/messages:send`;

    const results = await Promise.allSettled(
      message.recipients.map(async (recipient) => {
        const body = {
          message: {
            token: recipient.token,
            notification: { title: message.title, body: message.body },
            ...(message.data === undefined ? {} : { data: message.data }),
          },
        };

        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          return { recipient, delivered: true as const };
        }
        const dead = fcmBodyIsDeadToken(await readErrorBody(response));
        return { recipient, delivered: false as const, dead };
      })
    );

    let successCount = 0;
    let failureCount = 0;
    const deadTokens: PushRecipient[] = [];
    for (const result of results) {
      // A rejected settlement is a network/transport throw, not a token verdict.
      if (result.status === 'rejected') {
        failureCount++;
        continue;
      }
      if (result.value.delivered) {
        successCount++;
        continue;
      }
      failureCount++;
      if (result.value.dead) {
        deadTokens.push(result.value.recipient);
      }
    }

    if (config.db !== undefined && successCount > 0) {
      await recordServiceEvidence(config.db, config.isCI ?? false, SERVICE_NAMES.PUSH_FCM, {
        successCount,
        failureCount,
      });
    }

    return { successCount, failureCount, deadTokens };
  }

  return {
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      if (message.recipients.length === 0) {
        return okAsync({ successCount: 0, failureCount: 0, deadTokens: [] });
      }
      return fromPromise(deliver(message), (cause) =>
        unavailableError('push delivery failed', cause)
      );
    },
  };
}
