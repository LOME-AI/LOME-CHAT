import { describe, expect, it } from 'vitest';

import {
  ALICE_PAYMENT_SPECS,
  ALICE_USAGE_SPECS,
  SCREENSHOT_CONVERSATIONS,
  USAGE_MODELS,
} from './seed-fixtures.js';

describe('SCREENSHOT_CONVERSATIONS', () => {
  it('has the five curated conversations keyed by seed name', () => {
    expect(SCREENSHOT_CONVERSATIONS.map((c) => c.seedKey)).toEqual([
      'screenshot-conv-chat',
      'screenshot-conv-code',
      'screenshot-conv-mermaid',
      'screenshot-conv-privacy',
      'screenshot-conv-group-chat',
    ]);
  });

  it('owns every conversation with alice', () => {
    for (const conv of SCREENSHOT_CONVERSATIONS) {
      expect(conv.ownerPersona).toBe('alice');
    }
  });

  it('makes each solo conversation a user prompt + an ai reply', () => {
    const solo = SCREENSHOT_CONVERSATIONS.filter((c) => c.members === undefined);
    expect(solo).toHaveLength(4);
    for (const conv of solo) {
      expect(conv.messages.map((m) => m.sender)).toEqual(['alice', 'ai']);
    }
  });

  it('models the group chat as a three-persona thread with an ai reply', () => {
    const group = SCREENSHOT_CONVERSATIONS.find((c) => c.seedKey === 'screenshot-conv-group-chat');
    expect(group?.members).toEqual(['alice', 'bob', 'charlie']);
    expect(group?.messages.map((m) => m.sender)).toEqual(['alice', 'bob', 'charlie', 'ai']);
  });
});

describe('ALICE_PAYMENT_SPECS', () => {
  it('has 14 completed payments in nano-USD', () => {
    expect(ALICE_PAYMENT_SPECS).toHaveLength(14);
    for (const spec of ALICE_PAYMENT_SPECS) {
      expect(typeof spec.amountNanoUsd).toBe('bigint');
      expect(spec.amountNanoUsd).toBeGreaterThan(0n);
    }
  });

  it('backdates payments from 14 days ago to 1 day ago', () => {
    expect(ALICE_PAYMENT_SPECS[0]?.daysAgo).toBe(14);
    expect(ALICE_PAYMENT_SPECS.at(-1)?.daysAgo).toBe(1);
  });

  it('gives the final payment the legacy top-up amount ($12)', () => {
    expect(ALICE_PAYMENT_SPECS.at(-1)?.amountNanoUsd).toBe(12_000_000_000n);
  });

  it('alternates card brands and derives the last four', () => {
    expect(ALICE_PAYMENT_SPECS[0]?.cardType).toBe('Visa');
    expect(ALICE_PAYMENT_SPECS[1]?.cardType).toBe('Mastercard');
    expect(ALICE_PAYMENT_SPECS[0]?.cardLastFour).toBe('4000');
  });
});

describe('USAGE_MODELS', () => {
  it('carries the weighted model mix summing to 100', () => {
    expect(USAGE_MODELS).toHaveLength(5);
    expect(USAGE_MODELS.reduce((sum, m) => sum + m.weight, 0)).toBe(100);
  });

  it('expresses per-1k-token rates in nano-USD', () => {
    const opus = USAGE_MODELS.find((m) => m.model === 'anthropic/claude-opus-4.6');
    expect(opus?.costPer1kInputNanoUsd).toBe(15_000_000n);
    expect(opus?.costPer1kOutputNanoUsd).toBe(75_000_000n);
  });
});

describe('ALICE_USAGE_SPECS', () => {
  it('has 200 records spread over 90 days', () => {
    expect(ALICE_USAGE_SPECS).toHaveLength(200);
    for (const spec of ALICE_USAGE_SPECS) {
      expect(spec.daysAgo).toBeGreaterThanOrEqual(0);
      expect(spec.daysAgo).toBeLessThanOrEqual(90);
    }
  });

  it('charges each record a positive nano-USD cost from a known model', () => {
    const modelNames = new Set(USAGE_MODELS.map((m) => m.model));
    for (const spec of ALICE_USAGE_SPECS) {
      expect(spec.costNanoUsd).toBeGreaterThan(0n);
      expect(modelNames.has(spec.model)).toBe(true);
    }
  });

  it('carries the legacy token and clock offsets on the first record', () => {
    const first = ALICE_USAGE_SPECS[0];
    expect(first?.index).toBe(0);
    expect(first?.daysAgo).toBe(90);
    expect(first?.hour).toBe(0);
    expect(first?.minute).toBe(0);
    expect(first?.inputTokens).toBe(200);
    expect(first?.outputTokens).toBe(100);
    expect(first?.cachedTokens).toBe(50);
  });
});
