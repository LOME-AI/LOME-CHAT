import { describe, it, expect } from 'vitest';
import { generateNotifications, type NotificationInput } from './budget.js';
import { CAPACITY_RED_THRESHOLD, LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD } from './constants.js';
import { notices } from './notices.js';
import { ROUTES } from '../routes.js';

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
    it('returns error for premium_requires_credit', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
        })
      );
      const error = result.find((e) => e.id === 'premium_requires_credit');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error).toEqual(notices('premium_requires_credit'));
    });

    it('returns error for insufficient_funds', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
        })
      );
      const error = result.find((e) => e.id === 'insufficient_funds');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error).toEqual(notices('insufficient_funds'));
    });

    it('returns error for free_allowance_exhausted', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
        })
      );
      const error = result.find((e) => e.id === 'free_allowance_exhausted');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error).toEqual(notices('free_allowance_exhausted'));
    });

    it('returns error for guest_no_group_budget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
        })
      );
      const error = result.find((e) => e.id === 'guest_no_group_budget');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error).toEqual(notices('guest_no_group_budget'));
    });

    it('carries no payer-switch disclosure on a refused send', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'guest_no_group_budget')).toBe(true);
      expect(result.some((e) => e.id === 'payer_switched_to_personal')).toBe(false);
    });

    it('returns error for trial_message_cap_exceeded', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
        })
      );
      const error = result.find((e) => e.id === 'trial_message_cap_exceeded');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error).toEqual(notices('trial_message_cap_exceeded'));
    });
  });

  describe('funding source info notices', () => {
    it('shows free tier notice for free_allowance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
        })
      );
      const notice = result.find((e) => e.id === 'free_allowance_pays');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice).toEqual(notices('free_allowance_pays'));
    });

    it('shows trial notice for trial_fixed funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
        })
      );
      const notice = result.find((e) => e.id === 'trial_preview_pays');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice).toEqual(notices('trial_preview_pays'));
    });

    it('does not show tier notice for personal_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
        })
      );
      expect(result.some((e) => e.id === 'free_allowance_pays')).toBe(false);
      expect(result.some((e) => e.id === 'trial_preview_pays')).toBe(false);
    });

    it('does not show tier notice for owner_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
        })
      );
      expect(result.some((e) => e.id === 'free_allowance_pays')).toBe(false);
      expect(result.some((e) => e.id === 'trial_preview_pays')).toBe(false);
    });
  });

  describe('capacity notifications', () => {
    it('shows prompt_too_long when capacityPercent > 100', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 150 }));
      const error = result.find((e) => e.id === 'prompt_too_long');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
    });

    it('does not show prompt_too_long when capacityPercent <= 100', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 100 }));
      expect(result.some((e) => e.id === 'prompt_too_long')).toBe(false);
    });

    it('shows context_near_capacity at red threshold when no blocking errors', () => {
      const result = generateNotifications(
        notifInput({
          capacityPercent: CAPACITY_RED_THRESHOLD * 100,
        })
      );
      expect(result.some((e) => e.id === 'context_near_capacity')).toBe(true);
    });

    it('does not show context_near_capacity below red threshold', () => {
      const result = generateNotifications(
        notifInput({
          capacityPercent: CAPACITY_RED_THRESHOLD * 100 - 1,
        })
      );
      expect(result.some((e) => e.id === 'context_near_capacity')).toBe(false);
    });

    it('does not show context_near_capacity when denied (blocking error present)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: 80,
        })
      );
      expect(result.some((e) => e.id === 'context_near_capacity')).toBe(false);
    });

    it('does not show context_near_capacity when over capacity (prompt_too_long shown instead)', () => {
      const result = generateNotifications(notifInput({ capacityPercent: 110 }));
      expect(result.some((e) => e.id === 'context_near_capacity')).toBe(false);
      expect(result.some((e) => e.id === 'prompt_too_long')).toBe(true);
    });
  });

  describe('low balance warning', () => {
    it('shows answer_may_be_shortened for personal_balance with low maxOutputTokens', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD - 1,
        })
      );
      expect(result.some((e) => e.id === 'answer_may_be_shortened')).toBe(true);
    });

    it('does not show answer_may_be_shortened when maxOutputTokens >= threshold', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
        })
      );
      expect(result.some((e) => e.id === 'answer_may_be_shortened')).toBe(false);
    });

    it('shows answer_may_be_shortened even when hasDelegatedBudget is true (budget exhausted, personal fallback)', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          maxOutputTokens: 100,
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((e) => e.id === 'answer_may_be_shortened')).toBe(true);
    });

    it('does not show answer_may_be_shortened for non-personal_balance funding', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          maxOutputTokens: 100,
        })
      );
      expect(result.some((e) => e.id === 'answer_may_be_shortened')).toBe(false);
    });

    it('does not show answer_may_be_shortened when denied', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          maxOutputTokens: 100,
        })
      );
      expect(result.some((e) => e.id === 'answer_may_be_shortened')).toBe(false);
    });
  });

  describe('group funding notices', () => {
    it('shows group_budget_pays when owner_balance and hasDelegatedBudget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          hasDelegatedBudget: true,
        })
      );
      const notice = result.find((e) => e.id === 'group_budget_pays');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
      expect(notice).toEqual(notices('group_budget_pays'));
    });

    it('does not show group_budget_pays without hasDelegatedBudget', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
        })
      );
      expect(result.some((e) => e.id === 'group_budget_pays')).toBe(false);
    });

    it('discloses the payer switch for a member whose allocation ran out', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: {
            fundingSource: 'personal_balance',
            payerSwitch: 'group_headroom_insufficient',
          },
          hasDelegatedBudget: true,
        })
      );
      const notice = result.find((e) => e.id === 'payer_switched_to_personal');
      expect(notice).toBeDefined();
      expect(notice).toEqual(notices('payer_switched_to_personal'));
    });

    it('discloses the payer switch for a member who was never allocated a budget', () => {
      // The same reason covers both shapes, so the disclosure does not depend
      // on the sender ever having held an allocation.
      const result = generateNotifications(
        notifInput({
          billingResult: {
            fundingSource: 'personal_balance',
            payerSwitch: 'group_headroom_insufficient',
          },
        })
      );
      expect(result.some((e) => e.id === 'payer_switched_to_personal')).toBe(true);
    });

    it('discloses nothing when the sender was self-funding all along', () => {
      const result = generateNotifications(
        notifInput({ billingResult: { fundingSource: 'personal_balance' } })
      );
      expect(result.some((e) => e.id === 'payer_switched_to_personal')).toBe(false);
    });
  });

  describe('privilege notifications', () => {
    it('shows conversation_read_only when privilege is read', () => {
      const result = generateNotifications(notifInput({ privilege: 'read' }));
      const notice = result.find((e) => e.id === 'conversation_read_only');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('error');
      expect(notice).toEqual(notices('conversation_read_only'));
    });

    it('does not show conversation_read_only for write privilege', () => {
      const result = generateNotifications(notifInput({ privilege: 'write' }));
      expect(result.some((e) => e.id === 'conversation_read_only')).toBe(false);
    });

    it('does not show conversation_read_only when no privilege specified', () => {
      const result = generateNotifications(notifInput());
      expect(result.some((e) => e.id === 'conversation_read_only')).toBe(false);
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
    it('T1: basic, normal capacity, within cap → [trial_preview_pays]', () => {
      const result = generateNotifications(
        notifInput({ billingResult: { fundingSource: 'trial_fixed' }, capacityPercent: CAP_NORMAL })
      );
      expect(ids(result)).toEqual(['trial_preview_pays']);
    });

    it('T2: basic, warning capacity, within cap → [context_near_capacity, trial_preview_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['context_near_capacity', 'trial_preview_pays']);
    });

    it('T3: basic, exceeded capacity, within cap → [prompt_too_long, trial_preview_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['prompt_too_long', 'trial_preview_pays']);
    });

    it('T4: basic, normal capacity, over cap → [trial_message_cap_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['trial_message_cap_exceeded']);
    });

    it('T5: basic, warning capacity, over cap → [trial_message_cap_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['trial_message_cap_exceeded']);
    });

    it('T6: basic, exceeded capacity, over cap → [trial_message_cap_exceeded]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['trial_message_cap_exceeded']);
    });

    it('T7: premium, normal capacity → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });

    it('T8: premium, warning capacity → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });

    it('T9: premium, exceeded capacity → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });
  });

  describe('B. Free user — solo/owner', () => {
    it('F1: basic, normal, sufficient → [free_allowance_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_pays']);
    });

    it('F2: basic, warning, sufficient → [context_near_capacity, free_allowance_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['context_near_capacity', 'free_allowance_pays']);
    });

    it('F3: basic, exceeded, sufficient → [prompt_too_long, free_allowance_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'free_allowance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['prompt_too_long', 'free_allowance_pays']);
    });

    it('F4: basic, normal, insufficient → [free_allowance_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_exhausted']);
    });

    it('F5: basic, warning, insufficient → [free_allowance_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_exhausted']);
    });

    it('F6: basic, exceeded, insufficient → [free_allowance_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_exhausted']);
    });

    it('F7: premium, normal → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });

    it('F8: premium, warning → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });

    it('F9: premium, exceeded → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
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

    it('P2: normal, low balance → [answer_may_be_shortened]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_LOW,
        })
      );
      expect(ids(result)).toEqual(['answer_may_be_shortened']);
    });

    it('P3: warning, high balance → [context_near_capacity]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual(['context_near_capacity']);
    });

    it('P4: warning, low balance → [context_near_capacity, answer_may_be_shortened]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_LOW,
        })
      );
      expect(ids(result)).toEqual(['context_near_capacity', 'answer_may_be_shortened']);
    });

    it('P5: exceeded, sufficient → [prompt_too_long]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'personal_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_HIGH,
        })
      );
      expect(ids(result)).toEqual(['prompt_too_long']);
    });

    it('P6: normal, insufficient → [insufficient_funds]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_NORMAL,
        })
      );
      expect(ids(result)).toEqual(['insufficient_funds']);
    });

    it('P7: warning, insufficient → [insufficient_funds]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_WARNING,
        })
      );
      expect(ids(result)).toEqual(['insufficient_funds']);
    });

    it('P8: exceeded, insufficient → [insufficient_funds]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
        })
      );
      expect(ids(result)).toEqual(['insufficient_funds']);
    });
  });

  describe('D. Group member — budget active', () => {
    it('GM1: normal → [group_budget_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['group_budget_pays']);
    });

    it('GM2: warning → [context_near_capacity, group_budget_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['context_near_capacity', 'group_budget_pays']);
    });

    it('GM3: exceeded → [prompt_too_long, group_budget_pays]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'owner_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['prompt_too_long', 'group_budget_pays']);
    });
  });

  describe('E. Group member — the group budget cannot cover this turn, paid', () => {
    const switched = {
      fundingSource: 'personal_balance',
      payerSwitch: 'group_headroom_insufficient',
    } as const;

    it('GMP1: normal, high → [payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['payer_switched_to_personal']);
    });

    it('GMP2: normal, low → [answer_may_be_shortened, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_NORMAL,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['answer_may_be_shortened', 'payer_switched_to_personal']);
    });

    it('GMP3: warning, high → [context_near_capacity, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['context_near_capacity', 'payer_switched_to_personal']);
    });

    it('GMP4: warning, low → [context_near_capacity, answer_may_be_shortened, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_WARNING,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'context_near_capacity',
        'answer_may_be_shortened',
        'payer_switched_to_personal',
      ]);
    });

    it('GMP5: exceeded, sufficient → [prompt_too_long, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_HIGH,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['prompt_too_long', 'payer_switched_to_personal']);
    });

    it('GMP6: normal, insufficient → [insufficient_funds] with no disclosure', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_funds']);
    });

    it('GMP7: warning, insufficient → [insufficient_funds]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_funds']);
    });

    it('GMP8: exceeded, insufficient → [insufficient_funds]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['insufficient_funds']);
    });
  });

  describe('F. Group member — the group budget cannot cover this turn, free', () => {
    const switched = {
      fundingSource: 'free_allowance',
      payerSwitch: 'group_headroom_insufficient',
    } as const;

    it('GMF1: basic, normal, sufficient → [free_allowance_pays, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_pays', 'payer_switched_to_personal']);
    });

    it('GMF2: basic, warning, sufficient → [context_near_capacity, free_allowance_pays, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'context_near_capacity',
        'free_allowance_pays',
        'payer_switched_to_personal',
      ]);
    });

    it('GMF3: basic, exceeded, sufficient → [prompt_too_long, free_allowance_pays, payer_switched_to_personal]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: switched,
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual([
        'prompt_too_long',
        'free_allowance_pays',
        'payer_switched_to_personal',
      ]);
    });

    it('GMF4: basic, normal, insufficient → [free_allowance_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_exhausted']);
    });

    it('GMF5: basic, warning, insufficient → [free_allowance_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_exhausted']);
    });

    it('GMF6: basic, exceeded, insufficient → [free_allowance_exhausted]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['free_allowance_exhausted']);
    });

    it('GMF7: premium, normal → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });

    it('GMF8: premium, exceeded → [premium_requires_credit]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['premium_requires_credit']);
    });
  });

  describe('G. Link guest — refused rather than switched', () => {
    // A guest holds no wallet, so an exhausted group budget refuses the send
    // instead of falling through; the payer-switch disclosure exists for the
    // send that SUCCEEDS and must never ride a refusal.
    it('GMG1: normal → [guest_no_group_budget]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['guest_no_group_budget']);
    });

    it('GMG2: warning → [guest_no_group_budget]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
          capacityPercent: CAP_WARNING,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['guest_no_group_budget']);
    });

    it('GMG3: exceeded → [guest_no_group_budget]', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
          capacityPercent: CAP_EXCEEDED,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['guest_no_group_budget']);
    });

    it('GMG4: a guest within the preview cap keeps the preview notice only', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'trial_fixed' },
          capacityPercent: CAP_NORMAL,
          hasDelegatedBudget: true,
        })
      );
      expect(ids(result)).toEqual(['trial_preview_pays']);
    });
  });

  describe('H. Read-only member', () => {
    it('RO1: read-only returns only conversation_read_only regardless of billing state', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
          capacityPercent: CAP_EXCEEDED,
          maxOutputTokens: BAL_LOW,
          hasDelegatedBudget: true,
          privilege: 'read',
        })
      );
      expect(ids(result)).toEqual(['conversation_read_only']);
    });
  });

  describe('the free-allowance refusal keeps its payment path', () => {
    it('links the add-credit action to the billing route', () => {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
        })
      );
      const error = result.find((e) => e.id === 'free_allowance_exhausted');
      expect(error).toBeDefined();
      expect(error!.segments.some((segment) => segment.link === ROUTES.BILLING)).toBe(true);
    });
  });
});

describe('precedence when funding and length both bind', () => {
  // Two non-dismissible demands that disagree — "Add credit" and "Shorten your
  // message" — is the harm the precedence rule exists to prevent, and the
  // composer is where both would be rendered at once.
  it('answers money when the funding cannot cover a minimum answer', () => {
    const result = generateNotifications(
      notifInput({
        billingResult: { fundingSource: 'denied', reason: 'insufficient_balance' },
        capacityPercent: 150,
      })
    );
    expect(result.map((notice) => notice.id)).toEqual(['insufficient_funds']);
  });

  it('answers length when the funding is not the reason', () => {
    const result = generateNotifications(
      notifInput({ billingResult: { fundingSource: 'personal_balance' }, capacityPercent: 150 })
    );
    expect(result.map((notice) => notice.id)).toEqual(['prompt_too_long']);
  });

  it('answers the tier condition over length, since no shorter prompt unlocks it', () => {
    const result = generateNotifications(
      notifInput({
        billingResult: { fundingSource: 'denied', reason: 'premium_requires_balance' },
        capacityPercent: 150,
      })
    );
    expect(result.map((notice) => notice.id)).toEqual(['premium_requires_credit']);
  });
});

describe('informational notices that render beside a block', () => {
  // The precedence rule leaves at most one blocking notice, but the info
  // notices ride alongside it. An info notice makes no competing DEMAND, yet it
  // can still make a contradicted OFFER — inviting the send the block refuses,
  // or implying money relieves a bound money cannot reach. The set is derived
  // from the producer rather than restated, so a newly co-rendering notice is
  // covered without editing this test.
  const APPROVED: NotificationInput['billingResult'][] = [
    { fundingSource: 'owner_balance' },
    { fundingSource: 'personal_balance' },
    { fundingSource: 'free_allowance' },
    { fundingSource: 'trial_fixed' },
    { fundingSource: 'personal_balance', payerSwitch: 'group_headroom_insufficient' },
    { fundingSource: 'free_allowance', payerSwitch: 'group_headroom_insufficient' },
  ];

  function alongsideABlock(): string[] {
    const wordings = new Set<string>();
    for (const billingResult of APPROVED) {
      const notices = generateNotifications(
        notifInput({ billingResult, capacityPercent: 150, hasDelegatedBudget: true })
      );
      expect(notices.some((notice) => notice.type === 'error')).toBe(true);
      for (const notice of notices) {
        if (notice.type !== 'error') wordings.add(notice.message);
      }
    }
    return [...wordings];
  }

  it('never invites the send the block refuses', () => {
    const wordings = alongsideABlock();
    expect(wordings.length).toBeGreaterThan(0);
    for (const wording of wordings) expect(wording).not.toMatch(/\bsend\b/i);
  });

  it('never offers money as the remedy for a length refusal', () => {
    const wordings = alongsideABlock();
    for (const wording of wordings) expect(wording).not.toMatch(/\blonger\b|\blength\b/i);
  });
});

describe('severity tracks the verdict in both directions', () => {
  const DENIAL_REASONS = [
    'premium_requires_balance',
    'insufficient_balance',
    'insufficient_free_allowance',
    'trial_limit_exceeded',
    'guest_budget_exhausted',
  ] as const;

  const APPROVED_SOURCES = [
    'owner_balance',
    'personal_balance',
    'free_allowance',
    'trial_fixed',
  ] as const;

  it('gives every blocked send exactly one blocking notice', () => {
    for (const reason of DENIAL_REASONS) {
      const result = generateNotifications(
        notifInput({ billingResult: { fundingSource: 'denied', reason } })
      );
      expect(result.filter((notice) => notice.type === 'error')).toHaveLength(1);
    }
  });

  it('still gives exactly one when the prompt is over capacity as well', () => {
    for (const reason of DENIAL_REASONS) {
      const result = generateNotifications(
        notifInput({ billingResult: { fundingSource: 'denied', reason }, capacityPercent: 150 })
      );
      expect(result.filter((notice) => notice.type === 'error')).toHaveLength(1);
    }
  });

  it('blocks a read-only sender with a notice rather than a hint', () => {
    const result = generateNotifications(notifInput({ privilege: 'read' }));
    expect(result.filter((notice) => notice.type === 'error')).toHaveLength(1);
  });

  it('raises no blocking notice for a send the verdict permits', () => {
    for (const fundingSource of APPROVED_SOURCES) {
      const result = generateNotifications(
        notifInput({
          billingResult: { fundingSource },
          capacityPercent: CAPACITY_RED_THRESHOLD * 100,
          maxOutputTokens: 1,
          hasDelegatedBudget: true,
        })
      );
      expect(result.some((notice) => notice.type === 'error')).toBe(false);
    }
  });
});
