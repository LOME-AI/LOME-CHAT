import { describe, it, expect } from 'vitest';

import { ADMIN_OP_CONTRACTS, ADMIN_OP_NAMES, MAX_ADMIN_REASON_LENGTH } from './ops';

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
  'feedback.setStatus': ['feedback.setStatus', 'durable'],
  'banner.set': ['banner.set', 'durable'],
  'newsletter.schedule': ['newsletter.cancel', 'durable'],
  'newsletter.cancel': ['newsletter.schedule', 'durable'],
  'newsletter.testSend': [null, 'ephemeral'],
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

  it('every op accepts a reason exactly at the length cap', () => {
    for (const name of ADMIN_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      const valid = VALID_INPUTS[name];
      expect(
        contract.input.safeParse({ ...valid, reason: 'a'.repeat(MAX_ADMIN_REASON_LENGTH) }).success,
        `${name} reason at cap`
      ).toBe(true);
    }
  });

  it('every op rejects a reason over the length cap', () => {
    for (const name of ADMIN_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      const valid = VALID_INPUTS[name];
      expect(
        contract.input.safeParse({ ...valid, reason: 'a'.repeat(MAX_ADMIN_REASON_LENGTH + 1) })
          .success,
        `${name} reason over cap`
      ).toBe(false);
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
  'feedback.setStatus': { feedbackId: VALID_UUID, status: 'triaged', reason: REASON },
  'banner.set': {
    enabled: true,
    messages: [{ variant: 'info', text: 'Scheduled maintenance tonight' }],
    reason: REASON,
  },
  'newsletter.schedule': {
    subject: 'July product update',
    bodyMarkdown: '# Hello',
    scheduledAt: '2026-08-01T12:00:00Z',
    reason: REASON,
  },
  'newsletter.cancel': { issueId: VALID_UUID, reason: REASON },
  'newsletter.testSend': { subject: 'Draft check', bodyMarkdown: '# Hello', reason: REASON },
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

  it('feedback.setStatus rejects an unknown status', () => {
    const result = ADMIN_OP_CONTRACTS['feedback.setStatus'].input.safeParse({
      feedbackId: VALID_UUID,
      status: 'archived',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });
});

describe('banner.set input', () => {
  const bannerInput = (message: Record<string, unknown>): Record<string, unknown> => ({
    enabled: true,
    messages: [message],
    reason: REASON,
  });
  const parse = (input: Record<string, unknown>): boolean =>
    ADMIN_OP_CONTRACTS['banner.set'].input.safeParse(input).success;

  it('accepts a message with a safe absolute https href', () => {
    expect(
      parse(bannerInput({ variant: 'warning', text: 'Read this', href: 'https://hushbox.ai/blog' }))
    ).toBe(true);
  });

  it('accepts zero messages — the disabled state and undo-of-first-set', () => {
    expect(parse({ enabled: false, messages: [], reason: REASON })).toBe(true);
  });

  it('rejects an unknown variant instead of salvaging it', () => {
    expect(parse(bannerInput({ variant: 'danger', text: 'x' }))).toBe(false);
  });

  it('rejects empty and whitespace-only text', () => {
    expect(parse(bannerInput({ variant: 'info', text: '' }))).toBe(false);
    expect(parse(bannerInput({ variant: 'info', text: ' \t ' }))).toBe(false);
  });

  it('rejects text over 280 characters', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'a'.repeat(281) }))).toBe(false);
    expect(parse(bannerInput({ variant: 'info', text: 'a'.repeat(280) }))).toBe(true);
  });

  it('rejects unsafe hrefs', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example',
      '/relative/path',
      'not a url',
    ]) {
      expect(parse(bannerInput({ variant: 'info', text: 'x', href })), href).toBe(false);
    }
  });

  it('rejects more than 20 messages', () => {
    const messages = Array.from({ length: 21 }, () => ({ variant: 'info', text: 'x' }));
    expect(parse({ enabled: true, messages, reason: REASON })).toBe(false);
  });

  it('accepts exactly 20 messages — the cap boundary', () => {
    const messages = Array.from({ length: 20 }, () => ({ variant: 'info', text: 'x' }));
    expect(parse({ enabled: true, messages, reason: REASON })).toBe(true);
  });

  it('rejects an href over 2048 characters', () => {
    const hrefOfLength = (length: number): string => {
      const base = 'https://hushbox.ai/';
      return base + 'a'.repeat(length - base.length);
    };
    expect(parse(bannerInput({ variant: 'info', text: 'x', href: hrefOfLength(2048) }))).toBe(true);
    expect(parse(bannerInput({ variant: 'info', text: 'x', href: hrefOfLength(2049) }))).toBe(
      false
    );
  });

  it('accepts a message with a valid linkText', () => {
    expect(
      parse(
        bannerInput({
          variant: 'info',
          text: 'x',
          href: 'https://hushbox.ai/blog',
          linkText: 'Read the post',
        })
      )
    ).toBe(true);
  });

  it('accepts a message without linkText', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'x' }))).toBe(true);
  });

  it('rejects whitespace-only linkText instead of silently dropping it', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'x', linkText: ' \t ' }))).toBe(false);
  });

  it('rejects linkText over 60 characters', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'x', linkText: 'a'.repeat(61) }))).toBe(
      false
    );
    expect(parse(bannerInput({ variant: 'info', text: 'x', linkText: 'a'.repeat(60) }))).toBe(true);
  });

  it('rejects a missing messages field', () => {
    expect(parse({ enabled: true, reason: REASON })).toBe(false);
  });
});

describe('newsletter op inputs', () => {
  it('newsletter.schedule rejects a non-ISO scheduledAt', () => {
    const result = ADMIN_OP_CONTRACTS['newsletter.schedule'].input.safeParse({
      subject: 'x',
      bodyMarkdown: 'y',
      scheduledAt: 'tomorrow',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('newsletter.schedule rejects an empty subject and empty bodyMarkdown', () => {
    for (const patch of [{ subject: '' }, { bodyMarkdown: '' }]) {
      const result = ADMIN_OP_CONTRACTS['newsletter.schedule'].input.safeParse({
        subject: 'x',
        bodyMarkdown: 'y',
        scheduledAt: '2026-08-01T12:00:00Z',
        reason: REASON,
        ...patch,
      });
      expect(result.success).toBe(false);
    }
  });

  it('newsletter.cancel rejects a non-uuid issueId', () => {
    const result = ADMIN_OP_CONTRACTS['newsletter.cancel'].input.safeParse({
      issueId: 'not-a-uuid',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });
});
