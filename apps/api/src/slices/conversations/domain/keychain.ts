import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { assembleKeyChain } from './parent-chain.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
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
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<Outcome<KeyChainView>, DomainError> {
  const { conversationId, callerUserId } = params;
  return stores.conversations.get(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
      return stores.users.byId(callerUserId).andThen((user) => {
        if (user === null) {
          throw new Error('conversations: no users row for an authenticated principal');
        }
        return memberKeyChain(stores, conversationId, conversation.currentEpoch, user.publicKey);
      });
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
