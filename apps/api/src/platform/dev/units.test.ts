import { describe, expect, it } from 'vitest';
import { err, ok } from '../../lib/result/index.js';
import { DEV_MEDIA_FIXTURES } from './media-fixtures.js';
import { DevSeedError, requireSeed, unwrapSeed } from './factories.js';
import { creditsForView, formatCredits } from './personas.js';
import { firstCount, nanoUsdToDecimalString } from './reads.js';
import type { BalanceView } from '../../slices/billing/index.js';

describe('unwrapSeed', () => {
  it('returns the ok value', () => {
    expect(unwrapSeed(ok(41), 'step')).toBe(41);
  });

  it('throws DevSeedError naming the failed step', () => {
    expect(() => unwrapSeed(err('boom'), 'epoch insert')).toThrow(DevSeedError);
    expect(() => unwrapSeed(err('boom'), 'epoch insert')).toThrow(/epoch insert/);
  });
});

describe('requireSeed', () => {
  it('returns a present value', () => {
    expect(requireSeed('x', 'step')).toBe('x');
  });

  it.each([null, undefined])('throws DevSeedError on %s', (value) => {
    expect(() => requireSeed(value, 'sequence number')).toThrow(DevSeedError);
  });
});

describe('formatCredits', () => {
  it('sums the wallets and rounds to cents', () => {
    expect(formatCredits(5_000_000_000n, 0n)).toBe('$5.00');
    expect(formatCredits(1_234_000_000n, 1_000_000_000n)).toBe('$2.23');
    expect(formatCredits(5_000_000n, 0n)).toBe('$0.01');
  });

  it('renders a negative balance with a leading sign', () => {
    expect(formatCredits(-1_500_000_000n, 0n)).toBe('-$1.50');
  });
});

describe('creditsForView', () => {
  it('renders $0.00 when the balance is unreadable', () => {
    expect(creditsForView(null)).toBe('$0.00');
  });

  it('formats a readable balance', () => {
    const view: BalanceView = {
      purchasedNanoUsd: 5_000_000_000n,
      freeNanoUsd: 0n,
      allowance: { day: '2026-01-01', limitNanoUsd: 0n, spentNanoUsd: 0n, remainingNanoUsd: 0n },
    };
    expect(creditsForView(view)).toBe('$5.00');
  });
});

describe('firstCount', () => {
  it('returns the first row count', () => {
    expect(firstCount([{ count: 3 }])).toBe(3);
  });

  it('returns 0 when the query yielded no rows', () => {
    expect(firstCount([])).toBe(0);
  });
});

describe('nanoUsdToDecimalString', () => {
  it('renders nano-USD as a plain decimal string', () => {
    expect(nanoUsdToDecimalString(0n)).toBe('0.000000000');
    expect(nanoUsdToDecimalString(5_000_000_000n)).toBe('5.000000000');
    expect(nanoUsdToDecimalString(3_000_000n)).toBe('0.003000000');
  });

  it('renders negative amounts', () => {
    expect(nanoUsdToDecimalString(-2_500_000_000n)).toBe('-2.500000000');
  });
});

describe('dev media fixtures', () => {
  it('ships a decodable PNG image fixture', () => {
    const image = DEV_MEDIA_FIXTURES.image;
    expect(image.mimeType).toBe('image/png');
    // PNG magic bytes prove the base64 decode is byte-accurate.
    expect(image.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(image.width).toBe(1);
    expect(image.durationMs).toBeUndefined();
  });

  it('ships an EBML-tagged video stub with a duration', () => {
    const video = DEV_MEDIA_FIXTURES.video;
    expect(video.mimeType).toBe('video/webm');
    expect(video.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    expect(video.durationMs).toBe(1000);
  });
});
