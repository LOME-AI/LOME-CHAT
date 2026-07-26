// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { MarkdownRenderer } from '@/components/chat/message/markdown-renderer';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { useDocumentStore } from '@/stores/document';

/**
 * The whole preview pipeline, driven end to end: a real `<MarkdownRenderer>`
 * parses the message, its document card publishes to the real store, and the
 * real panel mounts the real sandbox whose bridge these tests speak. Nothing
 * here inspects markdown structure — whether a preview may run is answered by
 * what the frame reports back, which is the only authority that cannot disagree
 * with the renderer about where a code block ends.
 */

const ORIGIN = 'http://localhost:7400';

function mockMatchMedia(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const REACT_LINES = [
  'export default function Widget() {',
  ...Array.from({ length: 13 }, (_, index) => `  const line${String(index)} = ${String(index)};`),
  '  return <div>hello</div>;',
].join('\n');

const PARTIAL_REACT = `\`\`\`jsx\n${REACT_LINES}`;
const CLOSED_REACT = `\`\`\`jsx\n${REACT_LINES}\n\`\`\``;
/** The same document after further tokens landed inside its block. */
const GROWN_REACT = `\`\`\`jsx\n${REACT_LINES}\n// and one more line\n\`\`\``;
const PARTIAL_MERMAID = '~~~mermaid\ngraph TD';

/** A raw-HTML code block: it reaches the card path without ever being a fence. */
const RAW_HTML_REACT = `<pre><code class="language-jsx">${REACT_LINES.replaceAll(
  '<',
  '&lt;'
)}</code></pre>`;

function Pipeline({
  content,
  isStreaming,
}: Readonly<{ content: string; isStreaming: boolean }>): React.JSX.Element {
  return (
    <>
      <MarkdownRenderer content={content} isStreaming={isStreaming} />
      <DocumentPanel />
    </>
  );
}

function statusOf(): string | null {
  return document.querySelector<HTMLElement>('#document-render-status')?.dataset['status'] ?? null;
}

interface Frame {
  /** Everything the panel sent through the port the frame transferred. */
  toFrame: ReturnType<typeof vi.spyOn>;
  /** The frame's one-shot announcement, carrying the port it mints. */
  handshake: () => void;
  emit: (data: unknown) => Promise<void>;
}

/** Every channel a test minted, so no endpoint outlives the test that made it. */
const channels: MessageChannel[] = [];

/** Open the message's document card and take hold of the sandbox frame's bridge. */
async function openPreview(title: string): Promise<Frame> {
  await userEvent.click(await screen.findByTestId(TEST_IDS.documentCard));
  const iframe = await screen.findByTitle<HTMLIFrameElement>(title);
  const win = iframe.contentWindow;
  if (!win) throw new Error('sandbox frame has no window');

  // The frame mints the channel and transfers one end on `ready`; these tests
  // stand in for the frame, so they hold the other end.
  const channel = new MessageChannel();
  channels.push(channel);
  const toFrame = vi.spyOn(channel.port2, 'postMessage');
  const handshake = (): void => {
    act(() => {
      globalThis.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'ready' },
          source: win,
          ports: [channel.port2],
        })
      );
    });
  };
  // Port delivery is a task, not a microtask: yield the loop before asserting.
  const emit = async (data: unknown): Promise<void> => {
    await act(async () => {
      channel.port1.postMessage(data);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  };
  return { toFrame, handshake, emit };
}

describe('document preview pipeline', () => {
  beforeEach(() => {
    mockMatchMedia();
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', ORIGIN);
    useDocumentStore.setState({
      isPanelOpen: false,
      activeDocumentId: null,
      activeDocument: null,
      activeSelectionId: 0,
      isFullscreen: false,
    });
  });

  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('hides a failed attempt while the message is still streaming', async () => {
    render(<Pipeline content={PARTIAL_REACT} isStreaming />);

    const { handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
    expect(statusOf()).toBe('streaming');
  });

  it('announces the wait as a status, never as a failure', async () => {
    render(<Pipeline content={PARTIAL_REACT} isStreaming />);

    const { handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'error', requestId: 'req-1', code: 'runtime_error', message: 'boom' });

    expect(screen.getByRole('status')).toHaveTextContent(/preview starts/i);
    expect(screen.queryByText(/could not be compiled/i)).not.toBeInTheDocument();
  });

  it('shows the compile error once the message has stopped streaming', async () => {
    render(<Pipeline content={PARTIAL_REACT} isStreaming={false} />);

    const { handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be compiled/i);
    expect(statusOf()).toBe('error');
  });

  it('keeps the last good render while a newer attempt fails', async () => {
    const { rerender } = render(<Pipeline content={CLOSED_REACT} isStreaming />);

    const { toFrame, handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'rendered', requestId: 'req-1' });
    expect(statusOf()).toBe('rendered');

    rerender(<Pipeline content={GROWN_REACT} isStreaming />);
    await waitFor(() => {
      expect(toFrame).toHaveBeenCalledTimes(2);
    });
    await emit({ type: 'error', requestId: 'req-2', code: 'transpile_failed', message: 'boom' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(statusOf()).toBe('rendered');
  });

  it('paints no error when the message settles with an attempt still queued', async () => {
    // The ordinary shape: the last chunk of code and the end of the stream
    // arrive together, leaving a re-init in the debounce behind them.
    const { rerender } = render(<Pipeline content={CLOSED_REACT} isStreaming />);

    const { handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

    rerender(<Pipeline content={GROWN_REACT} isStreaming={false} />);
    await waitFor(() => {
      expect(useDocumentStore.getState().activeDocument?.isStreaming).toBe(false);
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(statusOf()).toBe('streaming');
  });

  it('re-drives the same frame rather than mounting a new one per token', async () => {
    const { rerender } = render(<Pipeline content={CLOSED_REACT} isStreaming />);

    const { toFrame, handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'rendered', requestId: 'req-1' });
    const firstFrame = screen.getByTitle('Widget');

    rerender(<Pipeline content={GROWN_REACT} isStreaming />);
    await waitFor(() => {
      expect(toFrame).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByTitle('Widget')).toBe(firstFrame);
  });

  it('holds a mermaid diagram as source while its message streams', async () => {
    render(<Pipeline content={PARTIAL_MERMAID} isStreaming />);

    await userEvent.click(await screen.findByTestId(TEST_IDS.documentCard));

    expect(await screen.findByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
    expect(screen.queryByText(/could not render this diagram/i)).not.toBeInTheDocument();
    expect(statusOf()).toBe('streaming');
  });

  it('renders a mermaid diagram once its message has settled', async () => {
    render(<Pipeline content={PARTIAL_MERMAID} isStreaming={false} />);

    await userEvent.click(await screen.findByTestId(TEST_IDS.documentCard));

    await waitFor(() => {
      expect(
        screen.queryByTestId(TEST_IDS.mermaidLoading) ??
          screen.queryByTestId(TEST_IDS.mermaidDiagram)
      ).toBeInTheDocument();
    });
  });

  it('hides a failed attempt for a raw-HTML code block that is still streaming', async () => {
    render(<Pipeline content={RAW_HTML_REACT} isStreaming />);

    const { handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(statusOf()).toBe('streaming');
  });

  it('shows the error for a raw-HTML code block once streaming has stopped', async () => {
    render(<Pipeline content={RAW_HTML_REACT} isStreaming={false} />);

    const { handshake, emit } = await openPreview('Widget');
    handshake();
    await emit({ type: 'error', requestId: 'req-1', code: 'transpile_failed', message: 'boom' });

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be compiled/i);
  });
});
