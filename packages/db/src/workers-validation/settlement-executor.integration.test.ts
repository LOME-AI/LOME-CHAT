import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import {
  requireCount,
  runSettlementValidation,
  type SettlementValidationResult,
} from './settlement-executor';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

describe('runSettlementValidation (node environment, local neon-proxy)', () => {
  let db: Database;
  let result: SettlementValidationResult;

  beforeAll(async () => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    result = await runSettlementValidation(db, 'settlement_content_node');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // The deferred zero-sum trigger fires at COMMIT — the settlement transaction's
  // INSERTs succeed, then the whole transaction aborts because the legs do not
  // sum to zero.
  it('aborts the settlement transaction when the ledger legs do not sum to zero', () => {
    expect(result.unbalanced.aborted).toBe(true);
  });

  it('rejects the unbalanced write with the ledger zero-sum trigger', () => {
    expect(result.unbalanced.triggerRejected).toBe(true);
  });

  // saved⟺billed: the aborted billing rolls back the content saved in the same
  // transaction — nothing is saved unless the charge balances and commits.
  it('does not persist saved content when the settlement transaction aborts', () => {
    expect(result.unbalanced.contentPersisted).toBe(false);
  });

  it('persists no ledger legs when the settlement transaction aborts', () => {
    expect(result.unbalanced.legsPersisted).toBe(0);
  });

  it('commits a balanced settlement transaction', () => {
    expect(result.balanced.committed).toBe(true);
  });

  // saved⟺billed: a committed settlement writes the content and the charge
  // together.
  it('persists saved content when the settlement transaction commits', () => {
    expect(result.balanced.contentPersisted).toBe(true);
  });

  it('persists the balanced ledger legs when the settlement transaction commits', () => {
    expect(result.balanced.legsPersisted).toBe(2);
  });

  it('inserts the ledger legs on the first settlement attempt', () => {
    expect(result.exactlyOnce.firstAttemptLegsInserted).toBe(2);
  });

  // Exactly-once under simulated retry/crash: the retry re-runs the identical
  // settlement body; the per-leg idempotency key makes it a no-op.
  it('inserts nothing on the retried settlement attempt', () => {
    expect(result.exactlyOnce.secondAttemptLegsInserted).toBe(0);
  });

  it('leaves exactly one set of ledger legs after the retried attempt', () => {
    expect(result.exactlyOnce.finalLegCount).toBe(2);
  });

  it('rejects scratch table names that are not simple identifiers', async () => {
    await expect(runSettlementValidation(db, 'bad name; drop table users')).rejects.toThrow(
      /scratchTable/
    );
  });
});

describe('requireCount', () => {
  it('returns a numeric count unchanged', () => {
    expect(requireCount(2)).toBe(2);
  });

  it('throws when the count cell is not a number', () => {
    expect(() => requireCount(null)).toThrow(/requireCount/);
  });
});
