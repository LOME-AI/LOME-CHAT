import { describe, it, expect } from 'vitest';

import { column } from './__tests__/shape-helpers';
import { users } from './index';

/** Exercises the bytea customType through a real column's driver mapping. */
describe('bytea driver mapping', () => {
  const publicKey = column(users, 'public_key');

  it('encodes Uint8Array to the postgres hex format', () => {
    expect(publicKey.mapToDriverValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(
      String.raw`\xdeadbeef`
    );
  });

  it(String.raw`decodes a hex string with the \x prefix`, () => {
    expect(publicKey.mapFromDriverValue(String.raw`\xdead`)).toEqual(new Uint8Array([0xde, 0xad]));
  });

  it(String.raw`decodes a hex string without the \x prefix`, () => {
    expect(publicKey.mapFromDriverValue('beef')).toEqual(new Uint8Array([0xbe, 0xef]));
  });

  it('decodes a Buffer', () => {
    expect(publicKey.mapFromDriverValue(Buffer.from([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('decodes other array-like driver values', () => {
    expect(publicKey.mapFromDriverValue(new Uint8Array([7, 8]))).toEqual(new Uint8Array([7, 8]));
  });
});
