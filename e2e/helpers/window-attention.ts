import type { BrowserContext, CDPSession, Page } from '@playwright/test';

/**
 * Putting the app's own window out of the user's attention, and watching what
 * the app does about it.
 *
 * The app counts activity that arrives while the user is looking away, which
 * means a test about that count has to reach a state the harness normally
 * prevents: Playwright keeps every page permanently focused
 * (`Emulation.setFocusEmulationEnabled`) so tests behave the same whether or
 * not the host has a desktop. Turning that off is not enough on its own —
 * nothing else is competing for focus, so the page keeps it. Minimising the
 * window is not enough either: with focus emulation on, the page still reports
 * itself focused. Only both together produce a page whose
 * `document.hasFocus()` is false, and they produce it deterministically, with a
 * real `blur` and a real `focus` on the way back.
 *
 * Two limits come with that. It is Chromium-only, and it does not work in a
 * headed browser — a real window manager decides focus there, and neither
 * command overrules it. Every suite entry point runs headless, so the lever is
 * available wherever the tests actually run.
 *
 * This is a different state from `leaveApp`/`returnToApp` in the notifications
 * harness: those navigate the tab away from the app entirely, so no window of
 * it exists. Here the window exists, the app is running in it, and the user's
 * attention is simply elsewhere — which is the only state where an unread
 * count is allowed to grow.
 *
 * Raw protocol and page evaluation live here, never in a spec.
 */

const sessions = new WeakMap<Page, Promise<CDPSession>>();

/** The page's protocol session, opened once and reused. */
async function protocolSession(page: Page): Promise<CDPSession> {
  const opening = sessions.get(page) ?? page.context().newCDPSession(page);
  sessions.set(page, opening);
  return opening;
}

/**
 * Take the user's attention off this window: focus emulation off, window
 * minimised. The page keeps running at full speed and stays `visible` — what
 * changes is that it no longer has focus, which is what "away" means for a
 * desktop browser the user has clicked out of.
 */
export async function minimizeAndBlurWindow(page: Page): Promise<void> {
  const session = await protocolSession(page);
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'minimized' },
  });
}

/**
 * Give the window back the user's attention, restoring it before handing focus
 * emulation back so the page sees a genuine `focus` event from the window
 * coming up rather than one manufactured by the override.
 */
export async function restoreAndFocusWindow(page: Page): Promise<void> {
  const session = await protocolSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal' },
  });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

/** Whether the page itself believes it has the user's attention. */
export async function hasWindowFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => document.hasFocus());
}

/** One call the app made to the platform's badge API, and how it settled. */
export interface AppBadgeCall {
  readonly kind: 'set' | 'clear';
  /** The count asked for, or `null` for a clear, which takes no argument. */
  readonly count: number | null;
  /** How the platform answered the real call this spy passed through to. */
  readonly settled: 'pending' | 'fulfilled' | 'rejected';
}

const APP_BADGE_CALLS_KEY = '__hushboxAppBadgeCalls';

/**
 * Watch the OS badge the app sets on its icon. The Badging API is write-only —
 * there is no `getAppBadge` anywhere — so a spy is the only way to observe it
 * at all.
 *
 * It wraps rather than replaces: each recorded call is passed straight to the
 * real platform method and the real promise is returned, so the app runs the
 * shipped code path against the shipped API and `'setAppBadge' in navigator`
 * stays true. Nothing is installed when the platform has no Badging API, since
 * inventing one would make the app's own capability check pass on a browser
 * where it should not.
 *
 * Install before the context's first navigation.
 */
export async function installAppBadgeSpy(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    if (!('setAppBadge' in navigator) || !('clearAppBadge' in navigator)) return;
    const realSet = navigator.setAppBadge.bind(navigator);
    const realClear = navigator.clearAppBadge.bind(navigator);

    const calls: { kind: string; count: number | null; settled: string }[] = [];
    Object.defineProperty(globalThis, key, { value: calls, configurable: true });

    const record = (
      kind: string,
      count: number | null,
      call: () => Promise<void>
    ): Promise<void> => {
      const entry = { kind, count, settled: 'pending' };
      calls.push(entry);
      const settling = call();
      void (async (): Promise<void> => {
        try {
          await settling;
          entry.settled = 'fulfilled';
        } catch {
          entry.settled = 'rejected';
        }
      })();
      return settling;
    };

    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      writable: true,
      value: (count?: number): Promise<void> => record('set', count ?? null, () => realSet(count)),
    });
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      writable: true,
      value: (): Promise<void> => record('clear', null, () => realClear()),
    });
  }, APP_BADGE_CALLS_KEY);
}

/** Every badge call the app has made in this page, oldest first. */
async function appBadgeCalls(page: Page): Promise<AppBadgeCall[]> {
  const recorded = await page.evaluate(
    (key) => (globalThis as unknown as Record<string, unknown>)[key],
    APP_BADGE_CALLS_KEY
  );
  return (recorded ?? []) as AppBadgeCall[];
}

/**
 * The most recent badge call, or `undefined` before the app has made one. The
 * app badges on mount as well as on change, so what matters to a test is the
 * call its own step produced, not the whole history.
 */
export async function lastAppBadgeCall(page: Page): Promise<AppBadgeCall | undefined> {
  const calls = await appBadgeCalls(page);
  return calls.at(-1);
}

/**
 * Whether the platform's badge API is still there to be called — false would
 * mean either a browser without one or a spy that replaced it, and the app
 * skips badging entirely in both cases.
 */
export async function hasAppBadgeApi(page: Page): Promise<boolean> {
  return page.evaluate(() => 'setAppBadge' in navigator && 'clearAppBadge' in navigator);
}
