import { describe, it, expect } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import * as schema from './index';

/**
 * Every FK column gets an index or a written justification (Postgres does
 * not auto-index FKs; unindexed-FK cascades are the classic deletion-stall
 * bug). This test walks every declared FK and asserts its local columns are
 * the leading columns of some index, unique constraint, or primary key.
 *
 * Partial indexes count only when listed here: their predicate must be
 * exactly `<fk column> IS NOT NULL` (verified against pg_indexes by the
 * integration suite), which covers every FK lookup because FK scans only
 * ever probe non-null values.
 */
const NOT_NULL_PARTIAL_INDEXES = new Set([
  'ledger_entries_payment_id_idx',
  'ledger_entries_usage_record_id_idx',
  'usage_records_user_id_idx',
  'usage_records_content_item_id_idx',
  'conversation_members_link_id_idx',
  'conversation_members_invited_by_user_id_idx',
  'conversation_forks_tip_message_id_idx',
  'messages_parent_message_id_idx',
  'content_items_model_catalog_id_idx',
  'epochs_previous_epoch_id_idx',
]);

/** `table.column` FKs deliberately left unindexed, each with a written reason. */
const JUSTIFIED_UNINDEXED: Record<string, string> = {};

function leadingColumnsCover(indexColumns: string[], fkColumns: string[]): boolean {
  if (indexColumns.length < fkColumns.length) return false;
  const prefix = new Set(indexColumns.slice(0, fkColumns.length));
  return fkColumns.every((c) => prefix.has(c));
}

describe('every FK column is indexed or justified', () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => v instanceof PgTable
  );

  it('walks a non-empty table set', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  for (const table of tables) {
    const cfg = getTableConfig(table);
    for (const fk of cfg.foreignKeys) {
      const fkColumns = fk.reference().columns.map((c) => c.name);
      it(`${cfg.name}(${fkColumns.join(', ')}) is covered`, () => {
        const justification = JUSTIFIED_UNINDEXED[`${cfg.name}.${fkColumns.join(',')}`];
        if (justification !== undefined) {
          expect(justification.length).toBeGreaterThan(0);
          return;
        }
        const fullIndexes = cfg.indexes
          .filter(
            (index) =>
              index.config.where === undefined ||
              NOT_NULL_PARTIAL_INDEXES.has(index.config.name ?? '')
          )
          .map((index) =>
            index.config.columns.map((c) => ('name' in c ? (c as { name: string }).name : ''))
          );
        const uniques = cfg.uniqueConstraints.map((u) => u.columns.map((c) => c.name));
        const primaryKeys = cfg.primaryKeys.map((pk) => pk.columns.map((c) => c.name));
        const singleColumnCovers = cfg.columns
          .filter((c) => c.isUnique || c.primary)
          .map((c) => [c.name]);
        const candidates = [...fullIndexes, ...uniques, ...primaryKeys, ...singleColumnCovers];
        expect(
          candidates.some((indexColumns) => leadingColumnsCover(indexColumns, fkColumns))
        ).toBe(true);
      });
    }
  }
});
