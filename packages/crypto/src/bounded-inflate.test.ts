import { describe, it, expect } from 'vitest';
import { deflateSync } from 'fflate';
import { randomBytes } from '@noble/hashes/utils.js';
import { boundedInflate } from './bounded-inflate.js';
import {
  DecompressionCapError,
  DecompressionInvalidError,
  InvalidParameterError,
} from './errors.js';

const MIB = 1024 * 1024;

describe('boundedInflate', () => {
  it('round-trips deflated data within the cap', () => {
    const original = new TextEncoder().encode('hello bounded world');
    const compressed = deflateSync(original);

    const inflated = boundedInflate(compressed, 1 * MIB);

    expect(inflated).toEqual(original);
  });

  it('round-trips incompressible binary data', () => {
    const original = randomBytes(60_000);
    const compressed = deflateSync(original);

    const inflated = boundedInflate(compressed, 1 * MIB);

    expect(inflated).toEqual(original);
  });

  it('accepts output exactly at the cap', () => {
    const original = randomBytes(4096);
    const compressed = deflateSync(original);

    const inflated = boundedInflate(compressed, original.length);

    expect(inflated).toEqual(original);
  });

  it('rejects output one byte over the cap', () => {
    const original = randomBytes(4096);
    const compressed = deflateSync(original);

    expect(() => boundedInflate(compressed, original.length - 1)).toThrow(DecompressionCapError);
  });

  it('accepts compressed input as an array of chunks', () => {
    const original = randomBytes(50_000);
    const compressed = deflateSync(original);
    const mid = Math.floor(compressed.length / 2);
    const chunks = [compressed.subarray(0, mid), compressed.subarray(mid)];

    const inflated = boundedInflate(chunks, 1 * MIB);

    expect(inflated).toEqual(original);
  });

  it('aborts a 100 MB zip bomb mid-inflate at a 1 MB cap', () => {
    // 100 MiB of zeros deflates to ~100 KiB — the classic high-ratio payload.
    const bombPlaintextBytes = 100 * MIB;
    const compressed = deflateSync(new Uint8Array(bombPlaintextBytes));
    const cap = 1 * MIB;

    try {
      boundedInflate(compressed, cap);
      expect.unreachable('boundedInflate must abort');
    } catch (error) {
      expect(error).toBeInstanceOf(DecompressionCapError);
      const capError = error as DecompressionCapError;
      expect(capError.capBytes).toBe(cap);
      // Mid-inflate abort: the inflated total at abort must be bounded by
      // cap + one input slice's worst-case DEFLATE expansion (1024 B × 1032),
      // nowhere near the 100 MiB the stream decodes to. Inflate-then-measure
      // would report ~100 MiB here.
      expect(capError.bytesInflated).toBeGreaterThan(cap);
      expect(capError.bytesInflated).toBeLessThan(cap + 1024 * 1032);
    }
  });

  it('throws DecompressionInvalidError for garbage input', () => {
    const garbage = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

    expect(() => boundedInflate(garbage, 1 * MIB)).toThrow(DecompressionInvalidError);
  });

  it('throws DecompressionInvalidError for a truncated stream', () => {
    const compressed = deflateSync(randomBytes(10_000));
    const truncated = compressed.subarray(0, -4);

    expect(() => boundedInflate(truncated, 1 * MIB)).toThrow(DecompressionInvalidError);
  });

  it('throws DecompressionInvalidError for empty input', () => {
    expect(() => boundedInflate(new Uint8Array(0), 1 * MIB)).toThrow(DecompressionInvalidError);
  });

  it('throws InvalidParameterError for a zero cap', () => {
    const compressed = deflateSync(randomBytes(16));

    expect(() => boundedInflate(compressed, 0)).toThrow(InvalidParameterError);
  });

  it('throws InvalidParameterError for a negative cap', () => {
    const compressed = deflateSync(randomBytes(16));

    expect(() => boundedInflate(compressed, -1)).toThrow(InvalidParameterError);
  });

  it('throws InvalidParameterError for a non-integer cap', () => {
    const compressed = deflateSync(randomBytes(16));

    expect(() => boundedInflate(compressed, 1.5)).toThrow(InvalidParameterError);
  });

  it('throws InvalidParameterError for a NaN cap', () => {
    const compressed = deflateSync(randomBytes(16));

    expect(() => boundedInflate(compressed, Number.NaN)).toThrow(InvalidParameterError);
  });
});
