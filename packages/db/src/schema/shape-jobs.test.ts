import { describe, it, expect } from 'vitest';

import { column, findIndex, hasDefault } from './__tests__/shape-helpers';
import { jobs } from './index';

/**
 * The jobs table — the full dispatcher column set and exactly four partial
 * indexes (claim probe, active-dedupe unique, succeeded-prune,
 * discarded-prune).
 */
describe('jobs columns', () => {
  it('type is text by design (versioned job-type names)', () => {
    const c = column(jobs, 'type');
    expect(c.getSQLType()).toBe('text');
    expect(c.notNull).toBe(true);
  });

  it('shard is the job_shard pgEnum defaulting to default', () => {
    const c = column(jobs, 'shard');
    expect(c.getSQLType()).toBe('job_shard');
    expect(c.notNull).toBe(true);
    expect(hasDefault(jobs, 'shard')).toBe(true);
  });

  it('priority is a non-null integer with a default', () => {
    const c = column(jobs, 'priority');
    expect(c.getSQLType()).toBe('integer');
    expect(c.notNull).toBe(true);
    expect(hasDefault(jobs, 'priority')).toBe(true);
  });

  it('payload is non-null jsonb (mutable checkpoint state)', () => {
    const c = column(jobs, 'payload');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(true);
  });

  it('result is nullable jsonb', () => {
    const c = column(jobs, 'result');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(false);
  });

  it('dedupe_key is nullable text', () => {
    const c = column(jobs, 'dedupe_key');
    expect(c.getSQLType()).toBe('text');
    expect(c.notNull).toBe(false);
  });

  it('status is the job_status pgEnum defaulting to pending', () => {
    const c = column(jobs, 'status');
    expect(c.getSQLType()).toBe('job_status');
    expect(c.notNull).toBe(true);
    expect(hasDefault(jobs, 'status')).toBe(true);
  });

  it('carries the claims/maxClaims poison counter pair', () => {
    expect(column(jobs, 'claims').notNull).toBe(true);
    expect(hasDefault(jobs, 'claims')).toBe(true);
    expect(column(jobs, 'max_claims').notNull).toBe(true);
  });

  it('carries the failures/maxFailures backoff counter pair', () => {
    expect(column(jobs, 'failures').notNull).toBe(true);
    expect(hasDefault(jobs, 'failures')).toBe(true);
    expect(column(jobs, 'max_failures').notNull).toBe(true);
  });

  it('schedules with scheduled_at plus next_attempt_at', () => {
    expect(column(jobs, 'scheduled_at').getSQLType()).toBe('timestamp with time zone');
    expect(column(jobs, 'scheduled_at').notNull).toBe(true);
    expect(column(jobs, 'next_attempt_at').getSQLType()).toBe('timestamp with time zone');
    expect(column(jobs, 'next_attempt_at').notNull).toBe(true);
  });

  it('anchors the lease on claimed_at/claimed_by', () => {
    expect(column(jobs, 'claimed_at').notNull).toBe(false);
    expect(column(jobs, 'claimed_by').notNull).toBe(false);
  });

  it('configures the lease length per job', () => {
    const c = column(jobs, 'lease_seconds');
    expect(c.getSQLType()).toBe('integer');
    expect(c.notNull).toBe(true);
  });

  it('supports cooperative cancellation via cancel_requested', () => {
    const c = column(jobs, 'cancel_requested');
    expect(c.getSQLType()).toBe('boolean');
    expect(c.notNull).toBe(true);
    expect(hasDefault(jobs, 'cancel_requested')).toBe(true);
  });

  it('keeps the full error history as non-null jsonb', () => {
    const c = column(jobs, 'errors');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(true);
    expect(hasDefault(jobs, 'errors')).toBe(true);
  });

  it('records terminal time in finished_at for the prune index', () => {
    expect(column(jobs, 'finished_at').notNull).toBe(false);
  });

  it('timestamps creation', () => {
    expect(column(jobs, 'created_at').notNull).toBe(true);
  });
});

describe('jobs partial indexes', () => {
  it('has the claim probe on (shard, priority, next_attempt_at) over active rows', () => {
    expect(findIndex(jobs, 'jobs_claim_idx')).toEqual({
      name: 'jobs_claim_idx',
      unique: false,
      partial: true,
      columns: ['shard', 'priority', 'next_attempt_at'],
    });
  });

  it('has the at-most-one-active dedupe unique on dedupe_key', () => {
    expect(findIndex(jobs, 'jobs_dedupe_key_unique')).toEqual({
      name: 'jobs_dedupe_key_unique',
      unique: true,
      partial: true,
      columns: ['dedupe_key'],
    });
  });

  it('has the prune index on finished_at over succeeded rows', () => {
    expect(findIndex(jobs, 'jobs_prune_idx')).toEqual({
      name: 'jobs_prune_idx',
      unique: false,
      partial: true,
      columns: ['finished_at'],
    });
  });
});
