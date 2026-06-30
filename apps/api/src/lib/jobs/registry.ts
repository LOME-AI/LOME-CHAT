import type { jobs } from '@hushbox/db';
import type { z } from 'zod';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobOutcome } from './outcome.js';

export type JobRow = typeof jobs.$inferSelect;
export type JobShard = JobRow['shard'];

/**
 * The mandatory idempotency declaration: how a handler's effect stays
 * exactly-once-equivalent across redelivery. `txn` = the handler commits its
 * effect and the terminal transition in one transaction via the bound
 * `JobExecution.completeWithinTx` capability — the executor sees the
 * `completed` outcome and skips its own terminal write, and a crash before
 * commit persists neither the effect nor the transition; `natural` = the
 * effect is naturally idempotent (e.g. a delete); `providerKey` = the
 * external call carries a jobId-derived idempotency key; `byEventId` = the
 * effect dedupes on an external event id.
 */
export const JOB_IDEMPOTENCY_CLASSES = ['txn', 'natural', 'providerKey', 'byEventId'] as const;
export type JobIdempotencyClass = (typeof JOB_IDEMPOTENCY_CLASSES)[number];

const JOB_SHARDS: ReadonlySet<JobShard> = new Set(['default', 'bulk']);

/** Versioned job-type names (`export.build.v1`) so payloads can evolve. */
const VERSIONED_TYPE_PATTERN = /^[a-z][a-zA-Z0-9.-]*\.v\d+$/;

/**
 * Crashed claims tolerated beyond the failure budget before the claim-time
 * dead-letter pass declares the job poison: completed attempts consume
 * `failures`, so `claims` only outruns `failures` when claimants die
 * mid-execution without writing a completion.
 */
export const POISON_CLAIM_MARGIN = 3;

/**
 * The platform's 15-minute alarm wall caps one dispatcher pass, so a lease
 * longer than that is incoherent — the pass that holds it cannot outlive it —
 * and only delays crash recovery and poison detection.
 */
export const MAX_JOB_LEASE_SECONDS = 900;

/** What an executing handler may see and do; every write it can reach is fenced. */
export interface JobExecution<Payload> {
  readonly jobId: string;
  readonly payload: Payload;
  /** The claim counter for this execution — part of the completion fence. */
  readonly claims: number;
  /** Fenced lease touch for long jobs; `lost` means this claimant is a zombie. */
  heartbeat(): Promise<'alive' | 'lost'>;
  /**
   * The `txn`-class capability: writes this job's fenced `succeeded`
   * transition on the caller's open transaction, so the handler's effect and
   * the transition commit atomically. Returns the outcome the handler must
   * return; the executor then skips its own terminal write. A lost fence
   * throws, aborting the enclosing transaction — a zombie can never commit
   * its effect without the transition. Success is the only completion that
   * may carry an effect; `fail`/`dead`/`yield` outcomes are returned plainly
   * and written by the executor.
   */
  completeWithinTx(writer: DbWriter, result?: unknown): Promise<JobOutcome>;
}

export type JobHandler<Payload> = (execution: JobExecution<Payload>) => Promise<JobOutcome>;

export interface JobRegistration<Schema extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly schema: Schema;
  readonly leaseSeconds: number;
  readonly maxFailures: number;
  readonly idempotency: JobIdempotencyClass;
  readonly handler: JobHandler<z.infer<Schema>>;
  /** Default routing for the type; an enqueue may still override per job. */
  readonly shard?: JobShard;
}

export interface RegisteredJob {
  readonly type: string;
  readonly schema: z.ZodType;
  readonly leaseSeconds: number;
  readonly maxFailures: number;
  readonly maxClaims: number;
  readonly idempotency: JobIdempotencyClass;
  readonly shard: JobShard;
  readonly handler: JobHandler<unknown>;
}

export interface JobRegistry {
  register<Schema extends z.ZodType>(registration: JobRegistration<Schema>): void;
  get(type: string): RegisteredJob | undefined;
  types(): readonly string[];
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * Registration is rejected if incomplete — the checks run at runtime (not
 * just compile time) because a wrong declaration here silently corrupts
 * every row of that type: a job enqueued under a bad registration would
 * carry the wrong lease, budget, or shard for its entire life.
 */
function assertExecutableDeclaration(registration: JobRegistration): void {
  const { type, schema, handler } = registration;
  if (typeof type !== 'string' || !VERSIONED_TYPE_PATTERN.test(type)) {
    throw new Error(
      `job registry: type must be a versioned name like "export.build.v1", got ${JSON.stringify(type)}`
    );
  }
  if (!isZodSchema(schema)) {
    throw new Error(`job registry: ${type} declares no payload schema`);
  }
  if (typeof handler !== 'function') {
    throw new TypeError(`job registry: ${type} declares no handler`);
  }
}

function assertBudgetDeclaration(registration: JobRegistration): void {
  const { type, leaseSeconds, maxFailures, idempotency, shard } = registration;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_JOB_LEASE_SECONDS) {
    throw new Error(
      `job registry: ${type} leaseSeconds must be an integer between 1 and ${String(MAX_JOB_LEASE_SECONDS)}`
    );
  }
  if (!Number.isInteger(maxFailures) || maxFailures < 1) {
    throw new Error(`job registry: ${type} maxFailures must be a positive integer`);
  }
  if (!JOB_IDEMPOTENCY_CLASSES.includes(idempotency)) {
    throw new Error(
      `job registry: ${type} idempotency must be one of txn|natural|providerKey|byEventId`
    );
  }
  if (shard !== undefined && !JOB_SHARDS.has(shard)) {
    throw new Error(`job registry: ${type} shard must be one of default|bulk`);
  }
}

function assertCompleteRegistration(registration: JobRegistration): void {
  assertExecutableDeclaration(registration);
  assertBudgetDeclaration(registration);
}

export function createJobRegistry(): JobRegistry {
  const registrations = new Map<string, RegisteredJob>();
  return {
    register(registration) {
      assertCompleteRegistration(registration);
      if (registrations.has(registration.type)) {
        throw new Error(`job registry: ${registration.type} is already registered`);
      }
      registrations.set(registration.type, {
        type: registration.type,
        schema: registration.schema,
        leaseSeconds: registration.leaseSeconds,
        maxFailures: registration.maxFailures,
        maxClaims: registration.maxFailures + POISON_CLAIM_MARGIN,
        idempotency: registration.idempotency,
        shard: registration.shard ?? 'default',
        // The cast widens the payload type; safe because the execution path
        // always parses the payload with this registration's own schema
        // before invoking the handler.
        handler: registration.handler as JobHandler<unknown>,
      });
    },
    get(type) {
      return registrations.get(type);
    },
    types() {
      return [...registrations.keys()];
    },
  };
}
