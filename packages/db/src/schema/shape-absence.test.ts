import { describe, it, expect } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import * as schema from './index';

/**
 * Deliberately deleted tables: flowRuns (the run referee is the
 * idempotency-key row), exports (export jobs carry the archive key in
 * jobs.result), admin_pending_actions (delayed cancellable admin jobs),
 * projects (feature deleted), account_deletion_events (not part of the
 * data-model inventory), model_pricing (dead — pricing lives in the
 * model_catalog.descriptor jsonb since OpenRouter cost is authoritative
 * inline), model_overrides (OpenRouter's queryable metadata + ZDR list make
 * manual supplements obsolete). A table absent from the inventory does not
 * exist. service_evidence is NOT deleted: the service-evidence CI system is
 * retained, so the table survives into the new system.
 */
const DELETED_TABLE_NAMES = [
  'flow_runs',
  'flowRuns',
  'exports',
  'admin_pending_actions',
  'projects',
  'account_deletion_events',
  'model_pricing',
  'model_overrides',
];

describe('deleted tables are absent from the schema', () => {
  const tableNames = new Set(
    (Object.values(schema) as unknown[])
      .filter((v): v is PgTable => v instanceof PgTable)
      .map((t) => getTableConfig(t).name)
  );

  it.each(DELETED_TABLE_NAMES)('%s does not exist', (name) => {
    expect(tableNames.has(name)).toBe(false);
  });

  it.each([
    'flowRuns',
    'exports',
    'adminPendingActions',
    'projects',
    'accountDeletionEvents',
    'modelPricing',
    'modelOverrides',
    'modelPricingRelations',
    'modelOverridesRelations',
  ])('no %s export exists on the barrel', (exportName) => {
    expect(Object.keys(schema)).not.toContain(exportName);
  });
});
