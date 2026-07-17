import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The E2E DOM flag is driven purely by `env.isE2E` (env-mode detection), never
// by the raw VITE_E2E var. A hoisted, mutable mock lets each test flip the mode
// (and the demo-path gate) before the entry module's top-level side effect runs.
const { envMock, isDemoPathMock, mountDemoMock, renderMock, createRootMock, prewarmMock } =
  vi.hoisted(() => ({
    envMock: { isE2E: false },
    isDemoPathMock: vi.fn((_path: string) => false),
    mountDemoMock: vi.fn(),
    renderMock: vi.fn(),
    createRootMock: vi.fn(() => ({ render: renderMock })),
    prewarmMock: vi.fn(),
  }));

vi.mock('./lib/env', () => ({ env: envMock }));
vi.mock('./router', () => ({ router: {} }));
vi.mock('react-dom/client', () => ({ createRoot: createRootMock }));
vi.mock('./lib/is-demo-path', () => ({ isDemoPath: isDemoPathMock }));
vi.mock('./demo/bootstrap', () => ({ mountDemo: mountDemoMock }));
vi.mock('./lib/prewarm-tts', () => ({ prewarmTtsIfEnabled: prewarmMock }));

describe('main entry', () => {
  beforeEach(() => {
    delete document.documentElement.dataset['e2e'];
    document.body.innerHTML = '<div id="root"></div>';
    envMock.isE2E = false;
    isDemoPathMock.mockReturnValue(false);
    mountDemoMock.mockClear();
    renderMock.mockClear();
    createRootMock.mockClear();
    prewarmMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    delete document.documentElement.dataset['e2e'];
    vi.resetModules();
  });

  it('sets data-e2e on <html> when env.isE2E is true', async () => {
    envMock.isE2E = true;
    await import('./main.js');
    // main.tsx sets the flag via `dataset.e2e = ''` — an empty-string value.
    expect(document.documentElement.dataset['e2e']).toBe('');
  });

  it('does not set data-e2e on <html> when env.isE2E is false', async () => {
    envMock.isE2E = false;
    await import('./main.js');
    expect(document.documentElement.dataset['e2e']).toBeUndefined();
  });

  it('throws when the #root element is missing', async () => {
    document.body.innerHTML = '';
    await expect(import('./main.js')).rejects.toThrow('Root element not found');
  });

  it('mounts the real app (createRoot + prewarm) on a normal path', async () => {
    await import('./main.js');
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(prewarmMock).toHaveBeenCalledTimes(1);
    expect(mountDemoMock).not.toHaveBeenCalled();
  });

  it('boots the demo bundle on a demo path instead of the real app', async () => {
    isDemoPathMock.mockReturnValue(true);
    await import('./main.js');
    expect(mountDemoMock).toHaveBeenCalledTimes(1);
    expect(createRootMock).not.toHaveBeenCalled();
    expect(prewarmMock).not.toHaveBeenCalled();
  });
});
