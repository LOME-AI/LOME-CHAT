import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SHARD_STORAGE_KEY } from '../job-dispatcher-core.js';
import { jobDispatcherControl } from './test-worker.js';

function dispatcherStub(shard: string): DurableObjectStub {
  return env.JOB_DISPATCHER.get(env.JOB_DISPATCHER.idFromName(shard));
}

/**
 * Schedules a far-future alarm directly so `runDurableObjectAlarm` can force
 * it deterministically — a wake()'s immediate alarm self-fires and would
 * race the forced run.
 */
async function armFuture(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 600_000);
  });
}

async function getAlarm(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Force one alarm tick (the pass finds nothing, so the executor advises
 * `idle`) and report the window the re-arm must fall inside: the core reads
 * its clock between `before` and `after`, so a re-arm of `delay` lands in
 * `[before + delay, after + delay]` exactly.
 */
async function fireIdlePass(
  stub: DurableObjectStub
): Promise<{ before: number; after: number; alarm: number }> {
  const before = Date.now();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const after = Date.now();
  const alarm = await getAlarm(stub);
  expect(alarm).not.toBeNull();
  return { before, after, alarm: alarm! };
}

/** Poll the alarm until it settles at or beyond `floor`, defeating the read race
 * against an in-flight `onAlarm` (arm-first pulse then the final re-arm). */
async function waitForAlarmAtLeast(
  stub: DurableObjectStub,
  floor: number,
  what: string
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const alarm = await getAlarm(stub);
    if (alarm !== null && alarm >= floor) return alarm;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  jobDispatcherControl.passes.length = 0;
  jobDispatcherControl.results.length = 0;
  jobDispatcherControl.failNextPass = false;
});

describe('JobDispatcher under workerd', () => {
  it('arms the pulse before the pass, so a failing pass still leaves an alarm', async () => {
    const stub = dispatcherStub('arm-first');
    jobDispatcherControl.failNextPass = true;
    await armFuture(stub);
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarm = await getAlarm(stub);
    expect(jobDispatcherControl.passes).toEqual(['arm-first']);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + 25_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('drives a real pass from the platform alarm and re-arms to the advised delay', async () => {
    const stub = dispatcherStub('scheduled');
    jobDispatcherControl.results.push({ kind: 'scheduled', delayMs: 5000 });
    await armFuture(stub);
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarm = await getAlarm(stub);
    expect(jobDispatcherControl.passes).toEqual(['scheduled']);
    expect(alarm!).toBeGreaterThanOrEqual(before + 4000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('schedules an immediate alarm on a wake fetch, which fires a pass on its own', async () => {
    const stub = dispatcherStub('woken');
    const response = await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ woken: true });
    await until(() => jobDispatcherControl.passes.includes('woken'), 'the woken pass');
    // The pass found nothing (idle): the perpetual alarm is re-armed, never cleared.
    const alarm = await getAlarm(stub);
    expect(alarm).not.toBeNull();
  });

  it('answers anything but a wake with NOT_FOUND', async () => {
    const stub = dispatcherStub('routes');
    const response = await stub.fetch('https://job-dispatcher/other', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('persists its shard to storage on a live wake', async () => {
    const stub = dispatcherStub('persists');
    await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    await until(() => jobDispatcherControl.passes.includes('persists'), 'the woken pass');
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>(SHARD_STORAGE_KEY)
    );
    expect(stored).toBe('persists');
  });

  it('runs its pass when the platform revives it for an alarm without a named id', async () => {
    // The platform reconstructs an alarm-firing DO from the stored id alone,
    // which carries no name (`idFromString` reproduces that nameless id). The
    // shard, persisted by an earlier live wake, must survive that revival —
    // pre-seeded here directly so the alarm is the object's first construction.
    const named = env.JOB_DISPATCHER.idFromName('revived');
    const nameless = env.JOB_DISPATCHER.get(env.JOB_DISPATCHER.idFromString(named.toString()));
    await runInDurableObject(nameless, (_instance, state) =>
      state.storage.put(SHARD_STORAGE_KEY, 'revived')
    );
    await armFuture(nameless);
    jobDispatcherControl.passes.length = 0;

    expect(await runDurableObjectAlarm(nameless)).toBe(true);
    expect(jobDispatcherControl.passes).toEqual(['revived']);
  });

  it('steps the idle-decay ladder 60s→2m→5m→15m→30m-cap on repeated empty passes', async () => {
    const stub = dispatcherStub('idle-ladder');
    await armFuture(stub);
    // 60s → 2m → 5m → 15m, then the 30m cap holds (a fifth idle pass stays 30m).
    const expectedDelays = [60_000, 120_000, 300_000, 900_000, 1_800_000, 1_800_000];
    for (const delay of expectedDelays) {
      const { before, after, alarm } = await fireIdlePass(stub);
      expect(alarm).toBeGreaterThanOrEqual(before + delay);
      expect(alarm).toBeLessThanOrEqual(after + delay);
    }
  });

  it('delivers a cross-DO wake promptly, running a pass well before any idle alarm', async () => {
    // JD-7: node tests only fake the dispatcher namespace. Here a real
    // cross-DO wake fetch under workerd must drive a real pass promptly — the
    // ~10–50 ms enqueue→first-attempt latency the nudge buys — rather than
    // leaving delivery to the perpetual alarm (≥60 s away). A broken cross-DO
    // delivery makes `until` time out; a nudge that fell through to the idle
    // alarm blows the latency bound.
    const stub = dispatcherStub('wake-delivery');
    const before = Date.now();
    const response = await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    expect(response.status).toBe(200);
    await until(() => jobDispatcherControl.passes.includes('wake-delivery'), 'the woken pass');
    expect(Date.now() - before).toBeLessThan(2000);
  });

  it('resets the idle-decay ladder to the first rung when a wake lands mid-decay', async () => {
    const stub = dispatcherStub('idle-reset');
    await armFuture(stub);
    // Advance two rungs so the next idle re-arm would be the 5m rung if unreset.
    await fireIdlePass(stub);
    const stepped = await fireIdlePass(stub);
    expect(stepped.alarm).toBeGreaterThanOrEqual(stepped.before + 120_000);

    // A wake resets the ladder and schedules an immediate, self-firing pass. Its
    // idle re-arm returns to the first rung (60s) — not the 5m rung two steps in.
    // 45s floor clears the transient 30s arm-first pulse, so we read the settled
    // re-arm, never the mid-flight pulse.
    const before = Date.now();
    const response = await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    expect(response.status).toBe(200);
    const alarm = await waitForAlarmAtLeast(stub, before + 45_000, 'the post-wake idle re-arm');
    const after = Date.now();
    expect(alarm).toBeGreaterThanOrEqual(before + 60_000);
    expect(alarm).toBeLessThanOrEqual(after + 60_000);
  });
});
