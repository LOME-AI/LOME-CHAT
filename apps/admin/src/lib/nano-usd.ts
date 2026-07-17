import { nanoUsdToDollarString } from '@hushbox/shared';

/**
 * Display-format a signed NanoUSD wire string as dollars, truncated to
 * cents, with thousands grouping. The bigint truncate-to-cents math is the
 * shared `nanoUsdToDollarString`; this wrapper groups the integer part and
 * places the `$` after the sign. Callers preserve the exact wire string in a
 * `title`/copy affordance.
 */
export function formatNanoUsd(wire: string): string {
  const dollars = nanoUsdToDollarString(wire);
  const negative = dollars.startsWith('-');
  const [integerPart, cents] = (negative ? dollars.slice(1) : dollars).split('.') as [
    string,
    string,
  ];
  const grouped = integerPart.replaceAll(/\B(?=(\d{3})+$)/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${cents}`;
}
