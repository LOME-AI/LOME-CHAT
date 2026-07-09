import type { Redis } from '@upstash/redis';

/**
 * Cross-suite serialization for the shared, non-namespaced `model_catalog`
 * table.
 *
 * Every integration suite runs against ONE local Postgres, and several suites
 * read the catalog GLOBALLY (Smart Model / trial candidate derivation ranks and
 * prices every exposed text model; the classifier reserve scales with the whole
 * text catalog). A concurrent suite seeding its own catalog rows therefore
 * perturbs another suite's global read — inflating the reserve until the cheap
 * fixtures fall out of the affordable/1¢-eligible set, so a send that should
 * succeed is refused. Unique-per-test model ids cannot fix this: a global read
 * still sees every other suite's rows.
 *
 * The fix mirrors the jobs suites' shard convention (one owner of the shared
 * surface, everyone else stays clear): a lock serializes the catalog critical
 * sections across suites, and the global-read suite additionally clears foreign
 * rows under the lock so its read sees only its own controlled set.
 *
 * The lock lives in Redis rather than a Postgres advisory lock on purpose:
 * vitest kills workers mid-file under heavy parallel load (see
 * `orphan-wallet-sweep.ts`), and a session advisory lock held by a killed worker
 * is NOT released — the neon proxy keeps the backend alive, wedging every other
 * suite indefinitely.
 *
 * A plain fixed-TTL key is not enough either: a cold first run's critical
 * section (cold pools, cold SRH) can outlast the TTL, so the lock would expire
 * WHILE still legitimately held, a waiter would seize it and seed foreign rows,
 * and the holder's in-flight read would clobber. So the holder HEARTBEATS —
 * renews the TTL on an interval while alive — which decouples "how long a
 * critical section may run" from "how fast a crashed holder is detected": a live
 * holder never expires regardless of duration, and a killed holder stops
 * renewing and expires within {@link LOCK_TTL_MS}, well under the suite's
 * hook/test timeout so waiters recover instead of wedging.
 */

const LOCK_KEY = 'test:lock:model-catalog';
/** Expiry floor for a crashed (no-longer-heartbeating) holder. Comfortably
 *  below the 15s hook/test timeout so waiters recover. */
const LOCK_TTL_MS = 8000;
/** Renew well inside the TTL so a live holder's key never lapses. */
const HEARTBEAT_MS = 2500;
const SPIN_MS = 75;
/** Give up (loud failure, not a silent hang) past this; < the hook/test timeout
 *  so a stuck acquire surfaces as a clear error, and > TTL so a crashed holder's
 *  key expires and we still acquire before giving up. */
const MAX_WAIT_MS = 12_000;

/**
 * Acquires the model-catalog lock, returning a release function. Blocks (spins)
 * until free or {@link MAX_WAIT_MS}. While held, a heartbeat renews the TTL so a
 * long (e.g. cold-start) critical section never expires under a live holder; a
 * killed holder stops heartbeating and the key expires within the TTL. Release
 * is owner-checked so a TTL hand-off is never clobbered.
 */
export async function acquireModelCatalogLock(redis: Redis): Promise<() => Promise<void>> {
  const token = crypto.randomUUID();
  const start = Date.now();
  for (;;) {
    const acquired = await redis.set(LOCK_KEY, token, { nx: true, px: LOCK_TTL_MS });
    if (acquired === 'OK') break;
    if (Date.now() - start > MAX_WAIT_MS) {
      throw new Error('model-catalog test lock: timed out acquiring');
    }
    await new Promise((resolve) => setTimeout(resolve, SPIN_MS));
  }

  const heartbeat = setInterval(() => {
    // Renew only if still ours; swallow transient errors — the next tick retries
    // and the TTL is the safety net.
    void (async () => {
      try {
        if ((await redis.get(LOCK_KEY)) === token) await redis.pexpire(LOCK_KEY, LOCK_TTL_MS);
      } catch {
        /* transient Redis error; the next heartbeat retries */
      }
    })();
  }, HEARTBEAT_MS);
  // Never keep a vitest worker alive on the heartbeat timer alone.
  (heartbeat as { unref?: () => void }).unref?.();

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    // Release only if still ours: a TTL expiry may have handed the lock to
    // another suite, and a blind DEL would drop that suite's lock.
    if ((await redis.get(LOCK_KEY)) === token) await redis.del(LOCK_KEY);
  };
}

/**
 * Runs `run` while holding the model-catalog lock, guaranteeing no other
 * participating suite touches `model_catalog` concurrently. Always released,
 * even when `run` throws.
 */
export async function withModelCatalogLock<T>(redis: Redis, run: () => Promise<T>): Promise<T> {
  const release = await acquireModelCatalogLock(redis);
  try {
    return await run();
  } finally {
    await release();
  }
}
