/* eslint-disable unicorn/prevent-abbreviations -- "ParamSpec" is the spec-named contract; tests use the export names verbatim */
import { describe, expect, it } from 'vitest';
import { compileParamSpec, PARAM_TYPES, ParamSpec } from './param-spec.js';

describe('ParamSpec', () => {
  it('parses the full closed shape', () => {
    const spec = {
      type: 'integer',
      min: 1,
      max: 10,
      values: [1, 2, 3],
      default: 1,
      required: true,
      step: 1,
      requires: ['other'],
      conflictsWith: ['rival'],
      wire: 'providerOptions',
    };
    expect(ParamSpec.parse(spec)).toEqual(spec);
  });

  it('rejects keys outside the closed shape (escape hatch is the constraint registry)', () => {
    expect(ParamSpec.safeParse({ type: 'string', pattern: '^a' }).success).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(ParamSpec.safeParse({ type: 'object' }).success).toBe(false);
  });

  it('exposes the closed param type set', () => {
    expect(PARAM_TYPES).toEqual(['number', 'integer', 'string', 'boolean', 'enum']);
  });
});

describe('compileParamSpec — per-field validation', () => {
  it('enforces numeric bounds', () => {
    const schema = compileParamSpec({ temperature: { type: 'number', min: 0, max: 2 } });
    expect(schema.safeParse({ temperature: 1.5 }).success).toBe(true);
    expect(schema.safeParse({ temperature: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ temperature: -1 }).success).toBe(false);
  });

  it('enforces integer-ness', () => {
    const schema = compileParamSpec({ steps: { type: 'integer', min: 1 } });
    expect(schema.safeParse({ steps: 4 }).success).toBe(true);
    expect(schema.safeParse({ steps: 4.5 }).success).toBe(false);
  });

  it('enforces enum membership', () => {
    const schema = compileParamSpec({
      size: { type: 'enum', values: ['512x512', '1024x1024'] },
    });
    expect(schema.safeParse({ size: '512x512' }).success).toBe(true);
    expect(schema.safeParse({ size: '256x256' }).success).toBe(false);
  });

  it('fails fast on an enum spec without values', () => {
    expect(() => compileParamSpec({ size: { type: 'enum' } })).toThrow(/values/);
  });

  it('enforces values membership on non-enum types when declared', () => {
    const schema = compileParamSpec({ fps: { type: 'integer', values: [24, 30] } });
    expect(schema.safeParse({ fps: 24 }).success).toBe(true);
    expect(schema.safeParse({ fps: 25 }).success).toBe(false);
  });

  it('validates string and boolean params', () => {
    const schema = compileParamSpec({
      voice: { type: 'string' },
      loop: { type: 'boolean' },
    });
    expect(schema.safeParse({ voice: 'alloy', loop: true }).success).toBe(true);
    expect(schema.safeParse({ voice: 7 }).success).toBe(false);
    expect(schema.safeParse({ loop: 'yes' }).success).toBe(false);
  });

  it('requires required params', () => {
    const schema = compileParamSpec({ prompt: { type: 'string', required: true } });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ prompt: 'hi' }).success).toBe(true);
  });

  it('allows optional params to be absent', () => {
    const schema = compileParamSpec({ seed: { type: 'integer' } });
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('rejects undeclared params', () => {
    const schema = compileParamSpec({ seed: { type: 'integer' } });
    expect(schema.safeParse({ seed: 1, rogue: true }).success).toBe(false);
  });
});

describe('compileParamSpec — cross-field constraints', () => {
  it('enforces requires: a param present without its prerequisite fails', () => {
    const schema = compileParamSpec({
      negativePrompt: { type: 'string', requires: ['prompt'] },
      prompt: { type: 'string' },
    });
    expect(schema.safeParse({ negativePrompt: 'x' }).success).toBe(false);
    expect(schema.safeParse({ negativePrompt: 'x', prompt: 'y' }).success).toBe(true);
  });

  it('enforces conflictsWith: size XOR aspectRatio (the generateImage surface)', () => {
    const schema = compileParamSpec({
      size: { type: 'enum', values: ['512x512'], conflictsWith: ['aspectRatio'] },
      aspectRatio: { type: 'enum', values: ['16:9'], conflictsWith: ['size'] },
    });
    expect(schema.safeParse({ size: '512x512' }).success).toBe(true);
    expect(schema.safeParse({ aspectRatio: '16:9' }).success).toBe(true);
    expect(schema.safeParse({ size: '512x512', aspectRatio: '16:9' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(true);
  });
});
