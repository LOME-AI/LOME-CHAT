import { toBase64 } from '@hushbox/shared';
import { ResultAsync, okAsync } from '../../../lib/result/index.js';
import { resolveCallerPublicKey } from './caller.js';
import { isRefusal } from './outcomes.js';
import { assembleKeyChain } from './parent-chain.js';
import type { ConversationCaller } from './caller.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ConversationsStores, EpochChainLinkRecord, EpochWrapRecord } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

export interface KeyChainWrapView {
  readonly epochNumber: number;
  readonly wrap: string;
  readonly confirmationHash: string;
  readonly visibleFromEpoch: number;
}

export interface KeyChainLinkView {
  readonly epochNumber: number;
  readonly chainLink: string;
  readonly confirmationHash: string;
}

export interface KeyChainView {
  readonly wraps: KeyChainWrapView[];
  readonly chainLinks: KeyChainLinkView[];
  readonly currentEpoch: number;
}

/**
 * The member's decryption material: their ECIES wraps plus the chain links
 * ABOVE their visibility floor (the link into the floor epoch would reveal
 * the pre-membership key — `assembleKeyChain` owns that filter). Answered
 * only to an active member holding at least one wrap; every other caller
 * gets the indistinguishable not-found.
 */
export function getKeyChain(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<KeyChainView>, DomainError> {
  const { conversationId, caller } = params;
  return stores.conversations.get(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
    return resolveCallerPublicKey(stores, conversationId, caller).andThen((publicKey) => {
      if (publicKey === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
      return memberKeyChain(stores, conversationId, conversation.currentEpoch, publicKey);
    });
  });
}

function memberKeyChain(
  stores: ConversationsStores,
  conversationId: string,
  currentEpoch: number,
  memberPublicKey: Uint8Array
): ResultAsync<Outcome<KeyChainView>, DomainError> {
  return stores.epochs
    .wrapsForKey(conversationId, memberPublicKey)
    .andThen((wraps) =>
      stores.epochs
        .chainLinks(conversationId)
        .map((links) => serializeKeyChain(wraps, links, currentEpoch))
    );
}

function serializeKeyChain(
  wraps: EpochWrapRecord[],
  links: EpochChainLinkRecord[],
  currentEpoch: number
): Outcome<KeyChainView> {
  const assembled = assembleKeyChain(wraps, links, currentEpoch);
  if (assembled === null) return { refusal: 'not-found' };
  return {
    wraps: assembled.wraps.map((wrap) => ({
      epochNumber: wrap.epochNumber,
      wrap: toBase64(wrap.wrap),
      confirmationHash: toBase64(wrap.confirmationHash),
      visibleFromEpoch: wrap.visibleFromEpoch,
    })),
    chainLinks: assembled.chainLinks.map((link) => ({
      epochNumber: link.epochNumber,
      chainLink: toBase64(link.chainLink),
      confirmationHash: toBase64(link.confirmationHash),
    })),
    currentEpoch: assembled.currentEpoch,
  };
}

export interface KeyChainBatchView {
  /** Per-conversation decryption material for accessible ids only. */
  readonly keyChains: Record<string, KeyChainView>;
  /** Ids the caller cannot access (non-member or no wraps) — never a 404. */
  readonly missing: string[];
}

/**
 * The caller's own keychain for many conversations at once — the list view's
 * post-membership-change refresh. Partial by design: an inaccessible id (the
 * caller is not an active member, or holds no wraps) is omitted from `keyChains`
 * and named in `missing`, so a single stale id never fails the whole batch.
 * The caller's public key is read once and reused across every conversation.
 */
export function getKeyChainBatch(
  stores: ConversationsStores,
  params: { readonly conversationIds: readonly string[]; readonly callerUserId: string }
): ResultAsync<KeyChainBatchView, DomainError> {
  const ids = [...new Set(params.conversationIds)];
  return stores.users.byId(params.callerUserId).andThen((user) => {
    if (user === null) {
      throw new Error('conversations: no users row for an authenticated principal');
    }
    const publicKey = user.publicKey;
    return ResultAsync.combine(
      ids.map((id) =>
        resolveKeyChainEntry(stores, id, params.callerUserId, publicKey).map(
          (outcome) => [id, outcome] as const
        )
      )
    ).map((entries) => {
      const keyChains: Record<string, KeyChainView> = {};
      const missing: string[] = [];
      for (const [id, outcome] of entries) {
        if (isRefusal(outcome)) missing.push(id);
        else keyChains[id] = outcome;
      }
      return { keyChains, missing };
    });
  });
}

function resolveKeyChainEntry(
  stores: ConversationsStores,
  conversationId: string,
  callerUserId: string,
  publicKey: Uint8Array
): ResultAsync<Outcome<KeyChainView>, DomainError> {
  return stores.conversations.get(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
      return memberKeyChain(stores, conversationId, conversation.currentEpoch, publicKey);
    });
  });
}
