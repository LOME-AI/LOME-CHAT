import * as React from 'react';
import { renderHook, act } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { useIsMobile } from './use-is-mobile';

describe('useIsMobile', () => {
  const originalMatchMedia = globalThis.matchMedia;
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let mediaQueryListeners: Map<string, (e: MediaQueryListEvent) => void>;

  const createMockMatchMedia = (matches: boolean) => {
    mediaQueryListeners = new Map();
    mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') {
          mediaQueryListeners.set(query, callback);
        }
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: mockMatchMedia,
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('returns true when viewport is below 768px', () => {
    createMockMatchMedia(true); // matches max-width: 767px
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
  });

  it('returns false when viewport is 768px or above', () => {
    createMockMatchMedia(false); // does not match max-width: 767px
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it('uses correct breakpoint query (max-width: 767px)', () => {
    createMockMatchMedia(false);
    renderHook(() => useIsMobile());

    expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 767px)');
  });

  it('updates when media query changes from desktop to mobile', () => {
    createMockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);

    // Simulate viewport resize to mobile
    act(() => {
      const listener = mediaQueryListeners.get('(max-width: 767px)');
      if (listener) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(result.current).toBe(true);
  });

  it('updates when media query changes from mobile to desktop', () => {
    createMockMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);

    // Simulate viewport resize to desktop
    act(() => {
      const listener = mediaQueryListeners.get('(max-width: 767px)');
      if (listener) {
        listener({ matches: false } as MediaQueryListEvent);
      }
    });

    expect(result.current).toBe(false);
  });

  it('cleans up event listener on unmount', () => {
    createMockMatchMedia(false);
    const { unmount } = renderHook(() => useIsMobile());

    // The hook calls matchMedia twice: once in useState init, once in useEffect
    // We need the one from useEffect (second call) since that's where listener is added
    const lastCallIndex = mockMatchMedia.mock.results.length - 1;
    const lastResult = mockMatchMedia.mock.results[lastCallIndex];
    const mediaQueryList = lastResult?.value as { removeEventListener: ReturnType<typeof vi.fn> };
    unmount();

    expect(mediaQueryList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('useIsMobile (SSR — window absent)', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  it('server-renders to false when window is absent', () => {
    const Probe = (): React.ReactElement =>
      React.createElement('span', { 'data-mobile': String(useIsMobile()) });
    Reflect.deleteProperty(globalThis, 'window');
    try {
      const html = renderToStaticMarkup(React.createElement(Probe));
      expect(html).toContain('data-mobile="false"');
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    }
  });
});
