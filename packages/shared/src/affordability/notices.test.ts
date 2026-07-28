import { describe, expect, it } from 'vitest';
import { REFUSAL_CODES, refusalPrecedence } from './turn-types.js';
import { NOTICE_COPY, NOTICE_REASONS, notices, noticeText } from './notices.js';
import { ROUTES } from '../routes.js';
import type { NoticeReason } from './notices.js';

/** Every reason, once — the enumeration every structural assertion runs over. */
const EVERY_REASON: readonly NoticeReason[] = NOTICE_REASONS;

/**
 * A magnitude is an amount, a token count or a threshold (§Notices 6). Digits
 * and currency marks catch the amounts; the nouns catch the spelled-out
 * thresholds a number-free sentence can still leak.
 */
const MAGNITUDE = /\d|[$¢%]|\btokens?\b|\bcents?\b|\bdollars?\b|\bthresholds?\b|\blimits?\b/i;

function fullText(reason: NoticeReason): string {
  const notice = notices(reason);
  return `${notice.message} ${notice.segments.map((segment) => segment.text).join('')}`;
}

describe('the notice vocabulary', () => {
  it('covers every refusal code the turn arithmetic can produce', () => {
    for (const code of REFUSAL_CODES) {
      expect(NOTICE_REASONS).toContain(code);
    }
  });

  it('names each reason exactly once', () => {
    expect(new Set(NOTICE_REASONS).size).toBe(NOTICE_REASONS.length);
  });

  it('gives every reason exactly one wording, shared with no other reason', () => {
    const wordings = EVERY_REASON.map((reason) => noticeText(reason));
    for (const wording of wordings) expect(wording.length).toBeGreaterThan(0);
    expect(new Set(wordings).size).toBe(wordings.length);
  });

  it('renders the same wording from the notice as from the plain text', () => {
    for (const reason of EVERY_REASON) {
      expect(notices(reason).message).toBe(noticeText(reason));
    }
  });

  it('gives every reason an action clause', () => {
    for (const reason of EVERY_REASON) {
      const action = notices(reason).segments.slice(1);
      expect(action.length).toBeGreaterThan(0);
      expect(
        action
          .map((segment) => segment.text)
          .join('')
          .trim().length
      ).toBeGreaterThan(0);
    }
  });

  it('names no amount, token count or threshold in any wording', () => {
    for (const reason of EVERY_REASON) {
      expect(fullText(reason)).not.toMatch(MAGNITUDE);
    }
  });

  it('identifies every notice by its own reason', () => {
    for (const reason of EVERY_REASON) {
      expect(notices(reason).id).toBe(reason);
    }
  });
});

describe('severity is structural', () => {
  const blocking = EVERY_REASON.filter((reason) => NOTICE_COPY[reason].severity.blocking);
  const informational = EVERY_REASON.filter((reason) => !NOTICE_COPY[reason].severity.blocking);

  it('renders every blocking reason as an error', () => {
    expect(blocking.length).toBeGreaterThan(0);
    for (const reason of blocking) {
      expect(notices(reason).type).toBe('error');
    }
  });

  it('renders every informational reason as a warning or an info notice', () => {
    expect(informational.length).toBeGreaterThan(0);
    for (const reason of informational) {
      expect(['warning', 'info']).toContain(notices(reason).type);
    }
  });

  it('leaves no error severity that is not a blocking reason', () => {
    for (const reason of EVERY_REASON) {
      expect(notices(reason).type === 'error').toBe(NOTICE_COPY[reason].severity.blocking);
    }
  });
});

describe('precedence between money and length', () => {
  it('answers money when the funding cannot cover a minimum answer', () => {
    expect(noticeText(refusalPrecedence(['prompt_too_long', 'insufficient_funds']))).toBe(
      noticeText('insufficient_funds')
    );
  });

  it('answers length when only the prompt makes the turn infeasible', () => {
    expect(noticeText(refusalPrecedence(['prompt_too_long']))).toBe(noticeText('prompt_too_long'));
  });

  it('gives the money and length conditions different wordings', () => {
    expect(noticeText('insufficient_funds')).not.toBe(noticeText('prompt_too_long'));
  });
});

describe('a hold is not poverty', () => {
  it('words a held-funds block differently from an empty balance', () => {
    expect(noticeText('funds_held_by_run')).not.toBe(noticeText('insufficient_funds'));
  });

  it('offers no payment path, because paying would not help', () => {
    for (const segment of notices('funds_held_by_run').segments) {
      expect(segment.link).toBeUndefined();
    }
  });

  it('tells the user to wait', () => {
    expect(noticeText('funds_held_by_run').toLowerCase()).toContain('wait');
  });

  it('names no conversation', () => {
    expect(noticeText('funds_held_by_run').toLowerCase()).not.toContain('conversation');
  });
});

describe('reasons whose only remedy is someone else', () => {
  it('gives a guest with no allocation no top-up path', () => {
    for (const segment of notices('guest_no_group_budget').segments) {
      expect(segment.link).not.toBe(ROUTES.BILLING);
    }
    expect(noticeText('guest_no_group_budget').toLowerCase()).toContain('owner');
  });

  it('names the owner as the remedy when the owner-funded turn cannot be paid for', () => {
    expect(noticeText('group_owner_funds_unavailable').toLowerCase()).toContain('owner');
  });

  it('words the owner refusal differently from the unallocated-guest refusal', () => {
    expect(noticeText('group_owner_funds_unavailable')).not.toBe(
      noticeText('guest_no_group_budget')
    );
  });
});

describe('the unresolved admission refusal', () => {
  // The wire collapses several admission conditions onto one code, so its copy
  // must be true of every one of them and must offer no action that is false
  // for any — naming the balance would tell a payer with ample funds and runs
  // in flight to pay, which cannot help.
  it('names no single condition', () => {
    for (const condition of [
      'insufficient_funds',
      'funds_held_by_run',
      'guest_no_group_budget',
    ] as const) {
      expect(noticeText('send_cannot_start')).not.toBe(noticeText(condition));
    }
  });

  it('offers no payment path', () => {
    for (const segment of notices('send_cannot_start').segments) {
      expect(segment.link).toBeUndefined();
    }
    expect(noticeText('send_cannot_start').toLowerCase()).not.toContain('add credit');
  });

  it('offers waiting as well as checking, since either may be the remedy', () => {
    const text = noticeText('send_cannot_start').toLowerCase();
    expect(text).toContain('wait');
    expect(text).toContain('balance');
  });
});

describe('reasons a paid action can hit', () => {
  it('words the concurrent-run refusal once, with an action', () => {
    expect(NOTICE_COPY.run_already_in_progress.severity.blocking).toBe(true);
    expect(noticeText('run_already_in_progress').toLowerCase()).toContain('wait');
  });

  it('splits premium into the two conditions whose actions differ', () => {
    expect(noticeText('premium_requires_account')).not.toBe(noticeText('premium_requires_credit'));
    expect(
      notices('premium_requires_account').segments.some((segment) => segment.link === ROUTES.SIGNUP)
    ).toBe(true);
    expect(
      notices('premium_requires_credit').segments.some((segment) => segment.link === ROUTES.BILLING)
    ).toBe(true);
  });
});
