import { describe, expect, it } from 'vitest';
import { compileWireParams, resolveMediaInputs } from './wire-params.js';
import type { InputPart, ModelDescriptor } from '@hushbox/shared';

function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/model',
    provider: 'test',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {
      temperature: { type: 'number', min: 0, max: 2, wire: 'firstClass' },
      size: { type: 'enum', values: ['1024x1024', '512x512'], wire: 'providerOptions' },
      seed: { type: 'integer' },
    },
    behaviors: ['streaming'],
    limits: {},
    pricing: {},
    zdrReachable: true,
    fetchedAt: 0,
    ...overrides,
  };
}

describe('compileWireParams', () => {
  it('splits validated params by their declared wire target', () => {
    const wire = compileWireParams(descriptor(), {
      temperature: 1,
      size: '1024x1024',
    })._unsafeUnwrap();
    expect(wire.firstClass).toEqual({ temperature: 1 });
    expect(wire.providerOptions).toEqual({ size: '1024x1024' });
  });

  it('defaults a spec without a wire declaration to firstClass', () => {
    const wire = compileWireParams(descriptor(), { seed: 7 })._unsafeUnwrap();
    expect(wire.firstClass).toEqual({ seed: 7 });
    expect(wire.providerOptions).toEqual({});
  });

  it('drops a parameter passed as explicit undefined', () => {
    const wire = compileWireParams(descriptor(), { temperature: undefined })._unsafeUnwrap();
    expect(wire.firstClass).toEqual({});
    expect(wire.providerOptions).toEqual({});
  });

  it('rejects a parameter the descriptor does not declare', () => {
    const result = compileWireParams(descriptor(), { mystery: true });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a value outside the declared bounds', () => {
    const result = compileWireParams(descriptor(), { temperature: 9 });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a missing required parameter', () => {
    const required = descriptor({
      parameters: { promptStrength: { type: 'number', required: true } },
    });
    const result = compileWireParams(required, {});
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('resolveMediaInputs', () => {
  const textPart: InputPart = { modality: 'text', text: 'hello' };
  const imagePart: InputPart = {
    modality: 'image',
    ref: { ref: 'blob-1', mimeType: 'image/png', byteLength: 10 },
  };

  it('accepts inputs whose modalities the descriptor supports', () => {
    const supported = descriptor({ inputs: ['text', 'image'] });
    const resolved = resolveMediaInputs(supported, [textPart, imagePart])._unsafeUnwrap();
    expect(resolved).toEqual([textPart, imagePart]);
  });

  it('rejects an input modality the descriptor does not support', () => {
    const result = resolveMediaInputs(descriptor(), [textPart, imagePart]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
