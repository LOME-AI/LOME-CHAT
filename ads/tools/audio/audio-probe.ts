import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { resolveFfmpeg } from '../media/ffmpeg.js';
import { flacHeaderDurationSeconds, wavDurationSeconds } from './audio-duration.js';

/**
 * Duration of a VO take in seconds. WAV and total-sample-bearing FLAC parse
 * from the header with no subprocess; streamed FLAC (MiniMax speech exports
 * leave STREAMINFO's total-sample count at 0) falls back to a full decode
 * through the Remotion-bundled ffmpeg — the same binary the frame encoder uses.
 * Spawns a subprocess on that path, so it is verified by real use, not unit
 * coverage.
 */
export function audioDurationSeconds(path: string): number {
  const buffer = readFileSync(path);
  const tag = buffer.toString('ascii', 0, 4);
  if (tag === 'RIFF') return wavDurationSeconds(buffer);
  if (tag === 'fLaC') return flacHeaderDurationSeconds(buffer) ?? decodeDurationSeconds(path);
  throw new Error(`${path}: unrecognized audio container (expected WAV or FLAC)`);
}

/** Full-decode duration via ffmpeg `-f null`, read from the final stats line. */
function decodeDurationSeconds(path: string): number {
  const result = spawnSync(
    resolveFfmpeg(),
    ['-v', 'error', '-stats', '-i', path, '-f', 'null', '-'],
    { encoding: 'utf8' }
  );
  const matches = [...result.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) throw new Error(`${path}: could not measure duration via ffmpeg decode`);
  return Number(last[1] ?? 0) * 3600 + Number(last[2] ?? 0) * 60 + Number(last[3] ?? 0);
}
