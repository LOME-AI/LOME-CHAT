import { describe, it, expect } from 'vitest';

import { ADMIN_OP_CONTRACTS, ADMIN_OP_NAMES } from './ops';

const VALID_UUID = '018f6f6e-7c1a-7000-8000-000000000001';
const REASON = 'support ticket #123';

/** The v1 admin op inventory: name → [inverse, effectClass]. */
const EXPECTED_INVENTORY: Record<string, [string | null, 'durable' | 'ephemeral']> = {
  'wallet.credit': ['wallet.clawback', 'durable'],
  'wallet.clawback': ['wallet.credit', 'durable'],
  'user.lock': ['user.unlock', 'durable'],
  'user.unlock': ['user.lock', 'durable'],
  'sessions.revokeAll': [null, 'ephemeral'],
  'job.redrive': [null, 'ephemeral'],
  'job.discard': ['job.restore', 'durable'],
  'job.restore': ['job.discard', 'durable'],
  'model.disable': ['model.enable', 'durable'],
  'model.enable': ['model.disable', 'durable'],
  'share.revoke': ['share.unrevoke', 'durable'],
  'share.unrevoke': ['share.revoke', 'durable'],
};

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('ADMIN_OP_CONTRACTS inventory', () => {
  it('contains exactly the v1 admin ops, plus nothing', () => {
    expect([...ADMIN_OP_NAMES].toSorted(byName)).toEqual(
      Object.keys(EXPECTED_INVENTORY).toSorted(byName)
    );
  });

  it.each(Object.entries(EXPECTED_INVENTORY))(
    '%s has the registered inverse and effect class',
    (name, [inverse, effectClass]) => {
      const contract = ADMIN_OP_CONTRACTS[name as keyof typeof ADMIN_OP_CONTRACTS];
      expect(contract.name).toBe(name);
      expect(contract.inverse).toBe(inverse);
      expect(contract.effectClass).toBe(effectClass);
      expect(contract.kind).toBe('mutation');
    }
  );

  it('every declared inverse is itself a registered op pointing back', () => {
    for (const name of ADMIN_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      if (contract.inverse !== null) {
        const inverse = ADMIN_OP_CONTRACTS[contract.inverse as keyof typeof ADMIN_OP_CONTRACTS];
        expect(inverse, `${name} inverse ${contract.inverse} missing`).toBeDefined();
        expect(inverse.inverse).toBe(name);
      }
    }
  });

  it('every op rejects an input missing reason', () => {
    for (const name of ADMIN_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      const valid = VALID_INPUTS[name];
      const withoutReason = Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== 'reason')
      );
      expect(contract.input.safeParse(withoutReason).success, `${name} without reason`).toBe(false);
      expect(
        contract.input.safeParse({ ...valid, reason: '' }).success,
        `${name} empty reason`
      ).toBe(false);
      expect(
        contract.input.safeParse({ ...valid, reason: ' \t\n ' }).success,
        `${name} whitespace-only reason`
      ).toBe(false);
      expect(contract.input.safeParse(valid).success, `${name} valid input`).toBe(true);
    }
  });
});

const walletInput = { walletId: VALID_UUID, amountNanoUsd: '5000000000', reason: REASON };
const userInput = { userId: VALID_UUID, reason: REASON };
const jobInput = { jobId: VALID_UUID, reason: REASON };
const modelInput = { modelId: 'openai/gpt-5', reason: REASON };
const shareInput = { linkId: VALID_UUID, reason: REASON };

const VALID_INPUTS: Record<(typeof ADMIN_OP_NAMES)[number], Record<string, unknown>> = {
  'wallet.credit': walletInput,
  'wallet.clawback': walletInput,
  'user.lock': { ...userInput, lockReason: 'admin' },
  'user.unlock': userInput,
  'sessions.revokeAll': userInput,
  'job.redrive': jobInput,
  'job.discard': jobInput,
  'job.restore': jobInput,
  'model.disable': modelInput,
  'model.enable': modelInput,
  'share.revoke': shareInput,
  'share.unrevoke': shareInput,
};

describe('wallet op inputs', () => {
  it('parse amountNanoUsd from the NanoUSD wire string into a bigint', () => {
    const parsed = ADMIN_OP_CONTRACTS['wallet.credit'].input.parse({
      walletId: VALID_UUID,
      amountNanoUsd: '5000000000',
      reason: REASON,
    });
    expect(parsed.amountNanoUsd).toBe(5_000_000_000n);
  });

  it('reject a zero or negative amount', () => {
    for (const amount of ['0', '-1']) {
      const result = ADMIN_OP_CONTRACTS['wallet.clawback'].input.safeParse({
        walletId: VALID_UUID,
        amountNanoUsd: amount,
        reason: REASON,
      });
      expect(result.success).toBe(false);
    }
  });

  it('reject a non-canonical amount string', () => {
    const result = ADMIN_OP_CONTRACTS['wallet.credit'].input.safeParse({
      walletId: VALID_UUID,
      amountNanoUsd: '1e9',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('carry the wallet-adjustment cap guardrail', () => {
    for (const name of ['wallet.credit', 'wallet.clawback'] as const) {
      const guardrails = ADMIN_OP_CONTRACTS[name].guardrails;
      expect(guardrails?.maxAmountNanoUsd).toBeTypeOf('bigint');
      expect(guardrails?.maxAmountNanoUsd).toBeGreaterThan(0n);
    }
  });
});

describe('targeted op inputs', () => {
  it('user.lock rejects an unknown lockReason', () => {
    const result = ADMIN_OP_CONTRACTS['user.lock'].input.safeParse({
      userId: VALID_UUID,
      lockReason: 'because',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('uuid-targeted ops reject a non-uuid target', () => {
    const result = ADMIN_OP_CONTRACTS['job.redrive'].input.safeParse({
      jobId: 'not-a-uuid',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('model ops reject an empty modelId', () => {
    const result = ADMIN_OP_CONTRACTS['model.disable'].input.safeParse({
      modelId: '',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });
});
