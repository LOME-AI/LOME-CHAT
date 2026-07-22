// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TEST_IDS, type BannerResponse } from '@hushbox/shared';
import { MARQUEE_SPEED_FAST_PX_PER_S, MARQUEE_SPEED_READABLE_PX_PER_S } from './compute-mode.js';
import { createBanner } from './create-banner.js';
import { markBannerDismissed } from './dismissal-store.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeData(overrides: Partial<BannerResponse> = {}): BannerResponse {
  return { hash: 'h1', messages: [{ text: 'Hello world', variant: 'info' }], ...overrides };
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
      data: makeData({
        messages: [
          { text: 'one', variant: 'info' },
          { text: 'two', variant: 'info' },
          { text: 'three', variant: 'info' },
        ],
      }),
      isAuthenticated: false,
    });
    expect(root.querySelector<HTMLElement>('.hb-vp')?.dataset['mode']).toBe('scroll');
    expect(root.querySelector('button[aria-label="Pause announcements"]')).not.toBeNull();
  });

  it('builds a periodic scroll track: a separator follows every message, including at the loop seam', () => {
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'one', variant: 'info' },
          { text: 'two', variant: 'info' },
          { text: 'three', variant: 'info' },
        ],
      }),
      isAuthenticated: false,
    });
    const track = root.querySelector<HTMLElement>('.hb-track');
    const children = [...(track?.children ?? [])];
    // 3 messages -> [msg sep msg sep msg sep] duplicated for the loop; the seam
    // (end of each half) carries the same separator as any other boundary.
    const half = ['hb-msg', 'hb-sep', 'hb-msg', 'hb-sep', 'hb-msg', 'hb-sep'];
    expect(children.map((child) => child.className)).toEqual([...half, ...half]);
  });

  it('keeps a static track free of trailing separators', () => {
    createBanner(root, { data: makeData(), isAuthenticated: false });
    const track = root.querySelector<HTMLElement>('.hb-track');
    expect(root.querySelector<HTMLElement>('.hb-vp')?.dataset['mode']).toBe('static');
    expect(track?.querySelectorAll('.hb-sep')).toHaveLength(0);
    expect(track?.children).toHaveLength(1);
  });

  it('spawns scroll content fully off-screen right and seams a single over-wide message', () => {
    const scrollWidthSpy = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(1200);
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
    try {
      createBanner(root, {
        data: makeData({ messages: [{ text: 'one very wide message', variant: 'info' }] }),
        isAuthenticated: false,
      });
      expect(root.querySelector<HTMLElement>('.hb-vp')?.dataset['mode']).toBe('scroll');
      const track = root.querySelector<HTMLElement>('.hb-track');
      // Initial offset = the viewport width, so nothing is visible at t=0.
      expect(track?.style.getPropertyValue('--hb-enter-distance')).toBe('800px');
      expect(track?.style.getPropertyValue('--hb-enter-duration')).toBe(
        `${(800 / MARQUEE_SPEED_READABLE_PX_PER_S).toString()}s`
      );
      // A single message still gets a seam separator between the loop copies,
      // and content wider than the viewport keeps the minimum two copies.
      const children = [...(track?.children ?? [])];
      expect(children.map((child) => child.className)).toEqual([
        'hb-msg',
        'hb-sep',
        'hb-msg',
        'hb-sep',
      ]);
      // The loop travels exactly one content period, in px.
      expect(track?.style.getPropertyValue('--hb-loop-distance')).toBe('1200px');
    } finally {
      scrollWidthSpy.mockRestore();
      clientWidthSpy.mockRestore();
    }
  });

  it('duplicates short content until the track covers viewport + one period (no tail dead-air)', () => {
    // Content narrower than the viewport: 2 copies would let the window scroll
    // past the clone's tail. copies = ceil((1440 + 500) / 500) = 4.
    const scrollWidthSpy = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(500);
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1440);
    try {
      createBanner(root, {
        data: makeData({
          messages: [
            { text: 'one', variant: 'info' },
            { text: 'two', variant: 'info' },
          ],
        }),
        isAuthenticated: false,
      });
      const track = root.querySelector<HTMLElement>('.hb-track');
      const children = [...(track?.children ?? [])];
      const period = ['hb-msg', 'hb-sep', 'hb-msg', 'hb-sep'];
      expect(children.map((child) => child.className)).toEqual([
        ...period,
        ...period,
        ...period,
        ...period,
      ]);
      expect(track?.style.getPropertyValue('--hb-loop-distance')).toBe('500px');
      // Loop duration covers one content period at the shared speed.
      expect(track?.style.getPropertyValue('--hb-marquee-duration')).toBe(
        `${(500 / MARQUEE_SPEED_FAST_PX_PER_S).toString()}s`
      );
    } finally {
      scrollWidthSpy.mockRestore();
      clientWidthSpy.mockRestore();
    }
  });

  it('measures the scroll viewport after the pause control is inserted', () => {
    // The viewport is flex-remaining space, so its width shrinks once the pause
    // button + divider exist: 800px with the chrome present, 900px without.
    const scrollWidthSpy = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(1200);
    const clientWidthSpy = vi
      .spyOn(Element.prototype, 'clientWidth', 'get')
      .mockImplementation(() =>
        root.querySelector('button[aria-label="Pause announcements"]') === null ? 900 : 800
      );
    try {
      createBanner(root, {
        data: makeData({ messages: [{ text: 'one very wide message', variant: 'info' }] }),
        isAuthenticated: false,
      });
      const track = root.querySelector<HTMLElement>('.hb-track');
      expect(track?.style.getPropertyValue('--hb-enter-distance')).toBe('800px');
      expect(track?.style.getPropertyValue('--hb-enter-duration')).toBe(
        `${(800 / MARQUEE_SPEED_READABLE_PX_PER_S).toString()}s`
      );
    } finally {
      scrollWidthSpy.mockRestore();
      clientWidthSpy.mockRestore();
    }
  });

  it('scrolls a single message that only overflows once the pause control narrows the viewport', () => {
    const scrollWidthSpy = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(850);
    const clientWidthSpy = vi
      .spyOn(Element.prototype, 'clientWidth', 'get')
      .mockImplementation(() =>
        root.querySelector('button[aria-label="Pause announcements"]') === null ? 900 : 800
      );
    try {
      createBanner(root, {
        data: makeData({ messages: [{ text: 'fits without chrome only', variant: 'info' }] }),
        isAuthenticated: false,
      });
      expect(root.querySelector<HTMLElement>('.hb-vp')?.dataset['mode']).toBe('scroll');
      expect(root.querySelector('button[aria-label="Pause announcements"]')).not.toBeNull();
    } finally {
      scrollWidthSpy.mockRestore();
      clientWidthSpy.mockRestore();
    }
  });

  it('leaves no pause control behind when the message stays static', () => {
    createBanner(root, { data: makeData(), isAuthenticated: false });
    expect(root.querySelector<HTMLElement>('.hb-vp')?.dataset['mode']).toBe('static');
    expect(root.querySelector('button[aria-label="Pause announcements"]')).toBeNull();
    expect(root.querySelector('.hb-divider')).toBeNull();
  });

  it('makes every track link inert, clones included', () => {
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'one', variant: 'info', href: '/a', linkText: 'A' },
          { text: 'two', variant: 'info', href: '/b', linkText: 'B' },
        ],
      }),
      isAuthenticated: false,
    });
    const trackLinks = root.querySelectorAll<HTMLAnchorElement>('.hb-track a');
    // Originals + loop clones.
    expect(trackLinks).toHaveLength(4);
    for (const link of trackLinks) expect(link.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves no tabbable element inside the aria-hidden track (static mode included)', () => {
    createBanner(root, {
      data: makeData({
        messages: [{ text: 'one', variant: 'info', href: '/a', linkText: 'A' }],
      }),
      isAuthenticated: false,
    });
    const track = root.querySelector<HTMLElement>('.hb-track');
    expect(track?.getAttribute('aria-hidden')).toBe('true');
    const focusables = track?.querySelectorAll<HTMLElement>('a, button, [tabindex]') ?? [];
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of focusables) expect(el.tabIndex).toBe(-1);
  });

  it('renders an accessible static list carrying each linked message with a real link', () => {
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'Maintenance tonight', variant: 'warning', href: '/status', linkText: 'Status' },
          { text: 'No link here', variant: 'info' },
          { text: 'New models', variant: 'info', href: '/changelog' },
        ],
      }),
      isAuthenticated: false,
    });
    const list = root.querySelector<HTMLUListElement>('ul.hb-sr-list');
    expect(list).not.toBeNull();
    expect(list?.closest('[aria-hidden="true"]')).toBeNull();
    const items = [...(list?.querySelectorAll('li') ?? [])];
    expect(items.map((item) => item.textContent.includes('Maintenance tonight'))).toContain(true);
    const links = [...(list?.querySelectorAll<HTMLAnchorElement>('a.hb-sr-link') ?? [])];
    expect(links.map((link) => [link.getAttribute('href'), link.textContent])).toEqual([
      ['/status', 'Status'],
      ['/changelog', 'Learn more'],
    ]);
    // The accessible copies are the tabbable ones.
    for (const link of links) expect(link.tabIndex).toBe(0);
  });

  it('turns the pause control into a play control while paused', () => {
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'one', variant: 'info' },
          { text: 'two', variant: 'info' },
        ],
      }),
      isAuthenticated: false,
    });
    const toggle = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause announcements"]'
    );
    if (toggle === null) throw new Error('pause control missing');
    expect(toggle.querySelector('rect')).not.toBeNull();
    toggle.click();
    expect(toggle.getAttribute('aria-label')).toBe('Play announcements');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.querySelector('rect')).toBeNull();
    expect(toggle.querySelector('path')).not.toBeNull();
    toggle.click();
    expect(toggle.getAttribute('aria-label')).toBe('Pause announcements');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.querySelector('rect')).not.toBeNull();
  });

  it('clears the paused state on Play while focus stays on the toggle', () => {
    // Regression pin: resume must not depend on focus leaving the banner. The
    // CSS focus-pause is scoped away from the buttons (banner-styles.test.ts);
    // this pins the state side — `data-paused` flips on click alone, with the
    // clicked toggle still the active element.
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'one', variant: 'info' },
          { text: 'two', variant: 'info' },
        ],
      }),
      isAuthenticated: false,
    });
    const banner = root.querySelector<HTMLElement>('.hb-banner');
    const toggle = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause announcements"]'
    );
    if (toggle === null) throw new Error('pause control missing');
    toggle.focus();
    toggle.click();
    expect(banner?.dataset['paused']).toBe('true');
    toggle.click();
    expect(document.activeElement).toBe(toggle);
    expect(banner?.dataset['paused']).toBe('false');
  });

  it('keeps the explicit paused state when focus moves elsewhere', () => {
    // The toggle's aria-pressed is the source of truth for the explicit pause;
    // focus and blur must never clear it.
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'one', variant: 'info' },
          { text: 'two', variant: 'info' },
        ],
      }),
      isAuthenticated: false,
    });
    const banner = root.querySelector<HTMLElement>('.hb-banner');
    const toggle = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause announcements"]'
    );
    if (toggle === null) throw new Error('pause control missing');
    toggle.focus();
    toggle.click();
    expect(banner?.dataset['paused']).toBe('true');
    root.querySelector<HTMLButtonElement>('.hb-dismiss')?.focus();
    toggle.blur();
    expect(banner?.dataset['paused']).toBe('true');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('teardown removes the banner and is safe to call', () => {
    const teardown = createBanner(root, { data: makeData(), isAuthenticated: false });
    expect(root.children.length).toBeGreaterThan(0);
    teardown();
    expect(root.children).toHaveLength(0);
  });

  it('renders a warning message with its own data-variant and inline icon', () => {
    createBanner(root, {
      data: makeData({ messages: [{ text: 'Heads up', variant: 'warning' }] }),
      isAuthenticated: false,
    });
    const message = root.querySelector<HTMLElement>('.hb-msg');
    expect(message?.dataset['variant']).toBe('warning');
    expect(message?.querySelector('.hb-ico svg')).not.toBeNull();
  });

  it('renders a critical message with its own data-variant and inline icon', () => {
    createBanner(root, {
      data: makeData({ messages: [{ text: 'Outage', variant: 'critical' }] }),
      isAuthenticated: false,
    });
    const message = root.querySelector<HTMLElement>('.hb-msg');
    expect(message?.dataset['variant']).toBe('critical');
    expect(message?.querySelector('.hb-ico svg')).not.toBeNull();
  });

  it('does not set a banner-level variant or render a banner-level icon', () => {
    createBanner(root, { data: makeData(), isAuthenticated: false });
    const banner = root.querySelector<HTMLElement>('.hb-banner');
    expect(banner?.dataset['variant']).toBeUndefined();
    expect(banner?.querySelector(':scope > .hb-ico')).toBeNull();
  });

  it('renders mixed variants per message in one banner', () => {
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'informational', variant: 'info' },
          { text: 'alarming', variant: 'critical' },
        ],
      }),
      isAuthenticated: false,
    });
    // The scroll track duplicates content for a seamless loop; assert on the
    // first copy's message pair.
    const messages = [...root.querySelectorAll<HTMLElement>('.hb-msg')].slice(0, 2);
    expect(messages.map((message) => message.dataset['variant'])).toEqual(['info', 'critical']);
    for (const message of messages) {
      expect(message.querySelector('.hb-ico svg')).not.toBeNull();
    }
  });

  it('keeps each inline icon decorative (aria-hidden)', () => {
    createBanner(root, {
      data: makeData({ messages: [{ text: 'Heads up', variant: 'warning' }] }),
      isAuthenticated: false,
    });
    expect(root.querySelector('.hb-msg .hb-ico')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('emits registry test ids on the banner root, messages, and dismiss button', () => {
    createBanner(root, { data: makeData(), isAuthenticated: false });
    expect(root.querySelector<HTMLElement>('.hb-banner')?.dataset['testid']).toBe(
      TEST_IDS.announcementBanner
    );
    expect(root.querySelector<HTMLElement>('.hb-msg')?.dataset['testid']).toBe(
      TEST_IDS.announcementBannerMessage
    );
    expect(root.querySelector<HTMLElement>('.hb-dismiss')?.dataset['testid']).toBe(
      TEST_IDS.announcementBannerDismiss
    );
  });

  it('renders a message link with custom link text', () => {
    createBanner(root, {
      data: makeData({
        messages: [
          { text: 'See the update', variant: 'info', href: '/changelog', linkText: 'Details' },
        ],
      }),
      isAuthenticated: false,
    });
    const link = root.querySelector<HTMLAnchorElement>('a.hb-link');
    expect(link?.getAttribute('href')).toBe('/changelog');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe('Details');
  });

  it('defaults a link without linkText to "Learn more"', () => {
    createBanner(root, {
      data: makeData({
        messages: [{ text: 'See the update', variant: 'info', href: '/changelog' }],
      }),
      isAuthenticated: false,
    });
    expect(root.querySelector<HTMLAnchorElement>('a.hb-link')?.textContent).toBe('Learn more');
  });

  it('toggles and restores paused state via the pause control, then cleans up', () => {
    const teardown = createBanner(root, {
      data: makeData({
        messages: [
          { text: 'one', variant: 'info' },
          { text: 'two', variant: 'info' },
        ],
      }),
      isAuthenticated: false,
    });
    const pause = root.querySelector<HTMLButtonElement>('button[aria-label="Pause announcements"]');
    const banner = root.querySelector<HTMLElement>('.hb-banner');
    pause?.click();
    expect(banner?.dataset['paused']).toBe('true');
    expect(pause?.getAttribute('aria-pressed')).toBe('true');
    pause?.click();
    expect(banner?.dataset['paused']).toBe('false');
    expect(() => {
      teardown();
    }).not.toThrow();
  });

  it('dismisses without a save callback when authenticated but none is provided', () => {
    createBanner(root, { data: makeData(), isAuthenticated: true });
    const dismiss = root.querySelector<HTMLButtonElement>('.hb-dismiss');
    expect(() => dismiss?.click()).not.toThrow();
    expect(root.querySelector<HTMLElement>('.hb-banner')?.dataset['state']).toBe('closed');
  });

  it('dismisses for an unauthenticated user without calling the server', () => {
    const saveServerDismissal = vi.fn();
    createBanner(root, { data: makeData(), isAuthenticated: false, saveServerDismissal });
    root.querySelector<HTMLButtonElement>('.hb-dismiss')?.click();
    expect(saveServerDismissal).not.toHaveBeenCalled();
  });

  it('ignores a transitionend bubbled from a child and removes on the fallback timer', () => {
    vi.useFakeTimers();
    try {
      createBanner(root, { data: makeData(), isAuthenticated: false });
      const banner = root.querySelector<HTMLElement>('.hb-banner');
      root.querySelector<HTMLButtonElement>('.hb-dismiss')?.click();
      const track = banner?.querySelector<HTMLElement>('.hb-track');
      // A transitionend from a descendant must not finish the close.
      track?.dispatchEvent(new Event('transitionend', { bubbles: true }));
      expect(banner?.isConnected).toBe(true);
      // The banner's own transitionend finishes it; the later fallback is a no-op.
      banner?.dispatchEvent(new Event('transitionend'));
      vi.advanceTimersByTime(300);
      expect(root.querySelector('.hb-banner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reveal when torn down before the server dismissal check resolves', async () => {
    let resolveDismissal: (value: boolean) => void = () => {};
    const fetchServerDismissal = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDismissal = resolve;
        })
    );
    const teardown = createBanner(root, {
      data: makeData(),
      isAuthenticated: true,
      fetchServerDismissal,
    });
    teardown();
    resolveDismissal(false);
    await tick();
    expect(root.querySelector('.hb-banner')).toBeNull();
  });

  it('does not reveal when torn down before the server dismissal check rejects', async () => {
    let rejectDismissal: (reason?: unknown) => void = () => {};
    const fetchServerDismissal = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectDismissal = reject;
        })
    );
    const teardown = createBanner(root, {
      data: makeData(),
      isAuthenticated: true,
      fetchServerDismissal,
    });
    teardown();
    rejectDismissal(new Error('offline'));
    await tick();
    expect(root.querySelector('.hb-banner')).toBeNull();
  });
});
