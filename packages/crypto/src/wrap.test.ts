import { describe, it, expect } from 'vitest';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { wrapSecretTo, unwrapSecret } from './wrap.js';
import type { WrappedSecret } from './wrap.js';
import { generateAccountKeyPair, generateEpochKeyPair } from './keys.js';
import {
  DecryptionFailedError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from './errors.js';
import { BLOB_FORMAT_VERSION } from './format.js';

const LABEL = 'epoch-key.member';

/**
 * The canonical order-8 X25519 point (little-endian). noble rejects it (and
 * the all-zero point) by throwing from getSharedSecret because the resulting
 * shared secret is all zeros.
 */
const LOW_ORDER_POINT_HEX = 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800';

function withEphemeralPoint(wrapped: WrappedSecret, point: Uint8Array): WrappedSecret {
  const forged = new Uint8Array(wrapped);
  forged.set(point, 1);
  return forged as WrappedSecret;
}

describe('wrap', () => {
  describe('wrapSecretTo', () => {
    it('produces a versioned blob', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(wrapped.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('is randomized: wrapping the same secret twice differs', () => {
      const recipient = generateEpochKeyPair();
      const secret = randomBytes(32);

      const first = wrapSecretTo(recipient.publicKey, secret, LABEL);
      const second = wrapSecretTo(recipient.publicKey, secret, LABEL);

      expect(first).not.toEqual(second);
    });

    it('throws InvalidParameterError for an empty label', () => {
      const recipient = generateEpochKeyPair();

      expect(() => wrapSecretTo(recipient.publicKey, randomBytes(32), '')).toThrow(
        InvalidParameterError
      );
    });
  });

  describe('unwrapSecret', () => {
    it('round-trips a secret wrapped to an epoch key', () => {
      const recipient = generateEpochKeyPair();
      const secret = randomBytes(32);

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL);
      const unwrapped = unwrapSecret(recipient.privateKey, wrapped, LABEL);

      expect(unwrapped).toEqual(secret);
    });

    it('round-trips a secret wrapped to an account key', () => {
      const recipient = generateAccountKeyPair();
      const secret = randomBytes(48);

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL);
      const unwrapped = unwrapSecret(recipient.privateKey, wrapped, LABEL);

      expect(unwrapped).toEqual(secret);
    });

    it('fails with a different domain-separation label', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), 'label-x');

      expect(() => unwrapSecret(recipient.privateKey, wrapped, 'label-y')).toThrow(
        DecryptionFailedError
      );
    });

    it('fails with the wrong recipient private key', () => {
      const recipient = generateEpochKeyPair();
      const other = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(() => unwrapSecret(other.privateKey, wrapped, LABEL)).toThrow(DecryptionFailedError);
    });

    it('fails on a tampered blob', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const tampered = new Uint8Array(wrapped);
      const lastIndex = tampered.length - 1;
      tampered[lastIndex] = (tampered.at(lastIndex) ?? 0) ^ 0xff;

      expect(() => unwrapSecret(recipient.privateKey, tampered as typeof wrapped, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('throws DecryptionFailedError for an all-zero ephemeral point', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const forged = withEphemeralPoint(wrapped, new Uint8Array(32));

      expect(() => unwrapSecret(recipient.privateKey, forged, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('throws DecryptionFailedError for a low-order ephemeral point', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const forged = withEphemeralPoint(wrapped, hexToBytes(LOW_ORDER_POINT_HEX));

      expect(() => unwrapSecret(recipient.privateKey, forged, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('rejects an unknown version byte with a typed error', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const downgraded = new Uint8Array(wrapped);
      downgraded[0] = 0x01;

      expect(() => unwrapSecret(recipient.privateKey, downgraded as typeof wrapped, LABEL)).toThrow(
        UnknownBlobVersionError
      );
    });

    it('rejects a blob shorter than the minimum length', () => {
      const recipient = generateEpochKeyPair();
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2, 3);

      expect(() => unwrapSecret(recipient.privateKey, short as never, LABEL)).toThrow(
        MalformedBlobError
      );
    });

    it('throws InvalidParameterError for an empty label', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(() => unwrapSecret(recipient.privateKey, wrapped, '')).toThrow(InvalidParameterError);
    });
  });
});
