/** Retries never spread further than one hour apart. */
export const BACKOFF_CAP_SECONDS = 3600;

const JITTER_FRACTION = 0.1;

/**
 * The default retry backoff: failures^4 seconds with +/-10% jitter, capped at
 * one hour. The jitter source is injected so callers can seed it — the
 * dispatcher passes a real RNG in production and tests replay exact values.
 * Returns fractional seconds; the completion write feeds it to Postgres
 * `make_interval`, so sub-second precision survives.
 */
export function backoffSeconds(failures: number, random: () => number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new Error(`backoffSeconds: failures must be a positive integer, got ${String(failures)}`);
  }
  const base = Math.min(failures ** 4, BACKOFF_CAP_SECONDS);
  const jittered = base * (1 + (random() * 2 - 1) * JITTER_FRACTION);
  return Math.min(jittered, BACKOFF_CAP_SECONDS);
}
