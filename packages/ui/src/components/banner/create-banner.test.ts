import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BannerResponse } from '@hushbox/shared';
import { createBanner } from './create-banner.js';
import { markBannerDismissed } from './dismissal-store.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeData(overrides: Partial<BannerResponse> = {}): BannerResponse {
  return { hash: 'h1', variant: 'info', messages: [{ text: 'Hello world' }], ...overrides };
}

let root: HTMLDivElement;
beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  root = document.createElement('div');
  document.body.append(root);
});

describe('createBanner', () => {
  it('renders nothing when the banner is disabled (null hash)', () => {
    createBanner(root, { data: makeData({ hash: null, messages: [] }), isAuthenticated: false });
    expect(root.children).toHaveLength(0);
  });

  it('renders nothing when there are no messages', () => {
    createBanner(root, { data: makeData({ messages: [] }), isAuthenticated: false });
    expect(root.children).toHaveLength(0);
  });

  it('takes the local fast path: when dismissed locally it renders nothing and never calls the server', () => {
    markBannerDismissed('h1');
    const fetchServerDismissal = vi.fn().mockResolvedValue(false);
    createBanner(root, { data: makeData(), isAuthenticated: true, fetchServerDismissal });
    expect(root.children).toHaveLength(0);
    expect(fetchServerDismissal).not.toHaveBeenCalled();
  });

  it('renders the banner for an unauthenticated, non-dismissed user', () => {
    createBanner(root, { data: makeData(), isAuthenticated: false });
    const banner = root.querySelector<HTMLElement>('.hb-banner');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('region');
    expect(banner?.dataset['state']).toBe('open');
    expect(banner?.textContent).toContain('Hello world');
    expect(root.querySelector('.hb-dismiss')).not.toBeNull();
  });

  it('on dismiss: marks locally, calls the server save (authed), and removes after the transition', () => {
    const saveServerDismissal = vi.fn();
    createBanner(root, { data: makeData(), isAuthenticated: true, saveServerDismissal });
    const banner = root.querySelector<HTMLElement>('.hb-banner');
    root.querySelector<HTMLButtonElement>('.hb-dismiss')?.click();

    expect(localStorage.getItem('hushbox.banner.dismissed.v1')).toBe('h1');
    expect(saveServerDismissal).toHaveBeenCalledWith('h1');
    expect(banner?.dataset['state']).toBe('closed');

    banner?.dispatchEvent(new Event('transitionend'));
    expect(root.children).toHaveLength(0);
  });

  it('hides and caches locally when the server reports it dismissed (authed, local absent)', async () => {
    const fetchServerDismissal = vi.fn().mockResolvedValue(true);
    createBanner(root, { data: makeData(), isAuthenticated: true, fetchServerDismissal });
    await tick();
    expect(fetchServerDismissal).toHaveBeenCalledWith('h1');
    expect(root.querySelector('.hb-banner')).toBeNull();
    expect(localStorage.getItem('hushbox.banner.dismissed.v1')).toBe('h1');
  });

  it('shows when the server reports not dismissed', async () => {
    const fetchServerDismissal = vi.fn().mockResolvedValue(false);
    createBanner(root, { data: makeData(), isAuthenticated: true, fetchServerDismissal });
    await tick();
    expect(root.querySelector<HTMLElement>('.hb-banner')?.dataset['state']).toBe('open');
  });

  it('shows the banner if the server check throws (do not hide a real message)', async () => {
    const fetchServerDismissal = vi.fn().mockRejectedValue(new Error('offline'));
    createBanner(root, { data: makeData(), isAuthenticated: true, fetchServerDismissal });
    await tick();
    expect(root.querySelector<HTMLElement>('.hb-banner')?.dataset['state']).toBe('open');
  });

  it('uses scroll mode and adds a pause control for multiple messages', () => {
    createBanner(root, {
      data: makeData({ messages: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }),
      isAuthenticated: false,
    });
    expect(root.querySelector<HTMLElement>('.hb-vp')?.dataset['mode']).toBe('scroll');
    expect(root.querySelector('button[aria-label="Pause announcements"]')).not.toBeNull();
  });

  it('teardown removes the banner and is safe to call', () => {
    const teardown = createBanner(root, { data: makeData(), isAuthenticated: false });
    expect(root.children.length).toBeGreaterThan(0);
    teardown();
    expect(root.children).toHaveLength(0);
  });
});
