import * as React from 'react';
import { renderHook, act } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { useIsTouchDevice } from './use-is-touch-device';
import { TouchDeviceOverrideContext } from './touch-device-override-context';

describe('useIsTouchDevice', () => {
  const originalMatchMedia = globalThis.matchMedia;
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let mediaQueryListeners: Map<string, (e: MediaQueryListEvent) => void>;

  const createMockMatchMedia = (matches: boolean): void => {
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

  it('returns true when primary pointer is coarse (touch device)', () => {
    createMockMatchMedia(true);
    const { result } = renderHook(() => useIsTouchDevice());

    expect(result.current).toBe(true);
  });

  it('returns false when primary pointer is not coarse (desktop)', () => {
    createMockMatchMedia(false);
    const { result } = renderHook(() => useIsTouchDevice());

    expect(result.current).toBe(false);
  });

  it('uses the correct media query (pointer: coarse)', () => {
    createMockMatchMedia(false);
    renderHook(() => useIsTouchDevice());

    expect(mockMatchMedia).toHaveBeenCalledWith('(pointer: coarse)');
  });

  it('updates when pointer capability changes to touch', () => {
    createMockMatchMedia(false);
    const { result } = renderHook(() => useIsTouchDevice());

    expect(result.current).toBe(false);

    act(() => {
      const listener = mediaQueryListeners.get('(pointer: coarse)');
      listener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(result.current).toBe(true);
  });

  it('updates when pointer capability changes from touch to non-touch', () => {
    createMockMatchMedia(true);
    const { result } = renderHook(() => useIsTouchDevice());

    expect(result.current).toBe(true);

    act(() => {
      const listener = mediaQueryListeners.get('(pointer: coarse)');
      listener?.({ matches: false } as MediaQueryListEvent);
    });

    expect(result.current).toBe(false);
  });

  it('cleans up event listener on unmount', () => {
    createMockMatchMedia(false);
    const { unmount } = renderHook(() => useIsTouchDevice());

    const lastCallIndex = mockMatchMedia.mock.results.length - 1;
    const lastResult = mockMatchMedia.mock.results[lastCallIndex];
    const mediaQueryList = lastResult?.value as { removeEventListener: ReturnType<typeof vi.fn> };
    unmount();

    expect(mediaQueryList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('returns true when context override is true, regardless of media query', () => {
    createMockMatchMedia(false); // media query says non-touch
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element =>
      React.createElement(TouchDeviceOverrideContext.Provider, { value: true }, children);

    const { result } = renderHook(() => useIsTouchDevice(), { wrapper });

    expect(result.current).toBe(true);
  });

  it('returns false when context override is false, regardless of media query', () => {
    createMockMatchMedia(true); // media query says touch
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element =>
      React.createElement(TouchDeviceOverrideContext.Provider, { value: false }, children);

    const { result } = renderHook(() => useIsTouchDevice(), { wrapper });

    expect(result.current).toBe(false);
  });

  it('falls back to media query when context override is null', () => {
    createMockMatchMedia(true);
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element =>
      React.createElement(TouchDeviceOverrideContext.Provider, { value: null }, children);

    const { result } = renderHook(() => useIsTouchDevice(), { wrapper });

    expect(result.current).toBe(true);
  });

  describe('SSR — window absent', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;

    it('server-renders to false when window is absent', () => {
      const Probe = (): React.ReactElement =>
        React.createElement('span', { 'data-touch': String(useIsTouchDevice()) });
      Reflect.deleteProperty(globalThis, 'window');
      try {
        const html = renderToStaticMarkup(React.createElement(Probe));
        expect(html).toContain('data-touch="false"');
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
