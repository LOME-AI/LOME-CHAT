import { describe, expect, it } from 'vitest';
import { disableModelWithinTx, enableModelWithinTx } from './catalog-admin.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';

/**
 * Infra-failure paths against a stubbed handle (the happy paths and the
 * conditional-update semantics run against real Postgres in
 * `../domain/admin-disabled.integration.test.ts`).
 */

interface StubBehavior {
  readonly updateRows: readonly unknown[] | Error;
  readonly selectRows: readonly unknown[] | Error;
}

function stubDb(behavior: StubBehavior): DbWriter {
  const resolve = (outcome: readonly unknown[] | Error): Promise<readonly unknown[]> =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  return {
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => resolve(behavior.updateRows) }),
      }),
    }),
    select: () => ({
      from: () => ({ where: () => resolve(behavior.selectRows) }),
    }),
  } as unknown as DbWriter;
}

describe('disableModelWithinTx infra failures', () => {
  it('maps a failing conditional UPDATE to unavailable', async () => {
    const db = stubDb({ updateRows: new Error('connection lost'), selectRows: [] });
    const result = await disableModelWithinTx(db, 'a/model', new Date());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a failing zero-row state re-read to unavailable', async () => {
    const db = stubDb({ updateRows: [], selectRows: new Error('connection lost') });
    const result = await disableModelWithinTx(db, 'a/model', new Date());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('enableModelWithinTx infra failures', () => {
  it('maps a failing conditional UPDATE to unavailable', async () => {
    const db = stubDb({ updateRows: new Error('connection lost'), selectRows: [] });
    const result = await enableModelWithinTx(db, 'a/model');
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
