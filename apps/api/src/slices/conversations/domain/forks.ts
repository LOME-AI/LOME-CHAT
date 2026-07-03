import { z } from 'zod';
import { MAX_FORKS_PER_CONVERSATION, canSendMessages } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { refusalSchema } from './outcomes.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores, ForkRecord, MemberRecord } from '../ports/index.js';
import type { Outcome, Refusal } from './outcomes.js';

/**
 * Fork semantics (mirrors the legacy service, minus message deletion — the
 * chat slice owns `messages`, so orphan cleanup on fork deletion is its
 * concern via the published parent-chain walk):
 *
 * - The first branch materializes the implicit linear history as a "Main"
 *   fork tipped at the latest message, alongside the requested fork.
 * - Fork ids are client-generated uuids: a re-create of the same id
 *   converges instead of duplicating.
 * - Deleting down to one remaining fork reverts the conversation to linear
 *   (all fork rows removed).
 *
 * Every mutation runs under the conversation `FOR UPDATE` lock so limit
 * checks and the two-row first-branch insert never race; refusals commit
 * (they ride the success channel), so every check precedes the first write.
 */

/** The reserved name of the implicit linear-history fork. */
const MAIN_FORK_NAME = 'Main';

const AUTO_NAME_PATTERN = /^Fork (\d+)$/;

export const forkViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  tipMessageId: z.string().nullable(),
  createdAt: z.string(),
});

export type ForkView = z.infer<typeof forkViewSchema>;

function forkView(record: ForkRecord): ForkView {
  return {
    id: record.id,
    name: record.name,
    tipMessageId: record.tipMessageId,
    createdAt: record.createdAt.toISOString(),
  };
}

/** "Fork N" with N one past the highest existing auto-name. */
export function nextAutoName(existingNames: readonly string[]): string {
  let maxNumber = 0;
  for (const name of existingNames) {
    const matched = AUTO_NAME_PATTERN.exec(name);
    const parsed = matched?.[1] === undefined ? Number.NaN : Number.parseInt(matched[1], 10);
    if (!Number.isNaN(parsed) && parsed > maxNumber) maxNumber = parsed;
  }
  return `Fork ${String(maxNumber + 1)}`;
}

function forkWriteGate(caller: MemberRecord | null): Refusal | null {
  if (caller === null) return { refusal: 'not-found' };
  if (!canSendMessages(caller.privilege)) return { refusal: 'forbidden' };
  return null;
}

/**
 * The shared prelude of every fork mutation: take the conversation `FOR
 * UPDATE` lock, gate on the caller's write privilege, then run the operation
 * under that serialization.
 */
function underForkWriteGate<S>(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string },
  run: () => ResultAsync<Outcome<S>, DomainError>
): ResultAsync<Outcome<S>, DomainError> {
  return stores.conversations.lockForUpdate(params.conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<Outcome<S>>({ refusal: 'not-found' });
    return stores.members
      .activeByUser(params.conversationId, params.callerUserId)
      .andThen((caller) => {
        const gate = forkWriteGate(caller);
        if (gate !== null) return okAsync<Outcome<S>>(gate);
        return run();
      });
  });
}

export function listForks(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<Outcome<{ forks: ForkView[] }>, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) {
        return okAsync<Outcome<{ forks: ForkView[] }>>({ refusal: 'not-found' });
      }
      return stores.forks
        .list(params.conversationId)
        .map((rows) => ({ forks: rows.map((row) => forkView(row)) }));
    });
}

export const createForkOutcomeSchema = z.union([
  z.object({ forks: z.array(forkViewSchema), isNew: z.boolean() }),
  refusalSchema,
]);

export type CreateForkOutcome = z.infer<typeof createForkOutcomeSchema>;

export interface CreateForkParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly id: string;
  readonly fromMessageId: string;
  readonly name?: string | undefined;
}

export function createFork(
  stores: ConversationsStores,
  params: CreateForkParams
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, fromMessageId } = params;
  return underForkWriteGate(stores, params, () =>
    stores.forks.byId(conversationId, id).andThen((existing) => {
      if (existing !== null) return convergedForks(stores, conversationId, false);
      return stores.messages.inConversation(fromMessageId, conversationId).andThen((inConv) => {
        if (!inConv) return okAsync<CreateForkOutcome>({ refusal: 'not-found' });
        return planForkInsert(stores, params);
      });
    })
  );
}

/** Limit + name gates over the locked fork set, then the matching insert path. */
function planForkInsert(
  stores: ConversationsStores,
  params: CreateForkParams
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, fromMessageId } = params;
  return stores.forks.list(conversationId).andThen((forks) => {
    if (forks.length >= MAX_FORKS_PER_CONVERSATION) {
      return okAsync<CreateForkOutcome>({
        refusal: 'fork-limit',
        limit: MAX_FORKS_PER_CONVERSATION,
      });
    }
    const name = params.name ?? nextAutoName(forks.map((fork) => fork.name));
    // Name collisions refuse BEFORE any insert: a unique-violation inside
    // the byKey transaction would abort it wholesale (25P02 on the key-row
    // flip), and the conversation lock makes this pre-check race-free —
    // every fork-name writer takes it.
    if (forks.some((fork) => fork.name === name)) {
      return okAsync<CreateForkOutcome>({ refusal: 'fork-name-taken' });
    }
    return forks.length === 0
      ? insertFirstForks(stores, { conversationId, id, name, fromMessageId })
      : insertAdditionalFork(stores, { conversationId, id, name, fromMessageId });
  });
}

interface InsertForkParams {
  readonly conversationId: string;
  readonly id: string;
  readonly name: string;
  readonly fromMessageId: string;
}

/**
 * Materializes "Main" (tipped at the latest message) plus the requested
 * fork. The requested name is pre-checked against the reserved Main name
 * because a unique-violation on the SECOND insert would refuse AFTER the
 * Main row was written — and refusals commit.
 */
function insertFirstForks(
  stores: ConversationsStores,
  params: InsertForkParams
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, name, fromMessageId } = params;
  if (name === MAIN_FORK_NAME) return okAsync<CreateForkOutcome>({ refusal: 'fork-name-taken' });
  return stores.messages.latestId(conversationId).andThen((mainTip) => {
    const now = new Date();
    return stores.forks
      .insert({
        id: null,
        conversationId,
        name: MAIN_FORK_NAME,
        tipMessageId: mainTip,
        createdAt: now,
      })
      .andThen((main) => {
        if (main === 'name-taken') {
          throw new Error('conversations: Main fork collided in an empty fork set');
        }
        return stores.forks.insert({
          id,
          conversationId,
          name,
          tipMessageId: fromMessageId,
          // Strictly after Main so the creation-ordered list keeps Main first.
          createdAt: new Date(now.getTime() + 1),
        });
      })
      .andThen((inserted) => {
        if (inserted === 'name-taken') {
          throw new Error('conversations: fork name collided under the conversation lock');
        }
        return convergedForks(stores, conversationId, true);
      });
  });
}

function insertAdditionalFork(
  stores: ConversationsStores,
  params: InsertForkParams
): ResultAsync<CreateForkOutcome, DomainError> {
  const { conversationId, id, name, fromMessageId } = params;
  return stores.forks
    .insert({ id, conversationId, name, tipMessageId: fromMessageId })
    .andThen((inserted) => {
      if (inserted === 'name-taken') {
        throw new Error('conversations: fork name collided under the conversation lock');
      }
      return convergedForks(stores, conversationId, true);
    });
}

function convergedForks(
  stores: ConversationsStores,
  conversationId: string,
  isNew: boolean
): ResultAsync<CreateForkOutcome, DomainError> {
  return stores.forks
    .list(conversationId)
    .map((rows) => ({ forks: rows.map((row) => forkView(row)), isNew }));
}

export const renameForkOutcomeSchema = z.union([z.object({ fork: forkViewSchema }), refusalSchema]);

export type RenameForkOutcome = z.infer<typeof renameForkOutcomeSchema>;

export function renameFork(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly callerUserId: string;
    readonly name: string;
  }
): ResultAsync<RenameForkOutcome, DomainError> {
  const { conversationId, forkId, name } = params;
  return underForkWriteGate(stores, params, () =>
    stores.forks.list(conversationId).andThen((forks) => {
      // Pre-checked under the conversation lock (see planForkInsert): a
      // unique-violation inside the byKey transaction would abort it.
      // Renaming a fork to its own current name stays a legal no-op.
      if (forks.some((fork) => fork.name === name && fork.id !== forkId)) {
        return okAsync<RenameForkOutcome>({ refusal: 'fork-name-taken' });
      }
      return stores.forks
        .rename({ conversationId, forkId, name })
        .map((renamed): RenameForkOutcome => {
          if (renamed === 'name-taken') {
            throw new Error('conversations: fork rename collided under the conversation lock');
          }
          if (renamed === null) return { refusal: 'not-found' };
          return { fork: forkView(renamed) };
        });
    })
  );
}

export const updateForkTipOutcomeSchema = z.union([
  z.object({ fork: forkViewSchema }),
  refusalSchema,
]);

export type UpdateForkTipOutcome = z.infer<typeof updateForkTipOutcomeSchema>;

export interface UpdateForkTipParams {
  readonly conversationId: string;
  readonly forkId: string;
  readonly callerUserId: string;
  readonly tipMessageId: string;
  readonly expectedTipMessageId: string | null;
}

/**
 * The fork-tip CAS: the store's conditional UPDATE
 * (`WHERE tipMessageId IS NOT DISTINCT FROM expected`) is the winner-picker;
 * a zero-row outcome is disambiguated by re-reading the fork — gone is
 * not-found, moved is a conflict carrying the authoritative tip.
 */
export function updateForkTip(
  stores: ConversationsStores,
  params: UpdateForkTipParams
): ResultAsync<UpdateForkTipOutcome, DomainError> {
  const { conversationId, tipMessageId } = params;
  return underForkWriteGate(stores, params, () =>
    stores.messages.inConversation(tipMessageId, conversationId).andThen((inConv) => {
      if (!inConv) return okAsync<UpdateForkTipOutcome>({ refusal: 'not-found' });
      return casForkTip(stores, params);
    })
  );
}

/** The conditional tip write plus its zero-row disambiguation read. */
function casForkTip(
  stores: ConversationsStores,
  params: UpdateForkTipParams
): ResultAsync<UpdateForkTipOutcome, DomainError> {
  const { conversationId, forkId, tipMessageId, expectedTipMessageId } = params;
  return stores.forks
    .updateTip({ conversationId, forkId, expectedTipMessageId, tipMessageId })
    .andThen((updated) => {
      if (updated !== null) {
        return okAsync<UpdateForkTipOutcome>({ fork: forkView(updated) });
      }
      return stores.forks
        .byId(conversationId, forkId)
        .map(
          (fork): UpdateForkTipOutcome =>
            fork === null
              ? { refusal: 'not-found' }
              : { refusal: 'fork-tip-conflict', currentTipMessageId: fork.tipMessageId }
        );
    });
}

export const deleteForkOutcomeSchema = z.union([
  z.object({ forks: z.array(forkViewSchema) }),
  refusalSchema,
]);

export type DeleteForkOutcome = z.infer<typeof deleteForkOutcomeSchema>;

export function deleteFork(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly callerUserId: string;
  }
): ResultAsync<DeleteForkOutcome, DomainError> {
  const { conversationId, forkId } = params;
  return underForkWriteGate(stores, params, () =>
    // Converged whether this call deleted the row or a retry already had.
    stores.forks
      .remove({ conversationId, forkId })
      .andThen(() => remainingForksAfterDelete(stores, conversationId))
  );
}

function remainingForksAfterDelete(
  stores: ConversationsStores,
  conversationId: string
): ResultAsync<DeleteForkOutcome, DomainError> {
  return stores.forks.list(conversationId).andThen((remaining) => {
    if (remaining.length === 1) {
      // A single surviving fork is linear history: drop the fork layer.
      return stores.forks.removeAll(conversationId).map((): DeleteForkOutcome => ({ forks: [] }));
    }
    return okAsync<DeleteForkOutcome>({
      forks: remaining.map((row) => forkView(row)),
    });
  });
}
