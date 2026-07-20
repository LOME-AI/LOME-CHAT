/**
 * Server-side SSE stream handler utilities.
 *
 * Provides typed event writers for SSE streams used by chat endpoints.
 */

import { ERROR_CODE_STREAM_ERROR } from '@hushbox/shared';
import { extractErrorDiagnostics } from './error-diagnostics.js';
import type { StageDonePayload, StageErrorPayload, StageStartPayload } from '@hushbox/shared';

export interface SSEStream {
  writeSSE: (event: { event: string; data: string }) => Promise<void>;
  onAbort: (handler: () => void) => void;
}

export interface StartModelEntry {
  modelId: string;
  assistantMessageId: string;
}

export interface StartEventData {
  userMessageId: string;
  models: StartModelEntry[];
}

export interface ErrorEventData {
  message: string;
  code?: string;
}

export interface ModelDoneEventData {
  modelId: string;
  assistantMessageId: string;
}

export interface ModelErrorEventData {
  modelId: string;
  message: string;
  code: string;
}

export interface TokenEventData {
  modelId: string;
  content: string;
}

/**
 * `model:media:start` payload — surfaced from the AI client's media-start
 * event so the UI can swap the generic "Loading…" placeholder for a more
 * descriptive "Generating image…" indicator.
 *
 * `assistantMessageId` lets the frontend correlate the event with the
 * specific row it just rendered (one row per model in the slot). Without it,
 * the UI would have to guess which slot is starting when multiple models
 * stream concurrently.
 */
export interface ModelMediaStartEventData {
  modelId: string;
  assistantMessageId: string;
  mediaType: 'image' | 'audio' | 'video';
  mimeType: string;
}

/**
 * `model:media:progress` payload — synthetic progress for long-running media
 * generation calls (today: video). Emitted at fixed percent steps based on
 * an EXPECTED-duration estimate; the real generation time is unknown until
 * `model:done`. See {@link createSSEEventWriter.writeModelMediaProgress}.
 */
export interface ModelMediaProgressEventData {
  modelId: string;
  assistantMessageId: string;
  /** Integer in [0, 100]. Server emits up to 95% pre-completion. */
  percent: number;
}

/**
 * A single content item delivered in the SSE done event.
 * Mirrors the write-path shape of a row inserted into `content_items` under
 * the wrap-once envelope model. Text items carry `encryptedBlob` (base64);
 * media items carry only metadata (the bytes live in R2 under `storageKey`).
 */
export interface DoneContentItem {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  position: number;
  /** Base64-encoded symmetric ciphertext under the message's content key. Text items only. */
  encryptedBlob?: string | null;
  /**
   * Presigned GET URL for media items. Populated by the strategy after R2 upload.
   * Omitted (not nulled) when not applicable — keep this consistent with
   * `InsertedMediaContentItem.downloadUrl` so the persistence and wire shapes match.
   */
  downloadUrl?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  modelName: string | null;
  cost: string | null;
  isSmartModel: boolean;
}

/**
 * The wrap-once envelope for a single persisted message, delivered in the SSE
 * done event. Clients unwrap `wrappedContentKey` once with their epoch private
 * key and decrypt every content item with the resulting content key.
 */
export interface DoneMessageEnvelope {
  /** Base64-encoded ECIES-wrapped content key for the message. */
  wrappedContentKey: string;
  contentItems: DoneContentItem[];
}

export interface DoneModelEntry extends DoneMessageEnvelope {
  modelId: string;
  assistantMessageId: string;
  aiSequence: number;
  cost: string;
}

export interface DoneEventData {
  userMessageId: string;
  assistantMessageId: string;
  userSequence?: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  /** Envelope for the user message itself (sender_type='user'). */
  userEnvelope?: DoneMessageEnvelope;
  models?: DoneModelEntry[];
}

/**
 * Wrapper for the stage:done payload — the discriminated union itself
 * carries the stageId, while the wrapper carries the assistantMessageId so
 * the frontend can correlate the event to a specific row in the UI.
 */
export interface StageDoneEventData {
  assistantMessageId: string;
  payload: StageDonePayload;
}

export interface SSEEventWriter {
  writeStart: (data: StartEventData) => Promise<void>;
  writeModelToken: (data: TokenEventData) => Promise<void>;
  writeModelMediaStart: (data: ModelMediaStartEventData) => Promise<void>;
  writeModelMediaProgress: (data: ModelMediaProgressEventData) => Promise<void>;
  writeError: (data: ErrorEventData) => Promise<void>;
  writeModelDone: (data: ModelDoneEventData) => Promise<void>;
  writeModelError: (data: ModelErrorEventData) => Promise<void>;
  writeDone: (data?: DoneEventData) => Promise<void>;
  /** Pre-inference stage status — generic across all stage types. */
  writeStageStart: (data: StageStartPayload) => Promise<void>;
  /** Pre-inference stage success — payload is discriminated by stageId. */
  writeStageDone: (data: StageDoneEventData) => Promise<void>;
  /** Pre-inference stage failure — generic across all stage types. */
  writeStageError: (data: StageErrorPayload) => Promise<void>;
  isConnected: () => boolean;
  /**
   * True once `writeDone` has been invoked, regardless of whether the
   * underlying SSE write reached the client. The structural catches in
   * stream-pipeline and media-pipeline use this to suppress a misleading
   * `event: error` for exceptions that happen *after* the turn has already
   * been reported as successful (e.g., a post-`done` fire-and-forget
   * synchronously throwing). Stays false if `writeDone` no-oped because the
   * writer was already disconnected.
   */
  isDoneWritten: () => boolean;
}

/**
 * Surfaces an unexpected exception thrown inside a `streamSSE` callback as a
 * client-visible `event: error`. Without this wrapper the SSE socket closes
 * cleanly after the last successful event (typically `model:done`) and the
 * client sits at its STREAM_TIMEOUT_MS — a silent failure that hides server
 * crashes (e.g. catalog miss in `getGenerationStats`, billing persistence
 * errors).
 *
 * Always logs to `console.error` so the server-side trace survives even when
 * the writer is already disconnected. Write attempts after disconnect no-op
 * via the writer's connection guard, so this is safe to call from a `catch`.
 */
export async function writeStreamErrorFromException(
  writer: SSEEventWriter,
  err: unknown
): Promise<void> {
  // Workers' default `console.error` serializer only prints name/message/stack
  // and drops every enumerable property — including the cause chain that
  // carries the gateway's raw response body. Walk the chain ourselves and emit
  // a single JSON line so `wrangler tail` shows the full picture. The helper
  // omits user-data fields (prompts, headers, secrets) — see error-diagnostics.ts.
  const diagnostics = extractErrorDiagnostics(err);
  console.error('sse stream: uncaught exception', JSON.stringify(diagnostics));
  const message = err instanceof Error ? err.message : 'Stream processing failed';
  await writer.writeError({ message, code: ERROR_CODE_STREAM_ERROR });
}

/**
 * The structural catch used by streamSSE pipelines. Behaviour splits on
 * whether the `done` event has already been written:
 *
 *   - **Pre-`done`** — the turn never reached the success boundary. Surface the
 *     failure to the client via `writeStreamErrorFromException` so it can
 *     render an inline error instead of hanging on STREAM_TIMEOUT_MS.
 *
 *   - **Post-`done`** — the turn already reported success to the client
 *     (cost, envelopes, sequences all sent). Writing another `event: error`
 *     here would flip the client's perception from "message saved" to "chat
 *     stream failed" even though the assistant message is persisted and the
 *     billing is settled. Log server-side, but do not retract the success.
 *
 * The post-`done` branch is the one that catches synchronous throws from
 * fire-and-forget side-effects (push notifications, analytics) that run after
 * persistence.
 */
export async function handleStreamException(writer: SSEEventWriter, err: unknown): Promise<void> {
  if (writer.isDoneWritten()) {
    console.error('sse stream: uncaught exception after done event was already written', err);
    return;
  }
  await writeStreamErrorFromException(writer, err);
}

/**
 * Create a typed SSE event writer with connection tracking.
 *
 * Handles:
 * - Typed event writing (start, token, error, done)
 * - Connection state tracking via onAbort
 * - Graceful handling of write failures
 */
export function createSSEEventWriter(stream: SSEStream): SSEEventWriter {
  let connected = true;
  let doneWritten = false;

  stream.onAbort(() => {
    connected = false;
  });

  async function writeIfConnected(event: string, data: unknown): Promise<void> {
    if (!connected) {
      return;
    }

    try {
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    } catch {
      connected = false;
    }
  }

  return {
    writeStart: async (data: StartEventData) => {
      await writeIfConnected('start', data);
    },

    writeModelToken: async (data: TokenEventData) => {
      await writeIfConnected('token', data);
    },

    writeModelMediaStart: async (data: ModelMediaStartEventData) => {
      await writeIfConnected('model:media:start', data);
    },

    writeModelMediaProgress: async (data: ModelMediaProgressEventData) => {
      await writeIfConnected('model:media:progress', data);
    },

    writeError: async (data: ErrorEventData) => {
      await writeIfConnected('error', data);
    },

    writeModelDone: async (data: ModelDoneEventData) => {
      await writeIfConnected('model:done', data);
    },

    writeModelError: async (data: ModelErrorEventData) => {
      await writeIfConnected('model:error', data);
    },

    writeDone: async (data?: DoneEventData) => {
      // Set the flag whenever the writer was still connected when `done`
      // was attempted, regardless of whether the actual wire write threw
      // (which flips `connected` inside writeIfConnected). A pipeline that
      // got far enough to call writeDone is, semantically, past the
      // success boundary for the catch-suppression check.
      if (connected) {
        doneWritten = true;
      }
      await writeIfConnected('done', data ?? {});
    },

    writeStageStart: async (data: StageStartPayload) => {
      await writeIfConnected('stage:start', data);
    },

    writeStageDone: async (data: StageDoneEventData) => {
      await writeIfConnected('stage:done', data);
    },

    writeStageError: async (data: StageErrorPayload) => {
      await writeIfConnected('stage:error', data);
    },

    isConnected: () => connected,
    isDoneWritten: () => doneWritten,
  };
}
