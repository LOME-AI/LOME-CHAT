import '@testing-library/jest-dom/vitest';

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
