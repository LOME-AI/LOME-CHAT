import * as React from 'react';
import { Highlighter, type LucideIcon, Pause, Play, Square } from 'lucide-react';

import { TTS_MODEL_DOWNLOAD_MB } from '@hushbox/shared';

import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { TtsDownloadBar } from '../accessibility/tts-download-bar';
import { useA11yStore } from '../accessibility/store';
import { cn } from '../../lib/utilities';
import type { ChunkHighlighter } from '../accessibility/lib/chunk-highlighter';
import type {
  DocumentReader,
  DocumentReaderChunk,
  DocumentReaderState,
} from '../accessibility/lib/document-reader';
import type { TtsVoice } from '../accessibility/lib/tts-engine';

// A post page marks its rendered body with `data-reading` and carries exactly
// one such article, so this selector is unambiguous there.
const DEFAULT_ARTICLE_SELECTOR = 'article[data-reading]';
const DOWNLOAD_LABEL = 'Preparing the voice';
const ERROR_TEXT = "Couldn't start playback. Try again.";
// The blog reader's local-processing disclosure, split into the two halves
// that render as the two desktop lines. The break is authored rather
// than left to wrapping so it cannot land somewhere ragged at a width nobody
// tested; the halves are balanced, not sentence-aligned, so neither overruns
// the reader column. The size comes from the shared figure so it cannot drift
// from the widget's copy.
const DISCLOSURE_LINE_1 = 'Local text to speech. First listen downloads';
const DISCLOSURE_LINE_2 = `the voice model (about ${TTS_MODEL_DOWNLOAD_MB.toString()} MB, one time).`;
/**
 * How long the load must run before the download bar is worth showing.
 * A heuristic is unavoidable: transformers.js exposes no cache-hit signal, and
 * a cached read replays byte-identical progress events, so nothing in the data
 * distinguishes "downloading 90 MB" from "reading it back out of the cache".
 * Elapsed time is the only discriminator. The failure mode is deliberately
 * one-sided: a real download's bar appears this late (harmless), while a cached
 * load, which completes well inside the window, never flashes one.
 */
const DOWNLOAD_BAR_DWELL_MS = 900;

/** UI-facing lifecycle, collapsing the reader's `idle`/`stopped` into one idle state. */
type UiStatus = 'idle' | 'loading' | 'speaking' | 'paused' | 'error';

type ReaderModule = typeof import('../accessibility/lib/document-reader');
type HighlighterModule = typeof import('../accessibility/lib/chunk-highlighter');

/** Runs `action` only while the run that created it is still the current one. */
type RunGuard = (action: () => void) => void;

/** What painting a chunk needs: the live toggle state and the active highlighter. */
interface HighlightHandles {
  readonly highlightOnRef: React.RefObject<boolean>;
  readonly highlighterRef: React.RefObject<ChunkHighlighter | null>;
}

/** Stable handles a single read needs; assembled fresh per run from refs. */
interface RunContext extends HighlightHandles {
  readonly voice: TtsVoice;
  /** The context unlocked in the click; the engine adopts it as its player. */
  readonly audioCtx: AudioContext;
  /** The chunk being spoken, so the toggle can repaint without the reader. */
  readonly lastChunkRef: React.RefObject<DocumentReaderChunk | null>;
  readonly readerRef: React.RefObject<DocumentReader | null>;
  readonly applyReaderState: (next: DocumentReaderState) => void;
  readonly setPercent: (pct: number) => void;
}

/** Paint (or, when highlighting is off, clear) the chunk currently being read. */
function paintChunk(handles: HighlightHandles, chunk: DocumentReaderChunk): void {
  if (handles.highlightOnRef.current) {
    handles.highlighterRef.current?.highlight({
      blockEl: chunk.blockEl,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
    });
  } else {
    handles.highlighterRef.current?.clear();
  }
}

/** Build the highlighter + reader and kick off playback for one run. */
function wireReader(
  modules: { reader: ReaderModule; highlighter: HighlighterModule },
  container: HTMLElement,
  ctx: RunContext,
  live: RunGuard
): void {
  ctx.highlighterRef.current = modules.highlighter.createChunkHighlighter(container);
  const documentReader = modules.reader.createDocumentReader({
    container,
    voice: ctx.voice,
    onChunk: (chunk) => {
      live(() => {
        ctx.lastChunkRef.current = chunk;
        paintChunk(ctx, chunk);
      });
    },
    onState: (next) => {
      live(() => {
        ctx.applyReaderState(next);
      });
    },
    onDownloadProgress: ({ pct }) => {
      live(() => {
        ctx.setPercent(pct);
      });
    },
  });
  ctx.readerRef.current = documentReader;
  // Fires the read; never rejects (engine failures surface via onState('error')).
  void documentReader.start(ctx.audioCtx);
}

/**
 * Create (once) the AudioContext that will play the read, restart it if the
 * browser has stopped it, and prime it with a silent buffer. iOS Safari unlocks
 * audio per AudioContext instance, and only from inside the gesture's own
 * synchronous call stack — an `await` drops WebKit's user-activation token — so
 * this must run before the dynamic import below, and the very context unlocked
 * here is what the engine then adopts. A later listen re-primes that same
 * instance rather than building another: the engine keeps the first context it
 * adopts, and browsers cap how many contexts one page may hold.
 *
 * The `resume()` is load-bearing on iOS and cannot be left to the engine: a
 * context is born suspended there, and backgrounding the tab moves it to
 * WebKit's fourth state, `interrupted`, which nothing recovers on its own. The
 * engine's own recovery matches only `suspended` and runs outside the gesture,
 * where WebKit no longer honours it, so without this a listen after a tab
 * switch plays silently.
 */
function primeAudioContext(existing: AudioContext | null): AudioContext {
  const ctx = existing ?? new AudioContext();
  if (ctx.state !== 'running') void ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = ctx.createBuffer(1, 1, 22_050);
  source.connect(ctx.destination);
  source.start(0);
  return ctx;
}

/**
 * The band's reserved status slot: the download bar and the error line render
 * here, in the gap between the byline block and the reader stack, never inside
 * the stack. The slot is always present so neither arrival reflows anything.
 *
 * Where the band is a row, its height is the largest of its members' heights,
 * and `self-center` does not exempt this slot from that maximum — centring only
 * stops the slot being stretched, it still contributes its own height. So the
 * band's height is invariant across the bar's arrival only while the slot's
 * content stays shorter than the byline block: one line of bar or error is
 * ~34px against the byline+tags block's ~70px. Adding a second line here (a
 * bytes/speed/ETA row, as the accessibility widget's audio section renders)
 * would grow the band.
 *
 * Where the band is a column (mobile) an empty slot collapses instead, so the
 * reservation costs no dead space there.
 */
function BandStatusSlot({
  status,
  percent,
  showDownloadBar,
}: {
  readonly status: UiStatus;
  readonly percent: number;
  readonly showDownloadBar: boolean;
}): React.JSX.Element {
  let content: React.JSX.Element | null = null;
  if (showDownloadBar) {
    content = <TtsDownloadBar percent={percent} label={DOWNLOAD_LABEL} showLabel />;
  } else if (status === 'error') {
    content = (
      <p role="alert" className="text-destructive text-xs">
        {ERROR_TEXT}
      </p>
    );
  }
  return (
    <div
      data-slot="blog-reader-status"
      className="w-full min-w-0 self-center max-md:empty:hidden md:max-w-88 md:flex-1"
    >
      {content}
    </div>
  );
}

/** The four actions the one transport control can carry. */
interface TransportActions {
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
}

/** What the transport control says and does in one UI state. */
interface Transport {
  readonly label: string;
  /** Kept equal to, or a suffixed form of, the visible label (WCAG label in name). */
  readonly name: string;
  readonly Icon: LucideIcon;
  readonly onClick: () => void;
  /** A read is under way, so the control carries the in-progress fill. */
  readonly active: boolean;
}

function transportFor(status: UiStatus, actions: TransportActions): Transport {
  switch (status) {
    case 'speaking': {
      return { label: 'Pause', name: 'Pause', Icon: Pause, onClick: actions.onPause, active: true };
    }
    case 'paused': {
      return { label: 'Resume', name: 'Resume', Icon: Play, onClick: actions.onResume, active: true };
    }
    case 'loading': {
      // The model download has no cancel, so ending the read outright is all
      // this state can offer; pausing becomes possible once audio is playing.
      return { label: 'Stop', name: 'Stop', Icon: Square, onClick: actions.onStop, active: true };
    }
    default: {
      return {
        label: 'Listen',
        name: 'Listen to this post',
        Icon: Play,
        onClick: actions.onStart,
        active: false,
      };
    }
  }
}

/**
 * The reader's only control: Listen, then Pause, then Resume. One button rather
 * than a transport row is a product decision — a paused read is resumed or
 * abandoned by leaving the page (each post load is a fresh page), never stopped
 * back to the top from here.
 */
function TransportButton({
  status,
  actions,
}: {
  readonly status: UiStatus;
  readonly actions: TransportActions;
}): React.JSX.Element {
  const { label, name, Icon, onClick, active } = transportFor(status, actions);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium',
        active ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground'
      )}
    >
      <Icon className="size-3" fill="currentColor" aria-hidden="true" />
      {label}
    </button>
  );
}

/** Always-visible highlight-while-reading toggle with its hover/focus tooltip. */
function HighlightToggle({
  on,
  onToggle,
}: {
  readonly on: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={on}
          aria-label="Highlight while reading"
          onClick={onToggle}
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-md',
            on ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          )}
        >
          <Highlighter className="size-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{`Highlight while reading: ${on ? 'on' : 'off'}`}</TooltipContent>
    </Tooltip>
  );
}

export interface BlogReadAloudProps {
  /**
   * CSS selector for the rendered article to read aloud. Defaults to the blog
   * post's `article[data-reading]` container.
   */
  readonly articleSelector?: string;
}

/**
 * Blog "Listen" control: a borderless reader stack (controls, disclosure) plus
 * the status slot that carries the download bar, reading the post aloud
 * on-device. It renders those as two siblings rather than one root because they
 * are two separate members of the post header's band, with the byline block's
 * gap between them; the mount point must therefore be a flex or grid container
 * (Astro's island wrapper is `display: contents`, so it does not interpose a
 * box). The heavy reader and TTS engine are pulled in only by the first-click
 * dynamic import, so the marketing island stays light. Voice comes from the
 * shared accessibility store; the read never gates on the chat read-aloud
 * toggles.
 */
export function BlogReadAloud({
  articleSelector = DEFAULT_ARTICLE_SELECTOR,
}: BlogReadAloudProps): React.JSX.Element {
  const voice = useA11yStore((s) => s.ttsVoice);
  const readingHighlight = useA11yStore((s) => s.readingHighlight);
  const update = useA11yStore((s) => s.update);

  const [status, setStatus] = React.useState<UiStatus>('idle');
  const [percent, setPercent] = React.useState(0);

  const readerRef = React.useRef<DocumentReader | null>(null);
  const highlighterRef = React.useRef<ChunkHighlighter | null>(null);
  // The chunk currently being spoken. The reader exposes no accessor for it, so
  // retaining it here is what lets the toggle repaint mid-sentence instead of
  // waiting for the reader to reach the next chunk. Nulled whenever the read
  // ends, so a toggle after a finished read cannot resurrect a stale sentence.
  const lastChunkRef = React.useRef<DocumentReaderChunk | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  // Monotonic run token: a stop bumps it so late work from a torn-down or
  // in-flight reader (dynamic import still resolving) is ignored.
  const runIdRef = React.useRef(0);

  // Mirrors read inside stable callbacks / listeners so they see current values
  // without re-subscribing.
  const voiceRef = React.useRef(voice);
  const highlightOnRef = React.useRef(readingHighlight);
  const statusRef = React.useRef<UiStatus>(status);
  React.useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);
  React.useEffect(() => {
    highlightOnRef.current = readingHighlight;
    // Symmetric on purpose: off removes the live indicator at once, and on
    // repaints the sentence being spoken. `paintChunk` picks the direction from
    // the ref just assigned; with no retained chunk there is nothing to paint.
    const chunk = lastChunkRef.current;
    if (chunk === null) highlighterRef.current?.clear();
    else paintChunk({ highlightOnRef, highlighterRef }, chunk);
  }, [readingHighlight]);

  // Second half of the gate: the bar waits out `DOWNLOAD_BAR_DWELL_MS` of
  // `loading` before it may appear. Any exit from `loading` (including the
  // error path, which never reaches 100%) drops the flag and cancels the timer,
  // so the gate can never leave the bar waiting on a completion that stopped
  // coming.
  const [dwellElapsed, setDwellElapsed] = React.useState(false);
  React.useEffect(() => {
    setDwellElapsed(false);
    if (status !== 'loading') return;
    const timer = globalThis.setTimeout(() => {
      setDwellElapsed(true);
    }, DOWNLOAD_BAR_DWELL_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [status]);
  // The load reports exactly one 100% before it finishes, so a full bar means
  // the download is done and only warmup remains: drop it rather than parking a
  // full bar on screen until `speaking`.
  const showDownloadBar = status === 'loading' && dwellElapsed && percent < 100;

  const applyReaderState = React.useCallback((next: DocumentReaderState): void => {
    switch (next) {
      case 'loading': {
        setStatus('loading');
        break;
      }
      case 'speaking': {
        setStatus('speaking');
        break;
      }
      case 'paused': {
        // Deliberately keeps `lastChunkRef` and the painted highlight: the
        // sentence on screen is the only marker of where the read will pick up.
        setStatus('paused');
        break;
      }
      case 'error': {
        lastChunkRef.current = null;
        highlighterRef.current?.clear();
        setStatus('error');
        break;
      }
      case 'idle':
      case 'stopped': {
        lastChunkRef.current = null;
        highlighterRef.current?.clear();
        setStatus('idle');
        break;
      }
      default: {
        // Compile-time exhaustiveness. Without it a widened
        // DocumentReaderState still type-checks here and the new state falls
        // through as a silent no-op — which is exactly how 'paused' arrived.
        const unhandled: never = next;
        return unhandled;
      }
    }
  }, []);

  const handleStop = React.useCallback((): void => {
    runIdRef.current += 1;
    lastChunkRef.current = null;
    readerRef.current?.stop();
    readerRef.current = null;
    highlighterRef.current?.clear();
    highlighterRef.current = null;
    setStatus('idle');
    setPercent(0);
  }, []);

  const handlePause = React.useCallback((): void => {
    // Deliberately narrow, and nothing like handleStop: the run token is not
    // bumped and neither the reader nor the highlighter is released, because a
    // resumed read is the same run still reporting through the same callbacks.
    // Bumping the token here would make `live` drop every one of them — a
    // control reading "Resume" over silence, with nothing raising an error.
    // The reader's own pause() stops the engine, so there is no stop() here.
    readerRef.current?.pause();
  }, []);

  const handleResume = React.useCallback((): void => {
    // The same in-gesture unlock the first listen performs: while the read was
    // paused the browser may have suspended or interrupted the context, and
    // only this synchronous stack can restart it.
    audioCtxRef.current = primeAudioContext(audioCtxRef.current);
    // Never rejects; a failure surfaces through onState('error').
    void readerRef.current?.resume();
  }, []);

  const handleStart = React.useCallback(async (): Promise<void> => {
    // Only ever invoked from the Listen button, which renders only while idle,
    // so there is no re-entrant start to guard against.
    const container = document.querySelector<HTMLElement>(articleSelector);
    if (container === null) {
      setStatus('error');
      return;
    }
    const runId = (runIdRef.current += 1);
    // A stop (button, Esc, unmount) bumps runIdRef; `live` then drops every
    // effect of this run — the reader creation itself and each later callback.
    const live: RunGuard = (action) => {
      if (runIdRef.current === runId) action();
    };
    setPercent(0);
    setStatus('loading');
    try {
      // Still inside the click's synchronous call stack — the iOS unlock is
      // only valid here, before the import below is awaited.
      const audioCtx = (audioCtxRef.current = primeAudioContext(audioCtxRef.current));
      // First-click only: the reader module pulls the TTS engine, kept out of
      // the initial marketing bundle by loading it here rather than statically.
      const [reader, highlighter] = await Promise.all([
        import('../accessibility/lib/document-reader'),
        import('../accessibility/lib/chunk-highlighter'),
      ]);
      const ctx: RunContext = {
        voice: voiceRef.current,
        audioCtx,
        highlightOnRef,
        highlighterRef,
        lastChunkRef,
        readerRef,
        applyReaderState,
        setPercent,
      };
      live(() => {
        wireReader({ reader, highlighter }, container, ctx, live);
      });
    } catch {
      applyReaderState('error');
    }
  }, [applyReaderState, articleSelector]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // Escape does whatever the control does, so the two never disagree: it
      // pauses playback, and ends the read only while the model is loading,
      // where there is nothing to pause.
      if (statusRef.current === 'speaking') handlePause();
      else if (statusRef.current === 'loading') handleStop();
    }
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [handlePause, handleStop]);

  React.useEffect(
    () => () => {
      readerRef.current?.stop();
    },
    []
  );

  return (
    <>
      <BandStatusSlot status={status} percent={percent} showDownloadBar={showDownloadBar} />

      <div
        data-slot="blog-reader-stack"
        className="relative flex w-full min-w-0 md:w-72 md:flex-none"
      >
        {/*
          Taking the contents out of flow where the band is a row is what bounds
          the reader's height to the byline block: with nothing in flow the shell
          contributes no height of its own, so it can only be stretched to the
          band's height, never grow it, and `overflow-hidden` clips anything that
          would not fit. Where the band is a column the contents stay in flow and
          the stack sizes to them.
        */}
        <div className="flex w-full flex-col items-center justify-center gap-2 overflow-hidden text-center md:absolute md:inset-0">
          <div className="flex items-center justify-center gap-2">
            <TransportButton
              status={status}
              actions={{
                onStart: () => void handleStart(),
                onStop: handleStop,
                onPause: handlePause,
                onResume: handleResume,
              }}
            />
            <HighlightToggle
              on={readingHighlight}
              onToggle={() => {
                update({ readingHighlight: !readingHighlight });
              }}
            />
          </div>

          <p
            data-slot="blog-reader-disclosure"
            className="text-muted-foreground text-[0.7rem] leading-snug"
          >
            {/*
              Two authored lines where the band is a row: each half is held on
              one line, so the disclosure is exactly two lines at every desktop
              width. Below the breakpoint the halves rejoin as inline text and
              wrap naturally to three, the founder's explicit exception. The
              space between them belongs to the joined-up mobile sentence.
            */}
            <span className="block whitespace-nowrap max-md:inline max-md:whitespace-normal">
              {DISCLOSURE_LINE_1}
            </span>{' '}
            <span className="block whitespace-nowrap max-md:inline max-md:whitespace-normal">
              {DISCLOSURE_LINE_2}
            </span>
          </p>
        </div>
      </div>
    </>
  );
}
