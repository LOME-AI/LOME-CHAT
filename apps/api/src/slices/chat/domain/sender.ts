import type { ConversationCaller } from '../../conversations/index.js';

/**
 * The two-identifier turn model's SENDER, in the minimal shape both the run's
 * resolved `SenderPrincipal` (which additionally carries `memberId`) and the
 * route-time `TurnSender` satisfy. A member sends as `user` (its `userId`); a
 * shared-link visitor sends as `linkGuest` (the `linkId` its credential
 * resolved to). The PAYER is a separate identity (the owner for a guest, the
 * member themselves for a solo/self-funded user).
 */
type SenderLike =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string };

/**
 * The sender's principal id — a member's `userId`, a link guest's `linkId`.
 * This is what persists to `messages.senderId` (a guest has no userId) and
 * what keys the sender's rate-limit / eviction, never the paying owner.
 */
export function senderPrincipalId(sender: SenderLike): string {
  return sender.kind === 'user' ? sender.userId : sender.linkId;
}

/**
 * The membership-gate caller for a sender. A link guest carries the
 * conversation its credential resolved to, so the shared `resolveCallerMember`
 * / `resolveCallerPublicKey` gates key on the active `conversation_members` row
 * (a user by `userId`, a guest by `linkId`) — never on a client-claimed id.
 */
export function senderCaller(sender: SenderLike, conversationId: string): ConversationCaller {
  return sender.kind === 'user'
    ? { kind: 'user', userId: sender.userId }
    : { kind: 'linkGuest', linkId: sender.linkId, conversationId };
}
