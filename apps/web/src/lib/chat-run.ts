/**
 * The client half of the run protocol: HTTP starts/stops a run, the
 * conversation WebSocket carries the streamed output. This module owns one
 * run's lifecycle — gate the POST on an attached socket, demux `stream`
 * frames onto the pre-allocated per-model tiles via each stream's
 * `stream-start` label, arm the client-side deadline from the 201's
 * `deadlineAt`, and auto-resubmit the same Idempotency-Key once after a
 * reconnect (attach → keep streaming; replay → settled; fresh 201 → clean
 * re-execution, tiles reset). Pure with respect to React and the network:
 * the hook layer supplies `postRun` (typed client, key bound) and a socket.
 */
import type { RunFrame } from './server-frames.js';

export interface RunTransportSocket {
  connect(): void;
  waitForReady(timeoutMs: number): Promise<boolean>;
  readonly ready: boolean;
  onRunFrame(listener: (frame: RunFrame) => void): () => void;
  onStateChange(listener: () => void): () => void;
}

export type RunStartResponse =
  | { kind: 'started'; runId: string; deadlineAt: number }
  | { kind: 'attach' }
  | { kind: 'replay' };

export interface ChatRunTile {
  readonly modelId: string;
  readonly assistantMessageId: string;
}

export interface ChatRunCallbacks {
  onRunStarted?: ((runId: string) => void) | undefined;
  /** The stream's `stream-start` label — Smart Model's resolved model id included. */
  onModelResolved?: ((assistantMessageId: string, modelId: string) => void) | undefined;
  /** A resubmit began a clean re-execution: reset these tiles' content. */
  onRestart?: ((assistantMessageIds: string[]) => void) | undefined;
  onToken?: ((token: string, assistantMessageId: string) => void) | undefined;
  onReasoningToken?: ((token: string, assistantMessageId: string) => void) | undefined;
  /**
   * The finish frame's `usage.reasoningTokens` — the live billed count for
   * models that reason without emitting visible text. Fired only when the
   * provider reported one; a reasoning-free stream fires nothing.
   */
  onReasoningTokens?: ((count: number, assistantMessageId: string) => void) | undefined;
  onModelDone?: ((data: { assistantMessageId: string; modelId: string }) => void) | undefined;
  onModelError?:
    | ((data: { assistantMessageId: string; modelId: string; code: string }) => void)
    | undefined;
  onMediaStart?:
    | ((data: { assistantMessageId: string; mediaType: string; mimeType: string }) => void)
    | undefined;
  onMediaDone?: ((data: { assistantMessageId: string }) => void) | undefined;
  /**
   * Synthetic per-node generation progress (video). Percent never reaches
   * 100 on the wire — media-done / the run's terminal frames are completion.
   */
  onMediaProgress?: ((data: { assistantMessageId: string; percent: number }) => void) | undefined;
  /** Every tile reached a terminal stream event (or the run finished). */
  onAllModelsComplete?: (() => void) | undefined;
}

export interface ChatRunModelResult {
  modelId: string;
  assistantMessageId: string;
  errorCode?: string;
}

export type ChatRunResult =
  | { outcome: 'succeeded' | 'stopped'; models: ChatRunModelResult[] }
  | { outcome: 'replayed' }
  | { outcome: 'failed'; code: string; models: ChatRunModelResult[] }
  | { outcome: 'deadline'; models: ChatRunModelResult[] };

export interface ExecuteChatRunDeps {
  socket: RunTransportSocket;
  /** Bound run-start POST; MUST reuse the same Idempotency-Key across calls. */
  postRun: () => Promise<RunStartResponse>;
  /** Pre-allocated tiles in the user's selected model order. */
  tiles: readonly ChatRunTile[];
  callbacks: ChatRunCallbacks;
  /** Client-side grace past the server's deadlineAt before declaring the turn dead. */
  deadlineGraceMs?: number;
  readyTimeoutMs?: number;
}

/** Per-stream terminal error code when a branch fails (no billing implied). */
const STREAM_ERROR_CODE = 'STREAM_ERROR';
/** Failure code when the transport cannot carry the run at all. */
const TRANSPORT_FAILED_CODE = 'CHAT_STREAM_FAILED';
/** Floor for the client deadline timer — absorbs client/server clock skew. */
const MIN_DEADLINE_MS = 30_000;
/** Deadline assumed for an attach with no 201 in this tab (media ceiling). */
const ATTACH_FALLBACK_DEADLINE_MS = 15 * 60 * 1000;

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_GRACE_MS = 5000;

/**
 * A tile and its mutable run state, paired so every lookup that finds one
 * finds the other — no index juggling between parallel arrays.
 */
interface TileSlot {
  readonly tile: ChatRunTile;
  resolvedModelId: string;
  bound: boolean;
  finished: boolean;
  errorCode?: string;
}

export async function executeChatRun(deps: ExecuteChatRunDeps): Promise<ChatRunResult> {
  const { socket, postRun, tiles, callbacks } = deps;
  const graceMs = deps.deadlineGraceMs ?? DEFAULT_DEADLINE_GRACE_MS;

  socket.connect();
  const ready = await socket.waitForReady(deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  if (!ready) {
    // Never POST a run whose frames nobody can watch: an unreachable socket
    // fails the turn BEFORE anything can bill.
    return { outcome: 'failed', code: TRANSPORT_FAILED_CODE, models: [] };
  }

  // Mutable flags live in a box read through a function: they flip inside
  // closures across awaits, which control-flow narrowing cannot see (a bare
  // boolean here trips no-unnecessary-condition on genuinely necessary checks).
  const flags = { settled: false };
  const isSettled = (): boolean => flags.settled;
  let settle!: (result: ChatRunResult) => void;
  const done = new Promise<ChatRunResult>((resolve) => {
    settle = resolve;
  });

  const slots: TileSlot[] = tiles.map((tile) => ({
    tile,
    resolvedModelId: tile.modelId,
    bound: false,
    finished: false,
  }));
  const bindings = new Map<string, TileSlot>();
  let runId: string | null = null;
  let accepted = false;
  let allCompleteFired = false;
  let resubmitsLeft = 1;
  const timers: { deadline: ReturnType<typeof setTimeout> | null } = { deadline: null };
  const preAcceptBuffer: RunFrame[] = [];

  const models = (): ChatRunModelResult[] =>
    slots.map((slot) => ({
      modelId: slot.resolvedModelId,
      assistantMessageId: slot.tile.assistantMessageId,
      ...(slot.errorCode === undefined ? {} : { errorCode: slot.errorCode }),
    }));

  const finish = (result: ChatRunResult): void => {
    if (flags.settled) return;
    flags.settled = true;
    settle(result);
  };

  const fireAllCompleteOnce = (): void => {
    if (allCompleteFired) return;
    allCompleteFired = true;
    callbacks.onAllModelsComplete?.();
  };

  const armDeadline = (deadlineAt: number): void => {
    if (timers.deadline !== null) clearTimeout(timers.deadline);
    const waitMs = Math.max(deadlineAt - Date.now(), MIN_DEADLINE_MS) + graceMs;
    timers.deadline = setTimeout(() => {
      finish({ outcome: 'deadline', models: models() });
    }, waitMs);
  };

  const bindStream = (streamId: string, modelId: string): TileSlot | undefined => {
    const slot =
      slots.find((s) => !s.bound && s.tile.modelId === modelId) ?? slots.find((s) => !s.bound);
    if (!slot) return undefined;
    slot.bound = true;
    slot.resolvedModelId = modelId;
    bindings.set(streamId, slot);
    callbacks.onModelResolved?.(slot.tile.assistantMessageId, modelId);
    return slot;
  };

  const finishTile = (slot: TileSlot, errorCode?: string): void => {
    if (slot.finished) return;
    slot.finished = true;
    if (errorCode === undefined) {
      callbacks.onModelDone?.({
        assistantMessageId: slot.tile.assistantMessageId,
        modelId: slot.resolvedModelId,
      });
    } else {
      slot.errorCode = errorCode;
      callbacks.onModelError?.({
        assistantMessageId: slot.tile.assistantMessageId,
        modelId: slot.resolvedModelId,
        code: errorCode,
      });
    }
    if (slots.every((s) => s.finished)) fireAllCompleteOnce();
  };

  const dispatchDelta = (
    tile: ChatRunTile,
    event: Extract<RunFrame, { type: 'stream' }>['event']
  ): boolean => {
    if (event.kind === 'text-delta') {
      callbacks.onToken?.(event.content, tile.assistantMessageId);
      return true;
    }
    if (event.kind === 'reasoning-delta') {
      callbacks.onReasoningToken?.(event.content, tile.assistantMessageId);
      return true;
    }
    return false;
  };

  const dispatchFinish = (
    slot: TileSlot,
    metadata: Extract<
      Extract<RunFrame, { type: 'stream' }>['event'],
      { kind: 'finish' }
    >['metadata']
  ): void => {
    const reasoningTokens = metadata.usage.reasoningTokens;
    if (reasoningTokens !== undefined) {
      callbacks.onReasoningTokens?.(reasoningTokens, slot.tile.assistantMessageId);
    }
    finishTile(slot, metadata.finishReason === 'error' ? STREAM_ERROR_CODE : undefined);
  };

  const dispatchBoundEvent = (
    slot: TileSlot,
    event: Extract<RunFrame, { type: 'stream' }>['event']
  ): void => {
    if (dispatchDelta(slot.tile, event)) return;
    switch (event.kind) {
      case 'media-start': {
        callbacks.onMediaStart?.({
          assistantMessageId: slot.tile.assistantMessageId,
          mediaType: event.modality,
          mimeType: event.mimeType,
        });
        break;
      }
      case 'media-done': {
        callbacks.onMediaDone?.({ assistantMessageId: slot.tile.assistantMessageId });
        break;
      }
      case 'media-progress': {
        callbacks.onMediaProgress?.({
          assistantMessageId: slot.tile.assistantMessageId,
          percent: event.percent,
        });
        break;
      }
      case 'finish': {
        dispatchFinish(slot, event.metadata);
        break;
      }
      default: {
        // tool-call / tool-result / step-start / step-finish: surfaced only
        // through telemetry today; they must never crash rendering.
        break;
      }
    }
  };

  const handleStreamFrame = (frame: Extract<RunFrame, { type: 'stream' }>): void => {
    const event = frame.event;
    if (event.kind === 'stream-start') {
      const slot = bindStream(frame.streamId, event.modelId);
      // A media-family stream announces its output modality up front: swap
      // the tile to its generating state now, with a placeholder mime that
      // media-start's real mime later upserts over (same tile, never a
      // second one).
      if (slot !== undefined && event.outputModality !== undefined) {
        callbacks.onMediaStart?.({
          assistantMessageId: slot.tile.assistantMessageId,
          mediaType: event.outputModality,
          mimeType: `${event.outputModality}/*`,
        });
      }
      return;
    }
    const slot = bindings.get(frame.streamId);
    if (slot === undefined) return;
    dispatchBoundEvent(slot, event);
  };

  const handleRunFinished = (frame: Extract<RunFrame, { type: 'run-finished' }>): void => {
    if (runId !== null && frame.runId !== runId) return;
    if (frame.outcome.outcome === 'succeeded') {
      // A tile with no terminal stream event on a successful run is a failed
      // optional branch — keep its error tile; the successful subset persisted.
      for (const slot of slots) {
        if (!slot.finished) finishTile(slot, STREAM_ERROR_CODE);
      }
      fireAllCompleteOnce();
      finish({ outcome: 'succeeded', models: models() });
      return;
    }
    fireAllCompleteOnce();
    if (frame.outcome.outcome === 'stopped') {
      finish({ outcome: 'stopped', models: models() });
      return;
    }
    finish({ outcome: 'failed', code: frame.outcome.code, models: models() });
  };

  const processFrame = (frame: RunFrame): void => {
    switch (frame.type) {
      case 'run-started': {
        runId ??= frame.runId;
        callbacks.onRunStarted?.(frame.runId);
        break;
      }
      case 'stream': {
        handleStreamFrame(frame);
        break;
      }
      case 'stream-gone': {
        // Replay for this stream is gone (buffer overflow / run over): stop
        // trusting the live buffer and rely on the post-run message refetch.
        break;
      }
      case 'run-finished': {
        handleRunFinished(frame);
        break;
      }
    }
  };

  const offFrames = socket.onRunFrame((frame) => {
    if (!accepted) {
      preAcceptBuffer.push(frame);
      return;
    }
    processFrame(frame);
  });

  const applyStartResponse = (response: Extract<RunStartResponse, { kind: 'started' }>): void => {
    runId = response.runId;
    accepted = true;
    armDeadline(response.deadlineAt);
  };

  const resubmit = async (): Promise<void> => {
    if (flags.settled) return;
    if (resubmitsLeft <= 0) {
      finish({ outcome: 'failed', code: TRANSPORT_FAILED_CODE, models: models() });
      return;
    }
    resubmitsLeft -= 1;
    try {
      const response = await postRun();
      if (isSettled()) return;
      if (response.kind === 'replay') {
        finish({ outcome: 'replayed' });
        return;
      }
      if (response.kind === 'started') {
        // A fresh 201 on the same key means the earlier execution died before
        // settlement (billed nothing): clean re-execution, tiles start over.
        bindings.clear();
        for (const slot of slots) {
          slot.resolvedModelId = slot.tile.modelId;
          slot.bound = false;
          slot.finished = false;
          delete slot.errorCode;
        }
        allCompleteFired = false;
        callbacks.onRestart?.(tiles.map((tile) => tile.assistantMessageId));
        applyStartResponse(response);
      }
      // attach: the run is still live — frames resume via the socket replay.
    } catch (error) {
      finish({
        outcome: 'failed',
        code: extractCode(error) ?? TRANSPORT_FAILED_CODE,
        models: models(),
      });
    }
  };

  let wasReady = socket.ready;
  const offState = socket.onStateChange(() => {
    const readyNow = socket.ready;
    if (!wasReady && readyNow && accepted && !flags.settled) {
      void resubmit();
    }
    wasReady = readyNow;
  });

  try {
    const response = await postRun();
    if (response.kind === 'replay') {
      return { outcome: 'replayed' };
    }
    if (response.kind === 'started') {
      applyStartResponse(response);
    } else {
      // attach to a live run this key already started (e.g. a resubmitted
      // send after reload): frames flow, deadline unknown — use the ceiling.
      accepted = true;
      armDeadline(Date.now() + ATTACH_FALLBACK_DEADLINE_MS);
    }
    for (const frame of preAcceptBuffer.splice(0)) {
      processFrame(frame);
    }
    return await done;
  } finally {
    offFrames();
    offState();
    if (timers.deadline !== null) clearTimeout(timers.deadline);
  }
}

function extractCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}
