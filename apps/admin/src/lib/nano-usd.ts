/**
 * Display-format a signed NanoUSD wire string as dollars, truncated to
 * cents. BigInt end to end: money strings can exceed float precision, and
 * `Number()` coercion on money is banned. Callers preserve the exact wire
 * string in a `title`/copy affordance; this is the human-readable rendering.
 */
export function formatNanoUsd(wire: string): string {
  const value = BigInt(wire);
  const negative = value < 0n;
  const cents = (negative ? -value : value) / 10_000_000n;
  const dollars = (cents / 100n).toString(10);
  const fraction = (cents % 100n).toString(10).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${fraction}`;
}
