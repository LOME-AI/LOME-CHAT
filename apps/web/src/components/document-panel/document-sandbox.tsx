import * as React from 'react';
import { Button, Img, cn } from '@hushbox/ui';
import {
  parseFrameToParentMessage,
  type RunnableDocumentKind,
  type FrameToParentMessage,
  type ParentToFrameMessage,
  type ResultOutput,
  type DocumentErrorCode,
  type LoadingPhase,
} from '@hushbox/shared/documents';
import { sandboxOrigin, sandboxPageUrl } from '../../lib/sandbox-origin';
import { DocumentRenderStatus, PENDING_PREVIEW_TEXT } from './document-render-status';
import type { DocumentRenderStatusValue } from './document-render-status';

interface DocumentSandboxProps {
  kind: RunnableDocumentKind;
  code: string;
  title: string;
  /** Whether the message carrying this document is still being written. */
  isStreaming: boolean;
  /** Stands in for the frame while a streaming document has yet to render once. */
  pendingView: React.ReactNode;
}

interface ConsoleLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

interface SandboxState {
  status: DocumentRenderStatusValue;
  phase: LoadingPhase | null;
  consoleLines: ConsoleLine[];
  outputs: ResultOutput[];
  errorCode: DocumentErrorCode | null;
  /** Whether any attempt has ever painted, which is what a newer one may replace. */
  hasRendered: boolean;
  /**
   * Whether the attempt in flight is the one that painted what is on screen. A
   * react document can report a failure after its render succeeded — React tears
   * the tree down when a later commit round throws — and that is the difference
   * between a failure that killed the live preview and one from an attempt that
   * never painted, which leaves the last good picture alone.
   */
  currentAttemptRendered: boolean;
  /**
   * The code the frame was last given, which is the code `status` is a verdict
   * about. It lives in state rather than a ref because the difference between it
   * and the current code decides what is rendered.
   */
  initializedCode: string | null;
  frameKey: number;
}

type SandboxAction =
  | { type: 'idle' }
  | { type: 'auto-start'; code: string }
  | { type: 'python-start'; code: string }
  | { type: 'stop' }
  | { type: 'frame'; message: FrameToParentMessage; isPython: boolean };

const INITIAL_STATE: SandboxState = {
  status: 'booting',
  phase: null,
  consoleLines: [],
  outputs: [],
  errorCode: null,
  hasRendered: false,
  currentAttemptRendered: false,
  initializedCode: null,
  frameKey: 0,
};

/**
 * What is on screen while an attempt is in flight. A render already painted is
 * never blanked for a newer attempt — the frame holds the last good picture
 * until that attempt paints or fails, so a document that keeps growing does not
 * flash between a preview and a spinner.
 */
function statusWhileWorking(
  state: SandboxState,
  working: DocumentRenderStatusValue
): DocumentRenderStatusValue {
  return state.hasRendered ? 'rendered' : working;
}

function applyFrameMessage(
  state: SandboxState,
  message: FrameToParentMessage,
  isPython: boolean
): SandboxState {
  switch (message.type) {
    case 'loading': {
      return {
        ...state,
        phase: message.phase,
        status: isPython ? 'running' : statusWhileWorking(state, 'loading'),
      };
    }
    case 'rendered': {
      return {
        ...state,
        phase: null,
        errorCode: null,
        status: 'rendered',
        hasRendered: true,
        currentAttemptRendered: true,
      };
    }
    case 'console': {
      return {
        ...state,
        consoleLines: [
          ...state.consoleLines,
          { id: state.consoleLines.length, stream: message.stream, text: message.text },
        ],
      };
    }
    case 'result': {
      return { ...state, outputs: message.outputs, phase: null, status: 'complete' };
    }
    case 'error': {
      // A failure naming the attempt that painted means that preview is gone —
      // there is no last good picture left to fall back to while the message
      // finishes. A failure from an attempt that never painted changes nothing
      // about the render still on screen.
      return {
        ...state,
        errorCode: message.code,
        phase: null,
        status: 'error',
        hasRendered: state.currentAttemptRendered ? false : state.hasRendered,
        currentAttemptRendered: false,
      };
    }
    /* v8 ignore next 3 -- 'ready' is handled before dispatch and never reaches the reducer */
    case 'ready': {
      return state;
    }
  }
}

function sandboxReducer(state: SandboxState, action: SandboxAction): SandboxState {
  switch (action.type) {
    case 'idle': {
      return { ...state, status: 'idle' };
    }
    case 'auto-start': {
      return {
        ...state,
        status: statusWhileWorking(state, 'loading'),
        phase: null,
        errorCode: null,
        currentAttemptRendered: false,
        initializedCode: action.code,
      };
    }
    case 'python-start': {
      return {
        ...state,
        status: 'running',
        phase: null,
        consoleLines: [],
        outputs: [],
        errorCode: null,
        currentAttemptRendered: false,
        initializedCode: action.code,
      };
    }
    case 'stop': {
      // A remount (new frameKey → fresh window) is the kill switch.
      return { ...INITIAL_STATE, frameKey: state.frameKey + 1 };
    }
    case 'frame': {
      return applyFrameMessage(state, action.message, action.isPython);
    }
  }
}

const LOADING_PHASE_TEXT: Record<LoadingPhase, string> = {
  transpiling: 'Transpiling',
  'loading-modules': 'Loading modules',
  'loading-runtime': 'Loading Python runtime',
  'loading-packages': 'Installing packages',
  executing: 'Executing',
};

// Friendly, content-free copy per closed error code — the machine-readable code
// maps to user text, never the raw author error (that detail rides `message`).
const DOCUMENT_ERROR_TEXT: Record<DocumentErrorCode, string> = {
  transpile_failed: 'This document could not be compiled.',
  import_failed: 'A module import failed.',
  mount_failed: 'The component could not be mounted.',
  runtime_error: 'The document crashed while running.',
  unsupported_kind: 'This document type is not supported.',
  python_error: 'Python raised an error.',
  timed_out: 'This document took too long and was stopped.',
  input_unsupported:
    'This program asks for interactive input, which is not available in the preview.',
};

const STATIC_STATUS_TEXT: Record<
  Exclude<DocumentRenderStatusValue, 'loading' | 'running' | 'error'>,
  string
> = {
  booting: 'Loading preview',
  streaming: PENDING_PREVIEW_TEXT,
  idle: 'Ready to run',
  rendered: 'Preview rendered',
  complete: 'Run complete',
};

function statusText(
  status: DocumentRenderStatusValue,
  phase: LoadingPhase | null,
  errorText: string | null
): string {
  if (status === 'loading' || status === 'running') {
    return phase ? LOADING_PHASE_TEXT[phase] : 'Working';
  }
  if (status === 'error') {
    /* v8 ignore next -- status only becomes 'error' in the reducer's error branch, which sets errorCode in the same update, so errorText is never null here */
    return errorText ?? 'Something went wrong';
  }
  return STATIC_STATUS_TEXT[status];
}

function StatusMirror({
  status,
  phase,
  errorText,
}: Readonly<{
  status: DocumentRenderStatusValue;
  phase: LoadingPhase | null;
  errorText: string | null;
}>): React.JSX.Element {
  return <DocumentRenderStatus status={status} text={statusText(status, phase, errorText)} />;
}

function LoadingLine({ phase }: Readonly<{ phase: LoadingPhase | null }>): React.JSX.Element {
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      {phase ? LOADING_PHASE_TEXT[phase] : 'Working'}…
    </div>
  );
}

function ErrorCard({ text }: Readonly<{ text: string | null }>): React.JSX.Element | null {
  if (!text) return null;
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
    >
      {text}
    </div>
  );
}

function ConsoleStrip({ lines }: Readonly<{ lines: ConsoleLine[] }>): React.JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Program output"
      className="bg-muted/50 max-h-48 overflow-auto rounded-md p-3 font-mono text-xs"
    >
      {lines.map((line) => (
        <div
          key={line.id}
          data-stream={line.stream}
          className={cn('whitespace-pre-wrap', line.stream === 'stderr' && 'text-destructive')}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

function OutputList({ outputs }: Readonly<{ outputs: ResultOutput[] }>): React.JSX.Element | null {
  if (outputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {outputs.map((output, index) =>
        output.type === 'image/png' ? (
          <Img
            // Result outputs have no stable identity beyond position within a run.
            key={index}
            src={`data:image/png;base64,${output.data}`}
            alt="Generated figure"
            className="max-w-full rounded-md"
          />
        ) : (
          <pre
            key={index}
            className="bg-muted/50 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
          >
            {output.data}
          </pre>
        )
      )}
    </div>
  );
}

function PythonSandboxView({
  frame,
  code,
  state,
  errorText,
  onRun,
  onStop,
}: Readonly<{
  frame: React.JSX.Element;
  code: string;
  state: SandboxState;
  errorText: string | null;
  onRun: () => void;
  onStop: () => void;
}>): React.JSX.Element {
  const { status, phase, consoleLines, outputs } = state;
  const isBusy = status === 'loading' || status === 'running';
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {frame}
      <pre className="bg-muted/50 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
        {code}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'booting' || isBusy}>
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={onStop} disabled={status === 'booting'}>
          Stop
        </Button>
      </div>
      {isBusy ? <LoadingLine phase={phase} /> : null}
      <ErrorCard text={errorText} />
      <ConsoleStrip lines={consoleLines} />
      <OutputList outputs={outputs} />
      <StatusMirror status={status} phase={phase} errorText={errorText} />
    </div>
  );
}

// The blank frame shows nothing while a render document loads or fails, so an
// overlay carries the loading/error text; a settled render leaves the iframe clear.
function renderOverlay(
  status: DocumentRenderStatusValue,
  phase: LoadingPhase | null,
  errorText: string | null
): React.JSX.Element | null {
  if (status === 'loading' || status === 'running') return <LoadingLine phase={phase} />;
  if (status === 'error') return <ErrorCard text={errorText} />;
  return null;
}

function RenderSandboxView({
  frame,
  status,
  phase,
  errorText,
  pendingView,
}: Readonly<{
  frame: React.JSX.Element;
  status: DocumentRenderStatusValue;
  phase: LoadingPhase | null;
  errorText: string | null;
  pendingView: React.ReactNode;
}>): React.JSX.Element {
  const overlay = renderOverlay(status, phase, errorText);
  return (
    <div className="relative flex h-full flex-col">
      {frame}
      {status === 'streaming' ? pendingView : null}
      {overlay ? (
        <div className="bg-background/85 absolute inset-0 flex items-center justify-center p-4">
          {overlay}
        </div>
      ) : null}
      <StatusMirror status={status} phase={phase} errorText={errorText} />
    </div>
  );
}

/**
 * What the panel shows in place of the frame's own verdict.
 *
 * Two things make a verdict unusable. The message may still be arriving, so a
 * failure describes half-written code the reader cannot act on. Or the code may
 * have moved on since the frame last saw it — a re-init sits in the debounce, or
 * is in flight — so the verdict is about text nobody is looking at any more. The
 * second case outlives the first: a message that settles right after its closing
 * fence delivers its last chunk and stops streaming in the same commit, leaving
 * a queued attempt behind it. Keying only on streaming would paint that stale
 * failure over the document for as long as the debounce runs.
 *
 * In either case the panel shows the last good render, or the source. A verdict
 * only reaches the reader once an attempt against the code they can see has
 * reported. Python is exempt: it runs only when the reader asks, so its answer
 * is theirs to see.
 */
function displayStatus(
  state: SandboxState,
  isStreaming: boolean,
  isPython: boolean,
  code: string
): DocumentRenderStatusValue {
  if (isPython) return state.status;
  const superseded = state.initializedCode !== null && state.initializedCode !== code;
  if (!isStreaming && !superseded) return state.status;
  return state.hasRendered ? 'rendered' : 'streaming';
}

/**
 * How long the document must hold still before the frame is re-driven. Every
 * init costs a transpile and a mount, so a message that grows a token at a time
 * spends a handful of attempts on settled text instead of one per token.
 */
const REINIT_DEBOUNCE_MS = 300;

/**
 * Embeds the sandbox-origin renderer iframe and drives the typed bridge. All
 * untrusted document code executes inside this cross-origin, `allow-scripts`-only
 * frame — never in the app origin. html/js/react auto-render once the frame is
 * ready and re-render as the document grows; python waits for an explicit Run,
 * and Stop tears the frame down (the only way to kill a main-thread Python run).
 * The panel keys this component by the user's selection, so switching documents
 * remounts it with fresh state while a growing document keeps its frame.
 *
 * Whether a preview may run is never predicted from the source text — the frame
 * is handed the code and its answer is observed. While the message is still
 * streaming a reported failure is treated as unfinished code rather than broken
 * code, so nothing is shown for it.
 *
 * A react document may fail after it rendered — React tears its tree down when a
 * later commit round throws, which can happen once a lazily imported child
 * arrives or a deferred update lands. That failure retires the render it names
 * (the preview is gone, so there is nothing left to hold) and reaches the reader
 * through the same suppression rule as any other verdict.
 */
export function DocumentSandbox({
  kind,
  code,
  title,
  isStreaming,
  pendingView,
}: Readonly<DocumentSandboxProps>): React.JSX.Element {
  const isPython = kind === 'python';
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const requestIdRef = React.useRef<string | null>(null);
  const requestCounterRef = React.useRef(0);
  const readyRef = React.useRef(false);
  const [state, dispatch] = React.useReducer(sandboxReducer, INITIAL_STATE);
  const { errorCode, frameKey } = state;

  const nextRequestId = React.useCallback((): string => {
    requestCounterRef.current += 1;
    return `req-${String(requestCounterRef.current)}`;
  }, []);

  const postToFrame = React.useCallback((message: ParentToFrameMessage): void => {
    // Target the sandbox origin explicitly — never '*' — so the message is never
    // delivered to a frame that navigated itself elsewhere.
    iframeRef.current?.contentWindow?.postMessage(message, sandboxOrigin());
  }, []);

  const startAutoRun = React.useCallback((): void => {
    const requestId = nextRequestId();
    requestIdRef.current = requestId;
    dispatch({ type: 'auto-start', code });
    postToFrame({ type: 'init', kind, code, requestId });
  }, [kind, code, nextRequestId, postToFrame]);

  const runPython = React.useCallback((): void => {
    const requestId = nextRequestId();
    requestIdRef.current = requestId;
    dispatch({ type: 'python-start', code });
    postToFrame({ type: 'init', kind, code, requestId });
    postToFrame({ type: 'run', requestId });
  }, [kind, code, nextRequestId, postToFrame]);

  const stop = React.useCallback((): void => {
    readyRef.current = false;
    requestIdRef.current = null;
    dispatch({ type: 'stop' });
  }, []);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame: MessageEventSource | null = iframeRef.current?.contentWindow ?? null;
      if (event.source !== frame) return;
      const parsed = parseFrameToParentMessage(event.data);
      if (!parsed.success) return;
      const message = parsed.data;

      if (message.type === 'ready') {
        readyRef.current = true;
        if (isPython) {
          dispatch({ type: 'idle' });
        } else {
          startAutoRun();
        }
        return;
      }

      // Drop stale messages (teardown races, killed runs) so a dead frame can
      // never mutate the live UI.
      if (message.requestId !== requestIdRef.current) return;
      dispatch({ type: 'frame', message, isPython });
    };

    globalThis.addEventListener('message', onMessage);
    return () => {
      globalThis.removeEventListener('message', onMessage);
    };
  }, [isPython, startAutoRun]);

  // Re-drive the live frame once the code has held still. The frame itself is
  // never remounted for a new attempt: a fresh one would be blank, discarding
  // the render already on screen.
  React.useEffect(() => {
    if (isPython || !readyRef.current || code === state.initializedCode) return;
    const timer = setTimeout(startAutoRun, REINIT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [code, isPython, state.initializedCode, startAutoRun]);

  const status = displayStatus(state, isStreaming, isPython, code);
  const errorText = errorCode ? DOCUMENT_ERROR_TEXT[errorCode] : null;

  const frame = (
    <iframe
      key={frameKey}
      ref={iframeRef}
      src={sandboxPageUrl(kind)}
      title={title}
      sandbox="allow-scripts"
      className={cn(
        'w-full border-0',
        isPython || status === 'streaming' ? 'h-0' : 'min-h-0 flex-1'
      )}
    />
  );

  if (isPython) {
    return (
      <PythonSandboxView
        frame={frame}
        code={code}
        state={state}
        errorText={errorText}
        onRun={runPython}
        onStop={stop}
      />
    );
  }

  return (
    <RenderSandboxView
      frame={frame}
      status={status}
      phase={state.phase}
      errorText={errorText}
      pendingView={pendingView}
    />
  );
}
