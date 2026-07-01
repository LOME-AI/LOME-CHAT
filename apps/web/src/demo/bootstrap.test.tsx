import { describe, it, expect, vi, afterEach } from 'vitest';
import { ROUTES } from '@hushbox/shared';

// `bootstrap.tsx` imports `@/routeTree.gen` (the ENTIRE app route tree → every
// page → every component) plus the real React/router/query-provider/chat-hook
// graphs. Loading those in jsdom takes ~75s and blows the 15s testTimeout.
// These tests only exercise the static fallback DOM and the boot try/catch, so
// stub the heavy graphs to bare shapes — the demo-internal collaborators below
// stay real (they're light) so the boot path itself is genuinely executed.
vi.mock('@/routeTree.gen', () => ({ routeTree: {} }));
vi.mock('@/providers/query-provider', () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock('@/hooks/chat/chat', () => ({
  chatKeys: { conversation: (id: string) => ['chat', 'conversations', id] },
}));
const createRoot = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => createRoot() }));
vi.mock('@tanstack/react-router', () => ({
  RouterProvider: () => null,
  createRouter: vi.fn(() => ({ history: { push: vi.fn() } })),
  createMemoryHistory: vi.fn(() => ({})),
}));

const seedDemoSession = vi.fn(() => ({ accountPublicKey: 'demo-key' }));
vi.mock('./seed-session', () => ({
  seedDemoSession: () => seedDemoSession(),
}));

// The remaining boot collaborators are irrelevant once seeding throws, but they
// must still resolve as modules so the import graph loads.
vi.mock('./mock-backend/fetch-shim', () => ({ installFetchShim: vi.fn() }));
vi.mock('./mock-backend/ws-shim', () => ({
  installWebSocketShim: vi.fn(),
  emitDemoRealtimeEvent: vi.fn(),
}));
const demoStore = { fillConversation: vi.fn() };
// A regular function (not an arrow) so the mock is usable with `new`.
function buildDemoStore(): typeof demoStore {
  return demoStore;
}
vi.mock('./mock-backend/store', () => ({ DemoBackendStore: vi.fn(buildDemoStore) }));
const startDirector = vi.fn();
vi.mock('./director', () => ({ startDirector: (...args: unknown[]) => startDirector(...args) }));
vi.mock('./guardrails', () => ({ installGuardrails: vi.fn() }));
vi.mock('./composer-cues', () => ({ installComposerCues: vi.fn() }));
vi.mock('./focus-scroll-guard', () => ({ installFocusScrollGuard: vi.fn() }));
// Keep the real parseFrozenParams; stub the DOM-driven scroll (covered in frozen.test.ts).
const scrollFrozenListToTop = vi.fn(() => Promise.resolve());
vi.mock('./frozen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./frozen')>();
  return { ...actual, scrollFrozenListToTop: () => scrollFrozenListToTop() };
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  delete document.documentElement.dataset['demo'];
  document.documentElement.style.fontSize = '';
  globalThis.history.replaceState(null, '', '/');
  document.documentElement.classList.remove('dark');
  delete globalThis.__virtuosoScrollToIndex;
});

describe('renderDemoFallback', () => {
  it('renders a static "Open HushBox" link into the root', async () => {
    const { renderDemoFallback } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    renderDemoFallback(root);

    const link = root.querySelector('a');
    expect(link?.textContent).toContain('Open HushBox');
    expect(link?.getAttribute('href')).toBe(ROUTES.CHAT);
  });
});

describe('mountDemo success', () => {
  it('marks the document for demo-scoped styles', async () => {
    seedDemoSession.mockReturnValue({ accountPublicKey: 'demo-key' });
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    mountDemo(root);

    expect(document.documentElement.dataset['demo']).toBe('');
  });

  it('wires the director navigate and conversation callbacks to the router and query client', async () => {
    seedDemoSession.mockReset();
    seedDemoSession.mockReturnValue({ accountPublicKey: 'demo-key' });
    globalThis.history.replaceState(null, '', '/');
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    mountDemo(root);

    expect(startDirector).toHaveBeenCalledTimes(1);
    const [context, , onConversation] = startDirector.mock.calls[0] as [
      { navigate: (path: string) => void },
      unknown,
      (conversationId: string) => void,
    ];
    expect(() => {
      context.navigate('/chat/demo-x');
      onConversation('demo-x');
    }).not.toThrow();
  });
});

describe('mountDemo boot failure', () => {
  it('renders the static fallback when boot throws instead of leaving a blank iframe', async () => {
    seedDemoSession.mockImplementation(() => {
      throw new Error('seed failed');
    });
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    expect(() => {
      mountDemo(root);
    }).not.toThrow();
    expect(root.querySelector('a')?.textContent).toContain('Open HushBox');
  });
});

describe('mountDemo frozen capture', () => {
  it('fills one conversation, applies the theme, scrolls to top, and skips the director', async () => {
    seedDemoSession.mockReset();
    seedDemoSession.mockReturnValue({ accountPublicKey: 'demo-key' });
    globalThis.history.replaceState(
      null,
      '',
      '/demo?frozen=1&convo=demo-welcome&theme=dark&scroll=top'
    );
    const postMessage = vi.spyOn(globalThis.parent, 'postMessage');
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    mountDemo(root);

    expect(demoStore.fillConversation).toHaveBeenCalledWith('demo-welcome');
    expect(startDirector).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await vi.waitFor(() => {
      expect(scrollFrozenListToTop).toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({ type: 'hb-demo-ready' }, '*');
    });
    postMessage.mockRestore();
  });

  it('signals ready without scrolling when scroll is not "top"', async () => {
    seedDemoSession.mockReset();
    seedDemoSession.mockReturnValue({ accountPublicKey: 'demo-key' });
    globalThis.history.replaceState(null, '', '/demo?frozen=1&convo=demo-group&scroll=bottom');
    const postMessage = vi.spyOn(globalThis.parent, 'postMessage');
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    mountDemo(root);

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'hb-demo-ready' }, '*');
    });
    expect(scrollFrozenListToTop).not.toHaveBeenCalled();
    postMessage.mockRestore();
  });

  it('still sets the theme class when localStorage is unavailable', async () => {
    seedDemoSession.mockReset();
    seedDemoSession.mockReturnValue({ accountPublicKey: 'demo-key' });
    globalThis.history.replaceState(null, '', '/demo?frozen=1&convo=demo-welcome&theme=dark');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const { mountDemo } = await import('./bootstrap');
    const root = document.createElement('div');
    document.body.append(root);

    mountDemo(root);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    setItem.mockRestore();
  });
});
