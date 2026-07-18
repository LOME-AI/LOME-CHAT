/**
 * Offline screen tracker. Extracts a plate's frames, seeded-flood-fills the
 * green screen in each (see regionBounds), temporally smooths the per-frame
 * rects, and writes a track JSON the ScreenReplace scene consumes. Run once per
 * plate; re-run only if the plate changes.
 *
 *   node_modules/.bin/tsx ads/tools/remotion/generate-track.ts \
 *     <plate.mp4> <seedX> <seedY> <tolerance> <out.json> [fps]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

import { resolveFfmpeg } from '../media/ffmpeg.js';
import { regionBounds, smoothTrack, type Rect, type RgbaImage } from './screen-track.js';

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface Neighbours {
  a: number;
  b: number;
  c: number;
}

/** Reverses a PNG scanline filter for one byte. */
function reconstruct(filter: number, value: number, { a, b, c }: Neighbours): number {
  switch (filter) {
    case 1: {
      return value + a;
    }
    case 2: {
      return value + b;
    }
    case 3: {
      return value + ((a + b) >> 1);
    }
    case 4: {
      return value + paethPredictor(a, b, c);
    }
    default: {
      return value;
    }
  }
}

interface PngHeader {
  width: number;
  height: number;
  colorType: number;
  idat: Buffer[];
}

function readPngChunks(buffer: Buffer): PngHeader {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    switch (type) {
      case 'IHDR': {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        colorType = Number(data[9]);
        break;
      }
      case 'IDAT': {
        idat.push(data);
        break;
      }
      case 'IEND': {
        return { width, height, colorType, idat };
      }
      default: {
        break;
      }
    }
    offset += 12 + length;
  }
  return { width, height, colorType, idat };
}

function unfilterRow(
  raw: Buffer,
  out: Uint8Array,
  layout: { y: number; stride: number; channels: number }
): void {
  const { y, stride, channels } = layout;
  const filter = Number(raw[y * (stride + 1)]);
  for (let index = 0; index < stride; index++) {
    const value = Number(raw[y * (stride + 1) + 1 + index]);
    const a = index >= channels ? Number(out[y * stride + index - channels]) : 0;
    const b = y > 0 ? Number(out[(y - 1) * stride + index]) : 0;
    const c = y > 0 && index >= channels ? Number(out[(y - 1) * stride + index - channels]) : 0;
    out[y * stride + index] = reconstruct(filter, value, { a, b, c }) & 0xff;
  }
}

/** Minimal PNG decoder (RGB/RGBA, 8-bit) for the extracted frames. */
function decodePng(buffer: Buffer): RgbaImage {
  const { width, height, colorType, idat } = readPngChunks(buffer);
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    unfilterRow(raw, out, { y, stride, channels });
  }
  return { data: out, width, height, channels };
}

function extractFrames(plate: string, fps: number, dir: string): string[] {
  // `-r` (output rate) resamples to `fps` without a filter — this ffmpeg build
  // ships without the `fps` filter.
  execFileSync(
    resolveFfmpeg(),
    ['-y', '-i', plate, '-r', String(fps), path.join(dir, 'f%04d.png')],
    {
      stdio: 'ignore',
    }
  );
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .toSorted((a, b) => a.localeCompare(b))
    .map((f) => path.join(dir, f));
}

const [plate, seedX, seedY, tolerance, out, fpsArgument] = process.argv.slice(2);
if (!plate || !seedX || !seedY || !tolerance || !out) {
  throw new Error('usage: generate-track.ts <plate> <seedX> <seedY> <tolerance> <out.json> [fps]');
}
const fps = Number(fpsArgument ?? '30');
const dir = mkdtempSync(path.join(tmpdir(), 'screen-track-'));
try {
  const seed = { x: Number(seedX), y: Number(seedY) };
  const raw: Rect[] = extractFrames(plate, fps, dir).map((file) =>
    regionBounds(decodePng(readFileSync(file)), seed, Number(tolerance))
  );
  const frames = smoothTrack(raw, 2).map((r) => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }));
  writeFileSync(out, `${JSON.stringify({ fps, frames }, null, 2)}\n`);
  console.warn(`screen track: ${String(frames.length)} frames → ${out}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
