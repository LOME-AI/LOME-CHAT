/**
 * The wire encoding of a `FundingSnapshot`. Two doors serve the same snapshot —
 * `GET /billing/spendable` for a caller who holds a wallet and the
 * conversations slice's guest read for a link guest — so the encoding is one
 * function and these are its pins.
 */

import { describe, it, expect } from 'vitest';
import { getSpendableResponseSchema } from '@hushbox/shared';
import { serializeFundingSnapshot } from './spendable.js';
import type { FundingSnapshot } from './spendable.js';

const SNAPSHOT: FundingSnapshot = {
  spendableNanoUsd: 9_000_000_000n,
  heldNanoUsd: 250_000_000n,
  payerTier: 'paid',
  payer: 'owner',
};

describe('serializeFundingSnapshot', () => {
  it('renders the nano figures as canonical decimal strings, never numbers', () => {
    const wire = serializeFundingSnapshot(SNAPSHOT);

    expect(wire.spendableNanoUsd).toBe('9000000000');
    expect(wire.heldNanoUsd).toBe('250000000');
  });

  it('carries the payer identity through unchanged', () => {
    const wire = serializeFundingSnapshot(SNAPSHOT);

    expect(wire.payerTier).toBe('paid');
    expect(wire.payer).toBe('owner');
  });

  it('emits exactly the fields the served schema declares', () => {
    // The discriminating input is a field: dropping one from this function
    // leaves the schema's key list longer than the emitted one, and adding a
    // field the schema does not declare leaves it shorter. That is the property
    // one hand-rolled encoder per door could not have — one door would keep
    // pace with a schema change and the other would silently not.
    const wire = serializeFundingSnapshot(SNAPSHOT);

    expect(Object.keys(wire).toSorted((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(getSpendableResponseSchema.shape).toSorted((a, b) => a.localeCompare(b))
    );
  });
});
