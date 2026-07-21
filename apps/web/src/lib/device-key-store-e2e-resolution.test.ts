import { describe, it, expect } from 'vitest';

import { resolveDeviceKeyStoreE2eVariant } from './device-key-store-e2e-resolution';

const E2E_PATH = '/repo/apps/web/src/lib/device-key-store.e2e.ts';

describe('resolveDeviceKeyStoreE2eVariant', () => {
  it('remaps a relative device-key-store specifier to the e2e module', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant(
      './device-key-store.js',
      '/repo/apps/web/src/lib/auth-client.ts',
      E2E_PATH
    );

    expect(resolved).toBe(E2E_PATH);
  });

  it('remaps an @/ alias device-key-store specifier to the e2e module', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant(
      '@/lib/device-key-store',
      '/repo/apps/web/src/routes/index.tsx',
      E2E_PATH
    );

    expect(resolved).toBe(E2E_PATH);
  });

  it('does not remap unrelated specifiers', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant(
      './auth-client.js',
      '/repo/apps/web/src/lib/auth.ts',
      E2E_PATH
    );

    expect(resolved).toBeNull();
  });

  it('does not remap a specifier that already targets the e2e module', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant(
      './device-key-store.e2e.js',
      '/repo/apps/web/src/lib/device-key-store.test.ts',
      E2E_PATH
    );

    expect(resolved).toBeNull();
  });

  it('does not remap imports originating from the e2e module itself', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant('./device-key-store.js', E2E_PATH, E2E_PATH);

    expect(resolved).toBeNull();
  });

  it('does not remap a module whose name merely ends with device-key-store', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant(
      './not-the-device-key-store.js',
      '/repo/apps/web/src/lib/auth.ts',
      E2E_PATH
    );

    expect(resolved).toBeNull();
  });

  it('remaps even when the importer is unknown (entry resolution)', () => {
    const resolved = resolveDeviceKeyStoreE2eVariant('./device-key-store.js', undefined, E2E_PATH);

    expect(resolved).toBe(E2E_PATH);
  });
});
