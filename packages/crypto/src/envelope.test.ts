import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { encryptContentEnvelope, decryptContentEnvelope } from './envelope.js';
import { generateContentKey, generateEpochKeyPair } from './keys.js';
import { wrapSecretTo } from './wrap.js';
import {
  DecryptionFailedError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from './errors.js';
import { BLOB_FORMAT_VERSION } from './format.js';
import type { ContentLocation } from './envelope.js';
import type { WrappedSecret } from './wrap.js';

const LOCATION_A: ContentLocation = {
  conversationId: 'conv-1111',
  messageId: 'msg-2222',
  contentItemId: 'item-3333',
  position: 0,
  epochNumber: 5,
  senderId: 'user-4444',
};

function wrapKey(contentKey: Uint8Array): WrappedSecret {
  const epoch = generateEpochKeyPair();
  return wrapSecretTo(epoch.publicKey, contentKey, 'content-key.epoch');
}

describe('envelope', () => {
  const plaintext = new TextEncoder().encode('the content payload');

  describe('encryptContentEnvelope', () => {
    it('produces a versioned blob', () => {
      const key = generateContentKey();

      const blob = encryptContentEnvelope(key, wrapKey(key), LOCATION_A, plaintext);

      expect(blob.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('uses a fresh nonce per call', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const first = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);
      const second = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);

      expect(first).not.toEqual(second);
    });

    it('rejects a negative position', () => {
      const key = generateContentKey();
      const location = { ...LOCATION_A, position: -1 };

      expect(() => encryptContentEnvelope(key, wrapKey(key), location, plaintext)).toThrow(
        InvalidParameterError
      );
    });

    it('rejects a non-integer epoch number', () => {
      const key = generateContentKey();
      const location = { ...LOCATION_A, epochNumber: 1.5 };

      expect(() => encryptContentEnvelope(key, wrapKey(key), location, plaintext)).toThrow(
        InvalidParameterError
      );
    });
  });

  describe('decryptContentEnvelope', () => {
    it('round-trips at the same location with the same wrapped key', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('round-trips empty plaintext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, new Uint8Array(0));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted).toEqual(new Uint8Array(0));
    });

    it('round-trips a 5 MiB plaintext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const mib = 1024 * 1024;
      const large = new Uint8Array(5 * mib);
      for (let index = 0; index < large.length; index++) {
        large[index] = (index * 31 + 7) & 0xff;
      }

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, large);
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted.length).toBe(5 * mib);
      // Native byte comparison proves exact equality far faster than a
      // 5M-element deep-equal.
      expect(Buffer.compare(Buffer.from(decrypted), Buffer.from(large))).toBe(0);
    });

    it('round-trips unicode plaintext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const text = '混合 unicode → emoji 🎉, combining é, RTL שלום, and ﷽';
      const encoded = new TextEncoder().encode(text);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, encoded);
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(new TextDecoder().decode(decrypted)).toBe(text);
    });

    it('round-trips with unicode location-tuple strings', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const location: ContentLocation = {
        ...LOCATION_A,
        conversationId: '会話-🗨️-1',
        messageId: 'сообщение-2',
        contentItemId: 'पद-3',
        senderId: 'ユーザー-🙂-4',
      };

      const blob = encryptContentEnvelope(key, wrapped, location, plaintext);
      const decrypted = decryptContentEnvelope(key, wrapped, location, blob);

      expect(decrypted).toEqual(plaintext);
    });

    const spliceTargets: readonly [string, Partial<ContentLocation>][] = [
      ['conversationId', { conversationId: 'conv-9999' }],
      ['messageId', { messageId: 'msg-9999' }],
      ['contentItemId', { contentItemId: 'item-9999' }],
      ['position', { position: 1 }],
      ['epochNumber', { epochNumber: 6 }],
      ['senderId', { senderId: 'user-9999' }],
    ];

    it.each(spliceTargets)(
      'splice attack: relocating the blob to a different %s fails the AAD check',
      (_field, overrides) => {
        const key = generateContentKey();
        const wrapped = wrapKey(key);
        const locationB = { ...LOCATION_A, ...overrides };

        const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);

        expect(() => decryptContentEnvelope(key, wrapped, locationB, blob)).toThrow(
          DecryptionFailedError
        );
      }
    );

    it('fails when presented with a different wrapped content key', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const otherWrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);

      expect(() => decryptContentEnvelope(key, otherWrapped, LOCATION_A, blob)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails with the wrong content key', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);

      expect(() => decryptContentEnvelope(generateContentKey(), wrapped, LOCATION_A, blob)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails on a tampered ciphertext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);
      const tampered = new Uint8Array(blob);
      const lastIndex = tampered.length - 1;
      tampered[lastIndex] = (tampered.at(lastIndex) ?? 0) ^ 0xff;

      expect(() => decryptContentEnvelope(key, wrapped, LOCATION_A, tampered)).toThrow(
        DecryptionFailedError
      );
    });

    it('rejects an unknown version byte with a typed error', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, plaintext);
      const downgraded = new Uint8Array(blob);
      downgraded[0] = 0x03;

      expect(() => decryptContentEnvelope(key, wrapped, LOCATION_A, downgraded)).toThrow(
        UnknownBlobVersionError
      );
    });

    it('rejects a blob shorter than the minimum length', () => {
      const key = generateContentKey();
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2);

      expect(() => decryptContentEnvelope(key, wrapKey(key), LOCATION_A, short)).toThrow(
        MalformedBlobError
      );
    });

    it('decrypts independently of the epoch key, given key and wrap', () => {
      // Location binding, not authorship: anyone holding the content key and
      // the exact wrap bytes can decrypt — the AAD pins where, not who.
      const key = generateContentKey();
      const epoch = generateEpochKeyPair();
      const wrapped = wrapSecretTo(epoch.publicKey, key, 'content-key.epoch');

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, randomBytes(64));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted.length).toBe(64);
    });
  });
});
