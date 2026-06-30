/**
 * Deterministic seeded PRNG for property tests (mulberry32). The repo bans
 * unseeded randomness in specs — every property test passes an explicit seed
 * so a failure reproduces exactly.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform integer in [min, max] inclusive. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const index = intBetween(rng, 0, items.length - 1);
  // Index is in range by construction.
  return items[index] as T;
}

/** Random non-negative bigint with up to `bits` random bits. */
export function bigIntOfBits(rng: Rng, bits: number): bigint {
  let value = 0n;
  for (let remaining = bits; remaining > 0; remaining -= 32) {
    const chunkBits = Math.min(remaining, 32);
    const chunk = intBetween(rng, 0, 2 ** chunkBits - 1);
    value = (value << BigInt(chunkBits)) | BigInt(chunk);
  }
  return value;
}
