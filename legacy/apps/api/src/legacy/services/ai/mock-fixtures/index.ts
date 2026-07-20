import { TEST_IMAGE_JPEG_BASE64 } from './test-image.js';
import { TEST_AUDIO_MP3_BASE64 } from './test-audio.js';
import { TEST_VIDEO_WEBM_BASE64 } from './test-video.js';

/**
 * Real CC0 sample media used by the mock AI client. Source: samplelib.com,
 * "do whatever you want" license. See README.md in this directory.
 *
 * The mock streams these bytes for image/video/audio generation requests in
 * dev and E2E. Real media (vs. a hand-rolled minimal byte sequence) decodes
 * cleanly across browsers (notably WebKit, which rejects header-only MP4s)
 * and gives developers visible/audible output rather than 16×16 placeholders.
 */

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}

export const TEST_IMAGE_BYTES = decodeBase64(TEST_IMAGE_JPEG_BASE64);
export const TEST_AUDIO_BYTES = decodeBase64(TEST_AUDIO_MP3_BASE64);
export const TEST_VIDEO_BYTES = decodeBase64(TEST_VIDEO_WEBM_BASE64);

export const TEST_IMAGE_MIME = 'image/jpeg' as const;
export const TEST_AUDIO_MIME = 'audio/mpeg' as const;
export const TEST_VIDEO_MIME = 'video/webm' as const;

export const TEST_IMAGE_WIDTH = 400;
export const TEST_IMAGE_HEIGHT = 300;

export const TEST_AUDIO_DURATION_MS = 3000;
export const TEST_VIDEO_DURATION_MS = 3000;
export const TEST_VIDEO_WIDTH = 320;
export const TEST_VIDEO_HEIGHT = 180;
