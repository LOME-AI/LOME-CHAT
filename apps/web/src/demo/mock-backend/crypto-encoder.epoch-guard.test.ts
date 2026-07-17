import { describe, it, expect, vi } from 'vitest';

// The demo account always yields exactly one member wrap, so the "no member wrap"
// guard in createDemoEpoch is only reachable by forcing the crypto seam to return
// an empty wrap list. @hushbox/crypto is a true external package (not an internal
// slice), so mocking it here is permitted.
vi.mock('@hushbox/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/crypto')>();
  return {
    ...actual,
    createFirstEpoch: (keys: Parameters<typeof actual.createFirstEpoch>[0]) => ({
      ...actual.createFirstEpoch(keys),
      memberWraps: [],
    }),
  };
});

const { createDemoEpoch } = await import('./crypto-encoder');
const { generateKeyPair } = await import('@hushbox/crypto');

describe('createDemoEpoch member-wrap guard', () => {
  it('throws when the epoch yields no member wrap for the demo account', () => {
    // A real public key so the (spread) real createFirstEpoch runs, then the mock
    // empties its member-wrap list.
    expect(() => createDemoEpoch(generateKeyPair().publicKey)).toThrow('no member wrap');
  });
});
