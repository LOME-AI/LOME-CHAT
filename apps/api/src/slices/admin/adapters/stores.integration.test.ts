import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb } from '@hushbox/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { UndoAlreadyClaimedError } from '../ports/index.js';
import { createAdminStores } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin stores integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createAdminStores();

// admin_audit is append-only (UPDATE/DELETE raise) — rows created here stay;
// every test isolates by a unique actor instead of cleaning up.
function uniqueActor(): string {
  return `admin-stores-test-${crypto.randomUUID()}@hushbox.ai`;
}

describe('createAdminStores.insertAudit', () => {
  it('inserts an audit row and returns its id', async () => {
    const actor = uniqueActor();

    const { id } = await stores.insertAudit(db, {
      actor,
      action: 'fixture.mark',
      targetType: 'fixture',
      targetId: crypto.randomUUID(),
      details: { reason: 'integration test' },
    });

    const rows = await db.select().from(adminAudit).where(eq(adminAudit.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor,
      action: 'fixture.mark',
      details: { reason: 'integration test' },
      undoes: null,
    });
  });

  it('loads an audit row for undo validation and returns undefined for a missing id', async () => {
    const actor = uniqueActor();
    const details = { input: { reason: 'x' }, effects: [], inverseInput: null };
    const { id } = await stores.insertAudit(db, {
      actor,
      action: 'fixture.mark',
      details,
    });

    const found = await stores.getAuditForUndo(db, id);
    const missing = await stores.getAuditForUndo(db, crypto.randomUUID());

    expect(found).toEqual({ action: 'fixture.mark', details });
    expect(missing).toBeUndefined();
  });

  it('threads undoes and refuses a second undo of the same audit row', async () => {
    const actor = uniqueActor();
    const original = await stores.insertAudit(db, {
      actor,
      action: 'fixture.mark',
      details: {},
    });

    const firstUndo = await stores.insertAudit(db, {
      actor,
      action: 'fixture.unmark',
      details: {},
      undoes: original.id,
    });
    const undoRows = await db.select().from(adminAudit).where(eq(adminAudit.id, firstUndo.id));
    expect(undoRows[0]?.undoes).toBe(original.id);

    await expect(
      stores.insertAudit(db, {
        actor,
        action: 'fixture.unmark',
        details: {},
        undoes: original.id,
      })
    ).rejects.toBeInstanceOf(UndoAlreadyClaimedError);
  });

  it('rethrows non-undo failures untouched (defects keep throwing)', async () => {
    // A bigint cannot serialize into jsonb — an infra defect, not an undo
    // conflict; it must surface as-is, never as UndoAlreadyClaimedError.
    await expect(
      stores.insertAudit(db, {
        actor: uniqueActor(),
        action: 'fixture.mark',
        details: { amount: 5n },
      })
    ).rejects.not.toBeInstanceOf(UndoAlreadyClaimedError);
  });
});
