import { describe, it, expect } from 'vitest';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { encryptWebPushPayload, generateEphemeralKey } from './encrypt.js';

// RFC 8291 Appendix A — the frozen deterministic test vector. Injecting the
// sender's ephemeral key and the salt makes the aes128gcm output exact, so this
// pins the encryption byte-for-byte against the standard rather than against the
// implementation itself. Values transcribed verbatim from RFC 8291 §5 / App. A.
const RFC8291_VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // RFC 8291 §5 body: the aes128gcm content-coding header concatenated with the
  // single encrypted record (header || ciphertext), base64url with whitespace
  // removed.
  expectedBody:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

describe('encryptWebPushPayload', () => {
  it('reproduces the RFC 8291 Appendix A ciphertext byte-for-byte', async () => {
    const asPublic = fromBase64(RFC8291_VECTOR.asPublic);
    const body = await encryptWebPushPayload({
      plaintext: fromBase64(RFC8291_VECTOR.plaintext),
      clientPublicKey: fromBase64(RFC8291_VECTOR.uaPublic),
      authSecret: fromBase64(RFC8291_VECTOR.authSecret),
      salt: fromBase64(RFC8291_VECTOR.salt),
      ephemeral: {
        privateScalar: fromBase64(RFC8291_VECTOR.asPrivate),
        publicKey: asPublic,
      },
    });

    expect(toBase64(body)).toBe(RFC8291_VECTOR.expectedBody);
  });

  it('embeds the ephemeral public key as the content-coding keyid', async () => {
    const ephemeral = await generateEphemeralKey();
    const body = await encryptWebPushPayload({
      plaintext: new Uint8Array([1, 2, 3]),
      clientPublicKey: fromBase64(RFC8291_VECTOR.uaPublic),
      authSecret: fromBase64(RFC8291_VECTOR.authSecret),
      salt: fromBase64(RFC8291_VECTOR.salt),
      ephemeral,
    });

    // Header layout (RFC 8188 §2.1): salt(16) || rs(4) || idlen(1) || keyid.
    expect(body[20]).toBe(65);
    expect(body.subarray(21, 21 + 65)).toEqual(ephemeral.publicKey);
  });
});

describe('generateEphemeralKey', () => {
  it('returns a 32-byte scalar and a 65-byte uncompressed P-256 point', async () => {
    const key = await generateEphemeralKey();

    expect(key.privateScalar).toHaveLength(32);
    expect(key.publicKey).toHaveLength(65);
    expect(key.publicKey[0]).toBe(0x04);
  });

  it('produces a fresh key on every call', async () => {
    const a = await generateEphemeralKey();
    const b = await generateEphemeralKey();

    expect(toBase64(a.privateScalar)).not.toBe(toBase64(b.privateScalar));
  });
});
