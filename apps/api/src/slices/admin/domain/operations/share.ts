import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { adminRevokeSharedLink, adminUnrevokeSharedLink } from '../../../conversations/index.js';
import { defineAdminOp } from '../registry.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { DbWriter } from '../../../../lib/idempotency/index.js';
import type { Result, ResultAsync } from '../../../../lib/result/index.js';
import type {
  AdminSharedLinkParams,
  ConversationsStores,
  MembershipRevoker,
  RealtimeBroadcast,
} from '../../../conversations/index.js';
import type { AdminOpContext } from '../registry.js';

/**
 * The shared-link pair — `share.revoke` ↔ `share.unrevoke` — over
 * conversations' admin-engine writes. AUTHORIZATION-ONLY by founder ruling:
 * revoke flips `revokedAt` and departs the seated guest with no epoch
 * rotation (admins hold no key material; the member-initiated revoke remains
 * the cryptographic path), and unrevoke restores authorization only — the
 * departed guest is never re-seated; re-entry is the normal link flow. The
 * Iron Law projection is share validity, guest membership excluded by that
 * ruling.
 */

const revokeContract = ADMIN_OP_CONTRACTS['share.revoke'];
const unrevokeContract = ADMIN_OP_CONTRACTS['share.unrevoke'];

export interface AdminShareDeps {
  /** Bound per call to the engine-owned tx (the composition root passes `createConversationsStores`). */
  conversationsStores(writer: DbWriter): ConversationsStores;
  readonly membershipRevoker: MembershipRevoker;
  readonly realtime: RealtimeBroadcast;
}

/**
 * The shared prelude both ops run on the engine-owned tx: resolve the
 * link's conversation (the flat op input carries only `linkId`; the
 * composed writes need both ids), run the composed write, and map its
 * refusal to a typed not-found.
 */
async function composeLinkWrite<O extends object>(
  ctx: AdminOpContext<AdminShareDeps>,
  linkId: string,
  write: (stores: ConversationsStores, params: AdminSharedLinkParams) => ResultAsync<O, DomainError>
): Promise<
  Result<{ conversationId: string; value: Exclude<O, { refusal: unknown }> }, DomainError>
> {
  const stores = ctx.deps.conversationsStores(ctx.tx);
  const link = await stores.sharedLinks.byId(linkId);
  if (link.isErr()) return err(link.error);
  if (link.value === null) return err(notFoundError('shared link does not exist'));
  const { conversationId } = link.value;
  const outcome = await write(stores, { conversationId, linkId });
  if (outcome.isErr()) return err(outcome.error);
  if ('refusal' in outcome.value) return err(notFoundError('shared link does not exist'));
  return ok({ conversationId, value: outcome.value as Exclude<O, { refusal: unknown }> });
}

export const shareRevoke = defineAdminOp<AdminShareDeps, (typeof revokeContract)['input']>(
  revokeContract,
  {
    execute: async (ctx, input) => {
      const composed = await composeLinkWrite(ctx, input.linkId, adminRevokeSharedLink);
      if (composed.isErr()) return err(composed.error);
      const { conversationId, value } = composed.value;
      if ('alreadyRevoked' in value) {
        // A standing revocation is never re-applied: a second revoke's undo
        // would un-revoke a link some earlier actor revoked.
        return err(conflictError('shared link is already revoked'));
      }

      const { membershipRevoker, realtime } = ctx.deps;
      const evictees = value.evicteePrincipalIds;
      ctx.registerEphemeral({
        name: 'share.revoke.evict',
        // Best-effort live-socket eviction from the returned principal ids:
        // cache invalidation forces the verifier back to the database, the
        // eviction closes the sockets. A failure throws so telemetry sees it;
        // the broadcast-time membership recheck bounds any missed eviction.
        run: async (): Promise<void> => {
          for (const principalId of evictees) {
            const invalidated = await membershipRevoker.invalidate(conversationId, principalId);
            if (invalidated.isErr()) {
              throw new Error(
                `share revoke eviction: cache invalidation failed: ${invalidated.error.code}`
              );
            }
            const evicted = await realtime.evict(conversationId, principalId);
            if (evicted.isErr()) {
              throw new Error(
                `share revoke eviction: socket eviction failed: ${evicted.error.code}`
              );
            }
          }
        },
      });

      return ok({
        effects: [
          { label: 'sharedLink.revokedAt', before: null, after: 'revoked' },
          ...(value.memberId === null
            ? []
            : [{ label: 'sharedLink.guestMember', before: 'seated', after: 'departed' }]),
        ],
        target: { type: 'shared_link', id: input.linkId },
        inverseInput: {
          linkId: input.linkId,
          reason: `undo of share.revoke on link ${input.linkId}`,
        },
      });
    },
  }
);

export const shareUnrevoke = defineAdminOp<AdminShareDeps, (typeof unrevokeContract)['input']>(
  unrevokeContract,
  {
    execute: async (ctx, input) => {
      const composed = await composeLinkWrite(ctx, input.linkId, adminUnrevokeSharedLink);
      if (composed.isErr()) return err(composed.error);
      if ('alreadyLive' in composed.value.value) {
        return err(conflictError('shared link is not revoked'));
      }

      return ok({
        effects: [{ label: 'sharedLink.revokedAt', before: 'revoked', after: null }],
        target: { type: 'shared_link', id: input.linkId },
        inverseInput: {
          linkId: input.linkId,
          reason: `undo of share.unrevoke on link ${input.linkId}`,
        },
      });
    },
  }
);
