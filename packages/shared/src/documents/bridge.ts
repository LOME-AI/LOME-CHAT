import { z } from 'zod';

/**
 * The wire protocol between the app and the sandbox-origin iframe that renders
 * and runs untrusted document code. Defined once here and imported by both
 * sides: the app never re-types these shapes, and the renderer pages validate
 * every inbound message against the same schemas. Message identity is carried
 * by a `type` discriminant so one intake can route without inspecting other
 * fields.
 *
 * Messages ride a `MessageChannel`: the frame mints it and transfers one port
 * to its embedder on a one-shot `ready` broadcast, and all later traffic in
 * both directions goes over that port — the frame registers no `window` message
 * listener. Possession of the port is therefore the authority. A port message
 * carries no sender origin to check (`event.origin` is always empty), and an
 * origin string could not serve as the check in any case: a sandboxed frame's
 * origin is opaque and the embedding shell may be `capacitor://localhost` on
 * mobile. These schemas validate payload shape; they are not authentication.
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
 * The two colour schemes a frame can take. This is the standard CSS
 * `color-scheme` keyword, not an app token: it is what makes the browser draw
 * its own furniture — form controls, scrollbars, and a document's own
 * `Canvas`/`CanvasText` colours — to match, which no colour value can do.
 *
 * The embedder states it because the frame is cross-origin and cannot read
 * which theme the app is showing; `prefers-color-scheme` reports the OS
 * preference, which is wrong whenever the reader has overridden it in the app.
 */
export const DOCUMENT_THEMES = ['light', 'dark'] as const;

/** Zod schema for a frame colour scheme. */
export const DocumentTheme = z.enum(DOCUMENT_THEMES);

/** The colour scheme the embedder asks the frame to take. */
export type DocumentTheme = z.infer<typeof DocumentTheme>;

/**
 * A colour the embedder paints the frame with, as six hex digits.
 *
 * The frame writes these into a stylesheet, so the pattern is load-bearing
 * rather than tidiness: `;`, `{` and `}` are what a value would need to close
 * the declaration and open a rule of its own, and none of them is a hex digit —
 * so a colour can only ever be a colour. The app's theme tokens are all plain
 * six-digit hex, so the pattern is exact rather than lossy; widening it (for
 * `oklch()`, say) is a deliberate change that must still exclude those three
 * characters.
 */
export const DocumentColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A resolved colour the embedder paints the frame with. */
export type DocumentColour = z.infer<typeof DocumentColour>;

/**
 * The appearance the embedder asks the frame to take: the colour scheme plus the
 * colours themselves.
 *
 * The colours cross the wire rather than being written into the frame because
 * the frame is a separate, credential-free origin that cannot read the app's CSS
 * custom properties. A palette compiled into its bundle would be a copy of the
 * app's tokens that nothing keeps honest — the failure is a frame whose canvas
 * no longer matches the panel around it, which no test can see. Its parent can
 * read those tokens and is already sending a message, so it sends the values.
 *
 * Every field is optional because the app and the sandbox origin deploy
 * separately: an embedder that predates a field must keep working, and an
 * unstated field means "leave that part of the appearance alone".
 */
export const FrameAppearance = z.object({
  theme: DocumentTheme.optional(),
  background: DocumentColour.optional(),
  foreground: DocumentColour.optional(),
});

/** The appearance the embedder asks the frame to take. */
export type FrameAppearance = z.infer<typeof FrameAppearance>;

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

/**
 * Load a document into the frame: render html/js/react, or arm python for Run.
 *
 * It carries the appearance so a frame that has just been created is painted
 * before anything is shown in it, rather than flashing the browser's default
 * canvas first. Changing the appearance of a frame that already holds a document
 * is `theme` below — never a repeated `init`, which would restart the document.
 */
export const InitMessage = z.object({
  type: z.literal('init'),
  kind: RunnableDocumentKind,
  code: z.string(),
  requestId: z.string().min(1),
  ...FrameAppearance.shape,
});

/** A parent→frame `init` message. */
export type InitMessage = z.infer<typeof InitMessage>;

/**
 * Restyle the frame, leaving whatever it is running untouched.
 *
 * This exists as its own message because the alternative does damage: `init` is
 * how a document is loaded, so restating the appearance through it would unmount
 * the running document and re-execute it from the top — a reader toggling the
 * app's theme would lose the state of whatever was on screen. This message names
 * no request and carries no code, so there is nothing for the frame to run.
 */
export const ThemeMessage = z.object({
  type: z.literal('theme'),
  ...FrameAppearance.shape,
});

/** A parent→frame `theme` message. */
export type ThemeMessage = z.infer<typeof ThemeMessage>;

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
  ThemeMessage,
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
 * than fault on it. Whoever holds the port is already the trusted embedder, so
 * this guards against a payload the two sides disagree about, not an attacker.
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
