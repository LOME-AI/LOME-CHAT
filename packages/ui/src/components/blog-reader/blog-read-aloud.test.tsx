import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TTS_MODEL_DOWNLOAD_MB } from '@hushbox/shared';

import { BlogReadAloud } from './blog-read-aloud';
import { useA11yStore } from '../accessibility/store';
import type { CreateDocumentReaderOptions } from '../accessibility/lib/document-reader';

const h = vi.hoisted(() => ({
  captured: { value: null as CreateDocumentReaderOptions | null },
  reader: { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), chunkCount: 3 },
  highlighter: { highlight: vi.fn(), clear: vi.fn() },
  createDocumentReader: vi.fn(),
  createChunkHighlighter: vi.fn(),
}));

vi.mock('../accessibility/lib/document-reader', () => ({
  createDocumentReader: h.createDocumentReader,
}));

vi.mock('../accessibility/lib/chunk-highlighter', () => ({
  createChunkHighlighter: h.createChunkHighlighter,
}));

/** The reader options the component passed to `createDocumentReader`. */
function readerOptions(): CreateDocumentReaderOptions {
  if (h.captured.value === null) throw new Error('createDocumentReader was not called');
  return h.captured.value;
}

/** One of the component's band parts, by its `data-slot` name. */
function bandPart(name: 'status' | 'stack' | 'disclosure'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-slot="blog-reader-${name}"]`);
  if (el === null) throw new Error(`missing blog-reader-${name}`);
  return el;
}

function listenButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Listen to this post' });
}

function stopButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Stop' });
}

function pauseButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Pause' });
}

function resumeButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Resume' });
}

interface FakeAudioSource {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
}

interface FakeAudioContext {
  state: AudioContextState;
  readonly destination: object;
  readonly createBuffer: ReturnType<typeof vi.fn>;
  readonly createBufferSource: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
}

let createdContexts: FakeAudioContext[] = [];
let primedSources: FakeAudioSource[] = [];
const OriginalAudioContext = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;

function makeAudioContext(): FakeAudioContext {
  // Born suspended, as it is on iOS Safari until something unlocks it.
  const ctx: FakeAudioContext = {
    state: 'suspended',
    destination: {},
    createBuffer: vi.fn(() => ({})),
    createBufferSource: vi.fn(() => {
      const source: FakeAudioSource = { connect: vi.fn(), start: vi.fn() };
      primedSources.push(source);
      return source;
    }),
    resume: vi.fn(() => {
      ctx.state = 'running';
      return Promise.resolve();
    }),
  };
  createdContexts.push(ctx);
  return ctx;
}

function blockEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('article[data-reading] p');
  if (el === null) throw new Error('missing article paragraph');
  return el;
}

/** Click Listen and wait until the (mocked) reader has been constructed. */
async function startReading(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(listenButton());
  await waitFor(() => {
    expect(h.createDocumentReader).toHaveBeenCalled();
  });
}

/**
 * Longer than the component's cache-hit dwell, so advancing by it always lands
 * past the gate. Kept local rather than imported: the test pins the observable
 * behavior, not the exact constant the component chose.
 */
const PAST_DWELL_MS = 1000;

/**
 * Click Listen under fake timers and let the click's dynamic import settle.
 * Testing Library's `waitFor` polls on timers, so it cannot be used here;
 * `advanceTimersByTimeAsync` yields to the real task queue instead, draining
 * the pending microtasks that resolve the import.
 */
async function startReadingWithFakeTimers(): Promise<void> {
  fireEvent.click(listenButton());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.createDocumentReader).toHaveBeenCalled();
}

beforeEach(() => {
  createdContexts = [];
  primedSources = [];
  (globalThis as { AudioContext?: unknown }).AudioContext = vi.fn(makeAudioContext);
  h.captured.value = null;
  h.reader.start.mockReset();
  h.reader.stop.mockReset();
  h.reader.pause.mockReset();
  h.reader.resume.mockReset().mockImplementation(() => Promise.resolve());
  h.highlighter.highlight.mockReset();
  h.highlighter.clear.mockReset();
  h.createDocumentReader.mockReset().mockImplementation((options: CreateDocumentReaderOptions) => {
    h.captured.value = options;
    return h.reader;
  });
  h.createChunkHighlighter.mockReset().mockReturnValue(h.highlighter);

  // Fresh article container each test. Testing Library's automatic afterEach
  // cleanup unmounts prior render trees (and any open radix portals) before
  // this runs, so replacing body content here is safe; wiping it in an
  // afterEach instead would orphan an open tooltip portal mid-cleanup.
  document.body.innerHTML = '<article data-reading><p>Every message is encrypted.</p></article>';
  act(() => {
    useA11yStore.getState().reset();
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (OriginalAudioContext === undefined) {
    delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  } else {
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext = OriginalAudioContext;
  }
});

describe('BlogReadAloud — idle', () => {
  it('renders the Listen control and no active-state chrome', () => {
    render(<BlogReadAloud />);
    expect(listenButton()).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the canonical local-privacy disclosure verbatim', () => {
    render(<BlogReadAloud />);
    // Number sourced from the shared figure so it cannot drift from the widget.
    expect(bandPart('disclosure')).toHaveTextContent(
      `Local text to speech. First listen downloads the voice model (about ${TTS_MODEL_DOWNLOAD_MB.toString()} MB, one time).`
    );
  });

  it('defaults the highlight toggle to on (pressed)', () => {
    render(<BlogReadAloud />);
    expect(screen.getByRole('button', { name: 'Highlight while reading' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});

describe('BlogReadAloud — band layout', () => {
  it('renders the status slot as a sibling of the reader stack, not inside it', () => {
    render(<BlogReadAloud />);

    const status = bandPart('status');
    const stack = bandPart('stack');
    expect(stack).not.toContainElement(status);
    expect(status).not.toContainElement(stack);
    expect(status.parentElement).toBe(stack.parentElement);
  });

  it('keeps the status slot present and empty while idle', () => {
    render(<BlogReadAloud />);

    // Reserved, not conditional: the slot the download bar lands in already
    // occupies the band's gap, so its arrival reflows nothing.
    expect(bandPart('status')).toBeEmptyDOMElement();
  });

  it('renders the download bar in the status slot rather than the reader stack', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });

    const bar = screen.getByRole('status');
    expect(bandPart('status')).toContainElement(bar);
    expect(bandPart('stack')).not.toContainElement(bar);
  });

  it('renders the error line in the status slot rather than the reader stack', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('error');
    });

    const alert = screen.getByRole('alert');
    expect(bandPart('status')).toContainElement(alert);
    expect(bandPart('stack')).not.toContainElement(alert);
  });

  it('breaks the disclosure into exactly two elements so the desktop break is fixed', () => {
    render(<BlogReadAloud />);

    const lines = bandPart('disclosure').querySelectorAll('span');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent('Local text to speech. First listen downloads');
    expect(lines[1]).toHaveTextContent(
      `the voice model (about ${TTS_MODEL_DOWNLOAD_MB.toString()} MB, one time).`
    );
  });

  it('pins each disclosure line against wrapping on desktop and frees it on mobile', () => {
    render(<BlogReadAloud />);

    // The two/three-line split is pure layout, which happy-dom does not compute;
    // the classes carrying it are the only part assertable here.
    for (const line of bandPart('disclosure').querySelectorAll('span')) {
      expect(line).toHaveClass('whitespace-nowrap');
      expect(line).toHaveClass('max-md:inline');
      expect(line).toHaveClass('max-md:whitespace-normal');
    }
  });
});

describe('BlogReadAloud — highlight toggle', () => {
  it('flips aria-pressed and persists the preference on click', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    const toggle = screen.getByRole('button', { name: 'Highlight while reading' });

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(useA11yStore.getState().readingHighlight).toBe(false);
  });

  it('shows the on-state tooltip copy on hover', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.hover(screen.getByRole('button', { name: 'Highlight while reading' }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Highlight while reading: on');
  });

  it('shows the off-state tooltip copy when highlighting is off', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    act(() => {
      useA11yStore.getState().update({ readingHighlight: false });
    });

    await user.hover(screen.getByRole('button', { name: 'Highlight while reading' }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Highlight while reading: off');
  });
});

describe('BlogReadAloud — audio unlock', () => {
  it('creates and primes the AudioContext inside the click, before the import resolves', async () => {
    render(<BlogReadAloud />);

    fireEvent.click(listenButton());

    // Nothing is awaited between the click dispatch and these assertions, so
    // everything they observe happened inside the gesture's synchronous call
    // stack — the only place iOS Safari lets an AudioContext unlock.
    expect(createdContexts).toHaveLength(1);
    expect(primedSources).toHaveLength(1);
    const source = primedSources[0]!;
    expect(source.connect).toHaveBeenCalledWith(createdContexts[0]!.destination);
    expect(source.start).toHaveBeenCalled();
    // The dynamic import has not resolved yet: the unlock strictly precedes it.
    expect(h.createDocumentReader).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(h.createDocumentReader).toHaveBeenCalled();
    });
  });

  it('restarts a non-running context inside the click, before the import resolves', async () => {
    render(<BlogReadAloud />);

    fireEvent.click(listenButton());

    // Nothing is awaited before this assertion, so the restart happened inside
    // the gesture's synchronous stack — the only place WebKit honours it, and
    // the only recovery for a context the browser interrupted while the tab
    // was in the background.
    expect(createdContexts[0]!.resume).toHaveBeenCalled();
    expect(h.createDocumentReader).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(h.createDocumentReader).toHaveBeenCalled();
    });
  });

  it('leaves an already-running context alone on a later listen', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    await user.click(stopButton());
    const ctx = createdContexts[0]!;
    expect(ctx.state).toBe('running');
    ctx.resume.mockClear();

    await startReading(user);

    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('restarts an interrupted context inside the resume click, before the reader resumes', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });
    // Backgrounding the tab while paused is what leaves it in this state, and
    // the reader's resume() takes no context, so nothing downstream restarts it.
    const ctx = createdContexts[0]!;
    ctx.state = 'suspended';
    ctx.resume.mockClear();

    fireEvent.click(resumeButton());

    // Asserted with nothing awaited in between, so this all happened in the
    // gesture's own synchronous stack, and the unlock strictly precedes the
    // reader call that will schedule audio on it.
    expect(ctx.resume).toHaveBeenCalled();
    expect(h.reader.resume).toHaveBeenCalled();
    expect(ctx.resume.mock.invocationCallOrder[0]!).toBeLessThan(
      h.reader.resume.mock.invocationCallOrder[0]!
    );
  });

  it('hands the primed context to the reader so the engine adopts it', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await startReading(user);

    expect(h.reader.start).toHaveBeenCalledWith(createdContexts[0]);
  });

  it('re-primes the one context on a later listen instead of creating another', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    await user.click(stopButton());

    await startReading(user);

    expect(createdContexts).toHaveLength(1);
    expect(primedSources).toHaveLength(2);
  });
});

describe('BlogReadAloud — starting playback', () => {
  it('shows the Stop control immediately on first click', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.click(listenButton());

    expect(stopButton()).toBeInTheDocument();
  });

  it('constructs the reader with the container, store voice, and a highlighter', async () => {
    const user = userEvent.setup();
    act(() => {
      useA11yStore.getState().update({ ttsVoice: 'bf_emma' });
    });
    render(<BlogReadAloud />);

    await startReading(user);

    const options = readerOptions();
    expect(options.container).toBe(document.querySelector('article[data-reading]'));
    expect(options.voice).toBe('bf_emma');
    expect(h.createChunkHighlighter).toHaveBeenCalledWith(
      document.querySelector('article[data-reading]')
    );
    expect(h.reader.start).toHaveBeenCalledTimes(1);
  });

  it('sets error and skips the reader when the article is absent', async () => {
    const user = userEvent.setup();
    document.body.innerHTML = '';
    render(<BlogReadAloud />);

    await user.click(listenButton());

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
    expect(h.createDocumentReader).not.toHaveBeenCalled();
  });

  it('surfaces an error when constructing the reader throws', async () => {
    const user = userEvent.setup();
    h.createDocumentReader.mockImplementation(() => {
      throw new Error('boom');
    });
    render(<BlogReadAloud />);

    await user.click(listenButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
    });
  });
});

describe('BlogReadAloud — reader lifecycle', () => {
  it('keeps the download bar visible when the reader reports loading', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      readerOptions().onState('loading');
      vi.advanceTimersByTime(PAST_DWELL_MS);
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('forwards download progress to the bar', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 42 });
    });

    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('hides the download bar once speaking begins', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();
    // The bar must genuinely be on screen first, or the assertion below would
    // hold for a bar that was never rendered at all.
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => {
      readerOptions().onState('speaking');
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(pauseButton()).toBeInTheDocument();
  });

  it('highlights each spoken chunk while highlighting is on', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    const p = blockEl();

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({ index: 0, blockEl: p, text: 'x', startOffset: 0, endOffset: 5 });
    });

    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: p,
      startOffset: 0,
      endOffset: 5,
    });
  });

  it('clears instead of highlighting when highlighting is off', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await user.click(screen.getByRole('button', { name: 'Highlight while reading' }));
    await startReading(user);
    const p = blockEl();

    act(() => {
      readerOptions().onChunk({ index: 0, blockEl: p, text: 'x', startOffset: 0, endOffset: 5 });
    });

    expect(h.highlighter.highlight).not.toHaveBeenCalled();
    expect(h.highlighter.clear).toHaveBeenCalled();
  });

  it('clears the current highlight when toggled off mid-read', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });
    h.highlighter.clear.mockClear();

    await user.click(screen.getByRole('button', { name: 'Highlight while reading' }));

    expect(h.highlighter.clear).toHaveBeenCalled();
  });

  it('returns to idle and clears the highlight when the read completes', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('idle');
    });

    expect(listenButton()).toBeInTheDocument();
    expect(h.highlighter.clear).toHaveBeenCalled();
  });

  it('returns to idle when the reader reports it stopped', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('stopped');
    });

    expect(listenButton()).toBeInTheDocument();
  });

  it('shows the error line and clears the highlight on reader error', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('error');
    });

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
    expect(h.highlighter.clear).toHaveBeenCalled();
  });
});

describe('BlogReadAloud — cached-model download bar', () => {
  it('does not show the download bar immediately on first click', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);

    await startReadingWithFakeTimers();

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the download bar once the load outlasts the cache-hit dwell', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
    });

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Preparing the voice');
  });

  it('never shows the download bar for a cached load that completes before the dwell', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(200);
      readerOptions().onDownloadProgress({ pct: 100 });
    });
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unmounts the download bar at 100% without waiting for speaking', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => {
      readerOptions().onDownloadProgress({ pct: 100 });
    });

    expect(screen.queryByRole('status')).toBeNull();
    // Still loading (warmup): the bar left on its own, not because of `speaking`.
    expect(stopButton()).toBeInTheDocument();
  });

  it('replaces the download bar with the error line when the load fails short of 100%', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });

    act(() => {
      readerOptions().onState('error');
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
  });
});

describe('BlogReadAloud — highlight repaint', () => {
  it('repaints the current chunk when highlighting is toggled back on mid-read', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    const p = blockEl();
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({ index: 0, blockEl: p, text: 'x', startOffset: 0, endOffset: 5 });
    });
    const toggle = screen.getByRole('button', { name: 'Highlight while reading' });
    await user.click(toggle);
    h.highlighter.highlight.mockClear();

    await user.click(toggle);

    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: p,
      startOffset: 0,
      endOffset: 5,
    });
  });

  it('does not repaint a finished read when highlighting is toggled back on', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({
        index: 0,
        blockEl: blockEl(),
        text: 'x',
        startOffset: 0,
        endOffset: 5,
      });
      readerOptions().onState('idle');
    });
    const toggle = screen.getByRole('button', { name: 'Highlight while reading' });
    await user.click(toggle);
    h.highlighter.highlight.mockClear();

    await user.click(toggle);

    expect(h.highlighter.highlight).not.toHaveBeenCalled();
  });
});

describe('BlogReadAloud — stopping', () => {
  // Stopping is what the control offers while the model loads, since that load
  // cannot be cancelled or paused. Once audio plays the control pauses instead.
  it('stops the reader and returns to idle when Stop is clicked during the load', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    await user.click(stopButton());

    expect(h.reader.stop).toHaveBeenCalled();
    expect(listenButton()).toBeInTheDocument();
  });

  it('stops on Escape while the model loads', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    await user.keyboard('{Escape}');

    expect(h.reader.stop).toHaveBeenCalled();
    expect(listenButton()).toBeInTheDocument();
  });

  it('ignores Escape while idle', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.keyboard('{Escape}');

    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('ignores stale reader callbacks after a stop', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    const options = readerOptions();
    await user.click(stopButton());

    act(() => {
      options.onState('speaking');
    });

    expect(listenButton()).toBeInTheDocument();
  });

  it('replays from the start on a second Listen after stopping', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    await user.click(stopButton());

    await user.click(listenButton());

    await waitFor(() => {
      expect(h.createDocumentReader).toHaveBeenCalledTimes(2);
    });
  });

  it('stops the reader on unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BlogReadAloud />);
    await startReading(user);

    unmount();

    expect(h.reader.stop).toHaveBeenCalled();
  });
});

/** Drive the mocked reader into `speaking` with one chunk painted. */
function speakChunk(span: { readonly startOffset: number; readonly endOffset: number }): void {
  act(() => {
    readerOptions().onState('speaking');
    readerOptions().onChunk({ index: 0, blockEl: blockEl(), text: 'x', ...span });
  });
}

describe('BlogReadAloud — pause and resume', () => {
  it('labels the control Pause while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
    });

    expect(pauseButton()).toHaveTextContent('Pause');
  });

  it('pauses the reader when the control is clicked while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });

    await user.click(pauseButton());

    expect(h.reader.pause).toHaveBeenCalledTimes(1);
    // Pausing already stops the engine once; a stop() here would be a second one.
    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('labels the control Resume once the reader reports paused', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });

    expect(resumeButton()).toHaveTextContent('Resume');
  });

  it('resumes the reader when the control is clicked while paused', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });

    await user.click(resumeButton());

    expect(h.reader.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps the reader connected across a pause, so the resumed read still paints', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    speakChunk({ startOffset: 0, endOffset: 5 });
    await user.click(pauseButton());
    act(() => {
      readerOptions().onState('paused');
    });

    await user.click(resumeButton());
    // Everything the resumed read reports: a run token bumped by the pause, or
    // a highlighter dropped by it, would silently discard all of this and leave
    // a control reading "Resume" over dead air.
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({
        index: 1,
        blockEl: blockEl(),
        text: 'y',
        startOffset: 6,
        endOffset: 11,
      });
    });

    expect(h.reader.resume).toHaveBeenCalledTimes(1);
    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: blockEl(),
      startOffset: 6,
      endOffset: 11,
    });
    expect(pauseButton()).toBeInTheDocument();
  });

  it('leaves the paused sentence highlighted', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    speakChunk({ startOffset: 0, endOffset: 5 });
    h.highlighter.clear.mockClear();

    act(() => {
      readerOptions().onState('paused');
    });

    // The painted sentence is the only marker of where the read will resume.
    expect(h.highlighter.clear).not.toHaveBeenCalled();
  });

  it('repaints the paused sentence when highlighting is toggled off and back on', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    speakChunk({ startOffset: 0, endOffset: 5 });
    act(() => {
      readerOptions().onState('paused');
    });
    const toggle = screen.getByRole('button', { name: 'Highlight while reading' });

    await user.click(toggle);
    expect(h.highlighter.clear).toHaveBeenCalled();
    h.highlighter.highlight.mockClear();
    await user.click(toggle);

    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: blockEl(),
      startOffset: 0,
      endOffset: 5,
    });
  });

  it('pauses rather than stops on Escape while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });

    await user.keyboard('{Escape}');

    expect(h.reader.pause).toHaveBeenCalledTimes(1);
    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('ignores keys other than Escape while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });

    // Not Space or Enter: those activate the focused control, which is the
    // button the click left focused, so they pause by design rather than by
    // this listener.
    await user.keyboard('a{ArrowDown}');

    expect(h.reader.pause).not.toHaveBeenCalled();
    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('ignores Escape while paused', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });

    await user.keyboard('{Escape}');

    expect(h.reader.pause).not.toHaveBeenCalled();
    expect(h.reader.stop).not.toHaveBeenCalled();
    expect(resumeButton()).toBeInTheDocument();
  });

  it('stops the reader on unmount while paused', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });
    await user.click(pauseButton());
    act(() => {
      readerOptions().onState('paused');
    });

    unmount();

    // Once, by the teardown: the pause itself must not have stopped anything.
    expect(h.reader.stop).toHaveBeenCalledTimes(1);
  });
});

describe('BlogReadAloud — custom selector', () => {
  it('reads the container named by articleSelector', async () => {
    const user = userEvent.setup();
    document.body.innerHTML = '<section id="doc"><p>Hello.</p></section>';
    render(<BlogReadAloud articleSelector="#doc" />);

    await startReading(user);

    expect(readerOptions().container).toBe(document.querySelector('#doc'));
  });
});
