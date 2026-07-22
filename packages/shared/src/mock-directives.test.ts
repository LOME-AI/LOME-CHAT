import { describe, expect, it } from 'vitest';
import { mockDirectivesSchema } from './mock-directives.js';

describe('mockDirectivesSchema', () => {
  it('parses an empty object (the default, mock-with-default-behavior)', () => {
    expect(mockDirectivesSchema.parse({})).toEqual({});
  });

  it('parses all directive knobs', () => {
    const parsed = mockDirectivesSchema.parse({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['m1', 'm2'],
      classifierDelayMs: 25,
      textDelayMs: 60,
      mediaDelayMs: 3000,
      holdPrimaryStream: true,
    });
    expect(parsed).toEqual({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['m1', 'm2'],
      classifierDelayMs: 25,
      textDelayMs: 60,
      mediaDelayMs: 3000,
      holdPrimaryStream: true,
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

  it('rejects a non-positive textDelayMs', () => {
    expect(mockDirectivesSchema.safeParse({ textDelayMs: 0 }).success).toBe(false);
  });

  it('rejects a non-positive mediaDelayMs', () => {
    expect(mockDirectivesSchema.safeParse({ mediaDelayMs: -1 }).success).toBe(false);
  });

  it('rejects a non-boolean holdPrimaryStream', () => {
    expect(mockDirectivesSchema.safeParse({ holdPrimaryStream: 'yes' }).success).toBe(false);
  });
});
