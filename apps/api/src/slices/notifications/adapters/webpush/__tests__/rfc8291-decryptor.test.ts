import { fromBase64 } from '@hushbox/shared';
import { describe, expect, it } from 'vitest';

import { encryptWebPushPayload, generateEphemeralKey, MAX_PLAINTEXT_BYTES } from '../encrypt.js';

import {
  decryptAes128GcmWebPushBody,
  deriveRecordKeys,
  generateSubscriptionKeys,
  type WebPushReceiverKeys,
} from './rfc8291-decryptor.js';

// RFC 8291 Appendix A / Section 5: the published Web Push encryption example.
// These are the specification's own values; the private scalar and auth secret
// are public constants of the RFC, not credentials.
const RFC_VECTOR = {
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  plaintext: 'When I grow up, I want to be a watermelon',
} as const;

const rfcReceiverKeys = {
  publicKey: fromBase64(RFC_VECTOR.uaPublic),
  privateKey: fromBase64(RFC_VECTOR.uaPrivate),
  authSecret: fromBase64(RFC_VECTOR.authSecret),
};

// Enough independent runs that a body which only happens to decrypt under one lucky
// combination of keys, salt and length would be caught.
const ROUND_TRIP_RUNS = 25;

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function encryptTo(
  receiver: WebPushReceiverKeys,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  return encryptWebPushPayload({
    plaintext,
    clientPublicKey: receiver.publicKey,
    authSecret: receiver.authSecret,
    salt: randomBytes(16),
    ephemeral: await generateEphemeralKey(),
  });
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Assembles a well-formed aes128gcm body around an arbitrary already-padded plaintext —
 * the only way to present a receiver with padding this sender would never emit.
 */
async function forgeBody(
  receiver: WebPushReceiverKeys,
  paddedPlaintext: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
  const sender = await generateSubscriptionKeys();
  const salt = randomBytes(16);
  const { contentEncryptionKey, nonce } = await deriveRecordKeys(receiver, salt, sender.publicKey);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(contentEncryptionKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(nonce), tagLength: 128 },
      aesKey,
      paddedPlaintext
    )
  );

  const header = new Uint8Array(21 + sender.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = sender.publicKey.length;
  header.set(sender.publicKey, 21);
  return concatenate(header, record);
}

describe('RFC 8291 decryptor', () => {
  it('decrypts the RFC 8291 Appendix A body to the specification plaintext', async () => {
    const plaintext = await decryptAes128GcmWebPushBody(
      fromBase64(RFC_VECTOR.body),
      rfcReceiverKeys
    );

    expect(new TextDecoder().decode(plaintext)).toBe(RFC_VECTOR.plaintext);
  });
});

describe('Web Push bodies this sender produces', () => {
  it('decrypt back to the plaintext across independently generated subscriptions', async () => {
    for (let run = 0; run < ROUND_TRIP_RUNS; run++) {
      const receiver = await generateSubscriptionKeys();
      const plaintext = randomBytes(1 + Math.floor(Math.random() * 512));

      const decrypted = await decryptAes128GcmWebPushBody(
        await encryptTo(receiver, plaintext),
        receiver
      );

      expect(decrypted).toStrictEqual(plaintext);
    }
  });

  it('decrypt back to the plaintext at the maximum payload size', async () => {
    const receiver = await generateSubscriptionKeys();
    const plaintext = randomBytes(MAX_PLAINTEXT_BYTES);

    const decrypted = await decryptAes128GcmWebPushBody(
      await encryptTo(receiver, plaintext),
      receiver
    );

    expect(decrypted).toStrictEqual(plaintext);
  });

  it('exactly fill the 4096-octet body limit at the maximum payload size', async () => {
    // RFC 8291 §4 / RFC 8030 §7.2: "A push service is not required to support more
    // than 4096 octets of payload body." A body that round-trips locally is still
    // undeliverable if it exceeds this, so the size is asserted, not just the decrypt.
    // Equality, not an upper bound: at the interoperable ceiling the body is exactly
    // header(86) + plaintext(3993) + delimiter(1) + tag(16) = 4096, so `toBe` also
    // catches an over-conservative ceiling, which would silently reject legitimate
    // payloads. An upper-bound assertion passes for any ceiling that is too low.
    const receiver = await generateSubscriptionKeys();

    const body = await encryptTo(receiver, randomBytes(MAX_PLAINTEXT_BYTES));

    expect(body.length).toBe(4096);
  });

  it('declare a record size larger than the record they carry', async () => {
    // RFC 8291 §4: the "rs" parameter MUST be "greater than the sum of the lengths of
    // the plaintext, the padding delimiter (1 octet), any padding, and the
    // authentication tag (16 octets)" — strictly greater, so equality is a violation.
    const receiver = await generateSubscriptionKeys();

    const body = await encryptTo(receiver, randomBytes(MAX_PLAINTEXT_BYTES));

    // Header layout (RFC 8188 §2.1): salt(16) || rs(4) || idlen(1) || keyid.
    const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
    expect(recordSize).toBeGreaterThan(MAX_PLAINTEXT_BYTES + 1 + 16);
  });
});

describe('bodies an independent receiver must reject', () => {
  it('rejects a body whose ciphertext has one flipped bit', async () => {
    const receiver = await generateSubscriptionKeys();
    const body = await encryptTo(receiver, randomBytes(64));
    const corrupted = Uint8Array.from(body);
    const lastIndex = corrupted.length - 1;
    corrupted[lastIndex] = (corrupted[lastIndex] ?? 0) ^ 0b0000_0001;

    await expect(decryptAes128GcmWebPushBody(corrupted, receiver)).rejects.toThrow();
  });

  it('rejects a body decrypted with the wrong authentication secret', async () => {
    const receiver = await generateSubscriptionKeys();
    const body = await encryptTo(receiver, randomBytes(64));

    await expect(
      decryptAes128GcmWebPushBody(body, { ...receiver, authSecret: randomBytes(16) })
    ).rejects.toThrow();
  });

  it('rejects a record whose padding delimiter is not the last-record value', async () => {
    const receiver = await generateSubscriptionKeys();
    // RFC 8188 §2: a non-final record's delimiter is 1, and a receiver "MUST fail if the
    // last record contains a padding delimiter with a value other than 2".
    const body = await forgeBody(receiver, concatenate(randomBytes(8), Uint8Array.of(0x01)));

    await expect(decryptAes128GcmWebPushBody(body, receiver)).rejects.toThrow(/delimiter/);
  });

  it('rejects a record that contains no non-zero octet', async () => {
    const receiver = await generateSubscriptionKeys();
    const body = await forgeBody(receiver, new Uint8Array(8));

    await expect(decryptAes128GcmWebPushBody(body, receiver)).rejects.toThrow(/delimiter/);
  });
});
