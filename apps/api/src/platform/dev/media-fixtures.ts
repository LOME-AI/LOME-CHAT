/**
 * Tiny deterministic media fixtures for the dev media-conversation seed.
 *
 * Semantic adaptation from legacy, which reused the mock gateway's CC0
 * sample media (~60 KB JPEG / ~75 KB WebM) so seeded turns were
 * byte-identical to generated ones. The new tree has no media mock
 * fixtures yet; these minimal stand-ins keep the seed path, storage layout
 * and crypto identical. The PNG is a valid decodable 1×1 image; the WebM is
 * an EBML-magic stub that exercises download + decrypt but will not play —
 * swap in real CC0 bytes when the E2E media suite needs browser rendering.
 */

const TEST_IMAGE_PNG_BASE64 =
  // eslint-disable-next-line no-secrets/no-secrets -- a committed 1×1 PNG fixture (public bytes), not a credential
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  // Every index below length yields a code point; Number() keeps the type
  // narrow without an uncoverable `?? 0` arm.
  return Uint8Array.from(binary, (char) => Number(char.codePointAt(0)));
}

export interface DevMediaFixture {
  readonly contentType: 'image' | 'video';
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | undefined;
}

export const DEV_MEDIA_FIXTURES: Readonly<Record<'image' | 'video', DevMediaFixture>> = {
  image: {
    contentType: 'image',
    bytes: decodeBase64(TEST_IMAGE_PNG_BASE64),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    durationMs: undefined,
  },
  video: {
    contentType: 'video',
    // EBML magic + padding: a syntactically-tagged WebM stub.
    bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
    mimeType: 'video/webm',
    width: 2,
    height: 2,
    durationMs: 1000,
  },
};
