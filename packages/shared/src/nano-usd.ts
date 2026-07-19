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

/** Nano-USD (1e-9 USD) in one integer cent (1e-2 USD). */
export const NANO_USD_PER_CENT = 10_000_000n;

/** Nano-USD (1e-9 USD) in one whole dollar. */
export const NANO_USD_PER_DOLLAR = 1_000_000_000n;

/**
 * A bare, signed dollar string (no `$`) from a canonical NanoUSD wire string,
 * carrying full nano precision (nine fractional digits) via integer bigint math
 * so no float rounding is introduced. Unlike `nanoUsdToDollarString` (which
 * truncates to whole cents), this preserves sub-cent amounts so a small settled
 * cost does not collapse to `0.00`. Callers add their own `$` / display
 * rounding (see `formatNanoUsdCost`).
 */
export function nanoUsdToFullDollarString(wire: string): string {
  const value = parseNanoUSD(wire);
  const negative = value < 0n;
  // Unbrand before negating: unary minus on the branded NanoUSD is lint-unsafe.
  const magnitude = negative ? -BigInt(value) : BigInt(value);
  const dollars = magnitude / NANO_USD_PER_DOLLAR;
  const fraction = magnitude % NANO_USD_PER_DOLLAR;
  return `${negative ? '-' : ''}${dollars.toString()}.${fraction.toString().padStart(9, '0')}`;
}

/**
 * Whole cents from a bare `X`/`X.XX` dollar string, using integer bigint math
 * so no float rounding is introduced. The fraction is truncated to two digits
 * (callers validate `≤ 2` decimals upstream). Total over the validated money
 * domain — `'0.10'`, `'5'`, `'10.99'`, `'.5'` all parse exactly.
 */
export function dollarsToCents(dollars: string): number {
  const [whole = '0', fraction = ''] = dollars.split('.');
  const wholeDigits = whole.length > 0 ? whole : '0';
  const cents = BigInt(wholeDigits) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return Number(cents);
}

/** Canonical NanoUSD wire string from whole cents (1 cent = 10^7 nano-USD). */
export function centsToNanoUsd(cents: number): string {
  return (BigInt(cents) * NANO_USD_PER_CENT).toString();
}

/**
 * Canonical NanoUSD wire string from a bare `X`/`X.XX` dollar string, via exact
 * integer cent math (never `parseFloat` on a billed amount). Callers validate
 * the amount (numeric, within bounds, ≤ 2 decimals) before charging.
 */
export function dollarsToNanoUsd(dollars: string): string {
  return centsToNanoUsd(dollarsToCents(dollars));
}

/**
 * Whole cents (integer, truncated toward zero) from a canonical NanoUSD wire
 * string. Negative-capable. Bridges a nano-USD amount into the cent-scale
 * `number` arithmetic the frontend billing math (`resolveClientBilling`,
 * `effectiveBudgetCents`) is built on; the `Number()` coercion is on the
 * already-divided cent value, never the full nano amount. Display/gate only —
 * sub-cent precision is dropped.
 */
export function nanoUsdToCents(wire: string): number {
  return Number(parseNanoUSD(wire) / NANO_USD_PER_CENT);
}

/**
 * A bare, signed `X.XX` dollar string (no `$`) from a canonical NanoUSD wire
 * string, computed with integer bigint math so no float rounding is introduced.
 * Sub-cent precision is truncated (display only). Callers add their own `$`.
 */
export function nanoUsdToDollarString(wire: string): string {
  const value = parseNanoUSD(wire);
  const negative = value < 0n;
  // Unbrand before negating: unary minus on the branded NanoUSD is lint-unsafe.
  const magnitude = negative ? -BigInt(value) : BigInt(value);
  const cents = magnitude / NANO_USD_PER_CENT;
  const dollars = cents / 100n;
  const remainder = cents % 100n;
  return `${negative ? '-' : ''}${dollars.toString()}.${remainder.toString().padStart(2, '0')}`;
}
