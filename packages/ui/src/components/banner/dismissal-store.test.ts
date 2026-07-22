// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BANNER_DISMISSED_STORAGE_KEY } from '@hushbox/shared';
import {
  readDismissedBannerHash,
  isBannerDismissed,
  markBannerDismissed,
} from './dismissal-store.js';

describe('banner dismissal store', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads null when nothing was dismissed (no "not dismissed" key is ever written)', () => {
    expect(readDismissedBannerHash()).toBeNull();
    expect(isBannerDismissed('abc')).toBe(false);
    // Reading must never create a key.
    expect(localStorage.getItem(BANNER_DISMISSED_STORAGE_KEY)).toBeNull();
  });

  it('marks a hash dismissed and reports it dismissed', () => {
    markBannerDismissed('hash-1');
    expect(localStorage.getItem(BANNER_DISMISSED_STORAGE_KEY)).toBe('hash-1');
    expect(isBannerDismissed('hash-1')).toBe(true);
  });

  it('treats a different hash as not dismissed (auto-reset when the set changes)', () => {
    markBannerDismissed('hash-1');
    expect(isBannerDismissed('hash-2')).toBe(false);
  });

  it('overwrites the stored hash on a new dismissal (one key only)', () => {
    markBannerDismissed('hash-1');
    markBannerDismissed('hash-2');
    expect(readDismissedBannerHash()).toBe('hash-2');
  });

  it('does not throw when storage reads fail (SSR / private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => readDismissedBannerHash()).not.toThrow();
    expect(readDismissedBannerHash()).toBeNull();
  });

  it('does not throw when storage writes fail (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => {
      markBannerDismissed('hash-1');
    }).not.toThrow();
  });

  it('degrades to "not dismissed" when localStorage is absent (SSR)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    try {
      expect(readDismissedBannerHash()).toBeNull();
      expect(isBannerDismissed('x')).toBe(false);
      expect(() => {
        markBannerDismissed('x');
      }).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('degrades to "not dismissed" when accessing localStorage throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    try {
      expect(readDismissedBannerHash()).toBeNull();
      expect(() => {
        markBannerDismissed('x');
      }).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
