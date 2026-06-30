import { z } from 'zod';

/**
 * Money is integer nano-USD `bigint` everywhere; it crosses JSON boundaries
 * only as a canonical decimal string (no exponent, no leading zeros, no
 * `-0`). `Number()` coercion on money is forbidden — 2^53 truncates
 * house-account aggregates silently.
 */
const CANONICAL_DECIMAL_PATTERN = /^(?:0|-?[1-9]\d*)$/;

/**
 * Zod schema for the JSON boundary: accepts a canonical decimal string,
 * outputs a branded bigint. The wire format is string-only by design.
 */
export const NanoUSD = z
  .string()
  .regex(CANONICAL_DECIMAL_PATTERN, 'NanoUSD must be a canonical decimal string')
  .transform(BigInt)
  .brand<'NanoUSD'>();

/** Branded bigint: nano-USD (1e-9 USD) integer amounts. */
export type NanoUSD = z.infer<typeof NanoUSD>;

/** Brands a raw bigint as NanoUSD. Every bigint is a valid amount. */
export function nanoUSD(value: bigint): NanoUSD {
  return value as NanoUSD;
}

/** Serializes for a JSON boundary: canonical decimal string. */
export function serializeNanoUSD(value: NanoUSD): string {
  return value.toString(10);
}

/** Parses a JSON-boundary string; throws ZodError on non-canonical input. */
export function parseNanoUSD(value: string): NanoUSD {
  return NanoUSD.parse(value);
}
