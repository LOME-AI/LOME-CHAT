import { DurableObject } from 'cloudflare:workers';

import { createDb, LOCAL_NEON_DEV_CONFIG } from '../client';
import { runLockValidation, type LockValidationResult } from './txn-executor';

interface ValidationEnv {
  DATABASE_URL: string;
}

/**
 * Thin-shell test DO (the arch pattern: a DO class contains only platform
 * glue). All transaction logic lives in the plain executor, which the
 * node-environment project covers; this class exists solely to prove the
 * executor runs inside a Durable Object under workerd.
 */
export class DbTxnRunnerDO extends DurableObject<ValidationEnv> {
  async runValidation(tableName: string): Promise<LockValidationResult> {
    const claimantA = createDb(this.env.DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const claimantB = createDb(this.env.DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    try {
      return await runLockValidation(claimantA, claimantB, tableName);
    } finally {
      await claimantA.$client.end();
      await claimantB.$client.end();
    }
  }
}

export default {
  fetch(): Response {
    return new Response('db workers-validation test worker');
  },
};
