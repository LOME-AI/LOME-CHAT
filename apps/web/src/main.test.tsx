import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The E2E DOM flag is driven purely by `env.isE2E` (env-mode detection), never
// by the raw VITE_E2E var. A hoisted, mutable mock lets each test flip the mode
// before the entry module's top-level side effect runs.
const { envMock } = vi.hoisted(() => ({ envMock: { isE2E: false } }));

vi.mock('./lib/env', () => ({ env: envMock }));
vi.mock('./router', () => ({ router: {} }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn() }) }));
vi.mock('./demo/bootstrap', () => ({ mountDemo: vi.fn() }));
vi.mock('./lib/prewarm-tts', () => ({ prewarmTtsIfEnabled: vi.fn() }));

describe('main entry: E2E DOM flag', () => {
  beforeEach(() => {
    delete document.documentElement.dataset['e2e'];
    document.body.innerHTML = '<div id="root"></div>';
    envMock.isE2E = false;
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
});
