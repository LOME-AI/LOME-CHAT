import { describe, it, expect } from 'vitest';

import { column, findForeignKey, findIndex } from './__tests__/shape-helpers';
import { adminAudit, jobs, modelCatalog } from './index';

/**
 * Admin-plane schema deltas: the undo claim column, the audit query indexes,
 * restorable job discard, and the model kill switch.
 */
describe('admin_audit undo claim', () => {
  it('undoes is a nullable uuid self-FK', () => {
    const c = column(adminAudit, 'undoes');
    expect(c.getSQLType()).toBe('uuid');
    expect(c.notNull).toBe(false);
    const fk = findForeignKey(adminAudit, ['undoes']);
    expect(fk.foreignTable).toBe('admin_audit');
    expect(fk.foreignColumns).toEqual(['id']);
  });

  it('undoes is UNIQUE (two concurrent undos of one row commit exactly one)', () => {
    expect(column(adminAudit, 'undoes').isUnique).toBe(true);
  });
});

describe('admin_audit target', () => {
  it('target_id is nullable text (model ops target string model ids, not uuids)', () => {
    const c = column(adminAudit, 'target_id');
    expect(c.getSQLType()).toBe('text');
    expect(c.notNull).toBe(false);
  });
});

describe('admin_audit query indexes', () => {
  it('has the (target_type, target_id) index', () => {
    const index = findIndex(adminAudit, 'admin_audit_target_idx');
    expect(index.columns).toEqual(['target_type', 'target_id']);
    expect(index.unique).toBe(false);
  });

  it('has the (actor, created_at) index', () => {
    const index = findIndex(adminAudit, 'admin_audit_actor_created_at_idx');
    expect(index.columns).toEqual(['actor', 'created_at']);
    expect(index.unique).toBe(false);
  });
});

describe('jobs restorable discard', () => {
  it('discarded_at is a nullable timestamptz', () => {
    const c = column(jobs, 'discarded_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(false);
  });

  it('has the discarded-prune partial index on discarded_at', () => {
    expect(findIndex(jobs, 'jobs_discarded_prune_idx')).toEqual({
      name: 'jobs_discarded_prune_idx',
      unique: false,
      partial: true,
      columns: ['discarded_at'],
    });
  });
});

describe('model_catalog admin kill switch', () => {
  it('admin_disabled_at is a nullable timestamptz', () => {
    const c = column(modelCatalog, 'admin_disabled_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(false);
  });
});
