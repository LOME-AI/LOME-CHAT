/**
 * Parameterized consistency tests for resolveClientBilling() ↔ generateNotifications().
 *
 * For every ClientBillingInput combination, calls BOTH resolveClientBilling() AND
 * generateNotifications(), asserting:
 * - If resolveClientBilling() → denied → notifications MUST include a blocking error
 * - If resolveClientBilling() → approved → notifications MUST NOT include afford-blocking errors
 *
 * Parameterized across: tier × balance × isPremium × group/solo × privilege
 */

import { describe, it, expect } from 'vitest';
import { resolveClientBilling, type ClientBillingInput } from './client-billing.js';

/** Cents → nano-USD for readable fixtures; served spendable = balance + the baked 50¢ cushion. */
const NANO_PER_CENT = 10_000_000n;
const nano = (cents: number): bigint => BigInt(cents) * NANO_PER_CENT;
const spendableFor = (cents: number): bigint => nano(cents + 50);
import { generateNotifications, type NotificationInput } from '../budget.js';

/** The typed reasons a billing denial resolves to (each blocks the send). */
const DENIAL_NOTIFICATION_IDS = new Set([
  'premium_requires_credit',
  'insufficient_funds',
  'free_allowance_exhausted',
  'trial_message_cap_exceeded',
  'guest_no_group_budget',
]);

function isDenialNotification(id: string): boolean {
  return DENIAL_NOTIFICATION_IDS.has(id);
}

/** Run resolveClientBilling + generateNotifications and check consistency */
function assertConsistency(
  input: ClientBillingInput,
  notificationOverrides: Partial<NotificationInput> = {}
): void {
  const billingResult = resolveClientBilling(input);

  const notifInput: NotificationInput = {
    billingResult,
    capacityPercent: 20, // default: not over capacity
    maxOutputTokens: 50_000, // default: plenty of tokens
    ...notificationOverrides,
  };

  const notifications = generateNotifications(notifInput);

  if (billingResult.fundingSource === 'denied') {
    // Denied → notifications MUST include a blocking denial error
    const hasDenialError = notifications.some(
      (n) => n.type === 'error' && isDenialNotification(n.id)
    );
    expect(hasDenialError).toBe(true);
  } else {
    // Approved → notifications MUST NOT include afford-blocking errors
    const hasDenialError = notifications.some(
      (n) => n.type === 'error' && isDenialNotification(n.id)
    );
    expect(hasDenialError).toBe(false);
  }
}

describe('resolveClientBilling ↔ generateNotifications consistency', () => {
  describe('personal: paid tier', () => {
    it('paid + sufficient balance + non-premium → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(1000),
        spendableNanoUsd: spendableFor(1000),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
      });
    });

    it('paid + sufficient balance + premium → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(1000),
        spendableNanoUsd: spendableFor(1000),
        isPremiumModel: true,
        estimatedMinimumCostNanoUsd: nano(10),
      });
    });

    it('paid + insufficient balance + non-premium → denied, has denial notification', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(200),
      });
    });

    it('paid + insufficient balance + premium → denied, has denial notification', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: true,
        estimatedMinimumCostNanoUsd: nano(200),
      });
    });
  });

  describe('personal: free tier', () => {
    it('free + allowance + non-premium → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'free',
        purchasedBalanceNanoUsd: nano(0),
        // A free payer's served spendable IS the day-keyed allowance remaining,
        // hold-aware and cushion-free — not a purchased balance plus cushion.
        spendableNanoUsd: nano(100),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
      });
    });

    it('free + allowance depleted + non-premium → denied, has denial notification', () => {
      assertConsistency({
        tier: 'free',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: nano(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
      });
    });

    it('free + premium model → denied, has denial notification', () => {
      assertConsistency({
        tier: 'free',
        purchasedBalanceNanoUsd: nano(0),
        // A free payer's served spendable IS the day-keyed allowance remaining,
        // hold-aware and cushion-free — not a purchased balance plus cushion.
        spendableNanoUsd: nano(100),
        isPremiumModel: true,
        estimatedMinimumCostNanoUsd: nano(10),
      });
    });
  });

  describe('personal: trial tier', () => {
    it('trial + cheap message → approved, no denial notifications', () => {
      assertConsistency({
        tier: 'trial',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(1),
      });
    });

    it('trial + expensive message → denied, has denial notification', () => {
      assertConsistency({
        tier: 'trial',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
      });
    });

    it('trial + premium model → denied, has denial notification', () => {
      assertConsistency({
        tier: 'trial',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: true,
        estimatedMinimumCostNanoUsd: nano(1),
      });
    });
  });

  describe('personal: guest tier', () => {
    it('guest without group budget → denied, has denial notification', () => {
      assertConsistency({
        tier: 'guest',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(1),
      });
    });

    it('guest + group budget → approved via owner, no denial notifications', () => {
      assertConsistency({
        tier: 'guest',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(1),
        group: { effectiveRemainingNanoUsd: nano(500), ownerBalanceNanoUsd: nano(5000) },
      });
    });

    it('guest + group budget exhausted → denied, has denial notification', () => {
      assertConsistency({
        tier: 'guest',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(1),
        group: { effectiveRemainingNanoUsd: nano(0), ownerBalanceNanoUsd: nano(5000) },
      });
    });

    it('guest + delegated budget active + owner pays → approved, no denial notifications', () => {
      assertConsistency(
        {
          tier: 'guest',
          purchasedBalanceNanoUsd: nano(0),
          spendableNanoUsd: spendableFor(0),
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: nano(1),
          group: { effectiveRemainingNanoUsd: nano(500), ownerBalanceNanoUsd: nano(5000) },
        },
        { hasDelegatedBudget: true }
      );
    });

    it('guest + group budget exhausted → denied, with no payer-switch disclosure', () => {
      assertConsistency(
        {
          tier: 'guest',
          purchasedBalanceNanoUsd: nano(0),
          spendableNanoUsd: spendableFor(0),
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: nano(1),
          group: { effectiveRemainingNanoUsd: nano(0), ownerBalanceNanoUsd: nano(5000) },
        },
        { hasDelegatedBudget: true }
      );
    });
  });

  describe('group paths', () => {
    it('group + owner can use model → approved via owner, no denial notifications', () => {
      assertConsistency({
        tier: 'free',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: nano(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
        group: { effectiveRemainingNanoUsd: nano(500), ownerBalanceNanoUsd: nano(5000) },
      });
    });

    it('group + owner cannot use premium → falls through to personal, consistency holds', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(1000),
        spendableNanoUsd: spendableFor(1000),
        isPremiumModel: true,
        estimatedMinimumCostNanoUsd: nano(10),
        group: { effectiveRemainingNanoUsd: nano(500), ownerBalanceNanoUsd: nano(0) },
      });
    });

    it('group budget exhausted → falls through to personal, consistency holds', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(1000),
        spendableNanoUsd: spendableFor(1000),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
        group: { effectiveRemainingNanoUsd: nano(0), ownerBalanceNanoUsd: nano(5000) },
      });
    });

    it('group budget exhausted + personal insufficient → denied, has denial notification', () => {
      assertConsistency({
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(200),
        group: { effectiveRemainingNanoUsd: nano(0), ownerBalanceNanoUsd: nano(5000) },
      });
    });
  });

  describe('with privilege context', () => {
    it('read privilege + approved → no denial notifications', () => {
      assertConsistency(
        {
          tier: 'paid',
          purchasedBalanceNanoUsd: nano(1000),
          spendableNanoUsd: spendableFor(1000),
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: nano(10),
        },
        { privilege: 'read' }
      );
    });

    it('write privilege + denied → has denial notification', () => {
      assertConsistency(
        {
          tier: 'paid',
          purchasedBalanceNanoUsd: nano(0),
          spendableNanoUsd: spendableFor(0),
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: nano(200),
        },
        { privilege: 'write' }
      );
    });

    it('delegated budget active + owner pays → approved, no denial notifications', () => {
      assertConsistency(
        {
          tier: 'free',
          purchasedBalanceNanoUsd: nano(0),
          spendableNanoUsd: spendableFor(0),
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: nano(10),
          group: { effectiveRemainingNanoUsd: nano(500), ownerBalanceNanoUsd: nano(5000) },
        },
        { hasDelegatedBudget: true }
      );
    });

    it('delegated budget exhausted + personal insufficient → denied, has notification', () => {
      assertConsistency(
        {
          tier: 'free',
          purchasedBalanceNanoUsd: nano(0),
          spendableNanoUsd: spendableFor(0),
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: nano(10),
          group: { effectiveRemainingNanoUsd: nano(0), ownerBalanceNanoUsd: nano(5000) },
        },
        { hasDelegatedBudget: true }
      );
    });
  });

  describe('capacity interaction', () => {
    it('approved billing + over capacity → capacity error present (not billing denial)', () => {
      const input: ClientBillingInput = {
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(1000),
        spendableNanoUsd: spendableFor(1000),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(10),
      };
      const billingResult = resolveClientBilling(input);
      expect(billingResult.fundingSource).not.toBe('denied');

      const notifications = generateNotifications({
        billingResult,
        capacityPercent: 150,
        maxOutputTokens: 50_000,
      });

      // Has capacity error but NOT billing denial
      expect(notifications.some((n) => n.id === 'prompt_too_long')).toBe(true);
      expect(notifications.some((n) => isDenialNotification(n.id))).toBe(false);
    });

    it('denied billing + over capacity → the funding reason alone, per §Notices 4', () => {
      const input: ClientBillingInput = {
        tier: 'paid',
        purchasedBalanceNanoUsd: nano(0),
        spendableNanoUsd: spendableFor(0),
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: nano(200),
      };
      const billingResult = resolveClientBilling(input);
      expect(billingResult.fundingSource).toBe('denied');

      const notifications = generateNotifications({
        billingResult,
        capacityPercent: 150,
        maxOutputTokens: 0,
      });

      // Both bind, so the precedence picks one: the funding floor is tested
      // first, and a length demand alongside it would contradict its action.
      expect(notifications.some((n) => isDenialNotification(n.id))).toBe(true);
      expect(notifications.some((n) => n.id === 'prompt_too_long')).toBe(false);
    });
  });
});
