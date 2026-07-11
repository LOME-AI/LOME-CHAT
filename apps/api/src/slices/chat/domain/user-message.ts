import { asEpochPublicKey } from '@hushbox/crypto';
import { createEvent } from '@hushbox/realtime/events';
import {
  createConversationsStores,
  reserveSequenceBlockWithinTx,
} from '../../conversations/index.js';
import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import { persistEncryptedMessage } from './message-write.js';
import type { Database } from '@hushbox/db';
import type { RealtimeBroadcast } from '../../conversations/index.js';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ChatStores } from '../ports/stores.js';
import type { EpochPublicKeyReader } from './settlement.js';

/**
 * The runless user-only send (Pattern A — one DB transaction, no run, no
 * charge): reserve ONE sequence through the same monotonic counter the run
 * settlement uses (disjoint blocks under concurrency, so a send during a live
 * run never collides) — the reservation's row lock also serializes this write
 * against key rotation, so the CURRENT-epoch wrap key read AFTER it can never
 * be superseded at persist — then resolve the linear parent tip and insert
 * the message + text content item through the shared `persistEncryptedMessage`
 * primitive. Free — the legacy group-chat "AI toggle off" send.
 *
 * Idempotency is the client-supplied `messageId` (the messages PK): a resent
 * id converges on the one existing row — the whole transaction rolls back
 * (returning its reserved sequence) and the caller answers 409 so the client
 * refreshes. The `(conversationId, sequenceNumber)` unique index is the same
 * outcome's backstop.
 */

type ConversationsStoresHandle = ReturnType<typeof createConversationsStores>;

export interface SaveUserOnlyMessageDeps {
  readonly db: Database;
  /** chat's single-writer content persister (`messages` + `content_items`). */
  readonly stores: ChatStores;
  /** The `epochs` wrap-key read the conversations slice publishes (single writer). */
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly newId: () => string;
  /**
   * Builds the conversations read/counter stores bound to this transaction.
   * Defaults to the real single-writer factory; injectable so fault tests can
   * drive the read/reservation failure arms.
   */
  readonly conversationsStores?: (tx: DbTransaction) => ConversationsStoresHandle;
}

export interface SaveUserOnlyMessageArgs {
  readonly conversationId: string;
  /** The authenticated sender's userId — persisted as `messages.senderId`. */
  readonly senderId: string;
  readonly messageId: string;
  readonly content: string;
}

export type UserOnlyMessageOutcome =
  | {
      readonly saved: true;
      readonly messageId: string;
      readonly sequenceNumber: number;
      readonly epochNumber: number;
    }
  | { readonly saved: false; readonly reason: 'duplicate' };

/** Carrier for expected domain refusals thrown out of the transaction closure. */
class UserMessageWriteError extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat user message: write refused');
    this.name = 'UserMessageWriteError';
  }
}

/** Postgres unique-violation (SQLSTATE 23505), chain-walked. Any unique hit on
 * this write path — the messages PK or the (conversation, sequence) backstop —
 * means the send already exists in some form: converge, never re-insert. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}

export function saveUserOnlyMessage(
  deps: SaveUserOnlyMessageDeps,
  args: SaveUserOnlyMessageArgs
): ResultAsync<UserOnlyMessageOutcome, DomainError> {
  return fromPromise(writeUserOnlyMessage(deps, args), (cause) =>
    cause instanceof UserMessageWriteError
      ? cause.domainError
      : unavailableError('chat user message: write failed', cause)
  );
}

async function writeUserOnlyMessage(
  deps: SaveUserOnlyMessageDeps,
  args: SaveUserOnlyMessageArgs
): Promise<UserOnlyMessageOutcome> {
  try {
    return await deps.db.transaction(async (tx) => {
      const conversationsStores = deps.conversationsStores
        ? deps.conversationsStores(tx)
        : createConversationsStores(tx);
      // Row lock FIRST (legacy ordering): the sequence reservation's UPDATE
      // takes the conversations row's exclusive lock, serializing this write
      // against a concurrent rotation's `currentEpoch` UPDATE. A rotation
      // either committed before the lock (the epoch read below sees it) or
      // blocks until this transaction commits — so the message can never wrap
      // to a superseded epoch (epoch-at-persist; settlement enforces the same
      // invariant via the published `assertWrapEpoch*WithinTx` FOR SHARE gate,
      // which cannot be used here BEFORE the reserve: two sends both holding
      // FOR SHARE and both upgrading to the reservation UPDATE would deadlock).
      const sequences = await reserveSequenceBlockWithinTx(conversationsStores, {
        conversationId: args.conversationId,
        count: 1,
      }).match(
        (block) => block,
        (error) => {
          throw new UserMessageWriteError(error);
        }
      );
      const sequenceNumber = sequences[0];
      /* v8 ignore next 3 -- a count-1 reservation always yields one sequence; guards a would-be reservation invariant break */
      if (sequenceNumber === undefined) {
        throw new Error('chat user message: sequence block yielded no sequence');
      }
      const conversation = await conversationsStores.conversations.get(args.conversationId).match(
        (row) => row,
        (error) => {
          throw new UserMessageWriteError(error);
        }
      );
      if (conversation === null) {
        throw new UserMessageWriteError(notFoundError('chat user message: conversation not found'));
      }
      const epochNumber = conversation.currentEpoch;
      const rawKey = await deps.readEpochPublicKey(tx, args.conversationId, epochNumber);
      if (rawKey === null) {
        // A conversation's currentEpoch always has an epochs row (rotation
        // inserts before advancing) — a missing key is a defect, not a state.
        throw new Error(
          `chat user message: conversation ${args.conversationId} has no epoch ${String(epochNumber)} to wrap to`
        );
      }
      const parentMessageId = await deps.stores.latestMessageIdWithinTx(tx, args.conversationId);
      await persistEncryptedMessage(
        tx,
        {
          stores: deps.stores,
          conversationId: args.conversationId,
          epochNumber,
          newId: deps.newId,
        },
        {
          messageId: args.messageId,
          epochPublicKey: asEpochPublicKey(rawKey),
          senderType: 'user',
          senderId: args.senderId,
          sequenceNumber,
          parentMessageId,
          batchId: deps.newId(),
          items: [{ text: args.content, modelId: null, providerName: null, cost: null }],
        }
      );
      return { saved: true, messageId: args.messageId, sequenceNumber, epochNumber };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { saved: false, reason: 'duplicate' };
    throw error;
  }
}

/**
 * Post-commit `message:new` broadcast for the runless user-only send.
 * Best-effort: the route logs a failure and never unwinds — the message
 * already committed and a client resync recovers.
 *
 * DOCTRINE: runs deliberately deliver via run frames (stream/settled events),
 * never `message:new` — this event is revived ONLY for the runless Pattern-A
 * case, whose frontend handler already exists.
 */
export function broadcastUserMessageNew(
  realtime: RealtimeBroadcast,
  params: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly sequenceNumber: number;
  }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('message:new', {
        messageId: params.messageId,
        conversationId: params.conversationId,
        senderType: 'user',
        senderId: params.senderId,
        sequenceNumber: params.sequenceNumber,
      })
    )
    .map((): void => undefined);
}
