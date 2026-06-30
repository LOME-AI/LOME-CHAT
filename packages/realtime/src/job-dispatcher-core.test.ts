import { describe, expect, it } from 'vitest';
import {
  ARM_FIRST_DELAY_MS,
  IDLE_DECAY_LADDER_MS,
  JobDispatcherCore,
} from './job-dispatcher-core.js';
import type { DispatcherTelemetry, JobPassResult } from './job-dispatcher-core.js';

class FakeScheduler {
  alarm: number | null = null;
  readonly sets: number[] = [];

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(at: number): Promise<void> {
    this.alarm = at;
    this.sets.push(at);
    return Promise.resolve();
  }
}

class FakeClock {
  t = 1_000_000;
  now = (): number => this.t;
}

interface Harness {
  core: JobDispatcherCore;
  scheduler: FakeScheduler;
  clock: FakeClock;
  failures: { shard: string }[];
}

function harness(runPass: (shard: string) => Promise<JobPassResult>): Harness {
  const scheduler = new FakeScheduler();
  const clock = new FakeClock();
  const failures: { shard: string }[] = [];
  const telemetry: DispatcherTelemetry = {
    passFailed: (fields) => {
      failures.push(fields);
    },
  };
  const core = new JobDispatcherCore({
    shard: 'default',
    executor: { runPass },
    scheduler,
    telemetry,
    now: clock.now,
  });
  return { core, scheduler, clock, failures };
}

const idle = (): Promise<JobPassResult> => Promise.resolve({ kind: 'idle' });

describe('JobDispatcherCore.wake', () => {
  it('arms an immediate alarm when none is set', async () => {
    const { core, scheduler, clock } = harness(idle);
    await core.wake();
    expect(scheduler.alarm).toBe(clock.t);
  });

  it('pulls a later alarm forward to now', async () => {
    const { core, scheduler, clock } = harness(idle);
    scheduler.alarm = clock.t + 60_000;
    await core.wake();
    expect(scheduler.alarm).toBe(clock.t);
  });

  it('never displaces an alarm already due', async () => {
    const { core, scheduler, clock } = harness(idle);
    scheduler.alarm = clock.t - 5000;
    await core.wake();
    expect(scheduler.alarm).toBe(clock.t - 5000);
    expect(scheduler.sets).toEqual([]);
  });
});

describe('JobDispatcherCore.onAlarm', () => {
  it('arms the pulse before any fallible work runs', async () => {
    const { core, scheduler, clock } = harness(() => {
      expect(scheduler.sets).toEqual([clock.t + ARM_FIRST_DELAY_MS]);
      return Promise.resolve<JobPassResult>({ kind: 'idle' });
    });
    await core.onAlarm();
    expect(scheduler.sets.length).toBeGreaterThan(1);
  });

  it('leaves the pulse standing when the pass throws, without throwing itself', async () => {
    const { core, scheduler, clock, failures } = harness(() =>
      Promise.reject(new Error('pass blew up'))
    );
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t + ARM_FIRST_DELAY_MS);
    expect(failures).toEqual([{ shard: 'default' }]);
  });

  it('re-arms immediately when more due work remains', async () => {
    const { core, scheduler, clock } = harness(() =>
      Promise.resolve<JobPassResult>({ kind: 'due' })
    );
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t);
  });

  it('re-arms to the exact scheduled delay inside the pulse window', async () => {
    const { core, scheduler, clock } = harness(() =>
      Promise.resolve<JobPassResult>({ kind: 'scheduled', delayMs: 5000 })
    );
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t + 5000);
  });

  it('lets an exact scheduled delay replace the pulse beyond thirty seconds', async () => {
    const { core, scheduler, clock } = harness(() =>
      Promise.resolve<JobPassResult>({ kind: 'scheduled', delayMs: 300_000 })
    );
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t + 300_000);
  });

  it('never displaces a wake that landed during the pass', async () => {
    const { core, scheduler, clock } = harness(async () => {
      await core.wake();
      return { kind: 'scheduled', delayMs: 300_000 };
    });
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t);
  });

  it('decays the idle alarm along the ladder to the thirty-minute cap', async () => {
    const { core, scheduler, clock } = harness(idle);
    const observed: number[] = [];
    for (let pass = 0; pass < IDLE_DECAY_LADDER_MS.length + 1; pass += 1) {
      const alarm = scheduler.alarm;
      clock.t = alarm ?? clock.t;
      await core.onAlarm();
      expect(scheduler.alarm).not.toBeNull();
      observed.push(scheduler.alarm! - clock.t);
    }
    expect(observed).toEqual([...IDLE_DECAY_LADDER_MS, 1_800_000]);
  });

  it('resets the idle decay ladder on a wake', async () => {
    const { core, scheduler, clock } = harness(idle);
    await core.onAlarm();
    await core.onAlarm();
    await core.wake();
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t + 60_000);
  });

  it('resets the idle decay ladder when a pass found work', async () => {
    const results: JobPassResult[] = [
      { kind: 'idle' },
      { kind: 'idle' },
      { kind: 'scheduled', delayMs: 1000 },
      { kind: 'idle' },
    ];
    const { core, scheduler, clock } = harness(() => {
      const next = results.shift();
      if (next === undefined) throw new Error('unexpected extra pass');
      return Promise.resolve(next);
    });
    await core.onAlarm();
    await core.onAlarm();
    await core.onAlarm();
    await core.onAlarm();
    expect(scheduler.alarm).toBe(clock.t + 60_000);
  });
});

/** Deterministic PRNG (Park-Miller) so failing sequences replay exactly. */
function seededRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) state += 2_147_483_646;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

/**
 * The property-test model: a fake shard whose pending work the executor
 * consumes when due, plus the op vocabulary (enqueue with or without its
 * wake, wake, fire, crash). Every op appends to the trace — the replay
 * artifact a failure message carries alongside its seed.
 */
class DispatcherModel {
  readonly scheduler = new FakeScheduler();
  readonly clock = new FakeClock();
  readonly pendingWork: number[] = [];
  readonly trace: string[] = [];
  private crashNextPass = false;
  private readonly core: JobDispatcherCore;

  constructor(private readonly seed: number) {
    this.core = new JobDispatcherCore({
      shard: 'default',
      executor: { runPass: () => this.runModelPass() },
      scheduler: this.scheduler,
      telemetry: { passFailed: () => {} },
      now: this.clock.now,
    });
  }

  artifact(): string {
    return `seed=${String(this.seed)} ops=${JSON.stringify(this.trace)}`;
  }

  async wake(label: string): Promise<void> {
    this.trace.push(label);
    await this.core.wake();
  }

  async enqueue(delay: number, withWake: boolean): Promise<void> {
    this.pendingWork.push(this.clock.t + delay);
    if (withWake) {
      await this.wake(`enqueue+wake@${String(delay)}`);
      return;
    }
    // The lost enqueue: commit landed, the post-commit wake was lost.
    this.trace.push(`enqueue-lost@${String(delay)}`);
  }

  async fireAlarm(label: string): Promise<void> {
    this.trace.push(label);
    const alarm = this.scheduler.alarm;
    expect(alarm, this.artifact()).not.toBeNull();
    this.clock.t = Math.max(this.clock.t, alarm!);
    await this.core.onAlarm();
  }

  async crashPass(): Promise<void> {
    this.crashNextPass = true;
    await this.fireAlarm('crash-pass');
  }

  assertAlarmArmed(): void {
    expect(this.scheduler.alarm, this.artifact()).not.toBeNull();
  }

  private runModelPass(): Promise<JobPassResult> {
    if (this.crashNextPass) {
      this.crashNextPass = false;
      return Promise.reject(new Error('scripted crash'));
    }
    const remaining = this.pendingWork.filter((at) => at > this.clock.t);
    this.pendingWork.length = 0;
    this.pendingWork.push(...remaining);
    if (remaining.length === 0) return Promise.resolve({ kind: 'idle' });
    const soonest = Math.min(...remaining);
    return Promise.resolve({
      kind: 'scheduled',
      delayMs: Math.max(250, soonest - this.clock.t),
    });
  }
}

async function runRandomOp(model: DispatcherModel, random: () => number): Promise<void> {
  const roll = random();
  if (roll < 0.35) {
    await model.enqueue(Math.floor(random() * 120_000), random() < 0.6);
  } else if (roll < 0.45) {
    await model.wake('wake');
  } else if (roll < 0.55) {
    await model.crashPass();
  } else {
    await model.fireAlarm('fire-alarm');
  }
}

describe('alarm-always-armed property', () => {
  it('keeps an alarm armed across seeded random enqueue/wake/pass/crash sequences and drains all work', async () => {
    const seeds = Array.from({ length: 30 }, (_, index) => 0xc0_ff_ee + index * 7919);
    for (const seed of seeds) {
      const random = seededRandom(seed);
      const model = new DispatcherModel(seed);

      // The dispatcher is born woken: a DO instance only exists once reached.
      await model.wake('wake');

      for (let step = 0; step < 40; step += 1) {
        await runRandomOp(model, random);
        // The invariant: after every operation an alarm is armed — the
        // perpetual pulse is what recovers lost enqueues.
        model.assertAlarmArmed();
      }

      // Liveness: firing the armed alarm repeatedly drains every pending job,
      // including ones whose enqueue lost its wake.
      for (let fires = 0; fires < 60 && model.pendingWork.length > 0; fires += 1) {
        await model.fireAlarm('drain-fire');
      }
      expect(model.pendingWork, model.artifact()).toEqual([]);
      model.assertAlarmArmed();
    }
  });
});
