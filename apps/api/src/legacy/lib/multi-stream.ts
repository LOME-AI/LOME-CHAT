import { classifyStreamErrorCode } from './classify-stream-error.js';
import type { InferenceEvent, InferenceStream } from '../services/ai/index.js';
import type { SSEEventWriter } from './stream-handler.js';

export interface ModelStreamEntry {
  modelId: string;
  assistantMessageId: string;
  stream: InferenceStream;
}

export interface MultiStreamResult {
  fullContent: string;
  /** Generation ID from the gateway's finish event — used post-hoc to fetch exact cost. */
  generationId: string | undefined;
  error: Error | null;
}

export interface MediaModelStreamEntry {
  modelId: string;
  assistantMessageId: string;
  stream: InferenceStream;
}

export interface MediaStreamResult {
  mediaBytes: Uint8Array | undefined;
  mimeType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  generationId: string | undefined;
  error: Error | null;
}

/** Default broadcast batching interval. Mirrors stream-pipeline's BATCH_INTERVAL_MS. */
const DEFAULT_BATCH_INTERVAL_MS = 100;

/**
 * Input to {@link collectSingleSlot}. A "slot" is a single (model, message)
 * pair whose stream is consumed independently — the same shape used by both
 * the multi-model fan-out and the single-model regenerate route.
 */
export interface CollectSingleSlotInput {
  modelId: string;
  assistantMessageId: string;
  stream: InferenceStream;
  writer: SSEEventWriter;
  /**
   * Optional broadcast hook. Invoked with batched token content (per-batch,
   * not per-token) when the batch interval elapses, plus a final flush at end.
   * Used by the regenerate route to broadcast tokens to other conversation
   * members; the multi-model fan-out doesn't broadcast.
   */
  onTokenBatch?: (modelId: string, content: string) => void;
  /** Default: {@link DEFAULT_BATCH_INTERVAL_MS}. */
  batchIntervalMs?: number;
  /**
   * Default: true. When true, writes `model:error` (with classified code) on
   * stream failure. When false (regenerate path), the route writes its own
   * top-level `error` event and the helper stays silent on error.
   */
  emitErrorEvent?: boolean;
}

/** Per-slot result. Same shape used by both fan-out and regenerate. */
export interface SlotResult {
  modelId: string;
  content: string;
  generationId: string | undefined;
  error: Error | null;
}

interface BroadcastBatchState {
  buffer: string;
  lastTime: number;
}

interface BatchAppendOptions {
  modelId: string;
  content: string;
  intervalMs: number;
  onTokenBatch: (modelId: string, content: string) => void;
}

function appendToBatch(
  state: BroadcastBatchState,
  options: BatchAppendOptions
): BroadcastBatchState {
  const newBuffer = state.buffer + options.content;
  if (Date.now() - state.lastTime >= options.intervalMs) {
    options.onTokenBatch(options.modelId, newBuffer);
    return { buffer: '', lastTime: Date.now() };
  }
  return { buffer: newBuffer, lastTime: state.lastTime };
}

interface SlotFoldState {
  content: string;
  generationId: string | undefined;
  broadcast: BroadcastBatchState;
}

interface SlotEventContext {
  modelId: string;
  writer: SSEEventWriter;
  onTokenBatch: ((modelId: string, content: string) => void) | undefined;
  batchIntervalMs: number;
}

async function handleTextDelta(
  state: SlotFoldState,
  content: string,
  ctx: SlotEventContext
): Promise<SlotFoldState> {
  if (content.length === 0) return state;
  await ctx.writer.writeModelToken({ modelId: ctx.modelId, content });
  const next: SlotFoldState = { ...state, content: state.content + content };
  if (ctx.onTokenBatch) {
    next.broadcast = appendToBatch(state.broadcast, {
      modelId: ctx.modelId,
      content,
      intervalMs: ctx.batchIntervalMs,
      onTokenBatch: ctx.onTokenBatch,
    });
  }
  return next;
}

async function foldSlotEvent(
  state: SlotFoldState,
  event: InferenceEvent,
  ctx: SlotEventContext
): Promise<SlotFoldState> {
  if (event.kind === 'text-delta') return handleTextDelta(state, event.content, ctx);
  if (event.kind === 'finish' && event.providerMetadata?.generationId) {
    return { ...state, generationId: event.providerMetadata.generationId };
  }
  return state;
}

async function emitSlotTerminalEvent(
  ctx: SlotEventContext & { assistantMessageId: string; emitErrorEvent: boolean },
  error: Error | null
): Promise<void> {
  if (error === null) {
    await ctx.writer.writeModelDone({
      modelId: ctx.modelId,
      assistantMessageId: ctx.assistantMessageId,
    });
    return;
  }
  if (ctx.emitErrorEvent) {
    await ctx.writer.writeModelError({
      modelId: ctx.modelId,
      message: error.message,
      code: classifyStreamErrorCode(error),
    });
  }
}

/**
 * Consumes a single InferenceStream, producing one SSE event sequence:
 *
 *   model:token (one per non-empty text-delta) → model:done (success)
 *                                              → model:error (failure, when
 *                                                emitErrorEvent=true)
 *
 * Handles broadcast batching when an `onTokenBatch` hook is provided. The
 * leftover broadcast buffer is always flushed at end of stream regardless of
 * success/failure, so subscribers see content collected before an error.
 *
 * Catches all errors so callers (notably {@link collectMultiModelStreams})
 * can run multiple slots in parallel without one failure aborting siblings.
 */
export async function collectSingleSlot(input: CollectSingleSlotInput): Promise<SlotResult> {
  const {
    modelId,
    assistantMessageId,
    stream,
    writer,
    onTokenBatch,
    batchIntervalMs = DEFAULT_BATCH_INTERVAL_MS,
    emitErrorEvent = true,
  } = input;

  const ctx: SlotEventContext = { modelId, writer, onTokenBatch, batchIntervalMs };
  let state: SlotFoldState = {
    content: '',
    generationId: undefined,
    broadcast: { buffer: '', lastTime: Date.now() },
  };
  let error: Error | null = null;

  try {
    for await (const event of stream) {
      state = await foldSlotEvent(state, event, ctx);
    }
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error('Unknown error');
  }

  if (onTokenBatch && state.broadcast.buffer.length > 0) {
    onTokenBatch(modelId, state.broadcast.buffer);
  }

  await emitSlotTerminalEvent({ ...ctx, assistantMessageId, emitErrorEvent }, error);

  return { modelId, content: state.content, generationId: state.generationId, error };
}

/**
 * Consumes an InferenceStream for a single media model (image/video/audio),
 * invoking `handler` for each event to fold media-specific state. Writes
 * model:done on success or model:error on failure. Catches all errors so
 * parallel media model streams continue independently.
 */
async function collectSingleMediaModelEvents<TState>(
  entry: { modelId: string; assistantMessageId: string; stream: InferenceStream },
  writer: SSEEventWriter,
  handler: (event: InferenceEvent, state: TState) => Promise<TState> | TState,
  initialState: TState
): Promise<{ state: TState; error: Error | null }> {
  let state = initialState;
  let error: Error | null = null;

  try {
    for await (const event of entry.stream) {
      state = await handler(event, state);
    }

    await writer.writeModelDone({
      modelId: entry.modelId,
      assistantMessageId: entry.assistantMessageId,
    });
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error('Unknown error');
    await writer.writeModelError({
      modelId: entry.modelId,
      message: error.message,
      code: classifyStreamErrorCode(error),
    });
  }

  return { state, error };
}

async function collectSingleModel(
  entry: ModelStreamEntry,
  writer: SSEEventWriter
): Promise<MultiStreamResult> {
  const result = await collectSingleSlot({
    modelId: entry.modelId,
    assistantMessageId: entry.assistantMessageId,
    stream: entry.stream,
    writer,
  });
  return { fullContent: result.content, generationId: result.generationId, error: result.error };
}

/**
 * Collects inference events from N model streams in parallel, writing
 * model-tagged SSE events as tokens arrive.
 *
 * Each model stream runs independently. If one fails, others continue.
 * Returns a Map of modelId → result (content, generationId, error).
 */
export async function collectMultiModelStreams(
  entries: ModelStreamEntry[],
  writer: SSEEventWriter
): Promise<Map<string, MultiStreamResult>> {
  const results = new Map<string, MultiStreamResult>();

  const promises = entries.map(async (entry) => {
    const result = await collectSingleModel(entry, writer);
    results.set(entry.modelId, result);
  });

  await Promise.all(promises);

  return results;
}

interface MediaCollectorState {
  mediaBytes: Uint8Array | undefined;
  mimeType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  generationId: string | undefined;
}

async function collectSingleMediaModel(
  entry: MediaModelStreamEntry,
  writer: SSEEventWriter
): Promise<MediaStreamResult> {
  const initial: MediaCollectorState = {
    mediaBytes: undefined,
    mimeType: undefined,
    width: undefined,
    height: undefined,
    durationMs: undefined,
    generationId: undefined,
  };

  const { state, error } = await collectSingleMediaModelEvents(
    entry,
    writer,
    async (event, s) => {
      switch (event.kind) {
        case 'media-start': {
          await writer.writeModelMediaStart({
            modelId: entry.modelId,
            assistantMessageId: entry.assistantMessageId,
            mediaType: event.mediaType,
            mimeType: event.mimeType,
          });
          return s;
        }
        case 'media-done': {
          return {
            ...s,
            mediaBytes: event.bytes,
            mimeType: event.mimeType,
            width: event.width,
            height: event.height,
            durationMs: event.durationMs,
          };
        }
        case 'finish': {
          return { ...s, generationId: event.providerMetadata?.generationId };
        }
        default: {
          return s;
        }
      }
    },
    initial
  );

  return { ...state, error };
}

/**
 * Collects media inference events from N model streams in parallel.
 * Each model stream is expected to yield media-start → media-done → finish.
 * Returns a Map of modelId → MediaStreamResult.
 */
export async function collectMultiMediaModelStreams(
  entries: MediaModelStreamEntry[],
  writer: SSEEventWriter
): Promise<Map<string, MediaStreamResult>> {
  const results = new Map<string, MediaStreamResult>();

  const promises = entries.map(async (entry) => {
    const result = await collectSingleMediaModel(entry, writer);
    results.set(entry.modelId, result);
  });

  await Promise.all(promises);

  return results;
}
