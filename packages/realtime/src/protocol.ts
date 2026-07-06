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

/**
 * Worker→DO run-start handoff, discriminated by policy `mode`. Hooks are bound
 * DO-side (functions cannot cross the fetch boundary). The run identity the
 * policy hooks close over rides the body: a paid run carries the paying wallet
 * and send-time epoch; a trial run carries only its session id (no wallet, no
 * epoch, no conversation). `conversationId` is never a body field — the DO
 * fills it from its own id rather than trust a worker-adjacent value that must
 * equal the room it addresses.
 */
const runStartCommonShape = {
  runKey: z.string().min(1),
  /** Canonical-JSON hash of the client's run request; feeds the referee's body-hash 409. */
  bodyHash: z.string().min(1),
  definition: WorkflowDefinition,
  inputs: z.record(z.string(), ContentValue),
};

export const runStartBodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('paid'),
    ...runStartCommonShape,
    userId: z.string().min(1),
    senderId: z.string().min(1),
    walletId: z.string().min(1),
    epochNumber: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal('trial'),
    ...runStartCommonShape,
    sessionId: z.string().min(1),
  }),
]);

export type RunStartBody = z.infer<typeof runStartBodySchema>;

export const evictBodySchema = z.object({ principalId: z.string().min(1) });

export type EvictBody = z.infer<typeof evictBodySchema>;

/**
 * A trial session's room is a Durable Object keyed by a sentinel-prefixed
 * session id — no conversation row backs it. The prefix is what lets the
 * broadcast-time membership verifier recognize a trial self-room without a DB
 * lookup: a conversation id is a bare uuid and never carries it.
 */
export const TRIAL_ROOM_PREFIX = 'trial:';

/** The DO id (room name) for a trial session. */
export function trialRoomName(sessionId: string): string {
  return `${TRIAL_ROOM_PREFIX}${sessionId}`;
}

/**
 * Whether a (conversationId, principalId) pair is a trial session streaming its
 * OWN trial room. A trial principal's id and its room's DO id are the same
 * sentinel-prefixed string, so the prefix plus equality admits exactly the
 * self-room case and nothing else: a trial principal addressing another room
 * fails the equality, and no conversation member ever matches the prefix — both
 * fall through to the authoritative membership check.
 */
export function isTrialRoomSelf(conversationId: string, principalId: string): boolean {
  return principalId.startsWith(TRIAL_ROOM_PREFIX) && conversationId === principalId;
}

/** The deadline alarm is the only other stopper; over HTTP only user-stop exists. */
export const runStopBodySchema = z.object({ reason: z.literal('user-stop') });

export type RunStopBody = z.infer<typeof runStopBodySchema>;

/**
 * Per-socket state surviving hibernation via serializeAttachment. The
 * principal is authenticated by the worker before the upgrade reaches the
 * DO; `principalId` is a userId, a linkId (link guests), or a trial room name
 * (trial sessions — see `trialRoomName`).
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
