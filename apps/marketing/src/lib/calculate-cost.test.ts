import { describe, it, expect } from 'vitest';
import { calculateMonthlyCost } from './calculate-cost';
import type { Model } from '@hushbox/shared';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test/model',
    name: 'Test Model',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 128_000,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    capabilities: [],
    description: 'A test model',
    supportedParameters: ['temperature'],
    ...overrides,
  };
}

describe('calculateMonthlyCost', () => {
  it('returns zero cost for empty model list', () => {
    const result = calculateMonthlyCost([]);
    expect(result.monthlyCost).toBe(0);
    expect(result.modelName).toBe('');
  });

  it('selects the cheapest model by combined token price', () => {
    const models = [
      makeModel({
        id: 'expensive/model',
        name: 'Expensive',
        pricing: { inputPerToken: '10000000', outputPerToken: '30000000' },
      }),
      makeModel({
        id: 'cheap/model',
        name: 'Cheap',
        pricing: { inputPerToken: '1000', outputPerToken: '2000' },
      }),
    ];
    const result = calculateMonthlyCost(models);
    expect(result.modelName).toBe('Cheap');
  });

  it('calculates a positive monthly cost', () => {
    const models = [makeModel()];
    const result = calculateMonthlyCost(models);
    expect(result.monthlyCost).toBeGreaterThan(0);
  });

  it('includes the customer markup in the cost', () => {
    const models = [makeModel()];
    const result = calculateMonthlyCost(models);
    expect(result.monthlyCost).toBeGreaterThan(0);
  });

  it('returns cost for 50 messages per day over 30 days', () => {
    const model = makeModel({
      pricing: { inputPerToken: '10000', outputPerToken: '10000' },
    });
    const result = calculateMonthlyCost([model]);
    expect(result.messagesPerDay).toBe(50);
    expect(result.daysPerMonth).toBe(30);
  });

  it('skips free models (no token pricing)', () => {
    const models = [
      makeModel({ id: 'free/model', name: 'Free', pricing: {} }),
      makeModel({
        id: 'paid/model',
        name: 'Paid',
        pricing: { inputPerToken: '1000', outputPerToken: '2000' },
      }),
    ];
    const result = calculateMonthlyCost(models);
    expect(result.modelName).toBe('Paid');
  });

  it('returns zero when only free models exist', () => {
    const models = [makeModel({ pricing: {} })];
    const result = calculateMonthlyCost(models);
    expect(result.monthlyCost).toBe(0);
  });

  it('treats a missing outputPerToken rate on the cheapest model as zero', () => {
    const missing = calculateMonthlyCost([makeModel({ pricing: { inputPerToken: '1000' } })]);
    const explicitZero = calculateMonthlyCost([
      makeModel({ pricing: { inputPerToken: '1000', outputPerToken: '0' } }),
    ]);
    expect(missing.monthlyCost).toBe(explicitZero.monthlyCost);
    expect(missing.monthlyCost).toBeGreaterThan(0);
  });

  it('treats a missing inputPerToken rate on the cheapest model as zero', () => {
    const missing = calculateMonthlyCost([makeModel({ pricing: { outputPerToken: '2000' } })]);
    const explicitZero = calculateMonthlyCost([
      makeModel({ pricing: { inputPerToken: '0', outputPerToken: '2000' } }),
    ]);
    expect(missing.monthlyCost).toBe(explicitZero.monthlyCost);
    expect(missing.monthlyCost).toBeGreaterThan(0);
  });

  it('returns a result with all expected fields', () => {
    const result = calculateMonthlyCost([makeModel()]);
    expect(result).toHaveProperty('monthlyCost');
    expect(result).toHaveProperty('modelName');
    expect(result).toHaveProperty('messagesPerDay');
    expect(result).toHaveProperty('daysPerMonth');
  });
});
