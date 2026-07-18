import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { column, findIndex, hasDefault } from './__tests__/shape-helpers';
import * as schema from './index';

describe('public_stats_snapshots', () => {
  it('lives in the public pg schema', () => {
    expect(getTableConfig(schema.publicStatsSnapshots).schema).toBeUndefined();
  });

  it('has a uuid primary key defaulting to uuidv7()', () => {
    const id = column(schema.publicStatsSnapshots, 'id');
    expect(id.primary).toBe(true);
    expect(id.getSQLType()).toBe('uuid');
    expect(hasDefault(schema.publicStatsSnapshots, 'id')).toBe(true);
  });

  it('versions each snapshot with a non-null integer schema_version', () => {
    const c = column(schema.publicStatsSnapshots, 'schema_version');
    expect(c.getSQLType()).toBe('integer');
    expect(c.notNull).toBe(true);
  });

  it('holds the full anonymized payload as non-null jsonb', () => {
    const c = column(schema.publicStatsSnapshots, 'stats');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(true);
  });

  it('timestamps every snapshot by default and indexes created_at for latest-row reads', () => {
    const c = column(schema.publicStatsSnapshots, 'created_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(true);
    expect(hasDefault(schema.publicStatsSnapshots, 'created_at')).toBe(true);
    expect(findIndex(schema.publicStatsSnapshots, 'public_stats_snapshots_created_at_idx')).toEqual(
      {
        name: 'public_stats_snapshots_created_at_idx',
        unique: false,
        partial: false,
        columns: ['created_at'],
      }
    );
  });

  it('is self-contained by design — no foreign keys, exactly the four columns', () => {
    const config = getTableConfig(schema.publicStatsSnapshots);
    expect(config.columns.map((c) => c.name)).toEqual([
      'id',
      'schema_version',
      'stats',
      'created_at',
    ]);
    expect(config.foreignKeys).toHaveLength(0);
  });
});
