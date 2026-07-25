import { toBase64 } from '@hushbox/shared';

/**
 * Derives the per-conversation collapse alias: the first 32 base64url
 * characters of HMAC-SHA-256(secret, conversationId). This value stands in for
 * the raw conversationId in the collapse identity every push service sees (the
 * FCM collapse_key, the APNs collapse id, the Web Push Topic), so the services
 * collapse a conversation's pending notifications to one without ever seeing
 * the id (the generic-payload law). It is deliberately NOT the Android
 * notification tag: that is the device-local address the client clears a read
 * conversation by, and it carries the raw id. base64url is exactly the Topic
 * alphabet, and 32 chars is the Web Push Topic ceiling.
 */
export function createCollapseAliasDeriver(
  secret: string
): (conversationId: string) => Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  let keyPromise: Promise<CryptoKey> | null = null;
  const signingKey = (): Promise<CryptoKey> =>
    (keyPromise ??= crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ));

  return async (conversationId: string): Promise<string> => {
    const mac = await crypto.subtle.sign(
      'HMAC',
      await signingKey(),
      new TextEncoder().encode(conversationId)
    );
    return toBase64(new Uint8Array(mac)).slice(0, 32);
  };
}
