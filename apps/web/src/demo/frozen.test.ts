import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEMO_BOOT_ID } from './mock-backend/fixtures';
import { parseFrozenParams, scrollFrozenListToTop } from './frozen';

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.__virtuosoScrollToIndex;
  document.body.innerHTML = '';
});

describe('parseFrozenParams', () => {
  it('returns null for the live demo (no frozen flag)', () => {
    expect(parseFrozenParams('')).toBeNull();
    expect(parseFrozenParams('?convo=demo-welcome')).toBeNull();
    expect(parseFrozenParams('?frozen=0')).toBeNull();
  });

  it('parses the conversation, scroll, and theme from the query', () => {
    expect(parseFrozenParams('?frozen=1&convo=demo-group&scroll=bottom&theme=dark')).toEqual({
      conversationId: 'demo-group',
      scroll: 'bottom',
      theme: 'dark',
    });
  });

  it('defaults to the boot conversation, top scroll, and light theme', () => {
    expect(parseFrozenParams('?frozen=1')).toEqual({
      conversationId: DEMO_BOOT_ID,
      scroll: 'top',
      theme: 'light',
    });
  });

  it('only treats theme=dark and scroll=bottom as their non-default values', () => {
    expect(parseFrozenParams('?frozen=1&theme=blue&scroll=middle')).toEqual({
      conversationId: DEMO_BOOT_ID,
      scroll: 'top',
      theme: 'light',
    });
  });
});

describe('scrollFrozenListToTop', () => {
  it('scrolls the settled chat log to the first message via the dev hatch', async () => {
    document.body.innerHTML = '<div data-testid="message-list" data-at-bottom="true"></div>';
    const list = document.querySelector('[data-testid="message-list"]')!;
    const scrollToIndex = vi.fn(() => {
      // The real hatch leaves the bottom; mirror that so the retry loop stops.
      list.setAttribute('data-at-bottom', 'false');
      return Promise.resolve();
    });
    globalThis.__virtuosoScrollToIndex = scrollToIndex;

    await scrollFrozenListToTop();

    expect(scrollToIndex).toHaveBeenCalledWith(0);
  });

  it('resolves without throwing when the hatch never appears', async () => {
    vi.useFakeTimers();
    const pending = scrollFrozenListToTop();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
  });

  it('gives up after retrying when the list never leaves the bottom', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-testid="message-list" data-at-bottom="true"></div>';
    const scrollToIndex = vi.fn(() => Promise.resolve());
    globalThis.__virtuosoScrollToIndex = scrollToIndex;

    const pending = scrollFrozenListToTop();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBeUndefined();
    expect(scrollToIndex).toHaveBeenCalledTimes(8);
  });
});
