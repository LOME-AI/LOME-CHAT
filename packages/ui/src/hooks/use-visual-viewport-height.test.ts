import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useVisualViewportHeight } from './use-visual-viewport-height';

describe('useVisualViewportHeight', () => {
  let originalVisualViewport: VisualViewport | null;
  let originalInnerHeight: number;
  let resizeHandler: (() => void) | null = null;
  let windowResizeHandler: (() => void) | null = null;
  const originalAddEventListener = window.addEventListener.bind(globalThis);
  const originalRemoveEventListener = window.removeEventListener.bind(globalThis);

  const mockVisualViewport = {
    height: 800,
    width: 400,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === 'resize') {
        resizeHandler = handler;
      }
    }),
    removeEventListener: vi.fn(),
    onresize: null,
    onscroll: null,
    dispatchEvent: vi.fn(),
  };

  beforeEach(() => {
    originalVisualViewport = window.visualViewport;
    originalInnerHeight = window.innerHeight;
    resizeHandler = null;
    windowResizeHandler = null;

    mockVisualViewport.height = 800;

    // Mock window.addEventListener to capture resize handler
    window.addEventListener = vi.fn((event: string, handler: EventListener) => {
      if (event === 'resize') {
        windowResizeHandler = handler as () => void;
      }
      originalAddEventListener(event, handler);
    }) as typeof globalThis.addEventListener;

    window.removeEventListener = vi.fn((event: string, handler: EventListener) => {
      originalRemoveEventListener(event, handler);
    }) as typeof globalThis.removeEventListener;

    Object.defineProperty(globalThis, 'visualViewport', {
      value: mockVisualViewport,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, 'innerHeight', {
      value: 800,
      writable: true,
      configurable: true,
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'visualViewport', {
      value: originalVisualViewport,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, 'innerHeight', {
      value: originalInnerHeight,
      writable: true,
      configurable: true,
    });

    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns initial viewport height', () => {
    const { result } = renderHook(() => useVisualViewportHeight());

    expect(result.current).toBe(800);
  });

  it('registers resize event listener on mount', () => {
    renderHook(() => useVisualViewportHeight());

    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function)
    );
  });

  it('removes resize event listener on unmount', () => {
    const { unmount } = renderHook(() => useVisualViewportHeight());

    unmount();

    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function)
    );
  });

  it('updates height when viewport resizes', () => {
    const { result } = renderHook(() => useVisualViewportHeight());

    expect(result.current).toBe(800);

    // Simulate keyboard opening (viewport shrinks)
    mockVisualViewport.height = 450;

    act(() => {
      if (resizeHandler) resizeHandler();
      vi.runAllTimers();
    });

    expect(result.current).toBe(450);
  });

  it('handles iOS Safari delayed viewport reporting with 300ms timeout', () => {
    const { result } = renderHook(() => useVisualViewportHeight());

    mockVisualViewport.height = 500;

    act(() => {
      if (resizeHandler) resizeHandler();
      // Run only the immediate RAF, not the 300ms timeout
      vi.advanceTimersByTime(16); // One frame
    });

    expect(result.current).toBe(500);

    // Safari reports different dimensions after animation completes
    mockVisualViewport.height = 450;

    act(() => {
      // Advance past the 300ms timeout and run its RAF
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe(450);
  });

  it('does not update state when height is unchanged', () => {
    const { result } = renderHook(() => useVisualViewportHeight());

    const initialHeight = result.current;

    act(() => {
      if (resizeHandler) resizeHandler();
      vi.runAllTimers();
    });

    expect(result.current).toBe(initialHeight);
  });

  it('falls back to innerHeight when visualViewport is unavailable', () => {
    Object.defineProperty(globalThis, 'visualViewport', {
      value: null,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, 'innerHeight', {
      value: 700,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useVisualViewportHeight());

    expect(result.current).toBe(700);
  });

  it('cleans up requestAnimationFrame on unmount', () => {
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

    const { unmount } = renderHook(() => useVisualViewportHeight());

    // Trigger a resize to schedule RAF
    act(() => {
      if (resizeHandler) resizeHandler();
    });

    unmount();

    expect(cancelSpy).toHaveBeenCalled();
  });

  it('registers window resize event listener on mount', () => {
    renderHook(() => useVisualViewportHeight());

    expect(window.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('removes window resize event listener on unmount', () => {
    const { unmount } = renderHook(() => useVisualViewportHeight());

    unmount();

    expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('updates height when window resizes (Playwright/desktop fallback)', () => {
    const { result } = renderHook(() => useVisualViewportHeight());

    expect(result.current).toBe(800);

    // Simulate viewport shrinking (like Playwright setViewportSize)
    mockVisualViewport.height = 450;
    Object.defineProperty(globalThis, 'innerHeight', {
      value: 450,
      writable: true,
      configurable: true,
    });

    act(() => {
      if (windowResizeHandler) windowResizeHandler();
      vi.runAllTimers();
    });

    expect(result.current).toBe(450);
  });

  it('updates height via window.resize when visualViewport is unavailable', () => {
    Object.defineProperty(globalThis, 'visualViewport', {
      value: null,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(globalThis, 'innerHeight', {
      value: 800,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useVisualViewportHeight());

    expect(result.current).toBe(800);

    Object.defineProperty(globalThis, 'innerHeight', {
      value: 500,
      writable: true,
      configurable: true,
    });

    act(() => {
      if (windowResizeHandler) windowResizeHandler();
      vi.runAllTimers();
    });

    expect(result.current).toBe(500);
  });

  it('coalesces rapid resizes into a single scheduled frame', () => {
    const { result } = renderHook(() => useVisualViewportHeight());
    expect(result.current).toBe(800);

    mockVisualViewport.height = 600;
    act(() => {
      // First resize schedules a frame; the second sees the pending frame and
      // returns early (the rafRef guard), so no duplicate frame is scheduled.
      resizeHandler?.();
      resizeHandler?.();
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current).toBe(600);
  });

  describe('SSR — window absent', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;

    it('server-renders to a height of 0 when window is absent', () => {
      const Probe = (): React.ReactElement =>
        React.createElement('span', { 'data-height': String(useVisualViewportHeight()) });
      Reflect.deleteProperty(globalThis, 'window');
      try {
        const html = renderToStaticMarkup(React.createElement(Probe));
        expect(html).toContain('data-height="0"');
      } finally {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          writable: true,
          value: originalWindow,
        });
      }
    });
  });
});
