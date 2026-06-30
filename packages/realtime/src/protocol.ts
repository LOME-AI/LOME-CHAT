import { z } from 'zod';
import { ContentValue, WorkflowDefinition } from '@hushbox/shared';
import { typingStartEventSchema, typingStopEventSchema } from './events.js';
import type { FlowRunOutcome, InferenceEvent } from '@hushbox/shared';
import type { RealtimeEvent } from './events.js';

/**
 * The ConversationRoom wire protocol. Three surfaces share these shapes:
 * client→server WebSocket messages, server→client frames, and the
 * worker→DO HTTP control bodies. The broadcast vocabulary itself stays in
 * events.ts (consumed by the web client); this module wraps it in frames.
 */

/** Upper bound on per-reconnect resume requests (client input — bounded at the boundary). */
export const MAX_RESUME_STREAMS = 32;

export const resumeRequestSchema = z.object({
  type: z.literal('resume'),
  streams: z
    .array(
      z.object({
        streamId: z.string().min(1),
        lastEventId: z.number().int().nonnegative(),
      })
    )
    .max(MAX_RESUME_STREAMS),
});

export type ResumeRequest = z.infer<typeof resumeRequestSchema>;

/**
 * Everything a client may send over the socket: typing relay and replay
 * resume. All other realtime events are server-published only.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  typingStartEventSchema,
  typingStopEventSchema,
  resumeRequestSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Worker→DO run-start handoff. Hooks are bound DO-side (functions cannot cross the fetch boundary). */
export const runStartBodySchema = z.object({
  runKey: z.string().min(1),
  definition: WorkflowDefinition,
  inputs: z.record(z.string(), ContentValue),
});

export type RunStartBody = z.infer<typeof runStartBodySchema>;

export const evictBodySchema = z.object({ principalId: z.string().min(1) });

export type EvictBody = z.infer<typeof evictBodySchema>;

/** The deadline alarm is the only other stopper; over HTTP only user-stop exists. */
export const runStopBodySchema = z.object({ reason: z.literal('user-stop') });

export type RunStopBody = z.infer<typeof runStopBodySchema>;

/**
 * Per-socket state surviving hibernation via serializeAttachment. The
 * principal is authenticated by the worker before the upgrade reaches the
 * DO; `principalId` is a userId or, for link guests, a linkId.
 */
export const socketAttachmentSchema = z.object({
  principalId: z.string().min(1),
  conversationId: z.string().min(1),
  displayName: z.string().optional(),
  isGuest: z.boolean(),
  connectedAt: z.number(),
});

export type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

/**
 * Server→client frames. `event` carries the broadcast vocabulary
 * (events.ts); `stream` carries run output with the per-stream monotonic
 * cursor that `Last-Event-ID` resume replays from; `stream-gone` is the
 * explicit no-silent-gap signal (client falls back to fetch-after-settlement).
 */
export type ServerFrame =
  | { readonly type: 'ready' }
  | { readonly type: 'event'; readonly event: RealtimeEvent }
  | {
      readonly type: 'stream';
      readonly streamId: string;
      readonly cursor: number;
      readonly event: InferenceEvent;
    }
  | { readonly type: 'stream-gone'; readonly streamId: string }
  | { readonly type: 'run-started'; readonly runId: string }
  | { readonly type: 'run-finished'; readonly runId: string; readonly outcome: FlowRunOutcome };

export function serializeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
