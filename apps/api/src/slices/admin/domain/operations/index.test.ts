import { describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS, ADMIN_OP_NAMES } from '@hushbox/shared';
import { createAdminOpRegistry } from '../registry.js';
import { adminOperations } from './index.js';
import type { AdminOperationsDeps } from './index.js';

/**
 * The registry exhaustiveness gate (Charter #6/#8): every shared contract
 * has exactly one registered implementation, the full set passes the Iron
 * Law gate, and every mutation input carries the required `reason`.
 */
describe('admin operations exhaustiveness', () => {
  it('implements every shared contract exactly once, and nothing else', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const implemented = adminOperations
      .map((operation) => operation.contract.name)
      .toSorted(byName);

    expect(implemented).toEqual([...ADMIN_OP_NAMES].toSorted(byName));
  });

  it('binds each implementation to its own shared contract object', () => {
    for (const operation of adminOperations) {
      expect(operation.contract).toBe(
        ADMIN_OP_CONTRACTS[operation.contract.name as keyof typeof ADMIN_OP_CONTRACTS]
      );
    }
  });

  it('passes the Iron Law gate as the full production set', () => {
    const registry = createAdminOpRegistry<AdminOperationsDeps>([...adminOperations]);

    expect(registry.list()).toHaveLength(ADMIN_OP_NAMES.length);
  });

  it('requires a reason on every mutation input schema', () => {
    for (const operation of adminOperations) {
      const withoutReason = { ...validShapeFor(operation.contract.name) };
      delete withoutReason['reason'];
      expect(operation.contract.input.safeParse(withoutReason).success).toBe(false);
    }
  });
});

function validShapeFor(name: string): Record<string, unknown> {
  const id = crypto.randomUUID();
  const shapes: Record<string, Record<string, unknown>> = {
    'wallet.credit': { walletId: id, amountNanoUsd: '1000', reason: 'r' },
    'wallet.clawback': { walletId: id, amountNanoUsd: '1000', reason: 'r' },
    'user.lock': { userId: id, lockReason: 'admin', reason: 'r' },
    'user.unlock': { userId: id, reason: 'r' },
    'sessions.revokeAll': { userId: id, reason: 'r' },
    'job.redrive': { jobId: id, reason: 'r' },
    'job.discard': { jobId: id, reason: 'r' },
    'job.restore': { jobId: id, reason: 'r' },
    'model.disable': { modelId: 'provider/model', reason: 'r' },
    'model.enable': { modelId: 'provider/model', reason: 'r' },
    'share.revoke': { linkId: id, reason: 'r' },
    'share.unrevoke': { linkId: id, reason: 'r' },
  };
  const shape = shapes[name];
  if (shape === undefined) {
    throw new Error(`exhaustiveness test has no valid input shape for ${name} — add one`);
  }
  return shape;
}
