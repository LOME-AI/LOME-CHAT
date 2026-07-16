import { useEffect, useRef } from 'react';
import { shouldReduceMotion, subscribeReducedMotion } from './use-reduced-motion';

interface UseAnimationFrameOptions {
  /** When true, respect the merged reduced-motion signal. Default true. */
  respectMotion?: boolean;
  /** When true, hook is paused (no rAF callbacks). Default false. */
  paused?: boolean;
}

/**
 * useAnimationFrame — accessibility-aware wrapper around requestAnimationFrame.
 * Use this instead of raw window.requestAnimationFrame for any JS-driven animation.
 *
 * When respectMotion is true (default), the loop pauses whenever the merged
 * reduced-motion signal is on and resumes when it turns off — same single
 * source of truth as `useReducedMotion()` and the `html.reduced-motion` class.
 */
export function useAnimationFrame(
  callback: (timestamp: number) => void,
  options: UseAnimationFrameOptions = {}
): void {
  const { respectMotion = true, paused = false } = options;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (paused) return;

    let rafId: number | null = null;

    const start = (): void => {
      // Re-entry guard. start() is only ever called from a stopped state — at
      // mount, or from the reduced-motion subscriber after stop() — so rafId is
      // always null here in practice.
      /* v8 ignore next */
      if (rafId !== null) return;
      const tick = (timestamp: number): void => {
        callbackRef.current(timestamp);
        rafId = globalThis.requestAnimationFrame(tick);
      };
      rafId = globalThis.requestAnimationFrame(tick);
    };

    const stop = (): void => {
      if (rafId === null) return;
      globalThis.cancelAnimationFrame(rafId);
      rafId = null;
    };

    if (!respectMotion) {
      start();
      return stop;
    }

    if (!shouldReduceMotion()) start();

    const unsubscribe = subscribeReducedMotion((reduced) => {
      if (reduced) stop();
      else start();
    });

    return () => {
      stop();
      unsubscribe();
    };
  }, [paused, respectMotion]);
}
