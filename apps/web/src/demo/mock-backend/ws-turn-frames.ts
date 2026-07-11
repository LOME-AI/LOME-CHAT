/**
 * Builds the run-protocol frames the real chat transport consumes, so a
 * director-driven demo "send" streams a canned reply through the genuine
 * token-by-token render path: run-started → stream-start (the model label)
 * → text deltas (or media start/done) → finish → run-finished. The client
 * mints its own tile ids and reconciles on the post-run refetch, exactly as
 * against the real backend.
 */
import type { ServerFrame } from '@hushbox/realtime/protocol';

/** Media-generation attributes for a turn whose reply is an image/video. */
export interface TurnMedia {
  readonly mediaType: 'image' | 'video';
  readonly mimeType: string;
}

export interface TurnFrameParams {
  readonly runId: string;
  readonly modelId: string;
  readonly content: string;
  /** Characters per text-delta frame. */
  readonly chunkSize?: number;
  /** Present for image/video turns; drives the synthetic generation frames. */
  readonly media?: TurnMedia;
}

const STREAM_ID = 'answer0#0';

export function buildTurnFrames(params: TurnFrameParams): ServerFrame[] {
  const { runId, modelId, content, chunkSize = 18, media } = params;
  let cursor = 0;
  const stream = (event: Extract<ServerFrame, { type: 'stream' }>['event']): ServerFrame => {
    cursor += 1;
    return { type: 'stream', streamId: STREAM_ID, cursor, event };
  };

  const frames: ServerFrame[] = [
    { type: 'run-started', runId },
    stream({ kind: 'stream-start', modelId }),
  ];
  if (media === undefined) {
    for (let index = 0; index < content.length; index += chunkSize) {
      frames.push(
        stream({ kind: 'text-delta', index: 0, content: content.slice(index, index + chunkSize) })
      );
    }
  } else {
    frames.push(
      stream({
        kind: 'media-start',
        index: 0,
        modality: media.mediaType,
        mimeType: media.mimeType,
      }),
      stream({
        kind: 'media-done',
        index: 0,
        value: {
          ref: `demo/${runId}`,
          mimeType: media.mimeType,
          modality: media.mediaType,
          byteLength: 0,
          metadata: {},
        },
      })
    );
  }
  frames.push(
    stream({
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'stop',
      },
    }),
    { type: 'run-finished', runId, outcome: { outcome: 'succeeded' } }
  );
  return frames;
}
