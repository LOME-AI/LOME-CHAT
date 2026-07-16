import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }));

vi.mock('./router', () => ({ router: {} }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: renderMock }) }));

describe('main entry', () => {
  beforeEach(() => {
    renderMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
  });

  it('mounts the router into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main.js');
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when #root is missing', async () => {
    document.body.innerHTML = '';
    await expect(import('./main.js')).rejects.toThrow('Root element not found');
  });
});
