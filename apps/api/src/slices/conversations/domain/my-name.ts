import { z } from 'zod';
import { MEMBER_PRIVILEGES } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { refusalSchema } from './outcomes.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ByTransitionParams } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { ConversationCaller } from './caller.js';
import type { Outcome } from './outcomes.js';

export const myNameViewSchema = z.object({
  /** The caller's own label: a user's `username`, a link guest's link display name. */
  displayName: z.string().nullable(),
  privilege: z.enum(MEMBER_PRIVILEGES),
});

export type MyNameView = z.infer<typeof myNameViewSchema>;

/**
 * The caller's own membership identity in the conversation — display label and
 * privilege — the guest-reachable read a shared-link visitor uses to render
 * itself. A user's label is their `username`; a link guest's is the link's
 * display name (guests have no `users` row). A non-member (or a revoked guest,
 * whose member row is left) gets the indistinguishable not-found.
 */
export function getMyName(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<MyNameView>, DomainError> {
  const { conversationId, caller } = params;
  if (caller.kind === 'user') {
    return stores.members.activeByUser(conversationId, caller.userId).andThen((member) => {
      if (member === null) return okAsync<Outcome<MyNameView>>({ refusal: 'not-found' });
      return stores.users.byId(caller.userId).map((user): Outcome<MyNameView> => {
        if (user === null) {
          throw new Error('conversations: no users row for an authenticated principal');
        }
        return { displayName: user.username, privilege: member.privilege };
      });
    });
  }
  return stores.members
    .activeLinkGuest(conversationId, caller.linkId)
    .map(
      (guest): Outcome<MyNameView> =>
        guest === null
          ? { refusal: 'not-found' }
          : { displayName: guest.displayName, privilege: guest.member.privilege }
    );
}

export const setMyNameOutcomeSchema = z.union([
  z.object({ success: z.literal(true) }),
  refusalSchema,
]);

export type SetMyNameOutcome = z.infer<typeof setMyNameOutcomeSchema>;

/**
 * A link guest renaming its own display label (its link's `displayName`).
 * Guest-self only: a full-session user has no link display name to set and is
 * refused. Naturally idempotent — the conditional write to a live link is the
 * dedup, so the route runs it through `byTransition` under the
 * `naturally-idempotent` exemption. A non-guest is `forbidden`; a guest whose
 * link is gone (revoked/left) resolves to the not-found no-op.
 */
export function setMyNameTransition(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly caller: ConversationCaller;
    readonly displayName: string;
  }
): ByTransitionParams<SetMyNameOutcome, DomainError> {
  const { conversationId, caller, displayName } = params;
  return {
    transition: () => {
      if (caller.kind !== 'linkGuest') {
        return okAsync<SetMyNameOutcome | null, DomainError>({ refusal: 'forbidden' });
      }
      // Confirm the caller is still an active guest before the write — link
      // liveness alone must never admit a departed guest (the read-path rule).
      return stores.members
        .activeLinkGuest(conversationId, caller.linkId)
        .andThen((guest) =>
          guest === null
            ? okAsync<SetMyNameOutcome | null, DomainError>(null)
            : stores.sharedLinks
                .updateDisplayName({ conversationId, linkId: caller.linkId, displayName })
                .map((updated): SetMyNameOutcome | null => (updated ? { success: true } : null))
        );
    },
    onZeroRows: () => okAsync<SetMyNameOutcome, DomainError>({ refusal: 'not-found' }),
  };
}
