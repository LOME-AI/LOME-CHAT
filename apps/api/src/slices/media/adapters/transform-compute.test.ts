import { describe, expect, it } from 'vitest';
import { mediaTag, textTag } from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import {
  createInProcessTransformCompute,
  createServerTransformCompute,
} from './transform-compute.js';
import { unwrap } from './test-fixtures.js';
import type { ContentValue } from '@hushbox/shared';
import type { MediaTransformEntry } from '../ports/index.js';

const upper: MediaTransformEntry = {
  name: 'upper',
  version: 1,
  ports: { in: [textTag()], out: textTag() },
  run: (inputs) => {
    const [input] = inputs;
    if (input?.kind !== 'text') return err(validationError('upper expects text'));
    return ok({ kind: 'text', text: input.text.toUpperCase() });
  },
};

const upperV2: MediaTransformEntry = { ...upper, version: 2 };

const text = (value: string): ContentValue => ({ kind: 'text', text: value });

describe('createInProcessTransformCompute', () => {
  it('executes the entry matching name plus version', async () => {
    const compute = createInProcessTransformCompute([upper, upperV2]);
    const output = await unwrap(compute.execute('upper', 1, [text('hi')]));
    expect(output).toEqual({ kind: 'text', text: 'HI' });
  });

  it('rejects an unregistered transform', async () => {
    const compute = createInProcessTransformCompute([upper]);
    const result = await compute.execute('upper', 9, [text('hi')]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an input arity that does not match the declared ports', async () => {
    const compute = createInProcessTransformCompute([upper]);
    const result = await compute.execute('upper', 1, [text('a'), text('b')]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an entry refusal on the error channel', async () => {
    const compute = createInProcessTransformCompute([upper]);
    const result = await compute.execute('upper', 1, [
      { kind: 'bytes', bytes: new Uint8Array([1]), mimeType: 'image/png', modality: 'image' },
    ]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('resolves the declared ports for registry wiring', () => {
    const compute = createInProcessTransformCompute([upper]);
    expect(compute.resolvePorts('upper', 1)).toEqual({ in: [textTag()], out: textTag() });
    expect(compute.resolvePorts('missing', 1)).toBeUndefined();
  });

  it('refuses a duplicate registration of the same name plus version', () => {
    expect(() => createInProcessTransformCompute([upper, upper])).toThrow(/upper@1/);
  });
});

describe('createServerTransformCompute', () => {
  it('ships the media transform implementations', () => {
    const compute = createServerTransformCompute();
    expect(compute.resolvePorts('strip-image-metadata', 1)).toEqual({
      in: [mediaTag('image', ['image/jpeg', 'image/png'])],
      out: mediaTag('image', ['image/jpeg', 'image/png']),
    });
  });
});
