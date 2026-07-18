/**
 * The dispatcher's scheduling brain, as a plain module the node project
 * covers (thin-shell doctrine: the DO class only adapts the platform). The
 * executor — claim, execute, complete against Postgres — is injected by the
 * worker; this core owns the alarm discipline: arm-first, re-arm to the
 * exact next attempt, idle decay, and the wake-overwrite race.
 */

/** What one dispatcher pass found, advising the next alarm. */
export type JobPassResult =
  | { readonly kind: 'due' }
  | { readonly kind: 'scheduled'; readonly delayMs: number }
  | { readonly kind: 'idle' };

/** The worker-bound pass executor (claim → execute → complete → advise). */
export interface JobPassExecutor {
  runPass(shard: string): Promise<JobPassResult>;
}

export interface DispatcherScheduler {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** The slim slice of DO storage the shard-identity resolver needs. */
export interface ShardStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

/** DO-storage key under which the dispatcher persists its own shard. */
export const SHARD_STORAGE_KEY = 'shard';

/**
 * Resolve the dispatcher's shard identity across reconstructions.
 * `DurableObjectState.id.name` is populated only when the object is reached
 * through a live `idFromName` stub; the platform revives an alarm-firing DO
 * from the stored id alone, where the name is absent. So the name is
 * persisted on every live construction and read back when the platform
 * reconstructs the DO for its alarm. The first construction is always a live
 * wake, so storage is populated before any alarm can fire.
 */
export async function resolveDispatcherShard(
  idName: string | undefined,
  store: ShardStore
): Promise<string> {
  if (idName !== undefined) {
    await store.put(SHARD_STORAGE_KEY, idName);
    return idName;
  }
  const stored = await store.get(SHARD_STORAGE_KEY);
  if (stored !== undefined) return stored;
  throw new Error(
    'JobDispatcher has no shard identity: id has no name and none was persisted — reach it via idFromName(shard) before its alarm fires'
  );
}

/**
 * Closed telemetry event set (the package carries no content-capable logging
 * surface); the worker binds each event to its typed Telemetry port.
 */
export interface DispatcherTelemetry {
  /** A whole pass rejected — per-job failures are the executor's business. */
  passFailed(fields: { shard: string }): void;
}

export interface JobDispatcherCoreOptions {
  readonly shard: string;
  readonly executor: JobPassExecutor;
  readonly scheduler: DispatcherScheduler;
  readonly telemetry: DispatcherTelemetry;
  readonly now: () => number;
}

/**
 * The pulse armed before any fallible work: a crashed pass still leaves an
 * alarm, so the re-arm — not platform retries — is the delivery guarantee.
 */
export const ARM_FIRST_DELAY_MS = 30_000;

/**
 * Idle decay 60 s → 2 m → 5 m → 15 m → 30 m cap (lets Neon scale to zero).
 * Applies only when a pass found nothing pending or scheduled; any wake or
 * work resets the ladder, and decay never displaces an exact nextAttemptAt.
 */
export const IDLE_DECAY_LADDER_MS: readonly number[] = [60_000, 120_000, 300_000, 900_000];

const IDLE_DECAY_CAP_MS = 1_800_000;

export class JobDispatcherCore {
  private idleStep = 0;

  constructor(private readonly options: JobDispatcherCoreOptions) {}

  /** `wake()` = `setAlarm(min(getAlarm() ?? ∞, now))`, plus a ladder reset. */
  async wake(): Promise<void> {
    this.idleStep = 0;
    const { scheduler, now } = this.options;
    const current = await scheduler.getAlarm();
    const at = now();
    if (current === null || current > at) {
      await scheduler.setAlarm(at);
    }
  }

  /**
   * One alarm tick. Never throws: per-job fallibility lives in the executor,
   * and a rejected pass leaves the arm-first pulse standing.
   */
  async onAlarm(): Promise<void> {
    const { scheduler, executor, telemetry, now, shard } = this.options;
    const armFirstAt = now() + ARM_FIRST_DELAY_MS;
    await scheduler.setAlarm(armFirstAt);
    let result: JobPassResult;
    try {
      result = await executor.runPass(shard);
    } catch {
      telemetry.passFailed({ shard });
      return;
    }
    const at = now();
    const target = this.targetFor(result, at);
    // The wake-overwrite race: an alarm earlier than our own arm-first pulse
    // can only be a wake() that landed during the pass — `min` keeps it. An
    // alarm at the pulse is our own and is replaced by the computed target.
    const current = await scheduler.getAlarm();
    const wakeSet = current !== null && current < armFirstAt ? current : Number.POSITIVE_INFINITY;
    await scheduler.setAlarm(Math.min(target, wakeSet));
  }

  private targetFor(result: JobPassResult, at: number): number {
    switch (result.kind) {
      case 'due': {
        this.idleStep = 0;
        return at;
      }
      case 'scheduled': {
        this.idleStep = 0;
        return at + result.delayMs;
      }
      case 'idle': {
        const delay = IDLE_DECAY_LADDER_MS[this.idleStep];
        this.idleStep += 1;
        return at + (delay ?? IDLE_DECAY_CAP_MS);
      }
    }
  }
}
