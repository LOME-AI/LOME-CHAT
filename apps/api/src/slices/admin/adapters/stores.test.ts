import { describe, expect, it } from 'vitest';
import { createAdminStores, isUndoUniqueViolation } from './stores.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';

const CONSTRAINT = 'admin_audit_undoes_unique';

describe('isUndoUniqueViolation', () => {
  it('matches a 23505 carrying the undoes constraint name', () => {
    expect(isUndoUniqueViolation({ code: '23505', constraint: CONSTRAINT })).toBe(true);
  });

  it('matches a 23505 without a constraint field via the error message', () => {
    const error = Object.assign(new Error(`duplicate key violates ${CONSTRAINT}`), {
      code: '23505',
    });

    expect(isUndoUniqueViolation(error)).toBe(true);
  });

  it('walks the cause chain to a nested 23505', () => {
    const cause = { code: '23505', constraint: CONSTRAINT };

    expect(isUndoUniqueViolation(new Error('query failed', { cause }))).toBe(true);
  });

  it('rejects a 23505 on a different constraint', () => {
    expect(isUndoUniqueViolation({ code: '23505', constraint: 'admin_audit_pkey' })).toBe(false);
  });

  it('rejects non-unique-violation errors and non-objects', () => {
    expect(isUndoUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUndoUniqueViolation('boom')).toBe(false);
  });
});

describe('createAdminStores.insertAudit (writer contract)', () => {
  it('treats an insert returning no row as a defect', async () => {
    const writer = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    } as unknown as DbWriter;

    await expect(
      createAdminStores().insertAudit(writer, { actor: 'a@x', action: 'fixture.mark', details: {} })
    ).rejects.toThrow(/returned no row/);
  });
});
