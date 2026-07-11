import { z } from 'zod';
import { MAX_CONVERSATION_MEMBERS, canManageLinks, fromBase64, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { resolveCallerMember } from './caller.js';
import { contentItemView, contentItemViewSchema } from './content-item-view.js';
import { refusalSchema } from './outcomes.js';
import { applyRotation, planEpochWraps } from './rotation.js';
import type { ConversationCaller } from './caller.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ConversationRecord,
  ConversationsStores,
  SharedLinkRecord,
  SharedMessageRecord,
} from '../ports/index.js';
import type { Outcome, Refusal } from './outcomes.js';
import type { PlannedWrap } from './rotation.js';
import type { RotationBody } from './schemas.js';

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
  z.object({
    link: sharedLinkViewSchema,
    created: z.literal(true),
    /** The seated link-guest member's id — the `member:added` broadcast payload. */
    memberId: z.string(),
    /** The new epoch when the mint rotated; null on the full-history path. */
    newEpochNumber: z.number().int().nullable(),
  }),
  z.object({ link: sharedLinkViewSchema, created: z.literal(false) }),
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
  /** Stored on the guest member row (`shared_links` has no privilege column). */
  readonly privilege: MemberPrivilege;
  readonly giveFullHistory: boolean;
  /** Full-history path: ECIES wrap of the current epoch key to the link key. */
  readonly memberWrap?: string | undefined;
  /** Full-history path: the epoch the `memberWrap` was built for. */
  readonly expectedEpoch?: number | undefined;
  /** Rotation path: departure-style rotation that also seats the link key. */
  readonly rotation?: RotationBody | undefined;
}

/** The seated-link facts a created mint surfaces for broadcasting; or a refusal. */
type MintedLink = { readonly link: SharedLinkView; readonly memberId: string } | Refusal;

/**
 * Refusal-before-write: every gate — membership/privilege, cross-conversation
 * conflict, member limit, stale epoch, wrap-set — runs before the first write.
 * The mint takes the conversation `FOR UPDATE` (uniform lock order, epoch
 * freshness) and re-reads the caller's membership `FOR SHARE` so a concurrent
 * removal serializes against it. A minted link seats a real guest member
 * (epoch-wrapped, read/write): a `giveFullHistory` mint wraps the current
 * epoch key to the link key; a rotation mint rotates the epoch, seating the
 * link key in the new wrap set. The client-generated `linkPublicKey` is the
 * natural idempotency guard — a re-mint of an existing key converges on the
 * existing (already-seated) link, and anyone else's key answers 409.
 */
export function createSharedLink(
  stores: ConversationsStores,
  params: CreateSharedLinkParams
): ResultAsync<CreateLinkOutcome, DomainError> {
  const linkPublicKey = fromBase64(params.linkPublicKey);
  const expiresAt = params.expiresAt === null ? null : new Date(params.expiresAt);
  return stores.conversations.lockForUpdate(params.conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<CreateLinkOutcome>({ refusal: 'not-found' });
    const ctx: MintCtx = { stores, params, conversation, linkPublicKey, expiresAt };
    return stores.members
      .lockActiveByUser(params.conversationId, params.callerUserId)
      .andThen((caller) => {
        if (caller === null) return okAsync<CreateLinkOutcome>({ refusal: 'not-found' });
        if (!canManageLinks(caller.privilege)) {
          return okAsync<CreateLinkOutcome>({ refusal: 'forbidden' });
        }
        return stores.sharedLinks.byPublicKey(linkPublicKey).andThen((existing) => {
          if (existing !== null) {
            // Idempotent re-mint: the guest member and wraps already exist from
            // the first mint, so nothing is written. A foreign key answers 409.
            if (existing.conversationId !== params.conversationId) {
              return okAsync<CreateLinkOutcome>({ refusal: 'conflict' });
            }
            return okAsync<CreateLinkOutcome>({ link: sharedLinkView(existing), created: false });
          }
          return admitNewLink(ctx);
        });
      });
  });
}

/** The bundled inputs a new-link seat needs, threaded through the seating paths. */
interface MintCtx {
  readonly stores: ConversationsStores;
  readonly params: CreateSharedLinkParams;
  readonly conversation: ConversationRecord;
  readonly linkPublicKey: Uint8Array;
  readonly expiresAt: Date | null;
}

/** Member-limit gate, then the chosen seating path. */
function admitNewLink(ctx: MintCtx): ResultAsync<CreateLinkOutcome, DomainError> {
  return ctx.stores.members.countActive(ctx.params.conversationId).andThen((count) => {
    if (count >= MAX_CONVERSATION_MEMBERS) {
      return okAsync<CreateLinkOutcome>({
        refusal: 'member-limit',
        limit: MAX_CONVERSATION_MEMBERS,
      });
    }
    return ctx.params.giveFullHistory ? mintFullHistory(ctx) : mintWithRotation(ctx);
  });
}

/** Full-history seat: wrap the current epoch key to the link key, no rotation. */
function mintFullHistory(ctx: MintCtx): ResultAsync<CreateLinkOutcome, DomainError> {
  const { stores, params, conversation, linkPublicKey } = ctx;
  if (params.memberWrap === undefined || params.expectedEpoch === undefined) {
    return okAsync<CreateLinkOutcome>({ refusal: 'validation' });
  }
  const memberWrap = params.memberWrap;
  if (params.expectedEpoch !== conversation.currentEpoch) {
    return okAsync<CreateLinkOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: conversation.currentEpoch,
    });
  }
  return stores.epochs
    .byNumber(params.conversationId, conversation.currentEpoch)
    .andThen((epoch) => {
      if (epoch === null) {
        throw new Error('conversations: current epoch row missing for link mint');
      }
      return insertLinkAndMember(ctx, 1).andThen((minted) => {
        if ('refusal' in minted) return okAsync<CreateLinkOutcome>(minted);
        return stores.epochs
          .insertWraps([
            {
              epochId: epoch.id,
              memberPublicKey: linkPublicKey,
              wrap: fromBase64(memberWrap),
              visibleFromEpoch: 1,
            },
          ])
          .map(
            (): CreateLinkOutcome => ({
              link: minted.link,
              created: true,
              memberId: minted.memberId,
              newEpochNumber: null,
            })
          );
      });
    });
}

/** Rotation seat: rotate the epoch, seating the link key in the new wrap set. */
function mintWithRotation(ctx: MintCtx): ResultAsync<CreateLinkOutcome, DomainError> {
  const { stores, params, conversation, linkPublicKey } = ctx;
  if (params.rotation === undefined) return okAsync<CreateLinkOutcome>({ refusal: 'validation' });
  const rotation = params.rotation;
  if (rotation.expectedEpoch !== conversation.currentEpoch) {
    return okAsync<CreateLinkOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: conversation.currentEpoch,
    });
  }
  const newEpochNumber = rotation.expectedEpoch + 1;
  return stores.members.activeVisibilityByKey(params.conversationId).andThen((visibility) => {
    const withLink = new Map(visibility);
    withLink.set(toBase64(linkPublicKey), newEpochNumber);
    const plan = planEpochWraps(withLink, rotation.memberWraps);
    if (plan === null) return okAsync<CreateLinkOutcome>({ refusal: 'wrap-set-mismatch' });
    return insertLinkAndMember(ctx, newEpochNumber).andThen((minted) => {
      if ('refusal' in minted) return okAsync<CreateLinkOutcome>(minted);
      return applyRotation(stores, {
        conversationId: params.conversationId,
        rotation,
        plan,
      }).map(
        (rotated): CreateLinkOutcome => ({
          link: minted.link,
          created: true,
          memberId: minted.memberId,
          newEpochNumber: rotated.newEpochNumber,
        })
      );
    });
  });
}

/**
 * Inserts the link row (natural-key idempotent) then seats its guest member.
 * A null insert means a concurrent mint of the same key won the race under
 * another conversation's lock — answered as a cross-conversation conflict; a
 * null member insert is a defect (the link id is brand new under our lock).
 */
function insertLinkAndMember(
  ctx: MintCtx,
  visibleFromEpoch: number
): ResultAsync<MintedLink, DomainError> {
  const { stores, params, linkPublicKey, expiresAt } = ctx;
  return stores.sharedLinks
    .insert({
      conversationId: params.conversationId,
      linkPublicKey,
      displayName: params.displayName,
      expiresAt,
    })
    .andThen((inserted) => {
      if (inserted === null) return okAsync<MintedLink>({ refusal: 'conflict' });
      return stores.members
        .insertLinkMember({
          conversationId: params.conversationId,
          linkId: inserted.id,
          privilege: params.privilege,
          visibleFromEpoch,
        })
        .map((member): MintedLink => {
          if (member === null) {
            throw new Error('conversations: link member insert lost under the conversation lock');
          }
          return { link: sharedLinkView(inserted), memberId: member.id };
        });
    });
}

export interface ListLinksResult {
  readonly links: SharedLinkView[];
}

/** Any active member may see the conversation's links; management is a separate gate. */
export function listSharedLinks(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<ListLinksResult>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
    if (caller === null) return okAsync<Outcome<ListLinksResult>>({ refusal: 'not-found' });
    return stores.sharedLinks
      .listForConversation(params.conversationId)
      .map((rows) => ({ links: rows.map((row) => sharedLinkView(row)) }));
  });
}

export const revokeLinkOutcomeSchema = z.union([
  z.object({
    revoked: z.literal(true),
    /** The departed guest member's id, or null when the link had no member. */
    memberId: z.string().nullable(),
    newEpochNumber: z.number().int(),
    evicteePrincipalIds: z.array(z.string()),
  }),
  /** An already-revoked link: the first revoke rotated and evicted; this replays. */
  z.object({ revoked: z.literal(true), alreadyRevoked: z.literal(true) }),
  refusalSchema,
]);

export type RevokeLinkOutcome = z.infer<typeof revokeLinkOutcomeSchema>;

export interface RevokeSharedLinkParams {
  readonly conversationId: string;
  readonly linkId: string;
  readonly callerUserId: string;
  readonly rotation: RotationBody;
}

/**
 * Revoking a link is a member departure: under the conversation `FOR UPDATE`
 * lock, it flips `revokedAt`, marks the guest member left (the media presign
 * member-path gate), and rotates the epoch out of the revoked link — the remaining
 * members re-wrap to a key the guest never held. Every gate (membership,
 * not-found, stale epoch, wrap-set) precedes the first write; an already-revoked
 * link is an idempotent no-op (the first revoke already rotated and evicted).
 */
export function revokeSharedLink(
  stores: ConversationsStores,
  params: RevokeSharedLinkParams
): ResultAsync<RevokeLinkOutcome, DomainError> {
  const { conversationId, linkId, callerUserId, rotation } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
      if (!canManageLinks(caller.privilege)) {
        return okAsync<RevokeLinkOutcome>({ refusal: 'forbidden' });
      }
      return stores.sharedLinks.byId(linkId).andThen((link) => {
        if (link === null) return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
        if (link.conversationId !== conversationId) {
          return okAsync<RevokeLinkOutcome>({ refusal: 'not-found' });
        }
        if (link.revokedAt !== null) {
          return okAsync<RevokeLinkOutcome>({ revoked: true, alreadyRevoked: true });
        }
        if (rotation.expectedEpoch !== conversation.currentEpoch) {
          return okAsync<RevokeLinkOutcome>({
            refusal: 'stale-epoch',
            currentEpoch: conversation.currentEpoch,
          });
        }
        return executeRevoke(stores, params);
      });
    });
  });
}

/** The gated revoke writes: plan the remaining wrap set, then apply. */
function executeRevoke(
  stores: ConversationsStores,
  params: RevokeSharedLinkParams
): ResultAsync<RevokeLinkOutcome, DomainError> {
  return planLinkDeparture(stores, params.conversationId, params.linkId, params.rotation).andThen(
    (plan) =>
      plan === null
        ? okAsync<RevokeLinkOutcome>({ refusal: 'wrap-set-mismatch' })
        : applyRevokeWrites(stores, params, plan)
  );
}

/** Flip `revokedAt`, mark the guest left, rotate the epoch out of the revoked link. */
function applyRevokeWrites(
  stores: ConversationsStores,
  params: RevokeSharedLinkParams,
  plan: readonly PlannedWrap[]
): ResultAsync<RevokeLinkOutcome, DomainError> {
  const { conversationId, linkId, rotation } = params;
  return stores.sharedLinks
    .revoke({ conversationId, linkId })
    .andThen((revoked) => {
      if (revoked === null) {
        throw new Error('conversations: revoke matched no row under the conversation lock');
      }
      return stores.members.markLeftByLink({ conversationId, linkId });
    })
    .andThen((left) =>
      applyRotation(stores, { conversationId, rotation, plan }).map(
        (rotated): RevokeLinkOutcome => ({
          revoked: true,
          memberId: left?.id ?? null,
          newEpochNumber: rotated.newEpochNumber,
          evicteePrincipalIds: [linkId],
        })
      )
    );
}

/** The remaining-members wrap plan: authoritative key set minus the revoked link. */
function planLinkDeparture(
  stores: ConversationsStores,
  conversationId: string,
  linkId: string,
  rotation: RotationBody
): ResultAsync<PlannedWrap[] | null, DomainError> {
  return stores.members.activeKeysOrdered(conversationId).map((keys) => {
    const remaining = new Map<string, number>();
    for (const key of keys) {
      if (key.linkId === linkId) continue;
      remaining.set(toBase64(key.publicKey), key.visibleFromEpoch);
    }
    return planEpochWraps(remaining, rotation.memberWraps);
  });
}

export const changeLinkPrivilegeOutcomeSchema = z.union([
  z.object({
    changed: z.literal(true),
    /** The affected guest member's id — the `member:privilege-changed` payload; null when the link seats no active guest. */
    memberId: z.string().nullable(),
  }),
  refusalSchema,
]);

export type ChangeLinkPrivilegeOutcome = z.infer<typeof changeLinkPrivilegeOutcomeSchema>;

/**
 * Admin-driven link privilege change. The privilege's single source of truth is
 * the link's guest MEMBER row (not a `shared_links` column), so this updates
 * that row and never rotates keys (a privilege change does not revoke access).
 * Not-found is keyed on the LINK: a missing, foreign, or revoked link answers
 * the same 404 as a live link with no active guest member would — except the
 * latter is a real (idempotent) change with a null member id.
 */
export function changeLinkPrivilege(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly linkId: string;
    readonly privilege: MemberPrivilege;
  }
): ResultAsync<ChangeLinkPrivilegeOutcome, DomainError> {
  const { conversationId, callerUserId, linkId, privilege } = params;
  return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
    if (caller === null) return okAsync<ChangeLinkPrivilegeOutcome>({ refusal: 'not-found' });
    if (!canManageLinks(caller.privilege)) {
      return okAsync<ChangeLinkPrivilegeOutcome>({ refusal: 'forbidden' });
    }
    return stores.sharedLinks.byId(linkId).andThen((link) => {
      if (link?.conversationId !== conversationId || link.revokedAt !== null) {
        return okAsync<ChangeLinkPrivilegeOutcome>({ refusal: 'not-found' });
      }
      return stores.members
        .updatePrivilegeByLink({ conversationId, linkId, privilege })
        .map(
          (member): ChangeLinkPrivilegeOutcome => ({ changed: true, memberId: member?.id ?? null })
        );
    });
  });
}

export const changeLinkNameOutcomeSchema = z.union([
  z.object({ success: z.literal(true) }),
  refusalSchema,
]);

export type ChangeLinkNameOutcome = z.infer<typeof changeLinkNameOutcomeSchema>;

/**
 * Admin-driven link display-name change. Gated on the link-management ladder
 * (admin+), then a conditional write to a live link; a missing, foreign, or
 * revoked link answers not-found.
 */
export function changeLinkName(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly linkId: string;
    readonly displayName: string;
  }
): ResultAsync<ChangeLinkNameOutcome, DomainError> {
  const { conversationId, callerUserId, linkId, displayName } = params;
  return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
    if (caller === null) return okAsync<ChangeLinkNameOutcome>({ refusal: 'not-found' });
    if (!canManageLinks(caller.privilege)) {
      return okAsync<ChangeLinkNameOutcome>({ refusal: 'forbidden' });
    }
    return stores.sharedLinks
      .updateDisplayName({ conversationId, linkId, displayName })
      .map(
        (updated): ChangeLinkNameOutcome => (updated ? { success: true } : { refusal: 'not-found' })
      );
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
  /** The `shared_messages` row id — the client mints media presign URLs with it (as `:shareId`). */
  id: z.string(),
  messageId: z.string(),
  wrappedContentKey: z.string(),
  createdAt: z.string(),
  contentItems: z.array(contentItemViewSchema),
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
      sharedMessages: rows.map((row) => publicShareMessageView(row)),
    }));
  });
}

function publicShareMessageView(
  row: SharedMessageRecord
): z.infer<typeof publicShareMessageSchema> {
  return {
    id: row.id,
    messageId: row.messageId,
    wrappedContentKey: toBase64(row.wrappedContentKey),
    createdAt: row.createdAt.toISOString(),
    contentItems: row.contentItems.map((item) => contentItemView(item)),
  };
}

function isExpired(link: SharedLinkRecord, now: Date): boolean {
  return link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime();
}
