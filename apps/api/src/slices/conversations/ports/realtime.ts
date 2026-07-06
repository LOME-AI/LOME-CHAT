import type { ERROR_CODES } from '@hushbox/shared';
import type { BroadcastReceipt, RealtimeEvent, RunStartBody } from '@hushbox/realtime';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The RealtimeBroadcast port (ARCHITECTURE.md infra edge): the worker's
 * typed surface onto a conversation's ConversationRoom Durable Object.
 * One DO per conversation, addressed by `idFromName(conversationId)`.
 *
 * A 409-class rejection rides the SUCCESS channel as a typed outcome — an
 * expected domain answer the route maps to its wire code (CONCURRENT_RUN for
 * the one-run block, IDEMPOTENCY_BODY_MISMATCH for a reused key with a
 * different body), not an infrastructure failure. The DomainError channel
 * carries transport/contract failures only.
 */

export interface RunStartReceipt {
  readonly runId: string;
  /** Epoch ms; the room's single alarm fires run control at this instant. */
  readonly deadlineAt: number;
}

/**
 * The room referee's four verdicts for a run start, all on the SUCCESS
 * channel (expected domain answers, not transport failures):
 * - `started: true`  — a fresh run began; the route hands back the run handle.
 * - `started: false` — a 409-class refusal (concurrent-run block or the
 *   reused-key-different-body conflict), mapped to a wire code.
 * - `outcome: 'replay'` — the run already settled under this key; the stored
 *   turn response replays verbatim (a duplicate POST is never a transport
 *   error). `response` is the referee's stored payload.
 * - `outcome: 'attach'` — a run is still live for this key; the client rejoins
 *   its stream over the conversation WebSocket rather than starting a second.
 */
export type RunStartOutcome =
  | ({ readonly started: true } & RunStartReceipt)
  | {
      readonly started: false;
      readonly code:
        | typeof ERROR_CODES.CONCURRENT_RUN
        | typeof ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH;
    }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | { readonly outcome: 'attach' };

/**
 * The upgrade principal the worker authenticated before proxying the socket to
 * the DO. `principalId` is a userId (or, for link guests, a linkId); the DO
 * binds it into the hibernation-surviving socket attachment.
 */
export interface UpgradePrincipal {
  readonly principalId: string;
  readonly isGuest: boolean;
  readonly displayName?: string;
}

export interface RealtimeBroadcast {
  /** Fan an event out to the conversation's sockets (broadcast-time revalidation applies). */
  broadcast(
    conversationId: string,
    event: RealtimeEvent
  ): ResultAsync<BroadcastReceipt, DomainError>;

  /** Close every socket held by the principal; resolves the count closed. */
  evict(conversationId: string, principalId: string): ResultAsync<number, DomainError>;

  /** Deduplicated authenticated userIds with an open socket (push suppression). */
  presence(conversationId: string): ResultAsync<readonly string[], DomainError>;

  /** Hand a run off to the room (the DO owns claim, deadline, and streaming). */
  startRun(
    conversationId: string,
    request: RunStartBody
  ): ResultAsync<RunStartOutcome, DomainError>;

  /** Plain-HTTP user stop — never WS-dependent. Resolves false when no run is active. */
  stopRun(conversationId: string): ResultAsync<boolean, DomainError>;

  /**
   * Proxy an authenticated WebSocket upgrade to the conversation's DO. The
   * worker route authorizes membership first; this only forwards the principal
   * (as DO query params) and the client's upgrade headers, returning the DO's
   * `101` response untouched so the socket reaches the client. The DomainError
   * channel carries transport failures only.
   */
  upgrade(
    conversationId: string,
    principal: UpgradePrincipal,
    headers: Headers
  ): ResultAsync<Response, DomainError>;
}
