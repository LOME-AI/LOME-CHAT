import { fromBase64, toBase64 } from '@hushbox/shared';

/**
 * RFC 8291 (Message Encryption for Web Push) over the RFC 8188 `aes128gcm`
 * content coding. Clean-room from the RFCs — the algorithm is pinned to RFC
 * 8291 Appendix A's deterministic vector in the colocated test.
 *
 * `aes128gcm` is the only encoding every current push service accepts (Apple's
 * `web.push.apple.com` rejects the legacy `aesgcm` draft with a 403), so no
 * legacy path exists here by design.
 */

/** RFC 8188 §2.1 header fields: salt(16) || rs(4) || idlen(1) || keyid(idlen). */
const SALT_LENGTH = 16;
const RECORD_SIZE_LENGTH = 4;
const ID_LENGTH_LENGTH = 1;
const HEADER_PREFIX_LENGTH = SALT_LENGTH + RECORD_SIZE_LENGTH + ID_LENGTH_LENGTH;

/**
 * RFC 8291 §4 requires the sender's ECDH public key, in X9.62 uncompressed point
 * form (65 octets), to form the entirety of `keyid` — so a Web Push header is
 * always exactly `HEADER_LENGTH` octets.
 */
const KEY_ID_LENGTH = 65;
const HEADER_LENGTH = HEADER_PREFIX_LENGTH + KEY_ID_LENGTH;

/** RFC 8188 header record size, written to the `rs` field. */
const RECORD_SIZE = 4096;

/** aes128gcm content encryption key length (bytes). */
const CEK_LENGTH = 16;

/** aes128gcm nonce length (bytes). */
const NONCE_LENGTH = 12;

/** AEAD_AES_128_GCM authentication tag length (bytes). */
const AUTH_TAG_LENGTH = 16;

/** The single 0x02 last-record padding delimiter octet (RFC 8188 §2). */
const PADDING_DELIMITER_LENGTH = 1;

/** RFC 8030 §7.2: a push service need not accept a payload body larger than this. */
const MAX_BODY_BYTES = 4096;

/**
 * Largest plaintext one interoperable Web Push message can carry, as stated by
 * RFC 8291 §4: the 4096-octet body a push service must support, less the header,
 * the padding delimiter and the AEAD expansion — "at most, 3993 octets of
 * plaintext". Payloads here are tiny generic JSON, so a single record suffices.
 *
 * §4 imposes a second, independent constraint: `rs` MUST be greater than the sum
 * of the plaintext, the padding delimiter and the tag. `RECORD_SIZE` (4096)
 * exceeds that sum (4010) at this ceiling, so both hold. Deriving the ceiling
 * from `RECORD_SIZE` instead would satisfy neither: it yields 4079, whose body is
 * 86 octets over the limit and whose record exactly equals `rs` rather than
 * being smaller.
 */
export const MAX_PLAINTEXT_BYTES =
  MAX_BODY_BYTES - HEADER_LENGTH - PADDING_DELIMITER_LENGTH - AUTH_TAG_LENGTH;

const textEncoder = new TextEncoder();

/**
 * A byte array explicitly backed by a plain `ArrayBuffer` (not a
 * `SharedArrayBuffer`), which is what `crypto.subtle` and `fetch` require. The
 * `@hushbox/shared` base64 helpers and `.subarray()` widen to `ArrayBufferLike`,
 * so byte plumbing here is normalized to this shape at the WebCrypto seams.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** Normalizes any `Uint8Array` into an `ArrayBuffer`-backed copy for WebCrypto. */
function asBytes(data: Uint8Array): Bytes {
  return new Uint8Array(data);
}

/**
 * An ECDH P-256 key in the raw form Web Push uses on the wire: a 32-byte
 * private scalar paired with the 65-byte uncompressed public point.
 */
export interface EphemeralKeyMaterial {
  /** 32-byte P-256 private scalar. */
  readonly privateScalar: Uint8Array;
  /** 65-byte uncompressed public point (`0x04 || X || Y`). */
  readonly publicKey: Uint8Array;
}

export interface EncryptWebPushParams {
  /** The message bytes to encrypt (must not exceed `MAX_PLAINTEXT_BYTES`). */
  readonly plaintext: Uint8Array;
  /** Subscription `p256dh` key: the UA's 65-byte uncompressed public point. */
  readonly clientPublicKey: Uint8Array;
  /** Subscription `auth` secret (16 bytes). */
  readonly authSecret: Uint8Array;
  /** The 16-byte record salt (random in production, injected in tests). */
  readonly salt: Uint8Array;
  /** The sender's ephemeral ECDH key (random in production, injected in tests). */
  readonly ephemeral: EphemeralKeyMaterial;
}

function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ecJwk(publicKey: Uint8Array, privateScalar?: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64(publicKey.subarray(1, 33)),
    y: toBase64(publicKey.subarray(33, 65)),
    ...(privateScalar === undefined ? {} : { d: toBase64(privateScalar) }),
    ext: true,
  };
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', asBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: asBytes(salt), info: asBytes(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/**
 * Generates a fresh ephemeral ECDH P-256 keypair for one message. The keypair
 * is single-use and may be discarded after encryption (RFC 8291 §2).
 */
export async function generateEphemeralKey(): Promise<EphemeralKeyMaterial> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  // The public point comes out as the 65-byte uncompressed `raw` form directly;
  // the private scalar is only reachable through the JWK `d` field.
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  /* v8 ignore next 3 -- WebCrypto always populates `d` when exporting a private
     EC key as JWK; the guard exists so the type is non-optional, and the branch
     is unreachable in practice. */
  if (jwk.d === undefined) {
    throw new Error('exported ECDH private key is missing its scalar');
  }
  return { privateScalar: fromBase64(jwk.d), publicKey };
}

/**
 * Encrypts `plaintext` into a complete RFC 8188 `aes128gcm` message body
 * (`header || ciphertext`) using the RFC 8291 key schedule:
 * ECDH → HKDF key-combining (IKM) → HKDF content key + nonce → AES-128-GCM.
 */
export async function encryptWebPushPayload(params: EncryptWebPushParams): Promise<Bytes> {
  const { plaintext, clientPublicKey, authSecret, salt, ephemeral } = params;

  const senderKey = await crypto.subtle.importKey(
    'jwk',
    ecJwk(ephemeral.publicKey, ephemeral.privateScalar),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const clientKey = await crypto.subtle.importKey(
    'jwk',
    ecJwk(clientPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, senderKey, 256)
  );

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret,
  //   "WebPush: info" || 0x00 || ua_public || as_public, 32).
  const keyInfo = concatBytes(
    textEncoder.encode('WebPush: info'),
    Uint8Array.of(0),
    clientPublicKey,
    ephemeral.publicKey
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: PRK = HKDF-Extract(salt, IKM); CEK and NONCE expand from it.
  const cek = await hkdf(
    salt,
    ikm,
    concatBytes(textEncoder.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0)),
    CEK_LENGTH
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concatBytes(textEncoder.encode('Content-Encoding: nonce'), Uint8Array.of(0)),
    NONCE_LENGTH
  );

  // Single, final record: plaintext with the 0x02 last-record padding delimiter.
  const record = concatBytes(plaintext, Uint8Array.of(0x02));
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, record)
  );

  // RFC 8188 §2.1 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  const header = new Uint8Array(HEADER_PREFIX_LENGTH + ephemeral.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_LENGTH, RECORD_SIZE, false);
  header[SALT_LENGTH + RECORD_SIZE_LENGTH] = ephemeral.publicKey.length;
  header.set(ephemeral.publicKey, HEADER_PREFIX_LENGTH);

  return concatBytes(header, ciphertext);
}
