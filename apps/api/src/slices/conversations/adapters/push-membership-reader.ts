import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The narrow active-user-member read (mute flag included) the push side-band
 * needs, structurally the notifications slice's `MembershipReader`. Declared
 * here — not imported from that slice — because a conversations adapter may not
 * import another slice's barrel (boundaries); the shapes match structurally so
 * the injected factory binds it as its `MembershipReader`.
 */
export interface PushMembershipReader {
  listActiveUserMembers(
    conversationId: string
  ): ResultAsync<readonly { readonly userId: string; readonly muted: boolean }[], DomainError>;
}

/**
 * The active user members of a conversation with their mute flag, read from
 * `conversation_members` (this slice's own table — single-writer). Link guests
 * carry a null `userId` and no devices, so they are excluded at the query.
 *
 * It lives in its own module, free of any `@hushbox/realtime` value import, so
 * the composition root can bind the same read for the route-fired capabilities
 * without dragging the workerd-only Durable Object runtime into `app.ts`.
 */
export function createPushMembershipReader(db: Database): PushMembershipReader {
  return {
    listActiveUserMembers: (conversationId) =>
      fromPromise(
        db
          .select({ userId: conversationMembers.userId, muted: conversationMembers.muted })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt),
              isNotNull(conversationMembers.userId)
            )
          ),
        (cause) => unavailableError('push membership read failed', cause)
      ).map((rows) =>
        rows.flatMap((row) =>
          row.userId === null ? [] : [{ userId: row.userId, muted: row.muted }]
        )
      ),
  };
}
