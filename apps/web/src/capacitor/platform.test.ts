import { describe, it, expect, vi, afterEach } from 'vitest';

describe('getPlatform', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns web when VITE_PLATFORM is web', async () => {
    vi.stubEnv('VITE_PLATFORM', 'web');
    vi.resetModules();
    const { getPlatform } = await import('./platform.js');
    expect(getPlatform()).toBe('web');
  });

  it('fails fast (throws on import) when VITE_PLATFORM is missing/invalid', async () => {
    vi.stubEnv('VITE_PLATFORM', '');
    vi.resetModules();
    await expect(import('./platform.js')).rejects.toThrow();
  });

  it('returns ios when VITE_PLATFORM is ios', async () => {
    vi.stubEnv('VITE_PLATFORM', 'ios');
    vi.resetModules();
    const { getPlatform } = await import('./platform.js');
    expect(getPlatform()).toBe('ios');
  });

  it('returns android when VITE_PLATFORM is android', async () => {
    vi.stubEnv('VITE_PLATFORM', 'android');
    vi.resetModules();
    const { getPlatform } = await import('./platform.js');
    expect(getPlatform()).toBe('android');
  });

  it('returns android-direct when VITE_PLATFORM is android-direct', async () => {
    vi.stubEnv('VITE_PLATFORM', 'android-direct');
    vi.resetModules();
    const { getPlatform } = await import('./platform.js');
    expect(getPlatform()).toBe('android-direct');
  });
});

describe('isNative', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns false for web', async () => {
    const { isNative } = await import('./platform.js');
    expect(isNative()).toBe(false);
  });

  it('returns true for ios', async () => {
    vi.stubEnv('VITE_PLATFORM', 'ios');
    vi.resetModules();
    const { isNative } = await import('./platform.js');
    expect(isNative()).toBe(true);
  });

  it('returns true for android', async () => {
    vi.stubEnv('VITE_PLATFORM', 'android');
    vi.resetModules();
    const { isNative } = await import('./platform.js');
    expect(isNative()).toBe(true);
  });

  it('returns true for android-direct', async () => {
    vi.stubEnv('VITE_PLATFORM', 'android-direct');
    vi.resetModules();
    const { isNative } = await import('./platform.js');
    expect(isNative()).toBe(true);
  });
});

describe('isPaymentDisabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns false for web', async () => {
    const { isPaymentDisabled } = await import('./platform.js');
    expect(isPaymentDisabled()).toBe(false);
  });

  it('returns true for ios (App Store)', async () => {
    vi.stubEnv('VITE_PLATFORM', 'ios');
    vi.resetModules();
    const { isPaymentDisabled } = await import('./platform.js');
    expect(isPaymentDisabled()).toBe(true);
  });

  it('returns true for android (Play Store)', async () => {
    vi.stubEnv('VITE_PLATFORM', 'android');
    vi.resetModules();
    const { isPaymentDisabled } = await import('./platform.js');
    expect(isPaymentDisabled()).toBe(true);
  });

  it('returns false for android-direct (Obtainium)', async () => {
    vi.stubEnv('VITE_PLATFORM', 'android-direct');
    vi.resetModules();
    const { isPaymentDisabled } = await import('./platform.js');
    expect(isPaymentDisabled()).toBe(false);
  });
});
