import { describe, it, expect } from 'vitest';
import { computeSafeMaxTokens, generateNotifications, type NotificationInput } from './budget.js';
import { CAPACITY_RED_THRESHOLD, LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD } from './constants.js';

function notifInput(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    billingResult: { fundingSource: 'personal_balance' },
    capacityPercent: 20,
    maxOutputTokens: 50_000,
    ...overrides,
  };
}

describe('generateNotifications', () => {
  describe('denial notifications', () => {
    it('returns error for premium_requires_balance', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
        })
      );
      const error = result.find((e) => e.id === 'premium_requires_balance');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('This model requires a paid account.');
      expect(error?.segments).toEqual([
        { text: 'This model requires a paid account. ' },
        { text: 'Top up', link: '/billing' },
        { text: ' to use premium models.' },
      ]);
    });

    it('returns error for insufficient_balance', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_balance');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('Insufficient balance. Top up or try a more affordable model.');
    });

    it('returns error for insufficient_free_allowance', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_free_allowance');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe(
        "Your free daily usage can't cover this message. Top up or try a shorter conversation."
      );
    });

    it('returns error for guest_budget_exhausted', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
        })
      );
      const error = result.find((e) => e.id === 'guest_budget_exhausted');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('No budget allocated. Contact the conversation owner.');
    });

    it('suppresses delegated_budget_exhausted when guest_budget_exhausted', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'guest_budget_exhausted')).toBe(true);
      expect(result.some((e) => e.id === 'delegated_budget_exhausted')).toBe(false);
    });

    it('returns error for trial_limit_exceeded', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
        })
      );
      const error = result.find((e) => e.id === 'trial_limit_exceeded');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe('This message exceeds the usage limit.');
    });
  });

  describe('funding source info notices', () => {
    it('shows free tier notice for free_allowance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
        })
      );
      const notice = result.find((e) => e.id === 'free_tier_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe('Using free allowance. Top up for longer conversations.');
    });

    it('shows trial notice for trial_fixed funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
        })
      );
      const notice = result.find((e) => e.id === 'trial_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe('Free preview. Sign up for full access.');
    });

    it('does not show tier notice for personal_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
        })
      );
      expect(result.some((e) => e.id === 'free_tier_notice')).toBe(false);
      expect(result.some((e) => e.id === 'trial_notice')).toBe(false);
    });

    it('does not show tier notice for owner_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
        })
      );
      expect(result.some((e) => e.id === 'free_tier_notice')).toBe(false);
      expect(result.some((e) => e.id === 'trial_notice')).toBe(false);
    });
  });

  describe('capacity notifications', () => {
    it('shows capacity_exceeded when capacityPercent > 100', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 150 }));
      const error = result.find((e) => e.id === 'capacity_exceeded');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
    });

    it('does not show capacity_exceeded when capacityPercent <= 100', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 100 }));
      expect(result.some((e) => e.id === 'capacity_exceeded')).toBe(false);
    });

    it('shows capacity_warning at red threshold when no blocking errors', () => {
      const result = generateNotifications(
        notifInput({
          capacityPercent: CAPACITY_RED_THRESHOLD * 100,
        })
      );
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(true);
    });

    it('does not show capacity_warning below red threshold', () => {
      const result = generateNotifications(
        notifInput({
          capacityPercent: CAPACITY_RED_THRESHOLD * 100 - 1,
        })
      );
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(false);
    });

    it('does not show capacity_warning when denied (blocking error present)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: 80,
        })
      );
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(false);
    });

    it('does not show capacity_warning when over capacity (capacity_exceeded shown instead)', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 110 }));
      expect(result.some((e) => e.id === 'capacity_warning')).toBe(false);
      expect(result.some((e) => e.id === 'capacity_exceeded')).toBe(true);
    });
  });

  describe('low balance warning', () => {
    it('shows low_balance for personal_balance with low maxOutputTokens', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD - 1,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(true);
    });

    it('does not show low_balance when maxOutputTokens >= threshold', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(false);
    });

    it('shows low_balance even when hasDelegatedBudget is true (budget exhausted, personal fallback)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: 100,
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(true);
    });

    it('does not show low_balance for non-personal_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          maxOutputTokens: 100,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(false);
    });

    it('does not show low_balance when denied', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          maxOutputTokens: 100,
        })
      );
      expect(result.some((e) => e.id === 'low_balance')).toBe(false);
    });
  });

  describe('delegated budget notices', () => {
    it('shows delegated_budget_notice when owner_balance and hasDelegatedBudget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          hasDelegatedBudget: true,
        })
      );
      const notice = result.find((e) => e.id === 'delegated_budget_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe(
        "You won't be charged. The conversation owner has allocated budget for your messages."
      );
    });

    it('does not show delegated_budget_notice without hasDelegatedBudget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
        })
      );
      expect(result.some((e) => e.id === 'delegated_budget_notice')).toBe(false);
    });

    it('shows delegated_budget_exhausted when hasDelegatedBudget but fell through to personal', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          hasDelegatedBudget: true,
        })
      );
      const notice = result.find((e) => e.id === 'delegated_budget_exhausted');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
    });

    it('shows delegated_budget_exhausted even when denied (provides context)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'delegated_budget_exhausted')).toBe(true);
    });
  });

  describe('privilege notifications', () => {
    it('shows read_only_notice when privilege is read', () => {
      const result = generateNotifications(notifInput({ privilege: 'read' }));
      const notice = result.find((e) => e.id === 'read_only_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice?.message).toBe('You have read-only access to this conversation.');
    });

    it('does not show read_only_notice for write privilege', () => {
      const result = generateNotifications(notifInput({ privilege: 'write' }));
      expect(result.some((e) => e.id === 'read_only_notice')).toBe(false);
    });

    it('does not show read_only_notice when no privilege specified', () => {
      const result = generateNotifications(notifInput());
      expect(result.some((e) => e.id === 'read_only_notice')).toBe(false);
    });
  });
});

describe('generateNotifications — comprehensive state audit', () => {
  /** Extract notification IDs in order */
  function ids(result: ReturnType<typeof generateNotifications>): string[] {
    return result.map((n) => n.id);
  }

  const CAP_NORMAL = 20;
  const CAP_WARNING = 80;
  const CAP_EXCEEDED = 150;
  const BAL_HIGH = 50_000;
  const BAL_LOW = 5000;

  describe('A. Trial user — solo', () => {
    it('T1: basic, normal capacity, within cap → [trial_notice]', () => {
      const result = generateNotifications(
        notifInput({ billingResult: { fundingSource: 'trial_fixed' }, capacityPercent: CAP_NORMAL })
      );
      expect(ids(result)).toEqual(['trial_notice']);
    });

    it('T2: basic, warning capacity, within cap → [capacity_warning, trial_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'trial_notice']);
    });

    it('T3: basic, exceeded capacity, within cap → [capacity_exceeded, trial_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'trial_notice']);
    });

    it('T4: basic, normal capacity, over cap → [trial_limit_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded']);
    });

    it('T5: basic, warning capacity, over cap → [trial_limit_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded']);
    });

    it('T6: basic, exceeded capacity, over cap → [capacity_exceeded, trial_limit_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'trial_limit_exceeded']);
    });

    it('T7: premium, normal capacity → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('T8: premium, warning capacity → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('T9: premium, exceeded capacity → [capacity_exceeded, premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'premium_requires_balance']);
    });
  });

  describe('B. Free user — solo/owner', () => {
    it('F1: basic, normal, sufficient → [free_tier_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['free_tier_notice']);
    });

    it('F2: basic, warning, sufficient → [capacity_warning, free_tier_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'free_tier_notice']);
    });

    it('F3: basic, exceeded, sufficient → [capacity_exceeded, free_tier_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'free_tier_notice']);
    });

    it('F4: basic, normal, insufficient → [insufficient_free_allowance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance']);
    });

    it('F5: basic, warning, insufficient → [insufficient_free_allowance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance']);
    });

    it('F6: basic, exceeded, insufficient → [capacity_exceeded, insufficient_free_allowance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'insufficient_free_allowance']);
    });

    it('F7: premium, normal → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('F8: premium, warning → [premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance']);
    });

    it('F9: premium, exceeded → [capacity_exceeded, premium_requires_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'premium_requires_balance']);
    });
  });

  describe('C. Paid user — solo/owner', () => {
    it('P1: normal, high balance → []', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual([]);
    });

    it('P2: normal, low balance → [low_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_LOW,
        })
      );
      expect(ids(result)).toEqual(['low_balance']);
    });

    it('P3: warning, high balance → [capacity_warning]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning']);
    });

    it('P4: warning, low balance → [capacity_warning, low_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_LOW,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'low_balance']);
    });

    it('P5: exceeded, sufficient → [capacity_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded']);
    });

    it('P6: normal, insufficient → [insufficient_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance']);
    });

    it('P7: warning, insufficient → [insufficient_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance']);
    });

    it('P8: exceeded, insufficient → [capacity_exceeded, insufficient_balance]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'insufficient_balance']);
    });
  });

  describe('D. Group member — budget active', () => {
    it('GM1: normal → [delegated_budget_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['delegated_budget_notice']);
    });

    it('GM2: warning → [capacity_warning, delegated_budget_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'delegated_budget_notice']);
    });

    it('GM3: exceeded → [capacity_exceeded, delegated_budget_notice]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'delegated_budget_notice']);
    });
  });

  describe('E. Group member — budget exhausted, paid', () => {
    it('GMP1: normal, high → [delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['delegated_budget_exhausted']);
    });

    it('GMP2: normal, low → [low_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['low_balance', 'delegated_budget_exhausted']);
    });

    it('GMP3: warning, high → [capacity_warning, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_warning', 'delegated_budget_exhausted']);
    });

    it('GMP4: warning, low → [capacity_warning, low_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_warning',
        'low_balance',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMP5: exceeded, sufficient → [capacity_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['capacity_exceeded', 'delegated_budget_exhausted']);
    });

    it('GMP6: normal, insufficient → [insufficient_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance', 'delegated_budget_exhausted']);
    });

    it('GMP7: warning, insufficient → [insufficient_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_balance', 'delegated_budget_exhausted']);
    });

    it('GMP8: exceeded, insufficient → [capacity_exceeded, insufficient_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'insufficient_balance',
        'delegated_budget_exhausted',
      ]);
    });
  });

  describe('F. Group member — budget exhausted, free', () => {
    it('GMF1: basic, normal, sufficient → [free_tier_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['free_tier_notice', 'delegated_budget_exhausted']);
    });

    it('GMF2: basic, warning, sufficient → [capacity_warning, free_tier_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_warning',
        'free_tier_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMF3: basic, exceeded, sufficient → [capacity_exceeded, free_tier_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'free_tier_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMF4: basic, normal, insufficient → [insufficient_free_allowance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance', 'delegated_budget_exhausted']);
    });

    it('GMF5: basic, warning, insufficient → [insufficient_free_allowance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_free_allowance', 'delegated_budget_exhausted']);
    });

    it('GMF6: basic, exceeded, insufficient → [capacity_exceeded, insufficient_free_allowance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'insufficient_free_allowance',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMF7: premium, normal → [premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance', 'delegated_budget_exhausted']);
    });

    it('GMF8: premium, exceeded → [capacity_exceeded, premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'premium_requires_balance',
        'delegated_budget_exhausted',
      ]);
    });
  });

  describe('G. Group member — budget exhausted, guest', () => {
    it('GMG1: basic, normal, within cap → [trial_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_notice', 'delegated_budget_exhausted']);
    });

    it('GMG2: basic, warning, within cap → [capacity_warning, trial_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_warning',
        'trial_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMG3: basic, exceeded, within cap → [capacity_exceeded, trial_notice, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'trial_notice',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMG4: basic, normal, over cap → [trial_limit_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded', 'delegated_budget_exhausted']);
    });

    it('GMG5: basic, warning, over cap → [trial_limit_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_limit_exceeded', 'delegated_budget_exhausted']);
    });

    it('GMG6: basic, exceeded, over cap → [capacity_exceeded, trial_limit_exceeded, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'trial_limit_exceeded',
        'delegated_budget_exhausted',
      ]);
    });

    it('GMG7: premium, normal → [premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_balance', 'delegated_budget_exhausted']);
    });

    it('GMG8: premium, exceeded → [capacity_exceeded, premium_requires_balance, delegated_budget_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'capacity_exceeded',
        'premium_requires_balance',
        'delegated_budget_exhausted',
      ]);
    });
  });

  describe('H. Read-only member', () => {
    it('RO1: read-only returns only read_only_notice regardless of billing state', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
          privilege: 'read',
        })
      );
      expect(ids(result)).toEqual(['read_only_notice']);
    });
  });

  describe('Issue E: insufficient_free_allowance segments', () => {
    it('includes Top up link to /billing', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_free_allowance');
      expect(error).toBeDefined();
      expect(error!.message).toBe(
        "Your free daily usage can't cover this message. Top up or try a shorter conversation."
      );
      expect(error!.segments).toEqual([
        { text: "Your free daily usage can't cover this message. " },
        { text: 'Top up', link: '/billing' },
        { text: ' or try a shorter conversation.' },
      ]);
    });
  });
});

describe('computeSafeMaxTokens', () => {
  it('returns the budget max when it is below the remaining context', () => {
    expect(
      computeSafeMaxTokens({
        budgetMaxTokens: 5000,
        modelContextLength: 128_000,
        estimatedInputTokens: 1000,
      })
    ).toBe(5000);
  });

  it('returns undefined when the budget max meets or exceeds the remaining context', () => {
    // remainingContext = 10_000 - 1_000 = 9_000; budget 9_000 >= 9_000 -> omit.
    expect(
      computeSafeMaxTokens({
        budgetMaxTokens: 9000,
        modelContextLength: 10_000,
        estimatedInputTokens: 1000,
      })
    ).toBeUndefined();
  });

  it('returns undefined when the budget max exceeds the remaining context', () => {
    expect(
      computeSafeMaxTokens({
        budgetMaxTokens: 50_000,
        modelContextLength: 8000,
        estimatedInputTokens: 2000,
      })
    ).toBeUndefined();
  });

  describe('provider completion cap (modelMaxOutputTokens)', () => {
    it('returns the budget max when it is below both the cap and the remaining context', () => {
      expect(
        computeSafeMaxTokens({
          budgetMaxTokens: 5000,
          modelContextLength: 128_000,
          estimatedInputTokens: 1000,
          modelMaxOutputTokens: 8192,
        })
      ).toBe(5000);
    });

    it('returns undefined when the budget max meets the cap and the cap is the tighter ceiling', () => {
      // The provider enforces its own completion ceiling, so no explicit
      // param is needed — admission bounds the hold at the cap regardless.
      expect(
        computeSafeMaxTokens({
          budgetMaxTokens: 50_000,
          modelContextLength: 128_000,
          estimatedInputTokens: 1000,
          modelMaxOutputTokens: 8192,
        })
      ).toBeUndefined();
    });

    it('never returns a value exceeding the cap (seeded sweep)', () => {
      for (let budget = 1; budget <= 20_000; budget += 977) {
        const result = computeSafeMaxTokens({
          budgetMaxTokens: budget,
          modelContextLength: 128_000,
          estimatedInputTokens: 1000,
          modelMaxOutputTokens: 8192,
        });
        if (result !== undefined) expect(result).toBeLessThanOrEqual(8192);
      }
    });

    it('keeps the remaining-context ceiling when it is tighter than the cap', () => {
      expect(
        computeSafeMaxTokens({
          budgetMaxTokens: 9000,
          modelContextLength: 10_000,
          estimatedInputTokens: 1000,
          modelMaxOutputTokens: 50_000,
        })
      ).toBeUndefined();
    });
  });
});
