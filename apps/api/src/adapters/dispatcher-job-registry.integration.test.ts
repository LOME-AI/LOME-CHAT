import { afterAll, describe, expect, it } from 'vitest';
import { createDispatcherJobRegistry, openDispatcherDbFromEnv } from './dispatcher-job-registry.js';
import { PAYMENT_VERIFY_JOB_TYPE } from '../slices/billing/index.js';
import type { JobExecution } from '../lib/jobs/index.js';
import type { Bindings } from '../lib/context/app-env.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`dispatcher registry tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

// The env the DO's composition sees. In dev the mock payment provider is
// selected — it fails fast without API_URL/HELCIM_WEBHOOK_VERIFIER, so both are
// supplied exactly as the local stack provides them.
const env: Bindings & { API_URL: string; HELCIM_WEBHOOK_VERIFIER: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  API_URL: requiredEnv('API_URL'),
  HELCIM_WEBHOOK_VERIFIER: requiredEnv('HELCIM_WEBHOOK_VERIFIER'),
};

// A minimal execution for a resolved handler. The payment-verify handler reads
// only `payload.paymentId`; on an absent pre-claim row it returns `dead` before
// touching the fenced completion/heartbeat capabilities, so those throw if the
// handler ever reaches for them.
function executionFor(paymentId: string): JobExecution<unknown> {
  return {
    jobId: crypto.randomUUID(),
    payload: { paymentId },
    claims: 1,
    heartbeat: () => Promise.reject(new Error('heartbeat unexpectedly invoked')),
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

describe('openDispatcherDbFromEnv', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => openDispatcherDbFromEnv({ NODE_ENV: 'development' })).toThrow('DATABASE_URL');
  });

  it('fails fast when DATABASE_URL is empty', () => {
    expect(() => openDispatcherDbFromEnv({ NODE_ENV: 'development', DATABASE_URL: '' })).toThrow(
      'DATABASE_URL'
    );
  });

  it('opens a working client from the env binding', async () => {
    const db = openDispatcherDbFromEnv(env);
    expect(db).toBeDefined();
    await db.$client.end();
  });
});

describe('createDispatcherJobRegistry — the registry the live JobDispatcher DO runs', () => {
  const db = openDispatcherDbFromEnv(env);
  afterAll(async () => {
    await db.$client.end();
  });

  it('registers and resolves payment.verify.v1 (not the empty lib-composed default)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(PAYMENT_VERIFY_JOB_TYPE);
    const registered = registry.get(PAYMENT_VERIFY_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(registered?.schema.safeParse({ paymentId: crypto.randomUUID() }).success).toBe(true);
  });

  it('resolves the row to its handler — dead-by-handler, never "unregistered job type"', async () => {
    // The registry built exactly as the DO composition builds it (job-dispatcher.ts).
    // Before the relocation the DO ran an empty registry, so this type resolved
    // to nothing and the executor dead-lettered it as "unregistered job type".
    // Through the adapter-composed registry it resolves to the payment-verify
    // handler, which dead-letters on the absent pre-claim row with ITS reason —
    // proving live resolution, not the unknown-type path. Invoking the handler
    // directly (rather than a shard-wide pass) keeps this test off the shared
    // jobs table, so it cannot race the other bulk-shard jobs tests.
    const registered = createDispatcherJobRegistry(env, db).get(PAYMENT_VERIFY_JOB_TYPE);
    if (registered === undefined) throw new Error('payment.verify.v1 did not resolve');
    const outcome = await registered.handler(executionFor(crypto.randomUUID()));
    expect(outcome).toEqual({ kind: 'dead', error: 'payment pre-claim row does not exist' });
  });
});
