import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DocumentSandbox } from './document-sandbox';

const ORIGIN = 'http://localhost:7400';

function renderSandbox(props: Partial<React.ComponentProps<typeof DocumentSandbox>> = {}): {
  iframe: HTMLIFrameElement;
  win: Window;
  postSpy: ReturnType<typeof vi.spyOn>;
  emit: (data: unknown, source?: Window | null) => void;
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
  const { container, rerender } = render(<DocumentSandbox {...merged} />);
  const iframe = screen.getByTitle<HTMLIFrameElement>(merged.title);
  const win = iframe.contentWindow!;
  const postSpy = vi.spyOn(win, 'postMessage');
  const emit = (data: unknown, source: Window | null = win): void => {
    act(() => {
      globalThis.dispatchEvent(new MessageEvent('message', { data, source }));
    });
  };
  const rerenderWith = (next: Partial<React.ComponentProps<typeof DocumentSandbox>>): void => {
    rerender(<DocumentSandbox {...merged} {...next} />);
  };
  return { iframe, win, postSpy, emit, container, rerenderWith };
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  describe('auto-render (html/js/react)', () => {
    it('sends init to the frame when it reports ready', () => {
      const { postSpy, emit } = renderSandbox({ kind: 'html', code: '<p>x</p>' });
      emit({ type: 'ready' });
      expect(postSpy).toHaveBeenCalledWith(
        { type: 'init', kind: 'html', code: '<p>x</p>', requestId: 'req-1' },
        ORIGIN
      );
    });

    it('posts to the frame targeting the sandbox origin, never a wildcard', () => {
      const { postSpy, emit } = renderSandbox();
      emit({ type: 'ready' });
      expect(postSpy).not.toHaveBeenCalledWith(expect.anything(), '*');
    });
  });

  describe('render-status element', () => {
    it('starts in a non-rendered state', () => {
      const { container } = renderSandbox();
      expect(statusOf(container)).not.toBe('rendered');
    });

    it('does not flip to rendered on a loading message', () => {
      const { emit, container } = renderSandbox();
      emit({ type: 'ready' });
      emit({ type: 'loading', requestId: 'req-1', phase: 'transpiling' });
      expect(statusOf(container)).not.toBe('rendered');
    });

    it('flips to rendered only when the frame posts rendered', () => {
      const { emit, container } = renderSandbox();
      emit({ type: 'ready' });
      emit({ type: 'rendered', requestId: 'req-1' });
      expect(statusOf(container)).toBe('rendered');
    });

    it('exposes a stable literal id for on-device and Playwright proofs', () => {
      const { container } = renderSandbox();
      expect(container.querySelector('#document-render-status')).not.toBeNull();
    });
  });

  describe('message hygiene', () => {
    it('ignores messages from a foreign source', () => {
      const { emit, container } = renderSandbox();
      emit({ type: 'ready' }, globalThis.window);
      // no init means still booting; a foreign ready must not start a run
      expect(statusOf(container)).toBe('booting');
    });

    it('ignores malformed messages', () => {
      const { emit, container } = renderSandbox();
      emit({ type: 'not-a-real-message' });
      expect(statusOf(container)).toBe('booting');
    });

    it('ignores messages for a stale request id', () => {
      const { emit, container } = renderSandbox();
      emit({ type: 'ready' });
      emit({ type: 'rendered', requestId: 'req-999' });
      expect(statusOf(container)).not.toBe('rendered');
    });
  });

  describe('loading and error surfacing', () => {
    it('announces a loading phase as text', () => {
      const { emit } = renderSandbox();
      emit({ type: 'ready' });
      emit({ type: 'loading', requestId: 'req-1', phase: 'loading-modules' });
      // Surfaced both in the visible loading card and the aria-live status mirror.
      expect(screen.getAllByText(/loading modules/i).length).toBeGreaterThan(0);
    });

    it('renders an error card with friendly text on a bridge error', () => {
      const { emit } = renderSandbox();
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'import_failed', message: 'boom' });
      expect(screen.getByRole('alert')).toHaveTextContent(/module import failed/i);
    });

    it('maps a render deadline to a friendly message', () => {
      const { emit } = renderSandbox();
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'timed_out', message: '' });
      expect(screen.getByRole('alert')).toHaveTextContent(/too long/i);
    });

    it('maps input_unsupported to a friendly message', async () => {
      const user = userEvent.setup();
      const { emit } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({ type: 'error', requestId: 'req-1', code: 'input_unsupported', message: '' });
      expect(screen.getByRole('alert')).toHaveTextContent(/interactive input/i);
    });
  });

  describe('python run lifecycle', () => {
    it('does not auto-run python on ready; shows a Run button', () => {
      const { postSpy, emit } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      expect(postSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });

    it('disables Run until the frame is ready', () => {
      renderSandbox({ kind: 'python' });
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
    });

    it('sends init then run when Run is clicked', async () => {
      const user = userEvent.setup();
      const { postSpy, emit } = renderSandbox({ kind: 'python', code: 'print(1)' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      expect(postSpy).toHaveBeenNthCalledWith(
        1,
        { type: 'init', kind: 'python', code: 'print(1)', requestId: 'req-1' },
        ORIGIN
      );
      expect(postSpy).toHaveBeenNthCalledWith(2, { type: 'run', requestId: 'req-1' }, ORIGIN);
    });

    it('shows the source alongside the Run control', () => {
      renderSandbox({ kind: 'python', code: 'print("marker")' });
      expect(screen.getByText(/print\("marker"\)/)).toBeInTheDocument();
    });

    it('streams console output into an aria-live log region', async () => {
      const user = userEvent.setup();
      const { emit } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({ type: 'console', requestId: 'req-1', stream: 'stdout', text: 'hello out' });
      emit({ type: 'console', requestId: 'req-1', stream: 'stderr', text: 'oops err' });
      const log = screen.getByRole('log');
      expect(log).toHaveTextContent('hello out');
      expect(log).toHaveTextContent('oops err');
    });

    it('renders a matplotlib PNG result as an image', async () => {
      const user = userEvent.setup();
      const { emit } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({
        type: 'result',
        requestId: 'req-1',
        outputs: [{ type: 'image/png', data: 'AAAA' }],
      });
      const img = screen.getByRole('img');
      expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    });

    it('renders a text result output', async () => {
      const user = userEvent.setup();
      const { emit } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({
        type: 'result',
        requestId: 'req-1',
        outputs: [{ type: 'text', data: 'the answer is 42' }],
      });
      expect(screen.getByText('the answer is 42')).toBeInTheDocument();
    });

    it('announces python loading phases while running', async () => {
      const user = userEvent.setup();
      const { emit } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({ type: 'loading', requestId: 'req-1', phase: 'loading-runtime' });
      expect(screen.getAllByText(/loading python runtime/i).length).toBeGreaterThan(0);
    });

    it('marks the run complete on result (not rendered)', async () => {
      const user = userEvent.setup();
      const { emit, container } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({ type: 'result', requestId: 'req-1', outputs: [] });
      expect(statusOf(container)).toBe('complete');
      expect(statusOf(container)).not.toBe('rendered');
    });
  });

  describe('a document that is still being written', () => {
    it('shows the source in place of the frame until something renders', () => {
      const { emit } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      expect(screen.getByTestId('pending-source')).toBeInTheDocument();
    });

    it('does not surface a render deadline either, since the code is unfinished', () => {
      const { emit, container } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'timed_out', message: '' });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('does not surface a failed attempt', () => {
      const { emit, container } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('shows the render once one lands', () => {
      const { emit, container } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'rendered', requestId: 'req-1' });
      expect(statusOf(container)).toBe('rendered');
      expect(screen.queryByTestId('pending-source')).not.toBeInTheDocument();
    });

    it('stops offering a render the live document has since died in', () => {
      // A failure naming the request that already rendered is the frame saying
      // that very preview is gone (React tears its tree down), so there is no
      // last good picture left to hold — but the reader still sees nothing while
      // the message is unfinished, since more tokens may fix it.
      const { emit, container } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'rendered', requestId: 'req-1' });
      emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });
      expect(statusOf(container)).toBe('streaming');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('pending-source')).toBeInTheDocument();
    });

    it('surfaces that death as soon as the message settles', () => {
      const { emit, container, rerenderWith } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'rendered', requestId: 'req-1' });
      emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });

      act(() => {
        rerenderWith({ isStreaming: false });
      });

      expect(screen.getByRole('alert')).toHaveTextContent(/crashed while running/i);
      expect(statusOf(container)).toBe('error');
    });

    it('surfaces the last failure as soon as the message settles', () => {
      const { emit, container, rerenderWith } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

      act(() => {
        rerenderWith({ isStreaming: false });
      });

      expect(screen.getByRole('alert')).toHaveTextContent(/could not be compiled/i);
      expect(statusOf(container)).toBe('error');
    });

    it('holds back a failure the settling message has already superseded', () => {
      // The message stops streaming in the same commit that delivers its last
      // chunk, so the attempt that failed ran against text the frame has since
      // been told nothing about. Its verdict is not about the document anyone
      // is now looking at.
      const { emit, container, rerenderWith } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

      rerenderWith({ code: '<h1>hi there</h1>', isStreaming: false });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('never flashes a superseded failure over the render it is holding', () => {
      // The failure belongs to an attempt that never painted, so the picture on
      // screen is still good and still held.
      vi.useFakeTimers();
      try {
        const { emit, container, rerenderWith } = renderSandbox({ isStreaming: true });
        emit({ type: 'ready' });
        emit({ type: 'rendered', requestId: 'req-1' });

        rerenderWith({ code: '<h1>hi there</h1>' });
        act(() => {
          vi.advanceTimersByTime(400);
        });
        emit({ type: 'error', requestId: 'req-2', code: 'runtime_error', message: 'boom' });

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
      const { emit } = renderSandbox({ kind: 'python', isStreaming: true });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });
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
      const { postSpy, emit, rerenderWith } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      expect(postSpy).toHaveBeenCalledTimes(1);

      rerenderWith({ code: '<h1>hi t</h1>' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(postSpy).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(postSpy).toHaveBeenCalledTimes(2);
    });

    it('spends one attempt on a burst of edits, not one per edit', () => {
      const { postSpy, emit, rerenderWith } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });

      for (const code of ['<h1>h</h1>', '<h1>he</h1>', '<h1>hel</h1>']) {
        rerenderWith({ code });
        act(() => {
          vi.advanceTimersByTime(100);
        });
      }
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(postSpy).toHaveBeenLastCalledWith(
        { type: 'init', kind: 'html', code: '<h1>hel</h1>', requestId: 'req-2' },
        ORIGIN
      );
    });

    it('surfaces the verdict of the queued attempt, not the superseded one', () => {
      const { postSpy, emit, container, rerenderWith } = renderSandbox({ isStreaming: true });
      emit({ type: 'ready' });
      emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

      rerenderWith({ code: '<h1>hi there</h1>', isStreaming: false });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      emit({ type: 'error', requestId: 'req-2', code: 'import_failed', message: 'boom' });

      expect(screen.getByRole('alert')).toHaveTextContent(/module import failed/i);
      expect(statusOf(container)).toBe('error');
    });

    it('never re-initializes before the frame is ready', () => {
      const { postSpy, rerenderWith } = renderSandbox({ isStreaming: true });

      rerenderWith({ code: '<h1>later</h1>' });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(postSpy).not.toHaveBeenCalled();
    });

    it('leaves python to its Run button', () => {
      const { postSpy, emit, rerenderWith } = renderSandbox({ kind: 'python', isStreaming: true });
      emit({ type: 'ready' });

      rerenderWith({ code: 'print(2)' });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  describe('stop tears down the frame', () => {
    it('drops console output from a killed run and clears the log', async () => {
      const user = userEvent.setup();
      const { emit, iframe } = renderSandbox({ kind: 'python' });
      emit({ type: 'ready' });
      await user.click(screen.getByRole('button', { name: /run/i }));
      emit({ type: 'console', requestId: 'req-1', stream: 'stdout', text: 'before stop' });
      expect(screen.getByRole('log')).toHaveTextContent('before stop');

      const killedWindow = iframe.contentWindow!;
      await user.click(screen.getByRole('button', { name: /stop/i }));

      // A message from the torn-down frame must not reach the UI.
      act(() => {
        globalThis.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'console', requestId: 'req-1', stream: 'stdout', text: 'after stop' },
            source: killedWindow,
          })
        );
      });
      expect(screen.queryByText('after stop')).not.toBeInTheDocument();
      expect(screen.queryByText('before stop')).not.toBeInTheDocument();
    });

    it('disables Stop before a run has started', () => {
      renderSandbox({ kind: 'python' });
      expect(screen.getByRole('button', { name: /stop/i })).toBeDisabled();
    });
  });
});
