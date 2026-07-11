import { z } from 'zod';
import { MEMBER_PRIVILEGES, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { resolveCallerMember } from './caller.js';
import type { ConversationCaller } from './caller.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

export const memberKeyViewSchema = z.object({
  memberId: z.string(),
  userId: z.string().nullable(),
  linkId: z.string().nullable(),
  /** Base64 public key: `users.publicKey` or `sharedLinks.linkPublicKey`. */
  publicKey: z.string(),
  privilege: z.enum(MEMBER_PRIVILEGES),
  visibleFromEpoch: z.number().int(),
});

export type MemberKeyView = z.infer<typeof memberKeyViewSchema>;

export const memberKeysViewSchema = z.object({ members: z.array(memberKeyViewSchema) });

export type MemberKeysView = z.infer<typeof memberKeysViewSchema>;

/**
 * Every active member's PUBLIC key — the authoritative set a departing member
 * must re-wrap the next epoch key against (`planEpochWraps` refuses a mismatch),
 * so key rotation is impossible without it. Gated at READ privilege, not admin:
 * a non-owner member generates the rotation client-side and needs every
 * remaining member's key. Public keys are non-secret crypto material by design;
 * a non-member gets the indistinguishable not-found. Link members appear once a
 * later task writes their `conversation_members` rows — the join returns only
 * existing rows, so user members work now with no special-casing.
 */
export function getMemberKeys(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<MemberKeysView>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
    if (caller === null) return okAsync<Outcome<MemberKeysView>>({ refusal: 'not-found' });
    return stores.members.activeKeysOrdered(params.conversationId).map((rows) => ({
      members: rows.map(
        (row): MemberKeyView => ({
          memberId: row.memberId,
          userId: row.userId,
          linkId: row.linkId,
          publicKey: toBase64(row.publicKey),
          privilege: row.privilege,
          visibleFromEpoch: row.visibleFromEpoch,
        })
      ),
    }));
  });
}
