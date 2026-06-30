import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
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
});
