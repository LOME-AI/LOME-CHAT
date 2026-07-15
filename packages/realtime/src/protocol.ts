import { z } from 'zod';
import {
  ChatHistoryMessage,
  ContentValue,
  WorkflowDefinition,
  mockDirectivesSchema,
} from '@hushbox/shared';
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
  /**
   * Client-supplied prior turns (paid and trial): E2E crypto keeps the server
   * from reconstructing history, so the client resends it each send. Threaded
   * to the executor as run-scoped context, never as a graph value. Absent
   * normalizes to [] here so every consumer sees one shape.
   */
  history: z.array(ChatHistoryMessage).default([]),
  /**
   * Client-supplied plaintext custom instructions (paid and trial): stored
   * E2E-encrypted, so — like history — the client decrypts and resends them
   * each send. Threaded to the executor as run-scoped context, never into the
   * definition (which must stay free of user content, safe to log). Absent
   * leaves the base system prompt untouched.
   */
  customInstructions: z.string().max(5000).optional(),
  /**
   * Dev/E2E deterministic-inference directives, set by the chat route ONLY in
   * dev/E2E (production never populates it). Optional — a production body omits
   * it, and even if a crafted body carries it, the DO-side provider selection
   * gates on env mode, so the mock stays unreachable in production.
   */
  mockDirectives: mockDirectivesSchema.optional(),
};

/**
 * The resolved sender as a discriminated principal, mirroring
 * `SenderPrincipal` in @hushbox/shared. Both variants carry `memberId` (the
 * `conversation_members.id`); a member send is `user`, a link-guest send is
 * `linkGuest` carrying its `linkId`. Optional on the paid body: a body may
 * still carry only the flat `userId`/`senderId`, keeping the existing user
 * shape valid.
 */
const senderPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string().min(1),
    memberId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('linkGuest'),
    linkId: z.string().min(1),
    memberId: z.string().min(1),
  }),
]);

export const runStartBodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('paid'),
    ...runStartCommonShape,
    userId: z.string().min(1),
    senderId: z.string().min(1),
    // The resolved sender principal (member or link-guest), carrying the
    // conversation_members.id the flat fields cannot. Optional so the existing
    // flat-only user body stays valid.
    sender: senderPrincipalSchema.optional(),
    walletId: z.string().min(1),
    epochNumber: z.number().int().positive(),
    // The initiator's message, supplied at send: its content is persisted
    // (epoch-wrapped) with the assistant's reply; the client-supplied id makes
    // that persistence idempotent across a re-executed run.
    userMessage: z.object({
      id: z.string().min(1),
      content: z.string().min(1),
    }),
    // The branch the turn extends, when the client sends onto a fork; the DO
    // threads it into the run identity so settlement chains onto the fork's tip
    // and advances it. Absent for a linear send.
    forkId: z.string().min(1).optional(),
    // Present when the turn re-runs an existing turn (regenerate/edit): the DO
    // threads it into the run identity so settlement deletes the superseded
    // reply(s) and re-parents the new reply. Absent for a fresh send.
    regenerate: z
      .object({
        action: z.enum(['retry', 'edit']),
        targetMessageId: z.string().min(1),
        replaceAssistantId: z.string().min(1).optional(),
        // The fork tip the pre-run guard validated its deletable tail against;
        // the settlement asserts the fork-row-locked tip still equals it (the
        // fork-tip TOCTOU fence). Null for a fork with no tip yet.
        observedForkTipId: z.string().min(1).nullish(),
      })
      .optional(),
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
 *
 * `sessionId` / `sessionCreatedAt` are the authorizing session snapshot the
 * broadcast-time session-liveness check validates (session-liveness.ts): the
 * session id keys the `sessionActive` read and `sessionCreatedAt` is compared
 * against the password-changed watermark. Optional — only a real authenticated
 * user carries them; link guests and trial-session principals hold no revocable
 * session, so their sockets are session-checked by neither field's absence.
 */
export const socketAttachmentSchema = z.object({
  principalId: z.string().min(1),
  conversationId: z.string().min(1),
  displayName: z.string().optional(),
  isGuest: z.boolean(),
  connectedAt: z.number(),
  sessionId: z.string().min(1).optional(),
  sessionCreatedAt: z.number().optional(),
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
