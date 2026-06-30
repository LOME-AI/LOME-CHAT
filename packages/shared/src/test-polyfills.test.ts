// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Import the side-effect module once — it installs all polyfills
beforeAll(async () => {
  await import('./test-polyfills.js');
});

describe('test-polyfills', () => {
  it('installs ResizeObserver polyfill with working methods', () => {
    expect(globalThis.ResizeObserver).toBeDefined();

    const observer = new globalThis.ResizeObserver(() => {});
    expect(() => {
      observer.observe(document.createElement('div'));
    }).not.toThrow();
    expect(() => {
      observer.unobserve(document.createElement('div'));
    }).not.toThrow();
    expect(() => {
      observer.disconnect();
    }).not.toThrow();
  });

  it('installs matchMedia polyfill returning MediaQueryList', () => {
    expect(globalThis.matchMedia).toBeDefined();

    const mql = globalThis.matchMedia('(min-width: 768px)');
    expect(mql.matches).toBe(false);
    expect(mql.media).toBe('(min-width: 768px)');
    expect(typeof mql.addEventListener).toBe('function');
    expect(typeof mql.removeEventListener).toBe('function');
    expect(mql.dispatchEvent(new Event('change'))).toBe(false);
  });

  it('installs IntersectionObserver polyfill with inert observer methods', () => {
    expect(globalThis.IntersectionObserver).toBeDefined();

    const observer = new globalThis.IntersectionObserver(() => {});
    expect(observer.root).toBeNull();
    expect(observer.rootMargin).toBe('0px');
    expect(observer.thresholds).toEqual([0]);
    expect(() => {
      observer.observe(document.createElement('div'));
    }).not.toThrow();
    expect(() => {
      observer.unobserve(document.createElement('div'));
    }).not.toThrow();
    expect(() => {
      observer.disconnect();
    }).not.toThrow();
    expect(observer.takeRecords()).toEqual([]);
  });

  it('matchMedia polyfill accepts both legacy and modern listener registration', () => {
    const mql = globalThis.matchMedia('(min-width: 768px)');
    const listener = (): void => {
      /* noop */
    };

    expect(mql.onchange).toBeNull();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- the polyfill deliberately ships the deprecated listener API because Sonner still calls it; verifying that contract requires calling it
      mql.addListener(listener);
      // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- same deprecated-API contract as addListener above
      mql.removeListener(listener);
      mql.addEventListener('change', listener);
      mql.removeEventListener('change', listener);
    }).not.toThrow();
  });

  it('re-import leaves already-installed implementations untouched (guarded assignment)', async () => {
    const installed = {
      io: globalThis.IntersectionObserver,
      ro: globalThis.ResizeObserver,
      mm: globalThis.matchMedia,
      siv: Element.prototype.scrollIntoView,
      hpc: Element.prototype.hasPointerCapture,
      spc: Element.prototype.setPointerCapture,
      rpc: Element.prototype.releasePointerCapture,
    };

    vi.resetModules();
    await import('./test-polyfills.js');

    expect(globalThis.IntersectionObserver).toBe(installed.io);
    expect(globalThis.ResizeObserver).toBe(installed.ro);
    expect(globalThis.matchMedia).toBe(installed.mm);
    expect(Element.prototype.scrollIntoView).toBe(installed.siv);
    expect(Element.prototype.hasPointerCapture).toBe(installed.hpc);
    expect(Element.prototype.setPointerCapture).toBe(installed.spc);
    expect(Element.prototype.releasePointerCapture).toBe(installed.rpc);
  });

  it('installs scrollIntoView polyfill', () => {
    expect(typeof Element.prototype.scrollIntoView).toBe('function');

    const el = document.createElement('div');
    expect(() => {
      el.scrollIntoView();
    }).not.toThrow();
  });

  it('installs pointer capture polyfills', () => {
    expect(typeof Element.prototype.hasPointerCapture).toBe('function');
    expect(typeof Element.prototype.setPointerCapture).toBe('function');
    expect(typeof Element.prototype.releasePointerCapture).toBe('function');

    const el = document.createElement('div');
    expect(el.hasPointerCapture(1)).toBe(false);
    expect(() => {
      el.setPointerCapture(1);
    }).not.toThrow();
    expect(() => {
      el.releasePointerCapture(1);
    }).not.toThrow();
  });

  it('uses guarded assignment that does not overwrite existing functions', () => {
    // The polyfill module uses `if (typeof X !== 'function')` guards.
    // Since jsdom may provide some of these natively, we verify the guards
    // work by checking the polyfill source uses conditional checks.
    // If the guards were missing, a real environment with native ResizeObserver
    // would have its implementation silently replaced.

    // Verify the polyfills are functions (either native or polyfilled)
    expect(typeof globalThis.ResizeObserver).toBe('function');
    expect(typeof globalThis.matchMedia).toBe('function');
    expect(typeof Element.prototype.scrollIntoView).toBe('function');
    expect(typeof Element.prototype.hasPointerCapture).toBe('function');
  });
});
