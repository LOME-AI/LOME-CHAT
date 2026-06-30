import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { runLockValidation, type LockValidationResult } from './txn-executor';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

describe('runLockValidation (node environment, local neon-proxy)', () => {
  let claimantA: Database;
  let claimantB: Database;
  let result: LockValidationResult;

  beforeAll(async () => {
    claimantA = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    claimantB = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    result = await runLockValidation(claimantA, claimantB, 'client_validation_node');
  });

  afterAll(async () => {
    await claimantA.$client.end();
    await claimantB.$client.end();
  });

  it('sees its own uncommitted insert inside the transaction', () => {
    expect(result.readYourWrites).toBe('inside-txn');
  });

  it('hides uncommitted rows from a concurrent client', () => {
    expect(result.uncommittedVisibleToOthers).toBe(false);
  });

  // 55P03 (lock_not_available) can only come from Postgres rejecting FOR
  // UPDATE NOWAIT on a row another transaction holds — it proves the row lock
  // is real through the driver, not merely MVCC invisibility of the insert.
  it('rejects a concurrent FOR UPDATE NOWAIT claimant with 55P03 while the row lock is held', () => {
    expect(result.lockBlockedCode).toBe('55P03');
  });

  it('commits the multi-statement transaction atomically', () => {
    expect(result.postCommitValue).toBe('updated-in-txn');
  });

  it('releases the row lock at commit', () => {
    expect(result.relockedAfterCommit).toBe(true);
  });

  it('rejects table names that are not simple identifiers', async () => {
    await expect(
      runLockValidation(claimantA, claimantB, 'bad name; drop table users')
    ).rejects.toThrow(/tableName/);
  });
});
