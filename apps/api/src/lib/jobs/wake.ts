import type { JobShard } from './registry.js';

/**
 * The structural slice of a Durable Object namespace the wake nudge needs;
 * the real `DurableObjectNamespace` binding satisfies it without casts, and
 * node tests fake it without platform types.
 */
export interface JobDispatcherNamespace<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): { fetch(url: string, init?: { method: string }): Promise<unknown> };
}

/**
 * The lossy post-commit nudge: callers fire it via `waitUntil` after any
 * enqueueing commit. Every failure is swallowed by design — the dispatcher's
 * perpetual alarm is the delivery guarantee, the wake only buys the
 * ~10–50 ms enqueue-to-first-attempt latency. Never call inside the domain
 * transaction.
 */
export async function wakeJobDispatcher(
  namespace: JobDispatcherNamespace,
  shard: JobShard
): Promise<void> {
  try {
    await namespace
      .get(namespace.idFromName(shard))
      .fetch('https://job-dispatcher/wake', { method: 'POST' });
  } catch {
    // Lossy by design: the next dispatcher pulse recovers a lost wake.
  }
}
