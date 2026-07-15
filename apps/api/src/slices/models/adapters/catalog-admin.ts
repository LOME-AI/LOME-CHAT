import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { modelCatalog } from '@hushbox/db';
import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { idempotent } from '../../../lib/idempotency/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter, Idempotent } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The admin kill switch's published writes (`model.disable` / `model.enable`),
 * composed by the admin operations inside their settlement transaction — hence
 * the `DbWriter` handle. Both are `idempotent.byTransition`: one atomic
 * conditional UPDATE (the WHERE clause is the check), with the 0-row outcome
 * disambiguated into a distinguishable already-done no-op or `not_found`.
 * The refresh upsert never writes `admin_disabled_at`, so a set flag survives
 * every catalog refresh.
 */

export type DisableModelOutcome = 'disabled' | 'already-disabled';
export type EnableModelOutcome = 'enabled' | 'already-enabled';

function readRowState(
  db: DbWriter,
  modelId: string,
  context: string
): ResultAsync<Date | null | 'missing', DomainError> {
  return fromPromise(
    db
      .select({ adminDisabledAt: modelCatalog.adminDisabledAt })
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, modelId)),
    (cause) => unavailableError(`${context}: state re-read failed`, cause)
  ).map((rows) => (rows.length === 0 ? 'missing' : (rows[0]?.adminDisabledAt ?? null)));
}

/**
 * Sets `admin_disabled_at` iff currently null. Already disabled is a
 * distinguishable no-op that keeps the original timestamp (the first
 * disable's moment is the audit-relevant fact).
 */
export function disableModelWithinTx(
  db: DbWriter,
  modelId: string,
  now: Date
): ResultAsync<Idempotent<DisableModelOutcome>, DomainError> {
  return idempotent.byTransition<DisableModelOutcome, DomainError>({
    transition: () =>
      fromPromise(
        db
          .update(modelCatalog)
          .set({ adminDisabledAt: now })
          .where(and(eq(modelCatalog.modelId, modelId), isNull(modelCatalog.adminDisabledAt)))
          .returning({ modelId: modelCatalog.modelId }),
        (cause) => unavailableError('model admin-disable failed', cause)
      ).map((rows) => (rows.length === 0 ? null : 'disabled')),
    onZeroRows: () =>
      readRowState(db, modelId, 'model admin-disable').andThen((state) =>
        state === 'missing'
          ? errAsync<DisableModelOutcome, DomainError>(
              notFoundError('model admin-disable: model not in catalog')
            )
          : okAsync<DisableModelOutcome, DomainError>('already-disabled')
      ),
  });
}

/** Clears `admin_disabled_at` iff currently set; already enabled is a no-op. */
export function enableModelWithinTx(
  db: DbWriter,
  modelId: string
): ResultAsync<Idempotent<EnableModelOutcome>, DomainError> {
  return idempotent.byTransition<EnableModelOutcome, DomainError>({
    transition: () =>
      fromPromise(
        db
          .update(modelCatalog)
          .set({ adminDisabledAt: null })
          .where(and(eq(modelCatalog.modelId, modelId), isNotNull(modelCatalog.adminDisabledAt)))
          .returning({ modelId: modelCatalog.modelId }),
        (cause) => unavailableError('model admin-enable failed', cause)
      ).map((rows) => (rows.length === 0 ? null : 'enabled')),
    onZeroRows: () =>
      readRowState(db, modelId, 'model admin-enable').andThen((state) =>
        state === 'missing'
          ? errAsync<EnableModelOutcome, DomainError>(
              notFoundError('model admin-enable: model not in catalog')
            )
          : okAsync<EnableModelOutcome, DomainError>('already-enabled')
      ),
  });
}
