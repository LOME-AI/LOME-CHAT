import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

/**
 * Closes the largest fidelity gap in the money code: the real settlement
 * transaction shape — `db.transaction(...)` writing real `ledger_entries` legs
 * under the production DEFERRABLE INITIALLY DEFERRED zero-sum trigger — is here
 * exercised inside a Durable Object under workerd (vitest-pool-workers), the
 * exact runtime the conversation DO runs `settle()` in. Every other
 * `*.workers.test.ts` uses scripted fakes or a lock-shaped scratch transaction;
 * this drives the genuine trigger + idempotency path where driver, `waitUntil`,
 * and connection semantics differ from node.
 *
 * Local runs reach the local neon-proxy (fine for the platform assertions). CI
 * targets managed Neon per DBI-8 — see the workers vitest config and ci.yml.
 */
describe('settlement validation (workerd + real ledger trigger inside a Durable Object)', () => {
  it('drives the real settlement transaction and its three money invariants inside a DO', async () => {
    const stub = env.DB_TXN_RUNNER.get(env.DB_TXN_RUNNER.idFromName('settlement-validation'));

    const result = await stub.runSettlement('settlement_content_do');

    expect(result).toEqual({
      // (3) the deferred zero-sum trigger aborts the unbalanced transaction at
      // COMMIT, and (2) saved⟺billed: the content saved in the same transaction
      // rolls back with the failed billing — nothing persists.
      unbalanced: {
        aborted: true,
        triggerRejected: true,
        contentPersisted: false,
        legsPersisted: 0,
      },
      // (2) saved⟺billed: a balanced settlement commits content and charge
      // together.
      balanced: {
        committed: true,
        contentPersisted: true,
        legsPersisted: 2,
      },
      // (1) exactly-once under a simulated retry/crash: the retried settlement
      // body inserts nothing (the per-leg idempotency key no-ops it) and exactly
      // one set of legs remains.
      exactlyOnce: {
        firstAttemptLegsInserted: 2,
        secondAttemptLegsInserted: 0,
        finalLegCount: 2,
      },
    });
  });
});
