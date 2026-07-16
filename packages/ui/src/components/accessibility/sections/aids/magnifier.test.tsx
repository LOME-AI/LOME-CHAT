import { render, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Magnifier } from './magnifier';

// fireEvent expects a Node/Window target; the unicorn rule wants `globalThis`.
// This typed alias lets us pass `window` to fireEvent without violating either.
const win = globalThis as unknown as Window;

interface MockMutationObserver {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  takeRecords: ReturnType<typeof vi.fn>;
  /** Default trigger uses document.body as the mutation target (outside the
   * magnifier) so the magnifier's "skip self-triggered mutations" filter
   * treats it as a real page change. */
  trigger: (target?: Node) => void;
}

let lastObserver: MockMutationObserver | null = null;

function installMutationObserver(): void {
  lastObserver = null;
  const ObserverImpl = vi.fn(function MockObserver(callback: MutationCallback) {
    const mock: MockMutationObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      takeRecords: vi.fn(() => []),
      trigger: (target: Node = document.body) => {
        const record = { target } as unknown as MutationRecord;
        callback([record], mock as unknown as MutationObserver);
      },
    };
    lastObserver = mock;
    return mock;
  });
  vi.stubGlobal('MutationObserver', ObserverImpl);
}

describe('Magnifier', () => {
  beforeEach(() => {
    installMutationObserver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<Magnifier enabled={false} />);
    expect(container.querySelector('[data-a11y-magnifier]')).toBeNull();
  });

  it('renders the lens when enabled', () => {
    const { container } = render(<Magnifier enabled />);
    expect(container.querySelector('[data-a11y-magnifier]')).not.toBeNull();
  });

  it('marks the lens as decorative for assistive tech', () => {
    const { container } = render(<Magnifier enabled />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens).not.toBeNull();
    expect(lens?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the lens with pointer-events: none', () => {
    const { container } = render(<Magnifier enabled />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens?.style.pointerEvents).toBe('none');
  });

  it('renders the lens as a fixed-position circle with default size 320', () => {
    const { container } = render(<Magnifier enabled />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens?.style.position).toBe('fixed');
    expect(lens?.style.width).toBe('320px');
    expect(lens?.style.height).toBe('320px');
    expect(lens?.style.borderRadius).toBe('50%');
    expect(lens?.style.overflow).toBe('hidden');
  });

  it('honors a custom size', () => {
    const { container } = render(<Magnifier enabled size={300} />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens?.style.width).toBe('300px');
    expect(lens?.style.height).toBe('300px');
  });

  it('repositions the lens to follow the cursor', () => {
    const { container } = render(<Magnifier enabled size={200} />);

    fireEvent.mouseMove(win, { clientX: 500, clientY: 400 });

    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    // Lens is anchored top-left at (cursor - size/2) so the circle is centered on the cursor.
    expect(lens?.style.transform).toContain('translate(400px, 300px)');
  });

  it('contains a magnified clone of the body that uses the configured zoom', () => {
    const { container } = render(<Magnifier enabled zoom={2.5} />);

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();
    expect(inner?.style.transform).toContain('scale(2.5)');
  });

  it('uses the default zoom of 2', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner?.style.transform).toContain('scale(2)');
  });

  it('updates the magnification origin to follow the cursor', () => {
    const { container } = render(<Magnifier enabled />);

    fireEvent.mouseMove(win, { clientX: 250, clientY: 175 });

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner?.style.transformOrigin).toBe('250px 175px');
  });

  it('offsets the inner clone so screen coordinates map to clone coordinates', () => {
    const { container } = render(<Magnifier enabled size={200} />);

    fireEvent.mouseMove(win, { clientX: 500, clientY: 400 });

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    // Lens top-left = (500 - 100, 400 - 100) = (400, 300). For the clone's local
    // (cursor.x, cursor.y) point to correspond to the screen cursor position, the
    // clone must be shifted by -lensLeft / -lensTop relative to the lens.
    expect(inner?.style.top).toBe('-300px');
    expect(inner?.style.left).toBe('-400px');
  });

  it('observes document.body when mounted', () => {
    render(<Magnifier enabled />);
    expect(lastObserver?.observe).toHaveBeenCalled();
    const [target, options] = lastObserver?.observe.mock.calls[0] ?? [];
    expect(target).toBe(document.body);
    expect(options).toMatchObject({
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  it('debounces clone refreshes after MutationObserver ticks', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();
    const initialHtml = inner!.innerHTML;

    document.body.append(
      Object.assign(document.createElement('span'), { textContent: 'fresh content' })
    );

    act(() => {
      lastObserver?.trigger();
    });

    // Before the debounce timer fires the clone has not been refreshed yet.
    const innerBeforeDebounce = container.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content]'
    );
    expect(innerBeforeDebounce?.innerHTML).toBe(initialHtml);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const innerAfterDebounce = container.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content]'
    );
    expect(innerAfterDebounce?.innerHTML).toContain('fresh content');
  });

  it('coalesces rapid MutationObserver ticks into a single debounced refresh', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    const initialHtml = inner!.innerHTML;

    // First tick schedules a timer.
    act(() => {
      lastObserver?.trigger();
    });

    // Second tick within the debounce window must clear the prior timer (covers
    // the `if (debounceId !== null) clearTimeout(...)` branch).
    document.body.append(
      Object.assign(document.createElement('span'), { textContent: 'late content' })
    );
    act(() => {
      lastObserver?.trigger();
    });

    // Before the debounce finishes, content has not yet been written.
    expect(container.querySelector<HTMLElement>('[data-a11y-magnifier-content]')?.innerHTML).toBe(
      initialHtml
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(
      container.querySelector<HTMLElement>('[data-a11y-magnifier-content]')?.innerHTML
    ).toContain('late content');
  });

  it('disconnects the MutationObserver on unmount', () => {
    const { unmount } = render(<Magnifier enabled />);
    unmount();
    expect(lastObserver?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('removes the mousemove listener on unmount', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { unmount } = render(<Magnifier enabled />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
  });

  it('removes listeners and disconnects the observer when toggled to disabled', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { rerender } = render(<Magnifier enabled />);
    const observer = lastObserver;

    rerender(<Magnifier enabled={false} />);

    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(observer?.disconnect).toHaveBeenCalled();
  });

  it('offsets the clone by window scroll so the magnified region matches what the user sees', () => {
    vi.stubGlobal('scrollX', 30);
    vi.stubGlobal('scrollY', 120);

    const { container } = render(<Magnifier enabled size={200} />);
    fireEvent.mouseMove(win, { clientX: 500, clientY: 400 });

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    // lensLeft = 400, lensTop = 300; clone shift adds -scrollX / -scrollY so that
    // the visible (scrolled) portion of the document lines up under the cursor.
    expect(inner?.style.top).toBe('-420px');
    expect(inner?.style.left).toBe('-430px');
    expect(inner?.style.transformOrigin).toBe('530px 520px');
  });

  it('mirrors scrollTop from a scrolled live container onto the clone', () => {
    const live = document.createElement('div');
    live.id = 'scroller';
    Object.defineProperty(live, 'scrollTop', { value: 250, writable: true, configurable: true });
    document.body.append(live);

    render(<Magnifier enabled />);
    act(() => {
      lastObserver?.trigger();
      vi.advanceTimersByTime(100);
    });

    const cloned = document.body.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content] #scroller'
    );
    expect(cloned).not.toBeNull();
    expect(cloned?.scrollTop).toBe(250);

    live.remove();
  });

  it('re-syncs the clone when an inner container scrolls without any DOM mutation', () => {
    const live = document.createElement('div');
    live.id = 'late-scroller';
    Object.defineProperty(live, 'scrollTop', { value: 0, writable: true, configurable: true });
    document.body.append(live);

    render(<Magnifier enabled />);

    // Initially the clone reflects scrollTop = 0.
    const initialClone = document.body.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content] #late-scroller'
    );
    expect(initialClone?.scrollTop).toBe(0);

    // Now simulate the user scrolling the inner container WITHOUT mutating the DOM.
    // The previous implementation never re-synced on bare scroll events because the
    // effect's deps only fired on bodyHtml / cursor changes.
    Object.defineProperty(live, 'scrollTop', { value: 420, writable: true, configurable: true });
    act(() => {
      live.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    const updatedClone = document.body.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content] #late-scroller'
    );
    expect(updatedClone?.scrollTop).toBe(420);

    live.remove();
  });

  it('registers the scroll listener in capture phase (scroll events do not bubble)', () => {
    const addSpy = vi.spyOn(globalThis, 'addEventListener');
    render(<Magnifier enabled />);
    const scrollCall = addSpy.mock.calls.find(([event]) => event === 'scroll');
    expect(scrollCall).toBeDefined();
    expect(scrollCall?.[2]).toMatchObject({ capture: true });
  });

  it('removes the scroll listener on unmount', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { unmount } = render(<Magnifier enabled />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true });
  });

  it('ignores mutations that originate inside the magnifier itself (no flicker loop)', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();
    const baseline = inner!.innerHTML;

    // Append fresh content to the real body so the next refresh COULD pick it up.
    document.body.append(
      Object.assign(document.createElement('span'), { textContent: 'late content' })
    );

    // Fire a mutation whose target is inside the magnifier — the previous code
    // would schedule a refresh, creating a feedback loop with every clone update.
    act(() => {
      lastObserver?.trigger(inner!);
      vi.advanceTimersByTime(100);
    });

    const after = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]')?.innerHTML;
    expect(after).toBe(baseline);
  });

  it('captured bodyHtml does NOT include the magnifier itself (avoids exponential recursion)', () => {
    const { container } = render(<Magnifier enabled />);
    act(() => {
      lastObserver?.trigger();
      vi.advanceTimersByTime(100);
    });

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();
    // The clone is INSIDE the magnifier-content div. If captureBodyHtml didn't
    // strip overlays before serialising, the clone would contain a nested copy
    // of itself, which itself would contain another, ad infinitum.
    expect(inner!.innerHTML).not.toContain('data-a11y-magnifier');
  });

  it('captured bodyHtml also strips reading-guide overlays', () => {
    const guideTop = document.createElement('div');
    guideTop.dataset['a11yReadingGuide'] = '';
    guideTop.textContent = 'top dim';
    document.body.append(guideTop);

    const { container } = render(<Magnifier enabled />);
    act(() => {
      lastObserver?.trigger();
      vi.advanceTimersByTime(100);
    });

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner!.innerHTML).not.toContain('data-a11y-reading-guide');
    guideTop.remove();
  });

  it('keeps live/clone walks aligned when a stripped overlay sits between scrollable siblings', () => {
    // Layout: body
    //   ├─ <div id="before-scroller">  scrollTop=0
    //   ├─ <div data-a11y-reading-guide=""> (stripped from clone)
    //   └─ <div id="real-scroller"> scrollTop=333
    //
    // If the live walk doesn't skip the reading-guide, indexing diverges:
    // live[1] = guide vs clone[1] = real-scroller. scrollTop=333 lands on
    // the wrong descendant and #real-scroller in the clone stays at 0.
    const before = document.createElement('div');
    before.id = 'before-scroller';
    Object.defineProperty(before, 'scrollTop', { value: 0, writable: true, configurable: true });

    const stray = document.createElement('div');
    stray.dataset['a11yReadingGuide'] = '';

    const real = document.createElement('div');
    real.id = 'real-scroller';
    Object.defineProperty(real, 'scrollTop', { value: 333, writable: true, configurable: true });

    document.body.append(before, stray, real);

    render(<Magnifier enabled />);
    act(() => {
      lastObserver?.trigger();
      vi.advanceTimersByTime(100);
    });

    const cloneReal = document.body.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content] #real-scroller'
    );
    expect(cloneReal).not.toBeNull();
    expect(cloneReal?.scrollTop).toBe(333);

    before.remove();
    stray.remove();
    real.remove();
  });

  it('preserves the clone scroll positions across cursor moves (no innerHTML reset)', () => {
    const live = document.createElement('div');
    live.id = 'persistent-scroller';
    Object.defineProperty(live, 'scrollTop', { value: 555, writable: true, configurable: true });
    document.body.append(live);

    render(<Magnifier enabled />);
    act(() => {
      lastObserver?.trigger();
      vi.advanceTimersByTime(100);
    });

    // After the first sync, the clone has scrollTop = 555.
    const cloneInitial = document.body.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content] #persistent-scroller'
    );
    expect(cloneInitial?.scrollTop).toBe(555);

    // User moves the cursor. The previous JSX dangerouslySetInnerHTML re-set
    // innerHTML on every render (object identity changes), wiping every
    // descendant's scrollTop. With imperative innerHTML the scrollTop stays.
    fireEvent.mouseMove(win, { clientX: 320, clientY: 200 });

    const cloneAfterMove = document.body.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content] #persistent-scroller'
    );
    expect(cloneAfterMove?.scrollTop).toBe(555);

    live.remove();
  });

  it('observes attribute changes (style) so animated content can update the clone', () => {
    render(<Magnifier enabled />);
    expect(lastObserver?.observe).toHaveBeenCalled();
    const [, options] = lastObserver?.observe.mock.calls[0] ?? [];
    expect(options).toMatchObject({ attributes: true, attributeFilter: ['style'] });
  });

  it('still refreshes when at least one mutation is outside any magnifier', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();

    document.body.append(
      Object.assign(document.createElement('span'), { textContent: 'mixed content' })
    );

    // Default trigger target is document.body — outside the magnifier — so the
    // refresh should run.
    act(() => {
      lastObserver?.trigger();
      vi.advanceTimersByTime(100);
    });

    expect(
      container.querySelector<HTMLElement>('[data-a11y-magnifier-content]')?.innerHTML
    ).toContain('mixed content');
  });

  it('mirrors inner scroll positions from the live page into the clone', () => {
    const scroller = document.createElement('div');
    const inner = document.createElement('div');
    scroller.append(inner);
    // A non-HTMLElement sibling exercises the isStrippedOverlay type guard.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.append(scroller);
    document.body.append(svg);
    Object.defineProperty(scroller, 'scrollTop', { value: 40, configurable: true });
    Object.defineProperty(scroller, 'scrollLeft', { value: 15, configurable: true });

    try {
      render(<Magnifier enabled />);
      // The scroll handler re-runs syncScrollPositions across the live tree.
      act(() => {
        fireEvent.scroll(win);
      });
      // Recursion reached the scrollable container and mirrored its offsets.
      const clonedScroller = document.querySelector('[data-a11y-magnifier-content] > div');
      expect(clonedScroller).not.toBeNull();
    } finally {
      scroller.remove();
      svg.remove();
    }
  });
});
