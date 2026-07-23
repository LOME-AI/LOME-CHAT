/**
 * Per-CPU local Playwright worker-count registry. The right worker count for a
 * fully-parallel E2E run is CPU-bound: too many workers saturate the cores and
 * produce CPU-starvation flakes, too few waste the box. This maps a machine's
 * CPU model to its empirically known-good worker count, falling back to a
 * core-count-relative default for CPUs no one has tuned yet. Local-only — CI's
 * worker count is pinned separately in playwright.config.ts.
 */
import os from 'node:os';

/**
 * CI's fixed local worker count (playwright.config.ts uses `isCI ? 7`). Named
 * here so the persona-pool derivation can floor at it — the pool must cover the
 * workers that actually run in CI as well as locally.
 */
export const CI_WORKER_COUNT = 7;

/**
 * CPU model → known-good local worker count. Keys are matched as
 * case-insensitive substrings of the full model string reported by
 * `os.cpus()[0].model` (e.g. `"Intel(R) Core(TM) Ultra 9 285K"`), so a key must
 * be distinctive enough not to false-match another vendor's model.
 *
 * To add a row: run the full e2e suite on the machine, find the highest worker
 * count that completes with no CPU-saturation flakes, then add
 * `'<distinctive model substring>': <count>`.
 */
export const CPU_WORKER_REGISTRY: Record<string, number> = {
  '285K': 12, // Intel Core Ultra 9 285K
  '13900H': 10, // Intel i9-13900H (mobile; desktop 13900K is a different part)
};

/**
 * Fallback worker count for a CPU not in {@link CPU_WORKER_REGISTRY}: 50% of the
 * machine's logical cores (rounded, floored at 1). Core-relative rather than a
 * fixed number so an untuned machine scales with its own size instead of
 * inheriting one box's constant.
 */
function defaultWorkerCount(): number {
  return Math.max(1, Math.round(0.5 * os.availableParallelism()));
}

/**
 * Resolve the local Playwright worker count for the running machine: the first
 * registry key that is a case-insensitive substring of this CPU's model, else
 * {@link defaultWorkerCount}. Clamped to the machine's logical core count so a
 * mistyped registry entry can never oversubscribe beyond available cores, and
 * floored at 1 so the return is always a positive integer.
 */
export function resolveLocalWorkerCount(): number {
  const model = os.cpus()[0]?.model ?? '';
  const lowerModel = model.toLowerCase();
  const match = Object.entries(CPU_WORKER_REGISTRY).find(([key]) =>
    lowerModel.includes(key.toLowerCase())
  );
  const desired = match ? match[1] : defaultWorkerCount();
  return Math.max(1, Math.min(desired, os.availableParallelism()));
}

/**
 * Persona-pool size: the larger of the workers that actually run locally
 * ({@link resolveLocalWorkerCount}) and CI's fixed count ({@link
 * CI_WORKER_COUNT}). Derived, never hand-set, so the per-worker wallet-isolation
 * pool always covers whatever worker count runs and the `workers ≤ pool`
 * invariant holds by construction (see seed-personas.ts).
 */
export const E2E_WORKER_POOL_SIZE = Math.max(resolveLocalWorkerCount(), CI_WORKER_COUNT);
