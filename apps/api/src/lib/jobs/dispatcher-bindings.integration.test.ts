import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import {
  createAppJobRegistry,
  createDispatcherTelemetry,
  createJobDispatcherBindings,
  openDispatcherDb,
} from './dispatcher-bindings.js';
import { enqueueWithinTx } from './enqueue.js';
import {
  PAYMENT_VERIFY_JOB_TYPE,
  createBillingStores,
  createPaymentVerifyJobRegistration,
} from '../../slices/billing/index.js';
import type { PaymentProvider } from '../../slices/billing/index.js';
import type { Telemetry } from '../telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

// A provider stub whose methods never run in these tests: the payment-verify
// handler dead-letters on the absent pre-claim row before it reaches the
// provider. Present only to satisfy the registration's dependency set.
const idleProvider: PaymentProvider = {
  isMock: true,
  charge: () => {
    throw new Error('provider.charge unexpectedly invoked');
  },
  getChargeStatus: () => {
    throw new Error('provider.getChargeStatus unexpectedly invoked');
  },
  findCaptureByReference: () => {
    throw new Error('provider.findCaptureByReference unexpectedly invoked');
  },
};

/** The registrations the app hands to `createAppJobRegistry` (billing's, today). */
function appRegistrations(db: ReturnType<typeof createDb>) {
  return [
    createPaymentVerifyJobRegistration({
      db,
      stores: createBillingStores(),
      provider: idleProvider,
    }),
  ];
}

interface Recorded {
  readonly port: Telemetry;
  readonly errors: string[];
  readonly captured: { message: string; errorCode: string }[];
}

function recordingTelemetry(): Recorded {
  const errors: string[] = [];
  const captured: { message: string; errorCode: string }[] = [];
  return {
    port: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg) => {
        errors.push(msg);
      },
      emitMetric: () => {},
      captureError: (error, errorCode) => {
        captured.push({ message: error.message, errorCode });
      },
    },
    errors,
    captured,
  };
}

describe('createDispatcherTelemetry', () => {
  it('maps a failed pass onto the typed port with an error capture', () => {
    const recorded = recordingTelemetry();
    createDispatcherTelemetry(recorded.port).passFailed({ shard: 'bulk' });
    expect(recorded.errors).toEqual(['job dispatcher pass failed']);
    expect(recorded.captured).toEqual([
      { message: 'job dispatcher pass failed on shard bulk', errorCode: 'job_pass_failed' },
    ]);
  });
});

describe('createAppJobRegistry', () => {
  it('registers nothing when given no registrations (the lib-resident default)', () => {
    expect(createAppJobRegistry().types()).toEqual([]);
  });

  it('registers and resolves the payment-verify job from the handed registration', () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    try {
      const registry = createAppJobRegistry(appRegistrations(db));
      expect(registry.types()).toContain(PAYMENT_VERIFY_JOB_TYPE);
      const registered = registry.get(PAYMENT_VERIFY_JOB_TYPE);
      expect(registered).toBeDefined();
      // The executor dead-letters an unknown type OR an unparseable payload;
      // a resolvable registration whose schema accepts the payload passes both
      // gates — the job executes rather than dead-lettering.
      expect(registered?.schema.safeParse({ paymentId: crypto.randomUUID() }).success).toBe(true);
      expect(registered?.schema.safeParse({}).success).toBe(false);
    } finally {
      // Never queried (registration only), but close the client so the test
      // leaves no socket open.
      void db.$client.end();
    }
  });
});

describe('openDispatcherDb', () => {
  it('builds a local-proxy client in dev and a direct client otherwise', async () => {
    const dev = openDispatcherDb(DATABASE_URL, { isDev: true });
    const production = openDispatcherDb(DATABASE_URL, { isDev: false });
    expect(dev).toBeDefined();
    expect(production).toBeDefined();
    await dev.$client.end();
    await production.$client.end();
  });
});

describe('createJobDispatcherBindings', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() =>
      createJobDispatcherBindings({ NODE_ENV: 'development' }, createAppJobRegistry())
    ).toThrow('DATABASE_URL');
  });

  it('binds an executor that runs a real pass per invocation', async () => {
    const bindings = createJobDispatcherBindings(
      { NODE_ENV: 'development', DATABASE_URL },
      createAppJobRegistry()
    );
    // No committed claimable rows exist outside the pass-test file, so an
    // empty registry's pass reports an idle shard.
    await expect(bindings.executor.runPass('bulk')).resolves.toEqual({ kind: 'idle' });
    expect(typeof bindings.now()).toBe('number');
  });
});

describe('createAppJobRegistry: payment-verify executes through a real pass', () => {
  const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  const enqueuedJobIds: string[] = [];

  afterAll(async () => {
    for (const id of enqueuedJobIds) {
      await db.delete(jobs).where(eq(jobs.id, id));
    }
    await db.$client.end();
  });

  it('claims and runs the job via its handler — never the unregistered-type dead-letter', async () => {
    const registry = createAppJobRegistry(appRegistrations(db));
    const bindings = createJobDispatcherBindings(
      { NODE_ENV: 'development', DATABASE_URL },
      registry
    );
    // The bulk shard is the only claimable shard a non-`pass` jobs test may
    // commit to (the shared-table rule). No pre-claim row exists, so the
    // handler dead-letters with ITS reason — proving it resolved and executed
    // rather than the executor's unknown-type dead-letter.
    const paymentId = crypto.randomUUID();
    const enqueue = await db.transaction((tx) =>
      enqueueWithinTx(tx, registry, {
        type: PAYMENT_VERIFY_JOB_TYPE,
        payload: { paymentId },
        shard: 'bulk',
        dedupeKey: `test:payment.verify:${paymentId}`,
      })
    );
    if (!enqueue.enqueued) throw new Error('payment-verify enqueue was deduped unexpectedly');
    enqueuedJobIds.push(enqueue.jobId);

    await bindings.executor.runPass('bulk');

    const rows = await db.select().from(jobs).where(eq(jobs.id, enqueue.jobId));
    const row = rows[0];
    expect(row?.status).toBe('dead');
    const errorText = JSON.stringify(row?.errors ?? []);
    expect(errorText).toContain('payment pre-claim row does not exist');
    expect(errorText).not.toContain('unregistered job type');
  });
});
