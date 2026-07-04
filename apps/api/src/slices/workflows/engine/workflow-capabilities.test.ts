import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listTag, optionalTag, textTag } from '@hushbox/shared';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
  predicateCode,
  reducerCode,
} from './workflow-capabilities.js';
import type { WorkflowCapabilities } from './workflow-capabilities.js';

const capabilities: WorkflowCapabilities = {
  schemas: [{ name: 'classification', version: 1, schema: z.object({ label: z.string() }) }],
  predicates: [{ name: 'always', version: 1, input: textTag(), run: () => true }],
  reducers: [
    {
      name: 'joinOptionalTexts',
      version: 1,
      in: [listTag(optionalTag(textTag()))],
      out: textTag(),
      run: (inputs) => (inputs[0] as (string | undefined)[]).filter(Boolean).join('|'),
    },
  ],
};

describe('createConstraintRegistry', () => {
  it('resolves schema, predicate, and reducer type entries by kind and name', () => {
    const registry = createConstraintRegistry(capabilities);
    expect(registry.resolve('schema', 'classification')?.version).toBe(1);
    expect(registry.resolve('predicate', 'always')?.input).toEqual(textTag());
    expect(registry.resolve('reducer', 'joinOptionalTexts')?.out).toEqual(textTag());
  });

  it('returns undefined for an unknown name or a mismatched kind', () => {
    const registry = createConstraintRegistry(capabilities);
    expect(registry.resolve('schema', 'missing')).toBeUndefined();
    expect(registry.resolve('reducer', 'always')).toBeUndefined();
  });

  it('exposes predicate and reducer code keyed by name', () => {
    expect(predicateCode(capabilities).get('always')?.('x')).toBe(true);
    const merged = reducerCode(capabilities).get('joinOptionalTexts')?.([['a', undefined, 'b']]);
    expect(merged).toBe('a|b');
  });
});

describe('DEFAULT_WORKFLOW_CAPABILITIES', () => {
  it('registers the tuple-typed multi-model reducer that drops failed branches', () => {
    const registry = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
    const entry = registry.resolve('reducer', 'joinOptionalTexts');
    expect(entry?.in).toEqual([listTag(optionalTag(textTag()))]);
    const join = reducerCode(DEFAULT_WORKFLOW_CAPABILITIES).get('joinOptionalTexts');
    expect(join?.([['one', undefined, 'three']])).toBe('one\nthree');
  });

  it('registers a boolean loop predicate and a routing predicate', () => {
    const predicates = predicateCode(DEFAULT_WORKFLOW_CAPABILITIES);
    expect(predicates.get('loopUntilNonEmpty')?.('')).toBe(false);
    expect(predicates.get('loopUntilNonEmpty')?.('done')).toBe(true);
    expect(predicates.get('routeByFirstWord')?.('hard question')).toBe('hard');
    expect(predicates.get('routeByFirstWord')?.('single')).toBe('single');
  });

  it('routes a non-string verdict to the empty label', () => {
    expect(predicateCode(DEFAULT_WORKFLOW_CAPABILITIES).get('routeByFirstWord')?.(42)).toBe('');
  });

  it('registers the plain list join and the two-input text pair reducers', () => {
    const reducers = reducerCode(DEFAULT_WORKFLOW_CAPABILITIES);
    expect(reducers.get('joinTexts')?.([['a', 'b']])).toBe('a\nb');
    expect(reducers.get('pairTexts')?.(['x', 'y'])).toBe('x y');
  });
});
