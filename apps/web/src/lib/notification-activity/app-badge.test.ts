import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyAppBadge } from './app-badge';

function installBadgeApi(): {
  setAppBadge: ReturnType<typeof vi.fn>;
  clearAppBadge: ReturnType<typeof vi.fn>;
} {
  const setAppBadge = vi.fn(() => Promise.resolve());
  const clearAppBadge = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'setAppBadge', { value: setAppBadge, configurable: true });
  Object.defineProperty(navigator, 'clearAppBadge', { value: clearAppBadge, configurable: true });
  return { setAppBadge, clearAppBadge };
}

describe('applyAppBadge', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'setAppBadge');
    Reflect.deleteProperty(navigator, 'clearAppBadge');
  });

  it('shows the count on the app icon', () => {
    const { setAppBadge } = installBadgeApi();

    applyAppBadge(3);

    expect(setAppBadge).toHaveBeenCalledWith(3);
  });

  it('clears the badge rather than setting it to zero', () => {
    const { setAppBadge, clearAppBadge } = installBadgeApi();

    applyAppBadge(0);

    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('does nothing on a platform without app badging', () => {
    expect(() => {
      applyAppBadge(2);
    }).not.toThrow();
  });

  it('never surfaces a refused badge write', async () => {
    const { setAppBadge } = installBadgeApi();
    setAppBadge.mockReturnValue(Promise.reject(new Error('badging not permitted')));

    expect(() => {
      applyAppBadge(1);
    }).not.toThrow();
    await Promise.resolve();

    expect(setAppBadge).toHaveBeenCalledTimes(1);
  });
});
