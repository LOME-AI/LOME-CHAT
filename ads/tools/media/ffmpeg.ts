import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const requireFromHere = createRequire(import.meta.url);

/**
 * Path to the Remotion-bundled ffmpeg binary. Remotion ships a complete ffmpeg
 * (libvpx, concat/image2 muxers, flac decode) as a per-platform package, so the
 * ads toolkit reuses it as its encoder/decoder rather than taking a separate
 * system ffmpeg dependency. Resolved at call time; the miss path is an
 * environment error, so this module is verified by real use, not unit coverage.
 */
export function resolveFfmpeg(): string {
  const candidates = ['@remotion/compositor-linux-x64-gnu', '@remotion/compositor-linux-x64-musl'];
  for (const packageName of candidates) {
    try {
      const bin = path.join(
        path.dirname(requireFromHere.resolve(`${packageName}/package.json`)),
        'ffmpeg'
      );
      if (existsSync(bin)) return bin;
    } catch {
      // package not installed for this libc — try the next candidate
    }
  }
  throw new Error('Remotion ffmpeg not found (expected @remotion/compositor-linux-x64-*)');
}
