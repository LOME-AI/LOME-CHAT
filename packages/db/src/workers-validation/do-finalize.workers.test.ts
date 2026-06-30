import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

/**
 * Validates the platform assumption the settlement design rests on: a
 * Durable Object under workerd (vitest-pool-workers) can run an interactive
 * multi-statement transaction with a real row lock through the client
 * against the local neon-proxy (the conversation DO runs settle() in
 * production). The 55P03 expectation is the load-bearing assertion: a
 * concurrent FOR UPDATE NOWAIT claimant hitting lock_not_available proves
 * the row lock is real through the driver under workerd.
 */
describe('DO finalize validation (workerd + client + local neon-proxy)', () => {
  it('executes a multi-statement interactive transaction with a real row lock inside a Durable Object', async () => {
    const stub = env.DB_TXN_RUNNER.get(env.DB_TXN_RUNNER.idFromName('db-finalize-validation'));

    const result = await stub.runValidation('client_validation_do');

    expect(result).toEqual({
      readYourWrites: 'inside-txn',
      uncommittedVisibleToOthers: false,
      lockBlockedCode: '55P03',
      postCommitValue: 'updated-in-txn',
      relockedAfterCommit: true,
    });
  });
});
