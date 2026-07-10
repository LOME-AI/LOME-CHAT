import { z } from 'zod';
import {
  MAX_CONVERSATION_MEMBERS,
  MEMBER_PRIVILEGES,
  canAddMembers,
  canChangePrivilege,
  canRemoveMember,
  getPrivilegeLevel,
  isOwner,
  fromBase64,
  toBase64,
} from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { isRefusal, refusalSchema } from './outcomes.js';
import { applyRotation, planEpochWraps } from './rotation.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ByTransitionParams } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationRecord, ConversationsStores, MemberRecord } from '../ports/index.js';
import type { Outcome, Refusal } from './outcomes.js';
import type { AddMemberBody, RotationBody } from './schemas.js';
import type { PlannedWrap } from './rotation.js';

export const memberViewSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  username: z.string().nullable(),
  privilege: z.enum(MEMBER_PRIVILEGES),
  visibleFromEpoch: z.number().int(),
  joinedAt: z.string(),
  accepted: z.boolean(),
});

export type MemberView = z.infer<typeof memberViewSchema>;

export function listMembers(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<Outcome<{ members: MemberView[] }>, DomainError> {
  return stores.members
    .activeByUser(params.conversationId, params.callerUserId)
    .andThen((caller) => {
      if (caller === null) {
        return okAsync<Outcome<{ members: MemberView[] }>>({ refusal: 'not-found' });
      }
      return stores.members.listActive(params.conversationId).map((rows) => ({
        members: rows.map(
          (row): MemberView => ({
            id: row.id,
            userId: row.userId,
            username: row.username,
            privilege: row.privilege,
            visibleFromEpoch: row.visibleFromEpoch,
            joinedAt: row.joinedAt.toISOString(),
            accepted: row.acceptedAt !== null,
          })
        ),
      }));
    });
}

export const addMemberOutcomeSchema = z.union([
  z.object({ member: memberViewSchema, newEpochNumber: z.number().int().nullable() }),
  refusalSchema,
]);

export type AddMemberOutcome = z.infer<typeof addMemberOutcomeSchema>;

export interface AddMemberParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly body: AddMemberBody;
}

interface AddContext {
  readonly conversation: ConversationRecord;
  readonly target: {
    readonly id: string;
    readonly username: string;
    readonly publicKey: Uint8Array;
  };
}

/**
 * Refusal-before-write discipline (binding for every byKey flow in this
 * slice): refusals ride the success channel and therefore COMMIT the
 * transaction, so every check — privilege, limit, stale epoch, wrap-set —
 * runs before the first domain write. The `FOR UPDATE` conversation lock
 * taken up front keeps those reads authoritative until commit.
 */
export function addMember(
  stores: ConversationsStores,
  params: AddMemberParams
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<AddMemberOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      const gate = addPrivilegeGate(caller, body);
      if (gate !== null) return okAsync<AddMemberOutcome>(gate);
      return stores.users.byId(body.userId).andThen((target) => {
        if (target === null) return okAsync<AddMemberOutcome>({ refusal: 'not-found' });
        return admitTarget(stores, params, { conversation, target });
      });
    });
  });
}

/** Duplicate-membership and member-limit gates, then the chosen add path. */
function admitTarget(
  stores: ConversationsStores,
  params: AddMemberParams,
  context: AddContext
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, body } = params;
  return stores.members.activeByUser(conversationId, context.target.id).andThen((existing) => {
    if (existing !== null) return okAsync<AddMemberOutcome>({ refusal: 'already-member' });
    return stores.members.countActive(conversationId).andThen((count) => {
      if (count >= MAX_CONVERSATION_MEMBERS) {
        return okAsync<AddMemberOutcome>({
          refusal: 'member-limit',
          limit: MAX_CONVERSATION_MEMBERS,
        });
      }
      return body.giveFullHistory
        ? addWithFullHistory(stores, params, context)
        : addWithRotation(stores, params, context);
    });
  });
}

function addPrivilegeGate(caller: MemberRecord | null, body: AddMemberBody): Refusal | null {
  if (caller === null) return { refusal: 'not-found' };
  if (!canAddMembers(caller.privilege)) return { refusal: 'forbidden' };
  // The grant must sit strictly below the granter: an admin can never mint
  // another admin, and owner stays unreachable (also excluded by schema).
  if (getPrivilegeLevel(body.privilege) >= getPrivilegeLevel(caller.privilege)) {
    return { refusal: 'forbidden' };
  }
  return null;
}

function addedMemberView(
  inserted: { readonly id: string; readonly joinedAt: Date },
  context: AddContext,
  body: AddMemberBody,
  visibleFromEpoch: number
): MemberView {
  return {
    id: inserted.id,
    userId: context.target.id,
    username: context.target.username,
    privilege: body.privilege,
    visibleFromEpoch,
    joinedAt: inserted.joinedAt.toISOString(),
    accepted: false,
  };
}

function addWithFullHistory(
  stores: ConversationsStores,
  params: AddMemberParams,
  context: AddContext
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  if (body.wrap === undefined || body.expectedEpoch === undefined) {
    return okAsync<AddMemberOutcome>({ refusal: 'validation' });
  }
  const wrap = body.wrap;
  if (body.expectedEpoch !== context.conversation.currentEpoch) {
    return okAsync<AddMemberOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: context.conversation.currentEpoch,
    });
  }
  return stores.epochs
    .byNumber(conversationId, context.conversation.currentEpoch)
    .andThen((epoch) => {
      if (epoch === null) {
        throw new Error('conversations: current epoch row missing for member add');
      }
      return stores.members
        .insert({
          conversationId,
          userId: context.target.id,
          privilege: body.privilege,
          visibleFromEpoch: 1,
          acceptedAt: null,
          invitedByUserId: callerUserId,
        })
        .andThen((inserted) => {
          if (inserted === null) return okAsync<AddMemberOutcome>({ refusal: 'already-member' });
          return stores.epochs
            .insertWraps([
              {
                epochId: epoch.id,
                memberPublicKey: context.target.publicKey,
                wrap: fromBase64(wrap),
                visibleFromEpoch: 1,
              },
            ])
            .map(
              (): AddMemberOutcome => ({
                member: addedMemberView(inserted, context, body, 1),
                newEpochNumber: null,
              })
            );
        });
    });
}

function addWithRotation(
  stores: ConversationsStores,
  params: AddMemberParams,
  context: AddContext
): ResultAsync<AddMemberOutcome, DomainError> {
  const { conversationId, callerUserId, body } = params;
  if (body.rotation === undefined) return okAsync<AddMemberOutcome>({ refusal: 'validation' });
  const rotation = body.rotation;
  if (rotation.expectedEpoch !== context.conversation.currentEpoch) {
    return okAsync<AddMemberOutcome>({
      refusal: 'stale-epoch',
      currentEpoch: context.conversation.currentEpoch,
    });
  }
  const newEpochNumber = rotation.expectedEpoch + 1;
  return stores.members.activeVisibilityByKey(conversationId).andThen((visibility) => {
    const withTarget = new Map(visibility);
    withTarget.set(toBase64(context.target.publicKey), newEpochNumber);
    const plan = planEpochWraps(withTarget, rotation.memberWraps);
    if (plan === null) return okAsync<AddMemberOutcome>({ refusal: 'wrap-set-mismatch' });
    return stores.members
      .insert({
        conversationId,
        userId: context.target.id,
        privilege: body.privilege,
        visibleFromEpoch: newEpochNumber,
        acceptedAt: null,
        invitedByUserId: callerUserId,
      })
      .andThen((inserted) => {
        if (inserted === null) return okAsync<AddMemberOutcome>({ refusal: 'already-member' });
        return applyRotation(stores, { conversationId, rotation, plan }).map(
          (rotated): AddMemberOutcome => ({
            member: addedMemberView(inserted, context, body, newEpochNumber),
            newEpochNumber: rotated.newEpochNumber,
          })
        );
      });
  });
}

export const removeMemberOutcomeSchema = z.union([
  z.object({
    removed: z.literal(true),
    newEpochNumber: z.number().int(),
    evicteePrincipalIds: z.array(z.string()),
  }),
  refusalSchema,
]);

export type RemoveMemberOutcome = z.infer<typeof removeMemberOutcomeSchema>;

export interface RemoveMemberParams {
  readonly conversationId: string;
  readonly memberId: string;
  readonly callerUserId: string;
  readonly rotation: RotationBody;
}

export function removeMember(
  stores: ConversationsStores,
  params: RemoveMemberParams
): ResultAsync<RemoveMemberOutcome, DomainError> {
  const { conversationId, memberId, callerUserId, rotation } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<RemoveMemberOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<RemoveMemberOutcome>({ refusal: 'not-found' });
      if (getPrivilegeLevel(caller.privilege) < getPrivilegeLevel('admin')) {
        return okAsync<RemoveMemberOutcome>({ refusal: 'forbidden' });
      }
      return stores.members.activeById(conversationId, memberId).andThen((target) => {
        const gate = removalGate(caller, target, callerUserId, conversation);
        if ('refusal' in gate) return okAsync<RemoveMemberOutcome>(gate);
        if (rotation.expectedEpoch !== conversation.currentEpoch) {
          return okAsync<RemoveMemberOutcome>({
            refusal: 'stale-epoch',
            currentEpoch: conversation.currentEpoch,
          });
        }
        return executeRemoval(stores, params, gate.targetUserId);
      });
    });
  });
}

/** The gated removal writes: the shared departure rotation, shaped for removal. */
function executeRemoval(
  stores: ConversationsStores,
  params: RemoveMemberParams,
  targetUserId: string
): ResultAsync<RemoveMemberOutcome, DomainError> {
  return rotateOutDeparture(stores, {
    conversationId: params.conversationId,
    memberId: params.memberId,
    leavingUserId: targetUserId,
    rotation: params.rotation,
  }).map(
    (outcome): RemoveMemberOutcome =>
      isRefusal(outcome)
        ? outcome
        : {
            removed: true,
            newEpochNumber: outcome.newEpochNumber,
            evicteePrincipalIds: [targetUserId],
          }
  );
}

/**
 * The shared departure write (removal and voluntary leave): plan the wrap
 * set minus the leaver, mark the row left, rotate the epoch — all under the
 * caller's conversation lock.
 */
function rotateOutDeparture(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly leavingUserId: string;
    readonly rotation: RotationBody;
  }
): ResultAsync<Outcome<{ newEpochNumber: number }>, DomainError> {
  const { conversationId, memberId, leavingUserId, rotation } = params;
  return planWithoutUser(stores, conversationId, leavingUserId, rotation).andThen((plan) => {
    if (plan === null) {
      return okAsync<Outcome<{ newEpochNumber: number }>>({ refusal: 'wrap-set-mismatch' });
    }
    return stores.members.markLeft({ conversationId, memberId }).andThen((left) => {
      if (left === null) {
        throw new Error('conversations: active member vanished under the conversation lock');
      }
      return applyRotation(stores, { conversationId, rotation, plan });
    });
  });
}

/** Refusal, or the admitted target's user id (narrowed non-null by the gates). */
function removalGate(
  caller: MemberRecord,
  target: MemberRecord | null,
  callerUserId: string,
  conversation: ConversationRecord
): Refusal | { readonly targetUserId: string } {
  if (target === null) return { refusal: 'not-found' };
  // Link-guest removal travels with link privileges (the shares slice path).
  if (target.userId === null) return { refusal: 'validation' };
  if (target.userId === callerUserId) return { refusal: 'cannot-remove-self' };
  if (isOwner(target.privilege) || target.userId === conversation.ownerUserId) {
    return { refusal: 'cannot-remove-owner' };
  }
  if (!canRemoveMember(caller.privilege, target.privilege)) return { refusal: 'forbidden' };
  return { targetUserId: target.userId };
}

/** The remaining-members wrap plan: authoritative visibility minus the leaver. */
function planWithoutUser(
  stores: ConversationsStores,
  conversationId: string,
  leavingUserId: string,
  rotation: RotationBody
): ResultAsync<PlannedWrap[] | null, DomainError> {
  return stores.users.byId(leavingUserId).andThen((leaving) => {
    if (leaving === null) {
      throw new Error('conversations: users row missing for an active member');
    }
    return stores.members.activeVisibilityByKey(conversationId).map((visibility) => {
      const remaining = new Map(visibility);
      remaining.delete(toBase64(leaving.publicKey));
      return planEpochWraps(remaining, rotation.memberWraps);
    });
  });
}

export const leaveOutcomeSchema = z.union([
  z.object({
    left: z.literal(true),
    /** The leaving member's id — the `member:removed` broadcast payload. */
    memberId: z.string(),
    newEpochNumber: z.number().int(),
    evicteePrincipalIds: z.array(z.string()),
  }),
  z.object({ deleted: z.literal(true), evicteePrincipalIds: z.array(z.string()) }),
  refusalSchema,
]);

export type LeaveOutcome = z.infer<typeof leaveOutcomeSchema>;

export interface LeaveParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly rotation?: RotationBody | undefined;
}

/**
 * The owner's leave is the conversation's hard deletion (legacy semantics:
 * the owner always remains otherwise); any other member must rotate the
 * epoch on the way out so the remaining members get a key the leaver never
 * held.
 */
export function leaveConversation(
  stores: ConversationsStores,
  params: LeaveParams
): ResultAsync<LeaveOutcome, DomainError> {
  const { conversationId, callerUserId, rotation } = params;
  return stores.conversations.lockForUpdate(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<LeaveOutcome>({ refusal: 'not-found' });
    return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
      if (caller === null) return okAsync<LeaveOutcome>({ refusal: 'not-found' });
      if (isOwner(caller.privilege)) return ownerLeave(stores, conversationId, callerUserId);
      if (rotation === undefined) return okAsync<LeaveOutcome>({ refusal: 'rotation-required' });
      if (rotation.expectedEpoch !== conversation.currentEpoch) {
        return okAsync<LeaveOutcome>({
          refusal: 'stale-epoch',
          currentEpoch: conversation.currentEpoch,
        });
      }
      return memberLeave(stores, { conversationId, callerUserId, memberId: caller.id, rotation });
    });
  });
}

/** A non-owner's exit: the shared departure rotation, shaped for leave. */
function memberLeave(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly memberId: string;
    readonly rotation: RotationBody;
  }
): ResultAsync<LeaveOutcome, DomainError> {
  return rotateOutDeparture(stores, {
    conversationId: params.conversationId,
    memberId: params.memberId,
    leavingUserId: params.callerUserId,
    rotation: params.rotation,
  }).map(
    (outcome): LeaveOutcome =>
      isRefusal(outcome)
        ? outcome
        : {
            left: true,
            memberId: params.memberId,
            newEpochNumber: outcome.newEpochNumber,
            evicteePrincipalIds: [params.callerUserId],
          }
  );
}

function ownerLeave(
  stores: ConversationsStores,
  conversationId: string,
  callerUserId: string
): ResultAsync<LeaveOutcome, DomainError> {
  return stores.members.activePrincipalIds(conversationId).andThen((principalIds) =>
    stores.conversations
      .deleteOwned({ conversationId, ownerUserId: callerUserId })
      .map((deleted): LeaveOutcome => {
        if (!deleted) {
          throw new Error(
            'conversations: owner-privilege member does not own the conversation row'
          );
        }
        return { deleted: true, evicteePrincipalIds: principalIds };
      })
  );
}

export type MuteOutcome = Outcome<{ muted: boolean }>;

export type PinOutcome = Outcome<{ pinned: boolean }>;

/**
 * Member-scoped flag writes: the WHERE clause binds the row to the CALLER's
 * active membership, so no input can reach another member's flags. Zero rows
 * disambiguates to not-found — the caller is not an active member (or the
 * conversation does not exist), and the two answer identically on purpose.
 */
export function setMutedTransition(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly muted: boolean;
  }
): ByTransitionParams<MuteOutcome, DomainError> {
  return {
    transition: () =>
      stores.members
        .setMuted({
          conversationId: params.conversationId,
          userId: params.callerUserId,
          muted: params.muted,
        })
        .map((updated) => (updated ? { muted: params.muted } : null)),
    onZeroRows: () => okAsync<MuteOutcome, DomainError>({ refusal: 'not-found' }),
  };
}

export function setPinnedTransition(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly pinned: boolean;
  }
): ByTransitionParams<PinOutcome, DomainError> {
  return {
    transition: () =>
      stores.members
        .setPinned({
          conversationId: params.conversationId,
          userId: params.callerUserId,
          pinned: params.pinned,
        })
        .map((updated) => (updated ? { pinned: params.pinned } : null)),
    onZeroRows: () => okAsync<PinOutcome, DomainError>({ refusal: 'not-found' }),
  };
}

export type AcceptOutcome = Outcome<{ accepted: true }>;

export const declineOutcomeSchema = z.union([
  z.object({ declined: z.literal(true), memberId: z.string() }),
  refusalSchema,
]);

export type DeclineOutcome = z.infer<typeof declineOutcomeSchema>;

/**
 * Accept a pending invite: the conditional `acceptedAt` write wins for a
 * pending membership; a 0-row outcome is disambiguated — a still-active member
 * is already accepted (an idempotent no-op success, legacy 200-on-repeat), and
 * a missing/left one is not-found.
 */
export function acceptInviteTransition(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ByTransitionParams<AcceptOutcome, DomainError> {
  const { conversationId, callerUserId } = params;
  return {
    transition: () =>
      stores.members
        .setAccepted({ conversationId, userId: callerUserId })
        .map((updated) => (updated ? { accepted: true as const } : null)),
    onZeroRows: () =>
      stores.members
        .activeByUser(conversationId, callerUserId)
        .map(
          (member): AcceptOutcome =>
            member === null ? { refusal: 'not-found' } : { accepted: true }
        ),
  };
}

/**
 * Decline a pending invite (pending-only — an accepted member must `/leave`
 * with a rotation): the conditional `leftAt` write wins for a pending
 * membership and yields the member id for the broadcast; a 0-row outcome is
 * disambiguated — a still-active member is accepted (a `validation` refusal),
 * and a missing/left one is not-found.
 */
export function declineInviteTransition(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ByTransitionParams<DeclineOutcome, DomainError> {
  const { conversationId, callerUserId } = params;
  return {
    transition: () =>
      stores.members
        .declinePending({ conversationId, userId: callerUserId })
        .map((row) => (row === null ? null : { declined: true as const, memberId: row.id })),
    onZeroRows: () =>
      stores.members
        .activeByUser(conversationId, callerUserId)
        .map(
          (member): DeclineOutcome =>
            member === null ? { refusal: 'not-found' } : { refusal: 'validation' }
        ),
  };
}

export const changePrivilegeOutcomeSchema = z.union([
  z.object({
    updated: z.literal(true),
    memberId: z.string(),
    privilege: z.enum(MEMBER_PRIVILEGES),
  }),
  refusalSchema,
]);

export type ChangePrivilegeOutcome = z.infer<typeof changePrivilegeOutcomeSchema>;

export interface ChangePrivilegeParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly memberId: string;
  readonly privilege: MemberPrivilege;
}

/**
 * The admin-driven member privilege change, porting the legacy authorization
 * ladder exactly: the caller must be an active admin+; the target must exist
 * and not be the caller; and `canChangePrivilege` gates the grant (target and
 * new privilege both strictly below the caller — so `owner` is never mintable
 * and the owner is never demoted). Refusals ride the success channel, so every
 * check precedes the conditional write.
 */
export function changeMemberPrivilege(
  stores: ConversationsStores,
  params: ChangePrivilegeParams
): ResultAsync<ChangePrivilegeOutcome, DomainError> {
  const { conversationId, callerUserId, memberId, privilege } = params;
  return stores.members.activeByUser(conversationId, callerUserId).andThen((caller) => {
    if (caller === null) return okAsync<ChangePrivilegeOutcome>({ refusal: 'not-found' });
    if (getPrivilegeLevel(caller.privilege) < getPrivilegeLevel('admin')) {
      return okAsync<ChangePrivilegeOutcome>({ refusal: 'forbidden' });
    }
    return stores.members.activeById(conversationId, memberId).andThen((target) => {
      if (target === null) return okAsync<ChangePrivilegeOutcome>({ refusal: 'not-found' });
      if (target.userId === callerUserId) {
        return okAsync<ChangePrivilegeOutcome>({ refusal: 'cannot-change-own-privilege' });
      }
      if (!canChangePrivilege(caller.privilege, target.privilege, privilege)) {
        // Legacy returns the distinct PRIVILEGE_INSUFFICIENT (403) for an
        // over-grant / not-strictly-below refusal, not the generic FORBIDDEN
        // the non-admin-caller rung above uses.
        return okAsync<ChangePrivilegeOutcome>({ refusal: 'privilege-insufficient' });
      }
      return stores.members.updatePrivilege({ conversationId, memberId, privilege }).map(
        (updated): ChangePrivilegeOutcome =>
          // 0 rows only if the target departed concurrently between the
          // authz read and this write — no lock is held here, so treat the
          // benign race as not-found rather than a defect.
          updated ? { updated: true, memberId, privilege } : { refusal: 'not-found' }
      );
    });
  });
}
