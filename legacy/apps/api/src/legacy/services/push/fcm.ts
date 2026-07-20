import type { PushClient, PushNotification, PushResult } from './types.js';

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

/** Module-level token cache — persists across requests in Workers isolate. */
let tokenCache: TokenCache | null = null;

/** @internal Test-only: resets module-level token cache between tests. */
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

  const headerB64 = stringToBase64Url(JSON.stringify(header));
  const payloadB64 = stringToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const der = pemToDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
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

async function getAccessToken(config: ServiceAccountConfig): Promise<string> {
  if (tokenCache !== null && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const jwt = await createSignedJwt(config.privateKeyPem, config.clientEmail);

  const response = await fetch(GOOGLE_TOKEN_URL, {
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

export function createFcmPushClient(projectId: string, serviceAccountJson: string): PushClient {
  const config = parseServiceAccountConfig(serviceAccountJson);

  return {
    async send(notification: PushNotification): Promise<PushResult> {
      if (notification.tokens.length === 0) {
        return { successCount: 0, failureCount: 0 };
      }

      const accessToken = await getAccessToken(config);
      const url = `${FCM_SEND_URL}/${projectId}/messages:send`;
      let successCount = 0;
      let failureCount = 0;

      const results = await Promise.allSettled(
        notification.tokens.map(async (token) => {
          const body: Record<string, unknown> = {
            message: {
              token,
              notification: {
                title: notification.title,
                body: notification.body,
              },
              ...(notification.data !== undefined && { data: notification.data }),
            },
          };

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            throw new Error(`FCM send failed for token ${token}: HTTP ${String(response.status)}`);
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          successCount++;
        } else {
          failureCount++;
        }
      }

      return { successCount, failureCount };
    },
  };
}
