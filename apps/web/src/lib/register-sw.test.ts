import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isNative } from '@/capacitor/platform';
import { registerPushServiceWorker } from './register-sw.js';

vi.mock('@/capacitor/platform', () => ({ isNative: vi.fn() }));

const isNativeMock = vi.mocked(isNative);

describe('registerPushServiceWorker', () => {
  beforeEach(() => {
    isNativeMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not register on native — FCM is the delivery path there', async () => {
    isNativeMock.mockReturnValue(true);
    const register = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    const result = await registerPushServiceWorker();

    expect(result).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('returns null when the browser has no service worker support', async () => {
    isNativeMock.mockReturnValue(false);
    vi.stubGlobal('navigator', {});

    expect(await registerPushServiceWorker()).toBeNull();
  });

  it('registers the stable /sw.js on the web and returns the registration', async () => {
    isNativeMock.mockReturnValue(false);
    const registration = { scope: 'https://app.example/' };
    const register = vi.fn(() => Promise.resolve(registration));
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    const result = await registerPushServiceWorker();

    expect(register).toHaveBeenCalledWith('/sw.js');
    expect(result).toBe(registration);
  });
});
