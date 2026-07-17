import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  findBlockedAction,
  isModalitySwitchTarget,
  resolveClickNudge,
  installGuardrails,
} from './guardrails';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findBlockedAction', () => {
  it('blocks denylisted test-ids (including icon children) and dynamic prefixes', () => {
    const button = document.createElement('button');
    button.dataset['testid'] = 'menu-logout';
    const icon = document.createElement('img');
    button.append(icon);
    expect(findBlockedAction(icon)).toBe('log out');

    const remove = document.createElement('button');
    remove.dataset['testid'] = 'member-remove-action-abc';
    expect(findBlockedAction(remove)).toBe('manage members');
  });

  it('blocks message-write actions by aria-label', () => {
    const share = document.createElement('button');
    share.setAttribute('aria-label', 'Share');
    expect(findBlockedAction(share)).toBe('share messages');
  });

  it('blocks the destructive member/link paths from the audit (incl. leave conversation)', () => {
    const leave = document.createElement('button');
    leave.dataset['testid'] = 'member-leave-action';
    expect(findBlockedAction(leave)).toBe('leave conversations');

    const memberActions = document.createElement('button');
    memberActions.dataset['testid'] = 'member-actions-abc';
    expect(findBlockedAction(memberActions)).toBe('manage members');

    const linkActions = document.createElement('button');
    linkActions.dataset['testid'] = 'link-actions-xyz';
    expect(findBlockedAction(linkActions)).toBe('manage links');

    const accessibility = document.createElement('button');
    accessibility.dataset['testid'] = 'menu-accessibility';
    expect(findBlockedAction(accessibility)).toBe('open accessibility settings');
  });

  it('allows supported controls (copy, regenerate, retry, conversation links, null)', () => {
    const copy = document.createElement('button');
    copy.setAttribute('aria-label', 'Copy');
    expect(findBlockedAction(copy)).toBeNull();

    const regenerate = document.createElement('button');
    regenerate.setAttribute('aria-label', 'Regenerate');
    expect(findBlockedAction(regenerate)).toBeNull();

    const retry = document.createElement('button');
    retry.setAttribute('aria-label', 'Retry');
    expect(findBlockedAction(retry)).toBeNull();

    const link = document.createElement('a');
    link.dataset['testid'] = 'chat-link';
    expect(findBlockedAction(link)).toBeNull();

    expect(findBlockedAction(null)).toBeNull();
  });
});

describe('isModalitySwitchTarget', () => {
  it('matches modality-switch icons and ignores other controls', () => {
    const image = document.createElement('button');
    image.setAttribute('aria-label', 'Switch to image generation');
    expect(isModalitySwitchTarget(image)).toBe(true);

    const send = document.createElement('button');
    send.setAttribute('aria-label', 'Generate image');
    expect(isModalitySwitchTarget(send)).toBe(false);

    // The header's theme toggle shares the "Switch to ..." wording but must stay live.
    const darkMode = document.createElement('button');
    darkMode.setAttribute('aria-label', 'Switch to dark mode');
    expect(isModalitySwitchTarget(darkMode)).toBe(false);

    expect(isModalitySwitchTarget(null)).toBe(false);
  });
});

describe('resolveClickNudge', () => {
  it('nudges blocked controls regardless of trust', () => {
    const logout = document.createElement('button');
    logout.dataset['testid'] = 'menu-logout';
    expect(resolveClickNudge(logout, false)).toBe('log out');
    expect(resolveClickNudge(logout, true)).toBe('log out');
  });

  it('nudges modality switches only on real (trusted) clicks', () => {
    const image = document.createElement('button');
    image.setAttribute('aria-label', 'Switch to image generation');
    // The director's synthetic (untrusted) click switches modality.
    expect(resolveClickNudge(image, false)).toBeNull();
    // A real user's (trusted) click is nudged toward sign-up.
    expect(resolveClickNudge(image, true)).toBe('switch modes');
  });

  it('allows supported controls', () => {
    const copy = document.createElement('button');
    copy.setAttribute('aria-label', 'Copy');
    expect(resolveClickNudge(copy, true)).toBeNull();
  });
});

describe('installGuardrails', () => {
  it('prevents the click and shows a nudge for a blocked control', () => {
    const uninstall = installGuardrails();
    const button = document.createElement('button');
    button.dataset['testid'] = 'menu-settings';
    document.body.append(button);
    let reachedTarget = false;
    button.addEventListener('click', () => {
      reachedTarget = true;
    });

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(reachedTarget).toBe(false);
    const nudge = document.querySelector('[data-testid="demo-signup-nudge"]');
    expect(nudge?.textContent).toContain('open settings');
    uninstall();
  });

  it('lets supported controls through', () => {
    const uninstall = installGuardrails();
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Copy');
    document.body.append(button);
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(clicked).toBe(true);
    uninstall();
  });

  it('auto-hides the nudge after a delay and restarts the timer on a repeat nudge', () => {
    vi.useFakeTimers();
    try {
      const uninstall = installGuardrails();
      const button = document.createElement('button');
      button.dataset['testid'] = 'menu-settings';
      document.body.append(button);
      const nudge = document.querySelector('[data-testid="demo-signup-nudge"]');
      if (nudge === null) throw new Error('no nudge');

      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(nudge.classList.contains('opacity-0')).toBe(false);

      // A second nudge before the first hide clears and restarts the timer.
      vi.advanceTimersByTime(1000);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(nudge.classList.contains('opacity-0')).toBe(false);
      // 1000ms after the second nudge — the first timer would have fired here had
      // it not been cleared; the nudge must still be visible.
      vi.advanceTimersByTime(1700);
      expect(nudge.classList.contains('opacity-0')).toBe(false);

      // Past the restarted 2600ms window, the hide callback runs.
      vi.advanceTimersByTime(1000);
      expect(nudge.classList.contains('opacity-0')).toBe(true);

      uninstall();
    } finally {
      vi.useRealTimers();
    }
  });
});
