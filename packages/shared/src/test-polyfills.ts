/**
 * Shared DOM polyfills for jsdom test environments.
 * Import as a side-effect: `import '@hushbox/shared/test-polyfills'`
 *
 * All polyfills use guarded assignment to avoid overwriting real implementations.
 */

// IntersectionObserver polyfill for ScrollReveal and scroll-triggered components
if (typeof globalThis.IntersectionObserver !== 'function') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- mock must match IntersectionObserver constructor signature
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
      /* noop */
    }
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '0px';
    // Required by the TS 7 (tsgo) DOM lib; harmless extra member under TS 5.9.
    readonly scrollMargin: string = '0px';
    readonly thresholds: readonly number[] = [0];
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  };
}

// ResizeObserver polyfill for Radix UI Tooltip/Popover components
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  };
}

// matchMedia polyfill for Sonner toast library and useIsMobile hook
if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: (): void => {
        /* noop */
      },
      removeListener: (): void => {
        /* noop */
      },
      addEventListener: (): void => {
        /* noop */
      },
      removeEventListener: (): void => {
        /* noop */
      },
      dispatchEvent: (): boolean => false,
    }),
  });
}

// scrollIntoView polyfill for Radix UI components
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function (): void {
    /* noop */
  };
}

// Pointer capture polyfills for Radix UI Select
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = function (): boolean {
    return false;
  };
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = function (): void {
    /* noop */
  };
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = function (): void {
    /* noop */
  };
}

// eslint-disable-next-line unicorn/require-module-specifiers -- side-effect-only module needs empty export for TypeScript module mode
export {};
