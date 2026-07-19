import { toBase64, textEncoder } from '@hushbox/shared';

export interface Rs256JwtSignParams {
  /** PKCS#8 PEM-encoded RSA private key (the service-account `private_key`). */
  privateKeyPem: string;
  /** JWT claim set; serialized verbatim as the payload segment. */
  claims: Record<string, unknown>;
}

/** Strip the PEM armor and decode the base64 body to raw PKCS#8 DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [\w ]+-----/, '')
    .replace(/-----END [\w ]+-----/, '')
    .replaceAll(/\s/g, '');

  const binaryString = atob(base64);
  /* v8 ignore next -- unreachable `?? 0`: each `char` is a single code point from Uint8Array.from(string, …), so codePointAt(0) is always defined */
  const bytes = Uint8Array.from(binaryString, (char) => char.codePointAt(0) ?? 0);
  return bytes.buffer;
}

/**
 * Sign a compact JWT with RS256 (RSASSA-PKCS1-v1_5 over SHA-256). The keyed
 * asymmetric operation lives here so that all keyed crypto stays inside
 * `packages/crypto` (segregation doctrine — see `index.ts`); callers pass only
 * their claim set and PEM key and never touch `crypto.subtle` directly.
 */
export async function signRs256Jwt(params: Rs256JwtSignParams): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };

  const signingInput = `${toBase64(textEncoder.encode(JSON.stringify(header)))}.${toBase64(
    textEncoder.encode(JSON.stringify(params.claims))
  )}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(params.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    textEncoder.encode(signingInput)
  );

  return `${signingInput}.${toBase64(new Uint8Array(signature))}`;
}
