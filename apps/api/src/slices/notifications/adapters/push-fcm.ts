import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { PushDelivery, PushMessage, PushSender } from '../ports/index.js';

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

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [\w ]+-----/, '')
    .replace(/-----END [\w ]+-----/, '')
    .replaceAll(/\s/g, '');

  const binaryString = atob(base64);
  const bytes = Uint8Array.from(binaryString, (char) => char.codePointAt(0) ?? 0);
  return bytes.buffer;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binaryString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
  return btoa(binaryString).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function stringToBase64Url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function createSignedJwt(privateKeyPem: string, clientEmail: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  };

  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(
    JSON.stringify(payload)
  )}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${arrayBufferToBase64Url(signature)}`;
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
      message.tokens.map(async (token) => {
        const body = {
          message: {
            token,
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

        if (!response.ok) {
          throw new Error(`FCM send failed: HTTP ${String(response.status)}`);
        }
      })
    );

    let successCount = 0;
    let failureCount = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failureCount++;
      }
    }

    if (config.db !== undefined && successCount > 0) {
      await recordServiceEvidence(config.db, config.isCI ?? false, SERVICE_NAMES.PUSH_FCM, {
        successCount,
        failureCount,
      });
    }

    return { successCount, failureCount };
  }

  return {
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      if (message.tokens.length === 0) {
        return okAsync({ successCount: 0, failureCount: 0 });
      }
      return fromPromise(deliver(message), (cause) =>
        unavailableError('push delivery failed', cause)
      );
    },
  };
}
