import { SignJWT } from 'jose';
import { fromBase64, toBase64 } from '@hushbox/shared';

/**
 * RFC 8292 (VAPID) — the application-server identification JWT. The push
 * service receives `Authorization: vapid t=<ES256 JWT>, k=<public key>` and
 * verifies the JWT against the public key, proving the sender controls the
 * VAPID keypair the subscription was created with.
 */

/** Default token lifetime — comfortably inside the RFC 8292 24-hour ceiling. */
const DEFAULT_EXPIRY_SECONDS = 12 * 60 * 60;

/** RFC 8292 §2: `exp` must be no more than 24 hours from issuance. */
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;

export interface VapidKeys {
  /** `mailto:` or `https:` URI identifying the sender (RFC 8292 §2.1 `sub`). */
  readonly subject: string;
  /** 65-byte uncompressed P-256 public point, base64url. */
  readonly publicKey: string;
  /** 32-byte P-256 private scalar, base64url. */
  readonly privateKey: string;
}

export interface VapidAuthorizationParams {
  /** The subscription endpoint; its origin becomes the JWT `aud`. */
  readonly endpoint: string;
  readonly keys: VapidKeys;
  /** Current time in epoch milliseconds (injected for deterministic tests). */
  readonly nowMs: number;
  /** Token lifetime in seconds; defaults to 12h, capped at 24h. */
  readonly expirySeconds?: number;
}

async function importSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicPoint = fromBase64(keys.publicKey);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64(publicPoint.subarray(1, 33)),
      y: toBase64(publicPoint.subarray(33, 65)),
      d: keys.privateKey,
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/**
 * Builds the `Authorization` header value for a Web Push request: an ES256 JWT
 * bound to the endpoint origin, plus the sender's public key in the `k`
 * parameter.
 */
export async function createVapidAuthorization(params: VapidAuthorizationParams): Promise<string> {
  const { endpoint, keys, nowMs } = params;
  const expirySeconds = params.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (expirySeconds <= 0 || expirySeconds > MAX_EXPIRY_SECONDS) {
    throw new Error('VAPID token expiry must be within (0, 24h]');
  }

  const issuedAt = Math.floor(nowMs / 1000);
  const audience = new URL(endpoint).origin;
  const signingKey = await importSigningKey(keys);

  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: 'JWT', alg: 'ES256' })
    .setAudience(audience)
    .setSubject(keys.subject)
    .setExpirationTime(issuedAt + expirySeconds)
    .sign(signingKey);

  return `vapid t=${jwt}, k=${keys.publicKey}`;
}
