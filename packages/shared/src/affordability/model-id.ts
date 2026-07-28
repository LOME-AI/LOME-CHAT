/**
 * `ModelId` — a catalog identifier, branded (`docs/BILLING.md` §Data
 * Structures).
 *
 * The brand is load-bearing rather than stylistic: §Where the Code Lives
 * forbids a bare `string` parameter on any export of the money layer, on the
 * reasoning that a branded or refined string is a checked shape while a bare
 * `string` is unbounded content. An identifier typed as plain `string` would
 * either fail that rule or force an allowlist entry into it, so the money
 * layer's identifiers carry their own type.
 *
 * `min(1)`: an empty identifier names no model, and admitting one would make
 * "the model this row is about" unanswerable at the far end of a wire.
 */

import { z } from 'zod';

export const ModelId = z.string().min(1).brand<'ModelId'>();

/** A catalog identifier. Branded, so it cannot be confused with prompt text. */
export type ModelId = z.infer<typeof ModelId>;

/**
 * Brands a raw identifier, validating it. Unlike {@link nanoUSD}, which brands
 * unconditionally because every bigint is a valid amount, not every string is a
 * valid identifier — so this fails fast rather than admitting an empty one.
 */
export function modelId(value: string): ModelId {
  return ModelId.parse(value);
}
