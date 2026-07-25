import { z } from 'zod';

/**
 * The wire protocol between the app (parent window) and the sandbox-origin
 * iframe that renders and runs untrusted document code. Defined once here and
 * imported by both sides: the app never re-types these shapes, and the renderer
 * pages validate every inbound message against the same schemas. Message
 * identity is carried by a `type` discriminant so a single `message` listener
 * can route without inspecting other fields.
 *
 * The parent origin is never trusted: the renderer validates message *shape*
 * with these schemas and does not authenticate the sender by origin string
 * (the embedding shell may be `capacitor://localhost` on mobile). Shape
 * validation is the contract; origin is not part of it.
 */

/**
 * The document kinds that execute inside the sandbox. Mermaid renders in the app
 * itself and is deliberately absent — it never crosses this bridge.
 */
export const RUNNABLE_DOCUMENT_KINDS = ['html', 'js', 'react', 'python'] as const;

/** Zod schema for a runnable document kind. */
export const RunnableDocumentKind = z.enum(RUNNABLE_DOCUMENT_KINDS);

/** A document kind that executes inside the sandbox iframe. */
export type RunnableDocumentKind = z.infer<typeof RunnableDocumentKind>;

/**
 * Closed set of error codes the frame reports. A closed enum lets the app switch
 * exhaustively on the failure and pick user-facing copy without parsing free
 * text. `message` carries the human-readable detail (the author's own syntax
 * error or traceback), never a code the app must interpret.
 */
export const DOCUMENT_ERROR_CODES = [
  // JSX/TS transpile rejected the source (syntax error) before any module load.
  'transpile_failed',
  // A dynamic module import (the document module or its bare dependencies) threw.
  'import_failed',
  // A react document loaded but exposed no usable default-export component.
  'mount_failed',
  // Uncaught error while executing an html/js document after it loaded.
  'runtime_error',
  // The frame was asked to handle a kind it does not implement.
  'unsupported_kind',
  // Python execution raised — `message` carries the traceback text.
  'python_error',
  // Python called `input()`; interactive stdin has no transport in the sandbox.
  'input_unsupported',
  // The frame reported no outcome within its budget: a render that never
  // finished, or a Python runtime that never finished loading. Distinct from a
  // thrown error — nothing failed, the work simply never arrived — and the app
  // needs it because it reads silence as "still working".
  'timed_out',
] as const;

/** Zod schema for a document error code. */
export const DocumentErrorCode = z.enum(DOCUMENT_ERROR_CODES);

/** A closed error code the frame reports to the app. */
export type DocumentErrorCode = z.infer<typeof DocumentErrorCode>;

/**
 * Closed set of lifecycle phases surfaced as announced loading text. The web
 * renderer emits `transpiling`/`loading-modules`; the Python runtime emits
 * `loading-runtime`/`loading-packages`/`executing`. New phases are a deliberate
 * addition to this single set (the app renders them), never an ad-hoc string.
 */
export const LOADING_PHASES = [
  'transpiling',
  'loading-modules',
  'loading-runtime',
  'loading-packages',
  'executing',
] as const;

/** Zod schema for a loading phase. */
export const LoadingPhase = z.enum(LOADING_PHASES);

/** An announced lifecycle phase during a render or run. */
export type LoadingPhase = z.infer<typeof LoadingPhase>;

/** The two output streams a running document can write to. */
export const CONSOLE_STREAMS = ['stdout', 'stderr'] as const;

/** Zod schema for a console stream. */
export const ConsoleStream = z.enum(CONSOLE_STREAMS);

/** A console output stream. */
export type ConsoleStream = z.infer<typeof ConsoleStream>;

/**
 * A single item in a run's result. `image/png` data is base64 (a matplotlib
 * figure); `text` data is plain text. The union stays closed so the app renders
 * each type deliberately.
 */
export const ResultOutput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image/png'), data: z.string() }),
  z.object({ type: z.literal('text'), data: z.string() }),
]);

/** A single result output (a PNG figure or a text block). */
export type ResultOutput = z.infer<typeof ResultOutput>;

// ── parent → frame ──────────────────────────────────────────────────────────

/** Load a document into the frame: render html/js/react, or arm python for Run. */
export const InitMessage = z.object({
  type: z.literal('init'),
  kind: RunnableDocumentKind,
  code: z.string(),
  requestId: z.string().min(1),
});

/** A parent→frame `init` message. */
export type InitMessage = z.infer<typeof InitMessage>;

/** Explicit request to execute a previously-`init`'d python document. */
export const RunMessage = z.object({
  type: z.literal('run'),
  requestId: z.string().min(1),
});

/** A parent→frame `run` message. */
export type RunMessage = z.infer<typeof RunMessage>;

/**
 * Request to stop the current run. For python the app enforces this by tearing
 * down the frame element (it owns it); the message is the cooperative signal.
 */
export const StopMessage = z.object({
  type: z.literal('stop'),
  requestId: z.string().min(1),
});

/** A parent→frame `stop` message. */
export type StopMessage = z.infer<typeof StopMessage>;

/** Every message the app sends into the frame. */
export const ParentToFrameMessage = z.discriminatedUnion('type', [
  InitMessage,
  RunMessage,
  StopMessage,
]);

/** A message the app sends into the frame. */
export type ParentToFrameMessage = z.infer<typeof ParentToFrameMessage>;

// ── frame → parent ──────────────────────────────────────────────────────────

/** The frame is loaded and listening; sent once, before any request. */
export const ReadyMessage = z.object({ type: z.literal('ready') });

/** A frame→parent `ready` message. */
export type ReadyMessage = z.infer<typeof ReadyMessage>;

/**
 * A render/run completed successfully for the given request.
 *
 * For a react document this is not always the last word: React reports a failure
 * from any phase — render, commit, or an effect — to the root it belongs to, and
 * a round can begin after the frame has already judged the render finished (a
 * lazily imported child arriving, or a state update deferred by a timer). React
 * unmounts the tree when that happens, so an `error` may follow `rendered` for
 * the same request. It means exactly one thing: the document that was on screen
 * is gone, and the frame is now empty. Every other kind and every other failure
 * path still sends exactly one terminal message per request.
 */
export const RenderedMessage = z.object({
  type: z.literal('rendered'),
  requestId: z.string().min(1),
});

/** A frame→parent `rendered` message. */
export type RenderedMessage = z.infer<typeof RenderedMessage>;

/** A line of console output produced while running. */
export const ConsoleMessage = z.object({
  type: z.literal('console'),
  requestId: z.string().min(1),
  stream: ConsoleStream,
  text: z.string(),
});

/** A frame→parent `console` message. */
export type ConsoleMessage = z.infer<typeof ConsoleMessage>;

/** Terminal outputs of a run (e.g. rendered figures). */
export const ResultMessage = z.object({
  type: z.literal('result'),
  requestId: z.string().min(1),
  outputs: z.array(ResultOutput),
});

/** A frame→parent `result` message. */
export type ResultMessage = z.infer<typeof ResultMessage>;

/**
 * A render or run failed; `code` is machine-readable, `message` is detail.
 *
 * The schema needs nothing for the post-`rendered` case described on
 * `RenderedMessage` — the message shape is identical and the `requestId` already
 * ties it to the render it invalidates. What changes is only the app's reading
 * of it: an `error` naming a request that already reported `rendered` retires
 * that render rather than arriving in its place.
 */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  requestId: z.string().min(1),
  code: DocumentErrorCode,
  message: z.string(),
});

/** A frame→parent `error` message. */
export type ErrorMessage = z.infer<typeof ErrorMessage>;

/** Progress signal so the app can announce what the frame is doing. */
export const LoadingMessage = z.object({
  type: z.literal('loading'),
  requestId: z.string().min(1),
  phase: LoadingPhase,
});

/** A frame→parent `loading` message. */
export type LoadingMessage = z.infer<typeof LoadingMessage>;

/** Every message the frame sends back to the app. */
export const FrameToParentMessage = z.discriminatedUnion('type', [
  ReadyMessage,
  RenderedMessage,
  ConsoleMessage,
  ResultMessage,
  ErrorMessage,
  LoadingMessage,
]);

/** A message the frame sends back to the app. */
export type FrameToParentMessage = z.infer<typeof FrameToParentMessage>;

/**
 * Validate an inbound parent→frame message. Returns a Zod safe-parse result and
 * never throws — the renderer must ignore anything it does not recognise rather
 * than fault on a stray `postMessage` from an unrelated source.
 */
export function parseParentToFrameMessage(
  data: unknown
): z.ZodSafeParseResult<ParentToFrameMessage> {
  return ParentToFrameMessage.safeParse(data);
}

/**
 * Validate an inbound frame→parent message. Returns a Zod safe-parse result and
 * never throws — the app treats an unrecognised message as noise.
 */
export function parseFrameToParentMessage(
  data: unknown
): z.ZodSafeParseResult<FrameToParentMessage> {
  return FrameToParentMessage.safeParse(data);
}
