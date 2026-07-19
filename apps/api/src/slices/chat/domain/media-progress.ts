import type { FlowStreamEvent, WorkflowDefinition } from '@hushbox/shared';

/**
 * Synthetic per-node VIDEO generation progress, reproducing the legacy media
 * UX on the run's stream frames: a 0→95% sweep paced by the expected
 * generation duration, then a 95% heartbeat until the real completion. Image
 * generations get no sweep (start/done only), matching legacy.
 *
 * This is DO-side runtime plumbing, wrapped around `FlowStartRequest.emit`
 * OUTSIDE the engine — the interpreter's deterministic core never sees a
 * wall-clock timer. The wrapper renumbers each stream's cursors so injected
 * `media-progress` frames stay monotonic with the forwarded events (a stream
 * without injected frames forwards byte-identically: both sides count 1..N).
 * Timers are per stream; they stop on that stream's media-done/finish, and
 * `stopAll` (the run's terminal sink) clears every survivor — an aborted or
 * deadline-killed run leaks nothing and emits no extra terminal signal.
 */

/** The sweep tops out here; the client renders the real completion as 100%. */
export const MEDIA_PROGRESS_MAX_PERCENT = 95;

/** Each sweep tick advances by this much. */
export const MEDIA_PROGRESS_STEP_PERCENT = 10;

/** Once capped, re-emit the max percent at this cadence (a "still waiting" pulse). */
export const MEDIA_PROGRESS_HEARTBEAT_MS = 5000;

/**
 * Observed gateway wait ≈ requested clip seconds × this multiplier (the legacy
 * pipeline's calibration, carried over unchanged).
 */
export const VIDEO_EXPECTED_GENERATION_MULTIPLIER = 8;

/** Pacing fallback when the node declares no durationSeconds. */
export const VIDEO_DEFAULT_DURATION_SECONDS = 5;

/** A media call yields exactly one file; its progress rides the same index 0. */
const MEDIA_FILE_INDEX = 0;

export interface VideoProgressEmitter {
  /** Drop-in replacement for the wrapped `FlowStartRequest.emit`. */
  readonly emit: (event: FlowStreamEvent) => void;
  /** Clears every live timer; called from the run's terminal sink. Idempotent. */
  readonly stopAll: () => void;
}

interface StreamState {
  cursor: number;
  percent: number;
  sweep: ReturnType<typeof setInterval> | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
}

/** The expected generation wait per video modelCall node, from its declared params. */
function expectedDurationsMs(definition: WorkflowDefinition): ReadonlyMap<string, number> {
  const durations = new Map<string, number>();
  for (const node of definition.nodes) {
    if (node.type !== 'modelCall') continue;
    const declared = node.params['durationSeconds'];
    const seconds =
      typeof declared === 'number' && Number.isFinite(declared) && declared > 0
        ? declared
        : VIDEO_DEFAULT_DURATION_SECONDS;
    durations.set(node.id, seconds * VIDEO_EXPECTED_GENERATION_MULTIPLIER * 1000);
  }
  return durations;
}

/** Stream ids are `<nodeId>#<sequence>` (NodeId forbids '#', so the split is exact). */
function nodeIdOf(streamId: string): string {
  const separator = streamId.indexOf('#');
  return separator === -1 ? streamId : streamId.slice(0, separator);
}

export function createVideoProgressEmitter(
  definition: WorkflowDefinition,
  downstream: (event: FlowStreamEvent) => void
): VideoProgressEmitter {
  const durations = expectedDurationsMs(definition);
  const streams = new Map<string, StreamState>();

  const forward = (streamId: string, state: StreamState, event: FlowStreamEvent['event']): void => {
    state.cursor += 1;
    downstream({ streamId, cursor: state.cursor, event });
  };

  const stopStream = (state: StreamState): void => {
    if (state.sweep !== undefined) clearInterval(state.sweep);
    if (state.heartbeat !== undefined) clearInterval(state.heartbeat);
    state.sweep = undefined;
    state.heartbeat = undefined;
  };

  const emitPercent = (streamId: string, state: StreamState): void => {
    forward(streamId, state, {
      kind: 'media-progress',
      index: MEDIA_FILE_INDEX,
      percent: state.percent,
    });
  };

  const startSweep = (streamId: string, state: StreamState): void => {
    if (state.sweep !== undefined || state.heartbeat !== undefined) return;
    const expectedMs = durations.get(nodeIdOf(streamId));
    if (expectedMs === undefined) return;
    const stepCount = Math.floor(MEDIA_PROGRESS_MAX_PERCENT / MEDIA_PROGRESS_STEP_PERCENT);
    const sweepIntervalMs = Math.max(1, Math.floor(expectedMs / stepCount));
    state.sweep = setInterval(() => {
      state.percent += MEDIA_PROGRESS_STEP_PERCENT;
      if (state.percent >= MEDIA_PROGRESS_MAX_PERCENT) {
        state.percent = MEDIA_PROGRESS_MAX_PERCENT;
        stopStream(state);
        state.heartbeat = setInterval(() => {
          emitPercent(streamId, state);
        }, MEDIA_PROGRESS_HEARTBEAT_MS);
      }
      emitPercent(streamId, state);
    }, sweepIntervalMs);
  };

  return {
    emit: (event): void => {
      let state = streams.get(event.streamId);
      if (state === undefined) {
        state = { cursor: 0, percent: 0, sweep: undefined, heartbeat: undefined };
        streams.set(event.streamId, state);
      }
      const kind = event.event.kind;
      if (kind === 'stream-start' && event.event.outputModality === 'video') {
        startSweep(event.streamId, state);
      }
      // The real completion (or the terminal finish, for a call whose file
      // never materialized) ends the tile — the sweep must not outlive it.
      if (kind === 'media-done' || kind === 'finish') {
        stopStream(state);
      }
      forward(event.streamId, state, event.event);
    },
    stopAll: (): void => {
      for (const state of streams.values()) stopStream(state);
    },
  };
}
