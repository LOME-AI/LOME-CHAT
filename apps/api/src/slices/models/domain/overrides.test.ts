import { describe, expect, it } from 'vitest';
import { ModelOverrideData, isZdrVerificationAged } from './overrides.js';

describe('ModelOverrideData', () => {
  it('parses an empty overrides object', () => {
    expect(ModelOverrideData.parse({})).toEqual({});
  });

  it('parses parameter spec supplements', () => {
    const parsed = ModelOverrideData.parse({
      parameters: { size: { type: 'enum', values: ['1024x1024'], wire: 'providerOptions' } },
    });
    expect(parsed.parameters?.['size']?.type).toBe('enum');
  });

  it('parses a flat pricing matrix of nano-USD strings', () => {
    const parsed = ModelOverrideData.parse({ pricing: { perImage: '40000000' } });
    expect(parsed.pricing?.['perImage']).toBe('40000000');
  });

  it('parses a nested per-resolution pricing matrix', () => {
    const parsed = ModelOverrideData.parse({
      pricing: { perSecondByResolution: { '720p': '100000000' } },
    });
    expect(parsed.pricing?.['perSecondByResolution']).toEqual({ '720p': '100000000' });
  });

  it('rejects pricing values that are not canonical nano-USD strings', () => {
    expect(ModelOverrideData.safeParse({ pricing: { perImage: '0.04' } }).success).toBe(false);
  });

  it('parses the model-level ZDR exclusion flag', () => {
    expect(ModelOverrideData.parse({ zdrExcluded: true }).zdrExcluded).toBe(true);
  });

  it('rejects unknown override keys', () => {
    expect(ModelOverrideData.safeParse({ surprise: 1 }).success).toBe(false);
  });
});

describe('isZdrVerificationAged', () => {
  const now = new Date('2026-06-12T00:00:00.000Z');

  it('reports a verification within ninety days as fresh', () => {
    expect(isZdrVerificationAged(new Date('2026-03-15T00:00:00.000Z'), now)).toBe(false);
  });

  it('reports a verification older than ninety days as aged', () => {
    expect(isZdrVerificationAged(new Date('2026-03-13T00:00:00.000Z'), now)).toBe(true);
  });

  it('treats exactly ninety days as fresh', () => {
    expect(isZdrVerificationAged(new Date('2026-03-14T00:00:00.000Z'), now)).toBe(false);
  });
});
