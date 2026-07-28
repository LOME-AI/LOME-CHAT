import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { ThemeProvider, useTheme } from '@/providers/theme-provider';
import { DocumentSandbox } from './document-sandbox';

// Shiki lazy-loads through React.lazy() inside Streamdown, so highlighted source
// is invisible to a synchronous test. The stub echoes the fenced block it was
// handed, which is what these tests are about.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

const ORIGIN = 'http://localhost:7400';

/** Every channel a test minted, so no endpoint outlives the test that made it. */
const channels: MessageChannel[] = [];

interface FrameChannel {
  /** The end the frame keeps: what the tests send frame→parent messages from. */
  framePort: MessagePort;
  /** The end the frame transfers on `ready`: what the parent must post through. */
  parentPort: MessagePort;
  /** Everything the parent posted through that end. */
  toFrame: ReturnType<typeof vi.spyOn>;
}

/** Stands in for the channel the real frame mints before it announces itself. */
function frameChannel(): FrameChannel {
  const channel = new MessageChannel();
  channels.push(channel);
  return {
    framePort: channel.port1,
    parentPort: channel.port2,
    toFrame: vi.spyOn(channel.port2, 'postMessage'),
  };
}

/**
 * Port delivery is a task, not a microtask, so a message the frame just sent has
 * not arrived yet. Yield the loop — or the fake clock's async tick, which yields
 * it too — before asserting on what it did.
 */
async function settle(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Stands in for the app's stylesheet: the tokens the frame is painted with. */
function stubTokens(): void {
  const style = document.createElement('style');
  style.dataset['tokens'] = '';
  style.textContent = `
    :root { --background: #faf9f6; --foreground: #1a1a1a; }
    .dark { --background: #1a1816; --foreground: #f2f1ef; }
    html.a11y-contrast-high { --background: #ffffff; --foreground: #000000; }
  `;
  document.head.append(style);
}

/**
 * What the app states when its stylesheet is not loaded, as in a test that
 * stubs no tokens: the colour scheme it is showing, and no colours to paint.
 */
const UNPAINTED = { theme: 'light' } as const;

const LIGHT = { theme: 'light', background: '#faf9f6', foreground: '#1a1a1a' } as const;
const DARK = { theme: 'dark', background: '#1a1816', foreground: '#f2f1ef' } as const;

/**
 * The View Transitions API, with the timing measured in Chromium: the callback
 * runs after the handler that started the transition has returned, so whatever
 * it changes is no longer inside a discrete event. happy-dom ships no
 * implementation, so without this the theme provider takes its fallback branch
 * and applies the change synchronously — the one ordering that cannot show this
 * bug.
 */
function stubViewTransitions(): () => void {
  const owned = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: (callback: () => void) => {
      setTimeout(callback, 0);
      return { finished: Promise.resolve(), ready: Promise.resolve() };
    },
  });
  return () => {
    if (owned) Object.defineProperty(document, 'startViewTransition', owned);
    else Reflect.deleteProperty(document, 'startViewTransition');
  };
}

function ThemeSwitch(): React.JSX.Element {
  const { triggerTransition } = useTheme();
  return (
    <button
      type="button"
      onClick={() => {
        triggerTransition({ x: 0, y: 0 });
      }}
    >
      switch theme
    </button>
  );
}

/** The real theme provider, plus the control that moves it to the other theme. */
function ThemeHarness({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <ThemeProvider>
      {children}
      <ThemeSwitch />
    </ThemeProvider>
  );
}

function renderSandbox(
  props: Partial<React.ComponentProps<typeof DocumentSandbox>> = {},
  options: { wrapper?: React.ComponentType<{ children: React.ReactNode }> } = {}
): {
  iframe: HTMLIFrameElement;
  win: Window;
  /** Calls into the frame's window — the transport an opaque frame never receives. */
  windowPost: ReturnType<typeof vi.spyOn>;
  toFrame: ReturnType<typeof vi.spyOn>;
  handshake: (options?: { source?: Window | null; ports?: MessagePort[] }) => void;
  emit: (data: unknown) => Promise<void>;
  emitOnWindow: (data: unknown, source?: Window | null) => void;
  container: HTMLElement;
  rerenderWith: (next: Partial<React.ComponentProps<typeof DocumentSandbox>>) => void;
} {
  const merged = {
    kind: 'html' as const,
    code: '<h1>hi</h1>',
    title: 'Preview',
    isStreaming: false,
    pendingView: <div data-testid="pending-source" />,
    ...props,
  };
  const { container, rerender } = render(
    <DocumentSandbox {...merged} />,
    options.wrapper ? { wrapper: options.wrapper } : undefined
  );
  const iframe = screen.getByTitle<HTMLIFrameElement>(merged.title);
  const win = iframe.contentWindow!;
  const windowPost = vi.spyOn(win, 'postMessage');
  const { framePort, parentPort, toFrame } = frameChannel();

  const emitOnWindow = (
    data: unknown,
    source: Window | null = win,
    ports: MessagePort[] = []
  ): void => {
    act(() => {
      globalThis.dispatchEvent(new MessageEvent('message', { data, source, ports }));
    });
  };
  const handshake = (options: { source?: Window | null; ports?: MessagePort[] } = {}): void => {
    emitOnWindow({ type: 'ready' }, options.source ?? win, options.ports ?? [parentPort]);
  };
  const emit = async (data: unknown): Promise<void> => {
    await act(async () => {
      framePort.postMessage(data);
      await settle();
    });
  };
  const rerenderWith = (next: Partial<React.ComponentProps<typeof DocumentSandbox>>): void => {
    rerender(<DocumentSandbox {...merged} {...next} />);
  };
  return {
    iframe,
    win,
    windowPost,
    toFrame,
    handshake,
    emit,
    emitOnWindow,
    container,
    rerenderWith,
  };
}

/**
 * A sandbox under the real theme provider. The provider writes to the root
 * element as it mounts, and the appearance hook watches that element, so the
 * resulting delivery is drained here inside `act` — left pending it would land
 * after the test body and update a still-mounted component outside it.
 */
async function renderThemedSandbox(
  props: Partial<React.ComponentProps<typeof DocumentSandbox>> = {}
): Promise<ReturnType<typeof renderSandbox>> {
  const rendered = renderSandbox(props, { wrapper: ThemeHarness });
  await act(async () => {});
  return rendered;
}

function statusOf(container: HTMLElement): string | null {
  const element = container.querySelector<HTMLElement>('#document-render-status');
  return element?.dataset['status'] ?? null;
}

describe('DocumentSandbox', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', ORIGIN);
  });

  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // Unmount before the page is stripped: the hook watches the root element,
    // so tearing the stylesheet out from under a live component would fire its
    // observer outside `act`.
    cleanup();
    // The theme harness writes through to the real page and to storage, so a
    // test that switched theme would otherwise hand the next one a dark app.
    for (const style of document.querySelectorAll('style[data-tokens]')) style.remove();
    document.documentElement.className = '';
    localStorage.clear();
  });

  describe('iframe attributes', () => {
    it('renders the web renderer page for html', () => {
      const { iframe } = renderSandbox({ kind: 'html' });
      expect(iframe.getAttribute('src')).toBe(`${ORIGIN}/render.html`);
    });

    it('renders the Pyodide runtime page for python', () => {
      const { iframe } = renderSandbox({ kind: 'python' });
      expect(iframe.getAttribute('src')).toBe(`${ORIGIN}/python.html`);
    });

    it('carries the document title', () => {
      const { iframe } = renderSandbox({ title: 'My Chart' });
      expect(iframe.getAttribute('title')).toBe('My Chart');
    });

    it('sandboxes with allow-scripts and nothing else', () => {
      const { iframe } = renderSandbox();
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('never grants same-origin, popups, top-navigation, or modals', () => {
      const { iframe } = renderSandbox();
      const sandbox = iframe.getAttribute('sandbox') ?? '';
      expect(sandbox).not.toContain('allow-same-origin');
      expect(sandbox).not.toContain('allow-popups');
      expect(sandbox).not.toContain('allow-top-navigation');
      expect(sandbox).not.toContain('allow-modals');
    });
  });

  describe('the handshake listener beats the frame', () => {
    it('takes a ready that arrives in the commit that mounted the frame', () => {
      // The frame begins loading the moment the iframe is committed, and its
      // `ready` is one-shot — nothing re-announces it. A listener installed in
      // a passive effect is installed in a *later task* than that commit, so a
      // frame quick enough to answer inside the gap (Capacitor serves the
      // sandbox from local files, with no network hop) hands its port to
      // nobody, and the panel sits at "Working…" forever. This probe answers
      // during the commit itself, which is the earliest the frame could.
      const { parentPort, toFrame } = frameChannel();
      const title = 'Handshake';
      function ReadyDuringCommit(): null {
        useLayoutEffect(() => {
          const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
          globalThis.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'ready' },
              source: frame?.contentWindow ?? null,
              ports: [parentPort],
            })
          );
        }, []);
        return null;
      }

      render(
        <>
          <DocumentSandbox
            kind="html"
            code="<p>x</p>"
            title={title}
            isStreaming={false}
            pendingView={null}
          />
          <ReadyDuringCommit />
        </>
      );

      expect(toFrame).toHaveBeenCalledWith({
        type: 'init',
        kind: 'html',
        code: '<p>x</p>',
        requestId: 'req-1',
        ...UNPAINTED,
      });
    });
  });

  describe('auto-render (html/js/react)', () => {
    it('sends init through the port when the frame reports ready', () => {
      const { toFrame, handshake } = renderSandbox({ kind: 'html', code: '<p>x</p>' });
      handshake();
      expect(toFrame).toHaveBeenCalledWith({
        type: 'init',
        kind: 'html',
        code: '<p>x</p>',
        requestId: 'req-1',
        ...UNPAINTED,
      });
    });

    it('sends nothing into the frame window, wildcard or otherwise', () => {
      const { windowPost, handshake } = renderSandbox();
      handshake();
      expect(windowPost).not.toHaveBeenCalled();
    });

    it('never posts into the frame window across a whole render cycle', async () => {
      // The frame's origin is opaque, so anything posted at its window is
      // dropped without an error — the failure that leaves a document at
      // "Working…" forever. Nothing may take that route.
      const { windowPost, toFrame, handshake, emit, container, iframe, win } = renderSandbox();
      handshake();
      await emit({ type: 'rendered', requestId: 'req-1' });

      expect(statusOf(container)).toBe('rendered');
      expect(toFrame).toHaveBeenCalledTimes(1);
      // The spy is only worth anything while it still watches the live frame.
      expect(iframe.contentWindow).toBe(win);
      expect(windowPost).not.toHaveBeenCalled();
    });
  });

  describe('render-status element', () => {
    it('starts in a non-rendered state', () => {
      const { container } = renderSandbox();
      expect(statusOf(container)).not.toBe('rendered');
    });

    it('does not flip to rendered on a loading message', async () => {
      const { emit, handshake, container } = renderSandbox();
      handshake();
      await emit({ type: 'loading', requestId: 'req-1', phase: 'transpiling' });
      expect(statusOf(container)).not.toBe('rendered');
    });

    it('flips to rendered only when the frame posts rendered', async () => {
      const { emit, handshake, container } = renderSandbox();
      handshake();
      await emit({ type: 'rendered', requestId: 'req-1' });
      expect(statusOf(container)).toBe('rendered');
    });

    it('exposes a stable literal id for on-device and Playwright proofs', () => {
      const { container } = renderSandbox();
      expect(container.querySelector('#document-render-status')).not.toBeNull();
    });
  });

  describe('message hygiene', () => {
    it('ignores messages from a foreign source', () => {
      const { handshake, container } = renderSandbox();
      handshake({ source: globalThis.window });
      // no init means still booting; a foreign ready must not start a run
      expect(statusOf(container)).toBe('booting');
    });

    it('ignores malformed messages on the window', () => {
      const { emitOnWindow, container } = renderSandbox();
      emitOnWindow({ type: 'not-a-real-message' });
      expect(statusOf(container)).toBe('booting');
    });

    it('ignores malformed messages on the port', async () => {
      const { emit, handshake, container } = renderSandbox();
      handshake();
      await emit({ type: 'not-a-real-message' });
      expect(statusOf(container)).toBe('loading');
    });

    it('ignores messages for a stale request id', async () => {
      const { emit, handshake, container } = renderSandbox();
      handshake();
      await emit({ type: 'rendered', requestId: 'req-999' });
      expect(statusOf(container)).not.toBe('rendered');
    });

    it('ignores a frame message that arrives on the window instead of the port', () => {
      // Only the handshake rides the window; everything the frame reports about
      // a request comes back over the port it transferred.
      const { emitOnWindow, handshake, container } = renderSandbox();
      handshake();
      emitOnWindow({ type: 'rendered', requestId: 'req-1' });
      expect(statusOf(container)).not.toBe('rendered');
    });

    it('ignores a ready that carries no port', () => {
      const { toFrame, handshake, container } = renderSandbox();
      handshake({ ports: [] });
      expect(toFrame).not.toHaveBeenCalled();
      expect(statusOf(container)).toBe('booting');
    });

    it('ignores a ready that arrives on the port', async () => {
      const { toFrame, handshake, emit } = renderSandbox();
      handshake();
      await emit({ type: 'ready' });
      expect(toFrame).toHaveBeenCalledTimes(1);
    });
  });

  describe('the first ready wins', () => {
    it('ignores a second ready from the same frame', () => {
      const { toFrame, handshake } = renderSandbox();
      handshake();
      expect(toFrame).toHaveBeenCalledTimes(1);

      const attacker = frameChannel();
      handshake({ ports: [attacker.parentPort] });

      expect(toFrame).toHaveBeenCalledTimes(1);
      expect(attacker.toFrame).not.toHaveBeenCalled();
    });

    it('does not redirect later traffic to a port a second ready offered', async () => {
      // Document code shares the frame's realm and can mint a channel of its
      // own; handing one up must not capture the bridge.
      const user = userEvent.setup();
      const { toFrame, handshake } = renderSandbox({ kind: 'python', code: 'print(1)' });
      handshake();
      const attacker = frameChannel();
      handshake({ ports: [attacker.parentPort] });

      await user.click(screen.getByRole('button', { name: /run/i }));

      expect(attacker.toFrame).not.toHaveBeenCalled();
      expect(toFrame).toHaveBeenNthCalledWith(1, {
        type: 'init',
        kind: 'python',
        code: 'print(1)',
        requestId: 'req-1',
        ...UNPAINTED,
      });
      expect(toFrame).toHaveBeenNthCalledWith(2, { type: 'run', requestId: 'req-1' });
    });
  });

  describe('loading and error surfacing', () => {
    it('announces a loading phase as text', async () => {
      const { emit, handshake } = renderSandbox();
      handshake();
      await emit({ type: 'loading', requestId: 'req-1', phase: 'loading-modules' });
      // Surfaced both in the visible loading card and the aria-live status mirror.
      expect(screen.getAllByText(/loading modules/i).length).toBeGreaterThan(0);
    });

    it('renders an error card with friendly text on a bridge error', async () => {
      const { emit, handshake } = renderSandbox();
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'import_failed', message: 'boom' });
      expect(screen.getByRole('alert')).toHaveTextContent(/module import failed/i);
    });

    it('maps a render deadline to a friendly message', async () => {
      const { emit, handshake } = renderSandbox();
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'timed_out', message: '' });
      expect(screen.getByRole('alert')).toHaveTextContent(/too long/i);
    });

    it('maps input_unsupported to a friendly message', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'error', requestId: 'req-1', code: 'input_unsupported', message: '' });
      expect(screen.getByRole('alert')).toHaveTextContent(/interactive input/i);
    });
  });

  describe('python run lifecycle', () => {
    it('does not auto-run python on ready; shows a Run button', () => {
      const { toFrame, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      expect(toFrame).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });

    it('disables Run until the frame is ready', () => {
      renderSandbox({ kind: 'python' });
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
    });

    it('sends init then run when Run is clicked', async () => {
      const user = userEvent.setup();
      const { toFrame, handshake } = renderSandbox({ kind: 'python', code: 'print(1)' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      expect(toFrame).toHaveBeenNthCalledWith(1, {
        type: 'init',
        kind: 'python',
        code: 'print(1)',
        requestId: 'req-1',
        ...UNPAINTED,
      });
      expect(toFrame).toHaveBeenNthCalledWith(2, { type: 'run', requestId: 'req-1' });
    });

    it('shows the source alongside the Run control', () => {
      renderSandbox({ kind: 'python', code: 'print("marker")' });
      expect(screen.getByText(/print\("marker"\)/)).toBeInTheDocument();
    });

    it('highlights that source as python, the same way the raw toggle does', () => {
      renderSandbox({ kind: 'python', code: 'print(1)' });
      expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toBe(
        '```python\nprint(1)\n```'
      );
    });

    it('streams console output into an aria-live log region', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'console', requestId: 'req-1', stream: 'stdout', text: 'hello out' });
      await emit({ type: 'console', requestId: 'req-1', stream: 'stderr', text: 'oops err' });
      const log = screen.getByRole('log');
      expect(log).toHaveTextContent('hello out');
      expect(log).toHaveTextContent('oops err');
    });

    it('renders a matplotlib PNG result as an image', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({
        type: 'result',
        requestId: 'req-1',
        outputs: [{ type: 'image/png', data: 'AAAA' }],
      });
      const img = screen.getByRole('img');
      expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    });

    it('renders a text result output', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({
        type: 'result',
        requestId: 'req-1',
        outputs: [{ type: 'text', data: 'the answer is 42' }],
      });
      expect(screen.getByText('the answer is 42')).toBeInTheDocument();
    });

    it('announces python loading phases while running', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'loading', requestId: 'req-1', phase: 'loading-runtime' });
      expect(screen.getAllByText(/loading python runtime/i).length).toBeGreaterThan(0);
    });

    it('marks the run complete on result (not rendered)', async () => {
      const user = userEvent.setup();
      const { emit, handshake, container } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'result', requestId: 'req-1', outputs: [] });
      expect(statusOf(container)).toBe('complete');
      expect(statusOf(container)).not.toBe('rendered');
    });
  });

  describe('frame appearance', () => {
    it('paints a new frame with the appearance the app is showing', async () => {
      stubTokens();
      const { toFrame, handshake } = await renderThemedSandbox({ code: '<p>x</p>' });
      handshake();

      expect(toFrame).toHaveBeenCalledWith({
        type: 'init',
        kind: 'html',
        code: '<p>x</p>',
        requestId: 'req-1',
        ...LIGHT,
      });
    });

    it('paints a python frame too, before anything is run in it', async () => {
      stubTokens();
      const user = userEvent.setup();
      const { toFrame, handshake } = await renderThemedSandbox({
        kind: 'python',
        code: 'print(1)',
      });
      handshake();
      await user.click(screen.getByRole('button', { name: /^run$/i }));

      expect(toFrame).toHaveBeenNthCalledWith(1, {
        type: 'init',
        kind: 'python',
        code: 'print(1)',
        requestId: 'req-1',
        ...LIGHT,
      });
    });

    // A second `init` would restyle too, and would restart the document doing
    // it. Nothing a reader is watching may be lost to a theme toggle.
    it('restyles a live frame without re-driving the document', async () => {
      stubTokens();
      const user = userEvent.setup();
      const { toFrame, handshake, iframe } = await renderThemedSandbox();
      handshake();
      toFrame.mockClear();

      await user.click(screen.getByRole('button', { name: 'switch theme' }));

      expect(toFrame).toHaveBeenCalledTimes(1);
      expect(toFrame).toHaveBeenCalledWith({ type: 'theme', ...DARK });
      // The same element, so the frame was never torn down and rebuilt.
      expect(screen.getByTitle('Preview')).toBe(iframe);
    });

    it('states the colour scheme even where the tokens do not resolve', async () => {
      const { toFrame, handshake } = await renderThemedSandbox();
      handshake();

      expect(toFrame).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'init', theme: 'light' })
      );
    });

    // The path a theme toggle really takes in Chromium and Safari. Measured
    // there: `startViewTransition` runs its callback after the click handler has
    // exited, so the state change is no longer inside a discrete event and React
    // flushes it on a task rather than synchronously — while the class write in
    // that same callback reaches the observer a microtask earlier. The frame must
    // still be told one appearance, with its two halves agreeing.
    it('pairs the theme with its own colours under a view transition', async () => {
      stubTokens();
      const restore = stubViewTransitions();
      try {
        const user = userEvent.setup();
        const { toFrame, handshake, iframe } = await renderThemedSandbox();
        handshake();
        toFrame.mockClear();

        await user.click(screen.getByRole('button', { name: 'switch theme' }));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(toFrame).toHaveBeenCalledTimes(1);
        expect(toFrame).toHaveBeenCalledWith({ type: 'theme', ...DARK });
        expect(screen.getByTitle('Preview')).toBe(iframe);
      } finally {
        restore();
      }
    });

    // The accessibility contrast tiers move the same tokens the theme does, and
    // a frame that missed one shows a canvas that does not match its panel.
    it('restyles for a contrast tier the theme never moved', async () => {
      stubTokens();
      const { toFrame, handshake, iframe } = await renderThemedSandbox();
      handshake();
      toFrame.mockClear();

      await act(async () => {
        document.documentElement.classList.add('a11y-contrast-high');
        await Promise.resolve();
      });

      expect(toFrame).toHaveBeenCalledTimes(1);
      expect(toFrame).toHaveBeenCalledWith({
        type: 'theme',
        theme: 'light',
        background: '#ffffff',
        foreground: '#000000',
      });
      expect(screen.getByTitle('Preview')).toBe(iframe);
    });

    it('sends no restyle to a frame that has not handed over its port', async () => {
      stubTokens();
      const user = userEvent.setup();
      const { toFrame } = await renderThemedSandbox();

      await user.click(screen.getByRole('button', { name: 'switch theme' }));

      expect(toFrame).not.toHaveBeenCalled();
    });
  });

  describe('content sits on the panel background', () => {
    it('gives the console strip no fill of its own', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'console', requestId: 'req-1', stream: 'stdout', text: 'out' });

      expect(screen.getByRole('log').className).not.toMatch(/\bbg-/);
    });

    it('gives a text result no fill of its own', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'result', requestId: 'req-1', outputs: [{ type: 'text', data: '42' }] });

      expect(screen.getByText('42').className).not.toMatch(/\bbg-/);
    });

    it('does not wash the frame over while a document is loading', async () => {
      // The overlay covers the whole frame, so a fill of its own reads as a slab
      // laid over the document rather than as the panel it sits in.
      const { emit, handshake, container } = renderSandbox();
      handshake();
      await emit({ type: 'loading', requestId: 'req-1', phase: 'transpiling' });

      const overlay = container.querySelector('.absolute.inset-0');
      expect(overlay).not.toBeNull();
      expect(overlay?.className).not.toMatch(/\bbg-/);
    });

    it('keeps the tint the error card carries deliberately', async () => {
      const { emit, handshake } = renderSandbox();
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'import_failed', message: 'boom' });

      expect(screen.getByRole('alert').className).toContain('bg-destructive/5');
    });
  });

  describe('a document that is still being written', () => {
    it('shows the source in place of the frame until something renders', () => {
      const { handshake } = renderSandbox({ isStreaming: true });
      handshake();
      expect(screen.getByTestId('pending-source')).toBeInTheDocument();
    });

    it('does not surface a render deadline either, since the code is unfinished', async () => {
      const { emit, handshake, container } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'timed_out', message: '' });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('does not surface a failed attempt', async () => {
      const { emit, handshake, container } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('shows the render once one lands', async () => {
      const { emit, handshake, container } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'rendered', requestId: 'req-1' });
      expect(statusOf(container)).toBe('rendered');
      expect(screen.queryByTestId('pending-source')).not.toBeInTheDocument();
    });

    it('stops offering a render the live document has since died in', async () => {
      // A failure naming the request that already rendered is the frame saying
      // that very preview is gone (React tears its tree down), so there is no
      // last good picture left to hold — but the reader still sees nothing while
      // the message is unfinished, since more tokens may fix it.
      const { emit, handshake, container } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'rendered', requestId: 'req-1' });
      await emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });
      expect(statusOf(container)).toBe('streaming');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('pending-source')).toBeInTheDocument();
    });

    it('surfaces that death as soon as the message settles', async () => {
      const { emit, handshake, container, rerenderWith } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'rendered', requestId: 'req-1' });
      await emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });

      act(() => {
        rerenderWith({ isStreaming: false });
      });

      expect(screen.getByRole('alert')).toHaveTextContent(/crashed while running/i);
      expect(statusOf(container)).toBe('error');
    });

    it('surfaces the last failure as soon as the message settles', async () => {
      const { emit, handshake, container, rerenderWith } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

      act(() => {
        rerenderWith({ isStreaming: false });
      });

      expect(screen.getByRole('alert')).toHaveTextContent(/could not be compiled/i);
      expect(statusOf(container)).toBe('error');
    });

    it('holds back a failure the settling message has already superseded', async () => {
      // The message stops streaming in the same commit that delivers its last
      // chunk, so the attempt that failed ran against text the frame has since
      // been told nothing about. Its verdict is not about the document anyone
      // is now looking at.
      const { emit, handshake, container, rerenderWith } = renderSandbox({ isStreaming: true });
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

      rerenderWith({ code: '<h1>hi there</h1>', isStreaming: false });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('never flashes a superseded failure over the render it is holding', async () => {
      // The failure belongs to an attempt that never painted, so the picture on
      // screen is still good and still held.
      vi.useFakeTimers();
      try {
        const { emit, handshake, container, rerenderWith } = renderSandbox({ isStreaming: true });
        handshake();
        await emit({ type: 'rendered', requestId: 'req-1' });

        rerenderWith({ code: '<h1>hi there</h1>' });
        act(() => {
          vi.advanceTimersByTime(400);
        });
        await emit({ type: 'error', requestId: 'req-2', code: 'runtime_error', message: 'boom' });

        // The document grew again before that verdict could be shown, so it is
        // about text nobody is looking at any more.
        rerenderWith({ code: '<h1>hi there now</h1>', isStreaming: false });

        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(statusOf(container)).toBe('rendered');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps showing a python failure, which only an explicit run can cause', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python', isStreaming: true });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  describe('re-driving the frame as the document grows', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for the code to hold still before re-initializing', () => {
      const { toFrame, handshake, rerenderWith } = renderSandbox({ isStreaming: true });
      handshake();
      expect(toFrame).toHaveBeenCalledTimes(1);

      rerenderWith({ code: '<h1>hi t</h1>' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(toFrame).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(toFrame).toHaveBeenCalledTimes(2);
    });

    it('spends one attempt on a burst of edits, not one per edit', () => {
      const { toFrame, handshake, rerenderWith } = renderSandbox({ isStreaming: true });
      handshake();

      for (const code of ['<h1>h</h1>', '<h1>he</h1>', '<h1>hel</h1>']) {
        rerenderWith({ code });
        act(() => {
          vi.advanceTimersByTime(100);
        });
      }
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(toFrame).toHaveBeenCalledTimes(2);
      expect(toFrame).toHaveBeenLastCalledWith({
        type: 'init',
        kind: 'html',
        code: '<h1>hel</h1>',
        requestId: 'req-2',
        ...UNPAINTED,
      });
    });

    it('surfaces the verdict of the queued attempt, not the superseded one', async () => {
      const { toFrame, emit, handshake, container, rerenderWith } = renderSandbox({
        isStreaming: true,
      });
      handshake();
      await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

      rerenderWith({ code: '<h1>hi there</h1>', isStreaming: false });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(toFrame).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await emit({ type: 'error', requestId: 'req-2', code: 'import_failed', message: 'boom' });

      expect(screen.getByRole('alert')).toHaveTextContent(/module import failed/i);
      expect(statusOf(container)).toBe('error');
    });

    it('never re-initializes before the frame is ready', () => {
      const { toFrame, rerenderWith } = renderSandbox({ isStreaming: true });

      rerenderWith({ code: '<h1>later</h1>' });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(toFrame).not.toHaveBeenCalled();
    });

    it('leaves python to its Run button', () => {
      const { toFrame, handshake, rerenderWith } = renderSandbox({
        kind: 'python',
        isStreaming: true,
      });
      handshake();

      rerenderWith({ code: 'print(2)' });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(toFrame).not.toHaveBeenCalled();
    });
  });

  describe('stop tears down the frame', () => {
    it('drops console output from a killed run and clears the log', async () => {
      const user = userEvent.setup();
      const { emit, handshake } = renderSandbox({ kind: 'python' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await emit({ type: 'console', requestId: 'req-1', stream: 'stdout', text: 'before stop' });
      expect(screen.getByRole('log')).toHaveTextContent('before stop');

      await user.click(screen.getByRole('button', { name: /stop/i }));

      // A message from the torn-down frame must not reach the UI.
      await emit({ type: 'console', requestId: 'req-1', stream: 'stdout', text: 'after stop' });
      expect(screen.queryByText('after stop')).not.toBeInTheDocument();
      expect(screen.queryByText('before stop')).not.toBeInTheDocument();
    });

    it('hands the replacement frame the bridge and never posts to the dead port', async () => {
      const user = userEvent.setup();
      const { toFrame, handshake } = renderSandbox({ kind: 'python', code: 'print(1)' });
      handshake();
      await user.click(screen.getByRole('button', { name: /run/i }));
      await user.click(screen.getByRole('button', { name: /stop/i }));
      const callsToDeadPort = toFrame.mock.calls.length;

      const replacement = frameChannel();
      const iframe = screen.getByTitle<HTMLIFrameElement>('Preview');
      act(() => {
        globalThis.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'ready' },
            source: iframe.contentWindow,
            ports: [replacement.parentPort],
          })
        );
      });
      await user.click(screen.getByRole('button', { name: /run/i }));

      expect(replacement.toFrame).toHaveBeenCalledWith({
        type: 'init',
        kind: 'python',
        code: 'print(1)',
        requestId: 'req-2',
        ...UNPAINTED,
      });
      expect(toFrame).toHaveBeenCalledTimes(callsToDeadPort);
    });

    it('disables Stop before a run has started', () => {
      renderSandbox({ kind: 'python' });
      expect(screen.getByRole('button', { name: /stop/i })).toBeDisabled();
    });
  });
});
