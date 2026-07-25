import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPromptDismissed, markPromptDismissed } from './prompt-dismissal.js';

function stubStorage(store: Map<string, string>): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
}

describe('enable-prompt dismissal', () => {
  beforeEach(() => {
    stubStorage(new Map());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not dismissed on a fresh device', () => {
    expect(isPromptDismissed()).toBe(false);
  });

  it('stays dismissed once marked', () => {
    markPromptDismissed();

    expect(isPromptDismissed()).toBe(true);
  });

  it('reports not dismissed when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    });

    expect(isPromptDismissed()).toBe(false);
  });

  it('does not throw when the dismissal cannot be persisted', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });

    expect(() => {
      markPromptDismissed();
    }).not.toThrow();
  });
});
