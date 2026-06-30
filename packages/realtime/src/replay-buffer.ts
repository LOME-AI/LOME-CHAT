import { serializeFrame } from './protocol.js';
import type { FlowStreamEvent } from '@hushbox/shared';

/**
 * Memory-only, current-run-only replay buffer (the resumable-stream
 * mechanism). Cursor contract:
 *
 * - Cursors are per-stream, strictly increasing integers starting at 1; the
 *   executor allocates them, the buffer enforces them (violation = defect).
 * - A live stream retains its complete event history, so any
 *   `0 ≤ lastEventId ≤ lastCursor` resumes without a gap.
 * - Overflowing `maxStreamBytes` drops that stream's replay permanently for
 *   the run: resume answers `gone` — the explicit signal, never a silent
 *   gap — and the client falls back to fetch-after-settlement. Live
 *   delivery is unaffected (buffering serves replay only).
 * - `lastEventId > lastCursor` claims events the room never produced:
 *   also `gone` (the client's state is unrecoverable from here).
 * - The buffer lives for exactly one run: the room constructs a fresh
 *   instance at run start and drops its reference at run end — post-run
 *   replay is the normal message fetch.
 */

export interface ReplayBufferOptions {
  /** Per-stream byte budget, metered on the serialized stream frame. */
  readonly maxStreamBytes: number;
}

export type AppendOutcome = 'buffered' | 'dropped';

export type ResumeResult =
  | { readonly kind: 'replay'; readonly events: readonly FlowStreamEvent[] }
  | { readonly kind: 'gone' };

interface StreamState {
  events: FlowStreamEvent[];
  bytes: number;
  lastCursor: number;
  gone: boolean;
}

const utf8 = new TextEncoder();

export class ReplayBuffer {
  private readonly streams = new Map<string, StreamState>();
  private readonly maxStreamBytes: number;

  constructor(options: ReplayBufferOptions) {
    this.maxStreamBytes = options.maxStreamBytes;
  }

  append(event: FlowStreamEvent): AppendOutcome {
    const state = this.streams.get(event.streamId) ?? {
      events: [],
      bytes: 0,
      lastCursor: 0,
      gone: false,
    };
    if (event.cursor <= state.lastCursor) {
      throw new Error(
        `replay-buffer: stream cursor must increase strictly (got ${String(event.cursor)} after ${String(state.lastCursor)})`
      );
    }
    state.lastCursor = event.cursor;
    this.streams.set(event.streamId, state);
    if (state.gone) {
      return 'dropped';
    }
    state.bytes += utf8.encode(
      serializeFrame({
        type: 'stream',
        streamId: event.streamId,
        cursor: event.cursor,
        event: event.event,
      })
    ).length;
    if (state.bytes > this.maxStreamBytes) {
      state.events = [];
      state.gone = true;
      return 'dropped';
    }
    state.events.push(event);
    return 'buffered';
  }

  resume(streamId: string, lastEventId: number): ResumeResult {
    const state = this.streams.get(streamId);
    if (!state || state.gone || lastEventId > state.lastCursor) {
      return { kind: 'gone' };
    }
    return { kind: 'replay', events: state.events.filter((event) => event.cursor > lastEventId) };
  }
}
