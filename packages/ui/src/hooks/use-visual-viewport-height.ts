import { useState, useEffect, useCallback, useRef } from 'react';

export function useVisualViewportHeight(): number {
  const [height, setHeight] = useState<number>(() => {
    if (!('window' in globalThis)) return 0;
    return window.visualViewport?.height ?? window.innerHeight;
  });
  const rafRef = useRef<number | undefined>(undefined);

  const updateHeight = useCallback(() => {
    if (rafRef.current !== undefined) return;
    // eslint-disable-next-line no-restricted-globals -- viewport polling, not animation; useAnimationFrame is for motion that must respect prefers-reduced-motion
    rafRef.current = requestAnimationFrame(() => {
      const newHeight = window.visualViewport?.height ?? window.innerHeight;
      setHeight((previous) => (previous === newHeight ? previous : newHeight));
      rafRef.current = undefined;
    });
  }, []);

  useEffect(() => {
    // SSR safety guard. Unreachable under jsdom + React: client render always
    // has `window`, and effects never run during server rendering.
    /* v8 ignore next 3 */
    if (!('window' in globalThis)) {
      return;
    }

    const handleResize = (): void => {
      updateHeight();
      setTimeout(updateHeight, 300); // iOS Safari reports late
    };

    // Listen to visualViewport for mobile keyboard/pinch-zoom
    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener('resize', handleResize);
    }

    // Listen to window resize as fallback (desktop, Playwright tests)
    window.addEventListener('resize', handleResize);

    return () => {
      if (viewport) {
        viewport.removeEventListener('resize', handleResize);
      }
      window.removeEventListener('resize', handleResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [updateHeight]);

  return height;
}
