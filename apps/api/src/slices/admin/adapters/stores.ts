import { eq } from 'drizzle-orm';
import { adminAudit } from '@hushbox/db';
import { UndoAlreadyClaimedError } from '../ports/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { AdminAuditInsertRow, AdminAuditUndoTarget, AdminStores } from '../ports/index.js';

const UNDOES_UNIQUE_CONSTRAINT = 'admin_audit_undoes_unique';

/** Postgres unique-violation (23505) on the undoes claim, chain-walked.
 * Exported for its own unit tests (the arms are hard to force through a
 * live database). */
export function isUndoUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return (
        candidate.constraint === UNDOES_UNIQUE_CONSTRAINT ||
        (candidate.constraint === undefined &&
          current instanceof Error &&
          current.message.includes(UNDOES_UNIQUE_CONSTRAINT))
      );
    }
    current = candidate.cause;
  }
  return false;
}

/** The only Drizzle-touching layer of the admin slice (owns `admin_audit`). */
export function createAdminStores(): AdminStores {
  return {
    async getAuditForUndo(writer: DbWriter, id: string): Promise<AdminAuditUndoTarget | undefined> {
      const rows = await writer
        .select({ action: adminAudit.action, details: adminAudit.details })
        .from(adminAudit)
        .where(eq(adminAudit.id, id));
      return rows[0];
    },
    async insertAudit(writer: DbWriter, row: AdminAuditInsertRow): Promise<{ id: string }> {
      try {
        const inserted = await writer
          .insert(adminAudit)
          .values({
            actor: row.actor,
            action: row.action,
            targetType: row.targetType ?? null,
            targetId: row.targetId ?? null,
            details: row.details,
            undoes: row.undoes ?? null,
          })
          .returning({ id: adminAudit.id });
        const first = inserted[0];
        if (first === undefined) {
          throw new Error('admin stores: audit insert returned no row');
        }
        return first;
      } catch (error) {
        if (row.undoes !== undefined && isUndoUniqueViolation(error)) {
          throw new UndoAlreadyClaimedError(row.undoes);
        }
        throw error;
      }
    },
  };
}
