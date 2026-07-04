import { z } from 'zod';
import { canManageLinks, fromBase64, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { refusalSchema } from './outcomes.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores, SharedLinkRecord } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

/**
 * Shares: a shared LINK is a public, revocable/expiring window into a
 * conversation, minted and revoked by link-managing members; a shared MESSAGE
 * exposes one message's wrapped content key through the specific link it was
 * shared into — the authorization boundary coincides with the per-link crypto
 * boundary (content keys are wrapped client-side to the link key). Revoke and
 * expiry are enforced LAZILY at the read path (a predicate, never a sweep),
 * so the unauthenticated public read is the single gate for both. The public
 * read leaks nothing beyond that link's shared content: no membership, no
 * other links' shares, no other conversations' titles, no epoch or private
 * key material.
 */

export const sharedLinkViewSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export type SharedLinkView = z.infer<typeof sharedLinkViewSchema>;

function sharedLinkView(record: SharedLinkRecord): SharedLinkView {
  return {
    id: record.id,
    displayName: record.displayName,
    revokedAt: record.revokedAt === null ? null : record.revokedAt.toISOString(),
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

export const createLinkOutcomeSchema = z.union([
  z.object({ link: sharedLinkViewSchema, created: z.boolean() }),
  refusalSchema,
]);

export type CreateLinkOutcome = z.infer<typeof createLinkOutcomeSchema>;

export interface CreateSharedLinkParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  /** Base64 client-generated public key; decoded here and opaque to the API. */
  readonly linkPublicKey: string;
  readonly displayName: string | null;
  /** ISO instant or null; stored as-is and enforced lazily at read. */
  readonly expiresAt: string | null;
}

/**
 * Refusal-before-write: the membership and privilege gates run before the
 * insert (refusals ride the success channel and therefore commit). The
 * client-generated `linkPublicKey` is the natural idempotency guard — a losing
 * insert converges on the existing row for the same conversation and refuses
 * anyone else's key.
 */
export function createSharedLink(
  stores: ConversationsStores,
  params: CreateSharedLinkParams
): ResultAsync<CreateLinkOutcome, DomainError> {
  const linkPublicKey = fromBase64(params.linkPublicKey);
  const expiresAt = params.expiresAt === null ? null : new Date(params.expiresAt);
  // FOR SHARE on the caller's membership row: a concurrent member removal
  // serializes against this mint, so a removal that commits first is seen
  // here (refusal) and a mint that commits first is seen by the remover —
  // never a link minted by an already-removed member.
  return stores.members
    .lockActiveByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) return okAsync<CreateLinkOutcome>({ refusal: 'not-found' });
      if (!canManageLinks(caller.privilege)) {
        return okAsync<CreateLinkOutcome>({ refusal: 'forbidden' });
      }
      return stores.sharedLinks
        .insert({
          conversationId: params.conversationId,
          linkPublicKey,
          displayName: params.displayName,
          expiresAt,
        })
        .andThen((inserted) => {
          if (inserted !== null) {
            return okAsync<CreateLinkOutcome>({ link: sharedLinkView(inserted), created: true });
          }
          return convergeOnExistingLink(stores, params.conversationId, linkPublicKey);
        });
    });
}

function convergeOnExistingLink(
  stores: ConversationsStores,
  conversationId: string,
  linkPublicKey: Uint8Array
): ResultAsync<CreateLinkOutcome, DomainError> {
  return stores.sharedLinks.byPublicKey(linkPublicKey).map((existing): CreateLinkOutcome => {
    if (existing === null) {
      // ON CONFLICT DO NOTHING skipped the insert, so the key must exist.
      throw new Error('conversations: link public key conflicted but resolved to no row');
    }
    if (existing.conversationId !== conversationId) {
      // Existence is not leaked cross-conversation: a foreign key answers 409.
      return { refusal: 'conflict' };
    }
    return { link: sharedLinkView(existing), created: false };
  });
}

export interface ListLinksResult {
  readonly links: SharedLinkView[];
}

/** Any active member may see the conversation's links; management is a separate gate. */
export function listSharedLinks(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<Outcome<ListLinksResult>, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) return okAsync<Outcome<ListLinksResult>>({ refusal: 'not-found' });
      return stores.sharedLinks
        .listForConversation(params.conversationId)
        .map((rows) => ({ links: rows.map((row) => sharedLinkView(row)) }));
    });
}

export const revokeLinkOutcomeSchema = z.union([
  z.object({ revoked: z.literal(true) }),
  refusalSchema,
]);

export type RevokeLinkOutcome = z.infer<typeof revokeLinkOutcomeSchema>;

/**
 * The revoke claim is an atomic conditional write; a 0-row outcome is
 * disambiguated by re-reading actual state — already-revoked is an idempotent
 * no-op, a missing or cross-conversation link is not-found, and a live link
 * surviving the miss is a defect.
 */
export function revokeSharedLink(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly linkId: string;
    readonly callerUserId: string;
  }
): ResultAsync<RevokeLinkOutcome, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
      if (!canManageLinks(caller.privilege)) {
        return okAsync<RevokeLinkOutcome>({ refusal: 'forbidden' });
      }
      return stores.sharedLinks
        .revoke({ conversationId: params.conversationId, linkId: params.linkId })
        .andThen((revoked) => {
          if (revoked !== null) return okAsync<RevokeLinkOutcome>({ revoked: true });
          return disambiguateRevoke(stores, params);
        });
    });
}

function disambiguateRevoke(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly linkId: string }
): ResultAsync<RevokeLinkOutcome, DomainError> {
  return stores.sharedLinks.byId(params.linkId).map((link): RevokeLinkOutcome => {
    if (link === null) return { refusal: 'not-found' };
    if (link.conversationId !== params.conversationId) return { refusal: 'not-found' };
    if (link.revokedAt === null) {
      throw new Error('conversations: revoke matched no row but the link is live');
    }
    return { revoked: true };
  });
}

export const createSharedMessageOutcomeSchema = z.union([
  z.object({ shareId: z.string() }),
  refusalSchema,
]);

export type CreateSharedMessageOutcome = z.infer<typeof createSharedMessageOutcomeSchema>;

/**
 * A member shares one message from a conversation they belong to, into one of
 * that conversation's live links. The message is verified to belong to the
 * conversation and the link must exist, belong to the conversation, and be
 * neither revoked nor expired — a dead or foreign link answers the same
 * uniform not-found as a missing message. The row is stamped with `createdBy`
 * so a creator's hard deletion severs their shares by FK cascade, and with
 * `linkId` so the share is visible only through its minting link.
 */
export function createSharedMessage(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly linkId: string;
    readonly messageId: string;
    /** Base64 wrap of the message content key under the link secret; decoded here, opaque to the API. */
    readonly wrappedContentKey: string;
    readonly now: Date;
  }
): ResultAsync<CreateSharedMessageOutcome, DomainError> {
  const wrappedContentKey = fromBase64(params.wrappedContentKey);
  // FOR SHARE on the caller's membership row — same serialization as the
  // link mint: a concurrent removal cannot slip between this guard and the
  // insert.
  return stores.members
    .lockActiveByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) return okAsync<CreateSharedMessageOutcome>({ refusal: 'not-found' });
      return stores.messages
        .inConversation(params.messageId, params.conversationId)
        .andThen((present) => {
          if (!present) return okAsync<CreateSharedMessageOutcome>({ refusal: 'not-found' });
          return insertShareIntoLiveLink(stores, params, wrappedContentKey);
        });
    });
}

/**
 * The link gate: missing, foreign, revoked, and expired links all answer the
 * same uniform not-found, so the share write is no oracle for link state.
 * Expiry reuses the read path's inclusive predicate.
 */
function insertShareIntoLiveLink(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly linkId: string;
    readonly messageId: string;
    readonly now: Date;
  },
  wrappedContentKey: Uint8Array
): ResultAsync<CreateSharedMessageOutcome, DomainError> {
  return stores.sharedLinks.byId(params.linkId).andThen((link) => {
    if (link?.conversationId !== params.conversationId) {
      return okAsync<CreateSharedMessageOutcome>({ refusal: 'not-found' });
    }
    if (link.revokedAt !== null || isExpired(link, params.now)) {
      return okAsync<CreateSharedMessageOutcome>({ refusal: 'not-found' });
    }
    return stores.sharedMessages
      .insert({
        messageId: params.messageId,
        linkId: link.id,
        createdBy: params.callerUserId,
        wrappedContentKey,
      })
      .map((inserted): CreateSharedMessageOutcome => ({ shareId: inserted.id }));
  });
}

export const publicShareMessageSchema = z.object({
  messageId: z.string(),
  wrappedContentKey: z.string(),
  createdAt: z.string(),
});

export const publicShareViewSchema = z.object({
  displayName: z.string().nullable(),
  sharedMessages: z.array(publicShareMessageSchema),
});

export type PublicShareView = z.infer<typeof publicShareViewSchema>;

/**
 * The unauthenticated public read. Revoke and expiry are enforced here and
 * only here (lazy, no sweep); all three of missing, revoked, and expired
 * answer the same not-found shape so the endpoint is no oracle. Expiry is
 * inclusive of the exact instant — a link expiring at `now` is already gone.
 */
export function readPublicShare(
  stores: ConversationsStores,
  params: { readonly linkId: string; readonly now: Date }
): ResultAsync<Outcome<PublicShareView>, DomainError> {
  return stores.sharedLinks.byId(params.linkId).andThen((link) => {
    if (link === null) return okAsync<Outcome<PublicShareView>>({ refusal: 'not-found' });
    if (link.revokedAt !== null || isExpired(link, params.now)) {
      return okAsync<Outcome<PublicShareView>>({ refusal: 'not-found' });
    }
    return stores.sharedMessages.listForLink(link.id).map((rows) => ({
      displayName: link.displayName,
      sharedMessages: rows.map((row) => ({
        messageId: row.messageId,
        wrappedContentKey: toBase64(row.wrappedContentKey),
        createdAt: row.createdAt.toISOString(),
      })),
    }));
  });
}

function isExpired(link: SharedLinkRecord, now: Date): boolean {
  return link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime();
}
