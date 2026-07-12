import { describe, it, expect } from 'vitest';
import {
  legacyGenerateContentKey,
  createShare,
  openShare,
  encryptTextWithContentKey,
  decryptTextWithContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';

// End-to-end proof that the sharer wiring (useMessageShare) and the viewer
// wiring (useSharedMessage) agree through the real symmetric share helpers: the
// secret carried in the URL fragment opens exactly the content key the sharer
// wrapped, so the viewer decrypts the sharer's plaintext. No mocks — the crypto
// is the contract under test.
describe('message-share round-trip', () => {
  it('recovers the sharer plaintext from the share URL secret and the wire-wrapped key', () => {
    const contentKey = legacyGenerateContentKey();
    const ciphertext = encryptTextWithContentKey(contentKey, 'the secret answer');

    // Sharer side: re-wrap the content key under a fresh share secret, then
    // serialize both exactly as useMessageShare does (secret → URL fragment,
    // wrapped key → the POST body's `wrappedContentKey`).
    const { shareSecret, wrappedShareKey } = createShare(contentKey);
    const url = `https://app.example/share/m/share-1#${toBase64(shareSecret)}`;
    const wireWrappedContentKey = toBase64(wrappedShareKey);

    // Viewer side: recover the secret from the fragment and the wrapped key from
    // the wire, exactly as useSharedMessage does.
    const secretFromUrl = fromBase64(new URL(url).hash.slice(1));
    const wrapped = fromBase64(wireWrappedContentKey) as WrappedContentKey;
    const recoveredKey = openShare(secretFromUrl, wrapped);
    const plaintext = decryptTextWithContentKey(recoveredKey, ciphertext);

    expect(plaintext).toBe('the secret answer');
  });

  it('a wrong URL secret cannot open the wrapped content key', () => {
    const contentKey = legacyGenerateContentKey();
    const { wrappedShareKey } = createShare(contentKey);
    const { shareSecret: wrongSecret } = createShare(legacyGenerateContentKey());

    expect(() => openShare(wrongSecret, wrappedShareKey)).toThrow();
  });
});
