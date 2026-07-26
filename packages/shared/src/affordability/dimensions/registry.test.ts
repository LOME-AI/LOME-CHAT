import { describe, expect, it } from 'vitest';

import {
  DIMENSIONS,
  DimensionRegistrationError,
  defineDimension,
  defineDimensions,
  dimensionFor,
  openDimension,
} from './registry.js';
import { DIMENSION_IDS } from './types.js';
import type { DimensionSpec } from './types.js';

/** A minimal well-formed declaration; each test bends exactly one field. */
function specFor(overrides: Partial<DimensionSpec> = {}): DimensionSpec {
  return {
    id: 'effort',
    param: { type: 'enum', values: ['a', 'b'] },
    resource: 'completionTokens',
    costClass: 'partition',
    ordered: true,
    enumerable: true,
    support: () => ({ options: [{ optionId: 'a', label: 'A' }], mandatory: false }),
    requirement: () => 1,
    wire: () => ({}),
    resolution: 'nearestBelow',
    promptDescription: 'How hard to think.',
    deliversAtHoldCeiling: true,
    ...overrides,
  };
}

describe('DIMENSIONS', () => {
  it('holds exactly one entry per closed dimension id', () => {
    const alphabetical = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(DIMENSIONS).toSorted(alphabetical)).toEqual(
      [...DIMENSION_IDS].toSorted(alphabetical)
    );
  });

  it('holds the model and effort entries', () => {
    expect(DIMENSIONS.model.id).toBe('model');
    expect(DIMENSIONS.effort.id).toBe('effort');
  });

  it('is frozen, so a consumer cannot register a dimension by assignment', () => {
    expect(Object.isFrozen(DIMENSIONS)).toBe(true);
  });
});

describe('dimensionFor', () => {
  it('reads an entry by id', () => {
    expect(dimensionFor('effort')).toBe(DIMENSIONS.effort);
  });
});

describe('defineDimension', () => {
  it('returns the declaration when it is well formed', () => {
    const spec = specFor();
    expect(defineDimension(spec)).toBe(spec);
  });

  it('rejects an enum domain that declares no values', () => {
    expect(() => defineDimension(specFor({ param: { type: 'enum' } }))).toThrow(
      DimensionRegistrationError
    );
  });

  it('rejects a resource of none paired with a non-free cost class', () => {
    expect(() => defineDimension(specFor({ resource: 'none', costClass: 'additive' }))).toThrow(
      DimensionRegistrationError
    );
  });

  it('rejects a free cost class paired with a consuming resource', () => {
    expect(() => defineDimension(specFor({ costClass: 'free' }))).toThrow(
      DimensionRegistrationError
    );
  });

  it('accepts the free/none pairing', () => {
    expect(() => defineDimension(specFor({ resource: 'none', costClass: 'free' }))).not.toThrow();
  });

  it('rejects an empty prompt description — every dimension names its axis', () => {
    expect(() => defineDimension(specFor({ promptDescription: '  ' }))).toThrow(
      DimensionRegistrationError
    );
  });

  it('rejects a multiplicative dimension that claims to deliver at the hold ceiling', () => {
    expect(() =>
      defineDimension(specFor({ costClass: 'multiplicative', resource: 'completionTokens' }))
    ).toThrow(DimensionRegistrationError);
  });

  it('accepts a multiplicative dimension that declares the shrink', () => {
    expect(() =>
      defineDimension(specFor({ costClass: 'multiplicative', deliversAtHoldCeiling: false }))
    ).not.toThrow();
  });
});

describe('defineDimensions', () => {
  it('rejects two declarations of the same id', () => {
    expect(() => defineDimensions([specFor(), specFor()])).toThrow(DimensionRegistrationError);
  });

  it('rejects a registry missing a declared dimension id', () => {
    expect(() => defineDimensions([specFor()])).toThrow(DimensionRegistrationError);
  });
});

describe('openDimension', () => {
  it('opens an enumerable dimension', () => {
    const spec = specFor();
    expect(openDimension(spec).spec).toBe(spec);
  });

  it('rejects a non-enumerable dimension at registration', () => {
    expect(() => openDimension(specFor({ enumerable: false }))).toThrow(DimensionRegistrationError);
  });

  it('names the dimension in the rejection, so the declaration is findable', () => {
    expect(() => openDimension(specFor({ enumerable: false }))).toThrow(/effort/);
  });

  it('opens both registered dimensions', () => {
    expect(openDimension(DIMENSIONS.model).spec).toBe(DIMENSIONS.model);
    expect(openDimension(DIMENSIONS.effort).spec).toBe(DIMENSIONS.effort);
  });
});
