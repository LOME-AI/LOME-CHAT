import { describe, it, expect, afterEach, vi } from 'vitest';
import { isAwayFromApp } from './app-attention';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('isAwayFromApp', () => {
  afterEach(() => {
    setVisibility('visible');
    vi.restoreAllMocks();
  });

  it('is false while the tab is visible and focused', () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    expect(isAwayFromApp()).toBe(false);
  });

  it('is true while the tab is hidden', () => {
    setVisibility('hidden');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    expect(isAwayFromApp()).toBe(true);
  });

  it('is true while the tab is visible but another window holds focus', () => {
    setVisibility('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    expect(isAwayFromApp()).toBe(true);
  });
});
