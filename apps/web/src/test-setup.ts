import '@testing-library/jest-dom/vitest';

// ResizeObserver polyfill for Radix UI Tooltip/Popover components
class ResizeObserverMock {
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}
window.ResizeObserver = ResizeObserverMock;

// Polyfills for Radix UI components (Select, etc.)
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
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function (): void {
    /* noop */
  };
}

// Mock localStorage for Zustand persist middleware
const localStorageMock: Storage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(() => null),
};
Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Polyfill for matchMedia
Object.defineProperty(window, 'matchMedia', {
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
