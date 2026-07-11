import { describe, expect, it } from 'vitest';
import { mockDirectivesSchema } from './mock-directives.js';

describe('mockDirectivesSchema', () => {
  it('parses an empty object (the default, mock-with-default-behavior)', () => {
    expect(mockDirectivesSchema.parse({})).toEqual({});
  });

  it('parses all four directive knobs', () => {
    const parsed = mockDirectivesSchema.parse({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['m1', 'm2'],
      classifierDelayMs: 25,
    });
    expect(parsed).toEqual({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['m1', 'm2'],
      classifierDelayMs: 25,
    });
  });

  it('rejects an empty classifierResolution', () => {
    expect(mockDirectivesSchema.safeParse({ classifierResolution: '' }).success).toBe(false);
  });

  it('rejects a false classifierFailure (only the survivable-failure literal is valid)', () => {
    expect(mockDirectivesSchema.safeParse({ classifierFailure: false }).success).toBe(false);
  });

  it('rejects an empty failingModels list', () => {
    expect(mockDirectivesSchema.safeParse({ failingModels: [] }).success).toBe(false);
  });

  it('rejects a non-positive classifierDelayMs', () => {
    expect(mockDirectivesSchema.safeParse({ classifierDelayMs: 0 }).success).toBe(false);
  });
});
