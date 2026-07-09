import { createEnvUtilities } from '@hushbox/shared';
import { createAppJobRegistry, openDispatcherDb } from '../lib/jobs/index.js';
import {
  createBillingStores,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
} from '../slices/billing/index.js';
import type { Database } from '@hushbox/db';
import type { JobRegistry } from '../lib/jobs/index.js';
import type { Bindings } from '../lib/context/app-env.js';

/**
 * Composition-root wiring for the JobDispatcher DO's job registry. It composes
 * the dispatcher's registrations from the owning slices' published barrels —
 * work `lib/jobs` may not do, since `lib` may not import a slice. The running
 * dispatcher's registry comes from here (via the composition-only
 * `job-dispatcher.ts`), so a `payment.verify.v1` row enqueued by billing's
 * pre-claim resolves to its handler instead of dead-lettering as an
 * unregistered type in the live dispatcher.
 */

/**
 * Opens the dispatcher's Database handle from the DO's per-invocation env. The
 * payment-verify handler's settlement writes run on this connection; the Neon
 * pool connects lazily, so an idle dispatcher still holds no socket, and it
 * lives for the DO instance (the pass executor opens its own per-pass
 * connection for claim/complete and closes it at pass end). Fails fast on a
 * missing DATABASE_URL rather than degrading.
 */
export function openDispatcherDbFromEnv(env: Bindings): Database {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'JobDispatcher registry: missing required binding DATABASE_URL — ' +
        'the dispatcher fails fast instead of degrading.'
    );
  }
  return openDispatcherDb(databaseUrl, createEnvUtilities(env));
}

/**
 * The registry the live JobDispatcher DO runs. The db is passed in (rather than
 * opened here) so the DO composition owns its lifetime and tests can supply a
 * closable handle.
 *
 * Only `payment.verify.v1` is registered today. `media.reclaimUser.v1` is
 * deliberately NOT registered yet — its R2-reclaim handler adapters do not
 * exist. It MUST be added here before account deletion enqueues it, or that job
 * will dead-letter as an unregistered type in the running dispatcher.
 */
export function createDispatcherJobRegistry(env: Bindings, db: Database): JobRegistry {
  return createAppJobRegistry([
    createPaymentVerifyJobRegistration({
      db,
      stores: createBillingStores(),
      provider: createPaymentProviderFromEnv(env),
    }),
  ]);
}
