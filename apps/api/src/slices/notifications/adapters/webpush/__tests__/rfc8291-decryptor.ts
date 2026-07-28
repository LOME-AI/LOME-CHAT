import { fromBase64, toBase64 } from '@hushbox/shared';

// An independent Web Push receiver, written from RFC 8291 and RFC 8188 as the external
// anchor for the sender in this directory. It is deliberately NOT an inversion of the
// sender's steps: an oracle reasoned out of the same code it checks would inherit that
// code's mistakes and prove nothing. Every constant and every step below cites the
// specification section it comes from.
//
// Test-only. Production never decrypts a Web Push body — the user agent does.

// RFC 8188 §2.1: header block is salt(16) || rs(4) || idlen(1) || keyid(idlen).
const SALT_LENGTH = 16;
const RECORD_SIZE_LENGTH = 4;
const ID_LENGTH_LENGTH = 1;
const HEADER_PREFIX_LENGTH = SALT_LENGTH + RECORD_SIZE_LENGTH + ID_LENGTH_LENGTH;

// RFC 8188 §2.1: "Values smaller than 18 are invalid" for the record size.
const MIN_RECORD_SIZE = 18;

// RFC 8291 §4: the keyid is the application server's public key in the X9.62
// uncompressed point form — a 65-octet sequence starting with 0x04.
const UNCOMPRESSED_POINT_LENGTH = 65;
const UNCOMPRESSED_POINT_TAG = 0x04;
const COORDINATE_LENGTH = 32;

// RFC 8188 §2: AEAD_AES_128_GCM produces ciphertext 16 octets longer than its input, and
// a valid record always holds at least a padding delimiter plus that tag.
const AEAD_TAG_LENGTH = 16;
const MIN_RECORD_LENGTH = AEAD_TAG_LENGTH + 1;

// RFC 8188 §2.2 / §2.3: the CEK is 16 octets, the nonce 12.
const CEK_LENGTH = 16;
const NONCE_LENGTH = 12;

// RFC 8188 §2: "The last record uses a padding delimiter octet set to the value 2".
const LAST_RECORD_DELIMITER = 0x02;

// RFC 8291 §3.2: "a hard-to-guess sequence of 16 octets".
const AUTH_SECRET_LENGTH = 16;

/** A push subscription's receiving material, as the user agent holds it. */
export interface WebPushReceiverKeys {
  /** Subscription public key, X9.62 uncompressed point form (the `p256dh` value). */
  readonly publicKey: Uint8Array;
  /** Subscription private key, as the raw 32-octet P-256 scalar. */
  readonly privateKey: Uint8Array;
  /** RFC 8291 §3.2: the 16-octet authentication secret (the `auth` value). */
  readonly authSecret: Uint8Array;
}

/**
 * A fresh subscription, as a user agent creates one: a P-256 key pair (RFC 8291 §3.1) and
 * a hard-to-guess 16-octet authentication secret (§3.2).
 */
export async function generateSubscriptionKeys(): Promise<WebPushReceiverKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (exported.d === undefined) {
    throw new Error('generated P-256 key exported without a private scalar');
  }
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: fromBase64(exported.d),
    authSecret: crypto.getRandomValues(new Uint8Array(AUTH_SECRET_LENGTH)),
  };
}

interface ContentCodingHeader {
  readonly salt: Uint8Array;
  readonly recordSize: number;
  readonly keyid: Uint8Array;
  readonly record: Uint8Array;
}

/** WebCrypto's `BufferSource` needs an `ArrayBuffer`-backed view, not a `SharedArrayBuffer` one. */
type Bytes = Uint8Array<ArrayBuffer>;

function asBytes(data: Uint8Array): Bytes {
  return new Uint8Array(data);
}

function concatenate(...parts: readonly Uint8Array[]): Bytes {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

function ascii(text: string): Bytes {
  return new TextEncoder().encode(text);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    asBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, asBytes(data)));
}

/** RFC 8188 §2.1. */
function parseContentCodingHeader(body: Uint8Array): ContentCodingHeader {
  if (body.length < HEADER_PREFIX_LENGTH) {
    throw new Error('aes128gcm body is too short to contain a content coding header');
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  // "an unsigned 32-bit integer in network byte order" — big-endian.
  const recordSize = view.getUint32(SALT_LENGTH, false);
  const idLength = body[SALT_LENGTH + RECORD_SIZE_LENGTH] ?? 0;
  const recordStart = HEADER_PREFIX_LENGTH + idLength;
  if (body.length < recordStart) {
    throw new Error('aes128gcm header declares a keyid longer than the body');
  }
  if (recordSize < MIN_RECORD_SIZE) {
    throw new Error(`aes128gcm record size ${String(recordSize)} is invalid`);
  }
  return {
    salt: body.subarray(0, SALT_LENGTH),
    recordSize,
    keyid: body.subarray(HEADER_PREFIX_LENGTH, recordStart),
    record: body.subarray(recordStart),
  };
}

/**
 * RFC 8291 §3.1: the receiver combines its own private key with the application server
 * public key carried in `keyid`, producing the same value the sender derived.
 */
async function deriveEcdhSecret(
  receiver: WebPushReceiverKeys,
  senderPublicKey: Uint8Array
): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: toBase64(receiver.privateKey),
      x: toBase64(receiver.publicKey.subarray(1, 1 + COORDINATE_LENGTH)),
      y: toBase64(receiver.publicKey.subarray(1 + COORDINATE_LENGTH)),
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    asBytes(senderPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  );
}

/**
 * RFC 8291 §3.3 / §3.4: HKDF-SHA-256 with the authentication secret as salt and the ECDH
 * secret as IKM, expanded once over
 * `"WebPush: info" || 0x00 || ua_public || as_public`, gives the input keying material
 * RFC 8188 then consumes.
 */
async function deriveInputKeyingMaterial(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  receiverPublicKey: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<Uint8Array> {
  const pseudoRandomKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatenate(
    ascii('WebPush: info'),
    Uint8Array.of(0x00),
    receiverPublicKey,
    senderPublicKey
  );
  return hmacSha256(pseudoRandomKey, concatenate(keyInfo, Uint8Array.of(0x01)));
}

/** The per-record AEAD inputs both parties derive (RFC 8188 §2.2, §2.3). */
interface RecordKeys {
  readonly contentEncryptionKey: Uint8Array;
  readonly nonce: Uint8Array;
}

/**
 * RFC 8188 §2.2 and §2.3: one HKDF-Extract over the header salt, then two single-HMAC
 * expansions truncated to the content encryption key and nonce lengths. The nonce is
 * XORed with the record sequence number, which is zero for the single record RFC 8291 §4
 * mandates, so the XOR is the identity here.
 */
async function deriveContentKeyAndNonce(
  salt: Uint8Array,
  inputKeyingMaterial: Uint8Array
): Promise<RecordKeys> {
  const pseudoRandomKey = await hmacSha256(salt, inputKeyingMaterial);
  const keyExpansion = await hmacSha256(
    pseudoRandomKey,
    concatenate(ascii('Content-Encoding: aes128gcm'), Uint8Array.of(0x00, 0x01))
  );
  const nonceExpansion = await hmacSha256(
    pseudoRandomKey,
    concatenate(ascii('Content-Encoding: nonce'), Uint8Array.of(0x00, 0x01))
  );
  return {
    contentEncryptionKey: keyExpansion.subarray(0, CEK_LENGTH),
    nonce: nonceExpansion.subarray(0, NONCE_LENGTH),
  };
}

/**
 * RFC 8188 §2: "On decryption, the padding delimiter is the last non-zero-valued octet of
 * the record. A decrypter MUST fail if the record contains no non-zero octet. A decrypter
 * MUST fail if the last record contains a padding delimiter with a value other than 2".
 * RFC 8291 §4 repeats the second rule: other values "MUST cause the message to be
 * discarded".
 */
function stripPadding(padded: Uint8Array): Uint8Array {
  let delimiterIndex = padded.length - 1;
  while (delimiterIndex >= 0 && padded[delimiterIndex] === 0x00) {
    delimiterIndex -= 1;
  }
  if (delimiterIndex < 0) {
    throw new Error('aes128gcm record carries no padding delimiter');
  }
  if (padded[delimiterIndex] !== LAST_RECORD_DELIMITER) {
    throw new Error('aes128gcm record ends with a padding delimiter other than the last-record 2');
  }
  return padded.subarray(0, delimiterIndex);
}

/**
 * The AEAD inputs for a record sent to `receiver` under `salt` by the holder of
 * `senderPublicKey` (RFC 8291 §3.1, §3.3, §3.4 feeding RFC 8188 §2.2, §2.3). A receiver
 * derives these from the header alone; forging a record for a receiver to reject needs
 * the same values, which is why this step is reachable on its own.
 */
export async function deriveRecordKeys(
  receiver: WebPushReceiverKeys,
  salt: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<RecordKeys> {
  const ecdhSecret = await deriveEcdhSecret(receiver, senderPublicKey);
  const inputKeyingMaterial = await deriveInputKeyingMaterial(
    ecdhSecret,
    receiver.authSecret,
    receiver.publicKey,
    senderPublicKey
  );
  return deriveContentKeyAndNonce(salt, inputKeyingMaterial);
}

/**
 * Decrypts one `aes128gcm` Web Push body (RFC 8188 header block followed by the single
 * record RFC 8291 §4 requires) and returns the plaintext.
 */
export async function decryptAes128GcmWebPushBody(
  body: Uint8Array,
  receiver: WebPushReceiverKeys
): Promise<Uint8Array> {
  const header = parseContentCodingHeader(body);
  if (
    header.keyid.length !== UNCOMPRESSED_POINT_LENGTH ||
    header.keyid[0] !== UNCOMPRESSED_POINT_TAG
  ) {
    throw new Error('aes128gcm keyid is not an X9.62 uncompressed P-256 point');
  }
  if (header.record.length < MIN_RECORD_LENGTH || header.record.length > header.recordSize) {
    throw new Error('aes128gcm record length is outside the declared record size');
  }

  const { contentEncryptionKey, nonce } = await deriveRecordKeys(
    receiver,
    header.salt,
    header.keyid
  );

  const aesKey = await crypto.subtle.importKey(
    'raw',
    asBytes(contentEncryptionKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  // RFC 8188 §2: "The additional data passed to each invocation of AEAD_AES_128_GCM is a
  // zero-length octet sequence."
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBytes(nonce), tagLength: AEAD_TAG_LENGTH * 8 },
      aesKey,
      asBytes(header.record)
    )
  );

  return stripPadding(padded);
}
