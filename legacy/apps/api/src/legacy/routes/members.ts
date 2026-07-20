import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, sql } from 'drizzle-orm';
import {
  conversationMembers,
  epochMembers,
  epochs,
  conversations,
  users,
  sharedLinks,
  type Database,
} from '@hushbox/db';
import {
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  ERROR_CODE_MEMBER_NOT_FOUND,
  ERROR_CODE_ALREADY_MEMBER,
  ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE,
  ERROR_CODE_CANNOT_REMOVE_OWNER,
  ERROR_CODE_CANNOT_REMOVE_SELF,
  ERROR_CODE_MEMBER_LIMIT_REACHED,
  ERROR_CODE_ROTATION_REQUIRED,
  ERROR_CODE_UNAUTHORIZED,
  MAX_CONVERSATION_MEMBERS,
  memberPrivilegeSchema,
  rotationSchema,
  canChangePrivilege,
  canRemoveMember,
  isOwner,
  fromBase64,
} from '@hushbox/shared';
import { createEvent } from '@hushbox/realtime/events';
import { requirePrivilege } from '../middleware/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { findActiveMember } from '../lib/db-helpers.js';
import { submitRotation, toRotationParams, handleRotationError } from '../services/keys/keys.js';
import { broadcastFireAndForget } from '../lib/broadcast.js';
import type { AppEnv } from '../types.js';
import type { Context } from 'hono';

type RotationInput = z.infer<typeof rotationSchema>;

async function loadTargetUser(
  db: AppEnv['Variables']['db'],
  targetUserId: string
): Promise<{ id: string; publicKey: Uint8Array; username: string } | undefined> {
  const rows = await db
    .select({
      id: users.id,
      publicKey: users.publicKey,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  return rows[0];
}

interface ConvEpochInfo {
  conversation: { id: string; currentEpoch: number };
  epoch: { id: string; epochNumber: number };
  memberCount: number;
}

async function loadConvEpoch(
  db: AppEnv['Variables']['db'],
  conversationId: string
): Promise<ConvEpochInfo | undefined> {
  const rows = await db
    .select({
      conversation: { id: conversations.id, currentEpoch: conversations.currentEpoch },
      epoch: { id: epochs.id, epochNumber: epochs.epochNumber },
      memberCount: sql<number>`(
        SELECT count(*)::int FROM conversation_members
        WHERE conversation_id = ${conversationId} AND left_at IS NULL
      )`,
    })
    .from(conversations)
    .innerJoin(
      epochs,
      and(
        eq(epochs.conversationId, conversations.id),
        eq(epochs.epochNumber, conversations.currentEpoch)
      )
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return rows[0];
}

interface RunMemberInsertionInput {
  db: AppEnv['Variables']['db'];
  conversationId: string;
  targetUserId: string;
  targetUserPublicKey: Uint8Array;
  invitingUserId: string;
  privilege: z.infer<typeof memberPrivilegeSchema>;
  visibleFromEpoch: number;
  giveFullHistory: boolean;
  wrap: string | undefined;
  rotation: RotationInput | undefined;
  currentEpochId: string;
}

/**
 * Runs the add-member transaction. Returns null when the user is already an
 * active member (insert hit the unique-on-active constraint), otherwise the
 * inserted member row. Throws ForkTipConflictError / RotationConflictError
 * for the caller to translate.
 */
async function runMemberInsertion(
  input: RunMemberInsertionInput
): Promise<{ id: string; joinedAt: Date } | null> {
  return input.db.transaction(async (tx) => {
    const [memberRow] = await tx
      .insert(conversationMembers)
      .values({
        conversationId: input.conversationId,
        userId: input.targetUserId,
        privilege: input.privilege,
        visibleFromEpoch: input.visibleFromEpoch,
        acceptedAt: null,
        invitedByUserId: input.invitingUserId,
      })
      .onConflictDoNothing({
        target: [conversationMembers.conversationId, conversationMembers.userId],
        where: isNull(conversationMembers.leftAt),
      })
      .returning();
    if (!memberRow) return null;

    if (input.giveFullHistory) {
      if (!input.wrap) throw new Error('invariant: wrap required for full history');
      await tx.insert(epochMembers).values({
        epochId: input.currentEpochId,
        memberPublicKey: input.targetUserPublicKey,
        wrap: fromBase64(input.wrap),
        visibleFromEpoch: input.visibleFromEpoch,
      });
    } else {
      if (!input.rotation) throw new Error('invariant: rotation required without history');
      await submitRotation(
        tx as unknown as Database,
        toRotationParams(input.conversationId, input.rotation)
      );
    }
    return memberRow;
  });
}

interface BroadcastMemberAddedInput {
  conversationId: string;
  newMemberId: string;
  targetUserId: string;
  privilege: z.infer<typeof memberPrivilegeSchema>;
  rotation: RotationInput | undefined;
}

function broadcastMemberAdded(env: Context<AppEnv>['env'], input: BroadcastMemberAddedInput): void {
  broadcastFireAndForget(
    env,
    input.conversationId,
    createEvent('member:added', {
      conversationId: input.conversationId,
      memberId: input.newMemberId,
      userId: input.targetUserId,
      privilege: input.privilege,
    })
  );
  if (input.rotation) {
    broadcastFireAndForget(
      env,
      input.conversationId,
      createEvent('rotation:complete', {
        conversationId: input.conversationId,
        newEpochNumber: input.rotation.expectedEpoch + 1,
      })
    );
  }
}

interface AddMemberRequestBody {
  userId: string;
  wrap?: string | undefined;
  privilege: z.infer<typeof memberPrivilegeSchema>;
  giveFullHistory: boolean;
  rotation?: RotationInput | undefined;
}

interface AddMemberGatesSuccess {
  targetUser: { id: string; publicKey: Uint8Array; username: string };
  convEpoch: ConvEpochInfo;
  visibleFromEpoch: number;
}

interface AddMemberGatesError {
  errorResponse: {
    body: ReturnType<typeof createErrorResponse>;
    status: 400 | 404;
  };
}

async function runAddMemberGates(
  db: AppEnv['Variables']['db'],
  conversationId: string,
  body: AddMemberRequestBody
): Promise<AddMemberGatesSuccess | AddMemberGatesError> {
  const targetUser = await loadTargetUser(db, body.userId);
  if (!targetUser) {
    return { errorResponse: { body: createErrorResponse(ERROR_CODE_NOT_FOUND), status: 404 } };
  }
  const convEpoch = await loadConvEpoch(db, conversationId);
  if (!convEpoch) {
    return {
      errorResponse: {
        body: createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND),
        status: 404,
      },
    };
  }
  if (convEpoch.memberCount >= MAX_CONVERSATION_MEMBERS) {
    return {
      errorResponse: {
        body: createErrorResponse(ERROR_CODE_MEMBER_LIMIT_REACHED),
        status: 400,
      },
    };
  }
  if (!body.giveFullHistory && !body.rotation) {
    return {
      errorResponse: { body: createErrorResponse(ERROR_CODE_VALIDATION), status: 400 },
    };
  }
  const visibleFromEpoch = body.giveFullHistory ? 1 : (body.rotation?.expectedEpoch ?? 0) + 1;
  return { targetUser, convEpoch, visibleFromEpoch };
}

interface PerformAddMemberInput {
  c: Context<AppEnv>;
  db: AppEnv['Variables']['db'];
  user: { id: string };
  conversationId: string;
  requestBody: AddMemberRequestBody;
  targetUser: AddMemberGatesSuccess['targetUser'];
  convEpoch: ConvEpochInfo;
  visibleFromEpoch: number;
}

async function performAddMember(input: PerformAddMemberInput): Promise<Response> {
  const { c, requestBody } = input;
  const newMember = await runMemberInsertion({
    db: input.db,
    conversationId: input.conversationId,
    targetUserId: requestBody.userId,
    targetUserPublicKey: input.targetUser.publicKey,
    invitingUserId: input.user.id,
    privilege: requestBody.privilege,
    visibleFromEpoch: input.visibleFromEpoch,
    giveFullHistory: requestBody.giveFullHistory,
    wrap: requestBody.wrap,
    rotation: requestBody.rotation,
    currentEpochId: input.convEpoch.epoch.id,
  });
  if (!newMember) {
    return c.json(createErrorResponse(ERROR_CODE_ALREADY_MEMBER), 409);
  }
  broadcastMemberAdded(c.env, {
    conversationId: input.conversationId,
    newMemberId: newMember.id,
    targetUserId: requestBody.userId,
    privilege: requestBody.privilege,
    rotation: requestBody.giveFullHistory ? undefined : requestBody.rotation,
  });
  return c.json(
    {
      member: {
        id: newMember.id,
        userId: requestBody.userId,
        username: input.targetUser.username,
        privilege: requestBody.privilege,
        visibleFromEpoch: input.visibleFromEpoch,
        joinedAt: newMember.joinedAt.toISOString(),
      },
    },
    201
  );
}

export const membersRoute = new Hono<AppEnv>()
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const rows = await db
        .select({
          id: conversationMembers.id,
          userId: conversationMembers.userId,
          linkId: conversationMembers.linkId,
          privilege: conversationMembers.privilege,
          visibleFromEpoch: conversationMembers.visibleFromEpoch,
          joinedAt: conversationMembers.joinedAt,
          username: users.username,
          linkDisplayName: sharedLinks.displayName,
        })
        .from(conversationMembers)
        .leftJoin(users, eq(conversationMembers.userId, users.id))
        .leftJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            isNull(conversationMembers.leftAt)
          )
        );

      return c.json(
        {
          members: rows.map((r) => ({
            id: r.id,
            userId: r.userId ?? r.linkId ?? r.id,
            linkId: r.linkId,
            username: r.username ?? r.linkDisplayName ?? 'Unknown',
            privilege: r.privilege,
            visibleFromEpoch: r.visibleFromEpoch,
            joinedAt: r.joinedAt.toISOString(),
          })),
        },
        200
      );
    }
  )
  .post(
    '/:conversationId/add',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z
        .object({
          userId: z.string(),
          privilege: memberPrivilegeSchema,
          giveFullHistory: z.boolean(),
          wrap: z.string().optional(),
          rotation: rotationSchema.optional(),
        })
        .refine((d) => (d.giveFullHistory ? d.wrap !== undefined : d.rotation !== undefined), {
          message: 'wrap required for full history, rotation required without history',
        })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const requestBody = c.req.valid('json');

      const gates = await runAddMemberGates(db, conversationId, requestBody);
      if ('errorResponse' in gates)
        return c.json(gates.errorResponse.body, gates.errorResponse.status);

      try {
        return await performAddMember({
          c,
          db,
          user,
          conversationId,
          requestBody,
          targetUser: gates.targetUser,
          convEpoch: gates.convEpoch,
          visibleFromEpoch: gates.visibleFromEpoch,
        });
      } catch (error) {
        return handleRotationError(error, c);
      }
    }
  )
  .post(
    '/:conversationId/remove',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z.object({
        memberId: z.string(),
        rotation: rotationSchema,
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { memberId, rotation } = c.req.valid('json');
      const requesterMember = c.get('members').get(conversationId);
      if (!requesterMember) throw new Error('Member required after requirePrivilege');

      const targetMember = await findActiveMember(db, memberId, conversationId);

      if (!targetMember) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_NOT_FOUND), 404);
      }

      if (targetMember.userId === user.id) {
        return c.json(createErrorResponse(ERROR_CODE_CANNOT_REMOVE_SELF), 400);
      }

      if (isOwner(targetMember.privilege)) {
        return c.json(createErrorResponse(ERROR_CODE_CANNOT_REMOVE_OWNER), 403);
      }

      if (!canRemoveMember(requesterMember.privilege, targetMember.privilege)) {
        return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
      }

      try {
        await db.transaction(async (tx) => {
          await tx
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(eq(conversationMembers.id, memberId));

          await submitRotation(
            tx as unknown as Database,
            toRotationParams(conversationId, rotation)
          );
        });
      } catch (error) {
        return handleRotationError(error, c);
      }

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('member:removed', {
          conversationId,
          memberId,
          ...(targetMember.userId != null && { userId: targetMember.userId }),
        })
      );

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('rotation:complete', {
          conversationId,
          newEpochNumber: rotation.expectedEpoch + 1,
        })
      );

      return c.json({ removed: true }, 200);
    }
  )
  .patch(
    '/:conversationId/privilege',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z.object({
        memberId: z.string(),
        privilege: memberPrivilegeSchema,
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { memberId, privilege: newPrivilege } = c.req.valid('json');
      const requesterMember = c.get('members').get(conversationId);
      if (!requesterMember) throw new Error('Member required after requirePrivilege');

      const targetMember = await findActiveMember(db, memberId, conversationId);

      if (!targetMember) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_NOT_FOUND), 404);
      }

      if (targetMember.userId === user.id) {
        return c.json(createErrorResponse(ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE), 403);
      }

      if (!canChangePrivilege(requesterMember.privilege, targetMember.privilege, newPrivilege)) {
        return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
      }

      await db
        .update(conversationMembers)
        .set({ privilege: newPrivilege })
        .where(eq(conversationMembers.id, memberId));

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('member:privilege-changed', {
          conversationId,
          memberId,
          privilege: newPrivilege,
        })
      );

      return c.json(
        {
          updated: true,
          memberId,
          privilege: newPrivilege,
        },
        200
      );
    }
  )
  .post(
    '/:conversationId/leave',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    zValidator(
      'json',
      z.object({
        rotation: rotationSchema.optional(),
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { rotation } = c.req.valid('json');
      const requesterMember = c.get('members').get(conversationId);
      if (!requesterMember) throw new Error('Member required after requirePrivilege');

      // Owner leaving deletes the entire conversation (CASCADE handles cleanup)
      if (isOwner(requesterMember.privilege)) {
        await db.delete(conversations).where(eq(conversations.id, conversationId));
        return c.json({ deleted: true }, 200);
      }

      // Non-owner: rotation is always required (owner always remains)
      if (!rotation) {
        return c.json(createErrorResponse(ERROR_CODE_ROTATION_REQUIRED), 400);
      }

      try {
        await db.transaction(async (tx) => {
          await tx
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(eq(conversationMembers.id, requesterMember.id));

          await submitRotation(
            tx as unknown as Database,
            toRotationParams(conversationId, rotation)
          );
        });
      } catch (error) {
        return handleRotationError(error, c);
      }

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('member:removed', {
          conversationId,
          memberId: requesterMember.id,
          userId: user.id,
        })
      );

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('rotation:complete', {
          conversationId,
          newEpochNumber: rotation.expectedEpoch + 1,
        })
      );

      return c.json({ left: true }, 200);
    }
  )
  .patch(
    '/:conversationId/mute',
    zValidator('param', z.object({ conversationId: z.string() })),
    zValidator('json', z.object({ muted: z.boolean() })),
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { muted } = c.req.valid('json');

      await db
        .update(conversationMembers)
        .set({ muted })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        );

      return c.json({ muted }, 200);
    }
  )
  .patch(
    '/:conversationId/pin',
    zValidator('param', z.object({ conversationId: z.string() })),
    zValidator('json', z.object({ pinned: z.boolean() })),
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { pinned } = c.req.valid('json');

      await db
        .update(conversationMembers)
        .set({ pinned })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        );

      return c.json({ pinned }, 200);
    }
  )
  .post(
    '/:conversationId/decline',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const requesterMember = c.get('members').get(conversationId);
      if (!requesterMember) throw new Error('Member required after requirePrivilege');

      // Decline is for pending invites only — accepted members must `/leave`
      // (which requires rotation). One atomic UPDATE expresses the contract:
      //   * `eq(id, requesterMember.id)` — only the caller's membership row.
      //     The id comes from the middleware's session-scoped lookup, so no
      //     other user's row is reachable.
      //   * `isNull(acceptedAt)` — pending state only.
      //   * `isNull(leftAt)` — belt-and-suspenders; requirePrivilege already
      //     enforces this, but stating it in the WHERE keeps the contract
      //     legible at the call site and makes the SQL re-runnable in
      //     isolation. A replay attempt sees leftAt already set and matches
      //     zero rows, so the operation is idempotent.
      const result = await db
        .update(conversationMembers)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(conversationMembers.id, requesterMember.id),
            isNull(conversationMembers.acceptedAt),
            isNull(conversationMembers.leftAt)
          )
        )
        .returning({ id: conversationMembers.id });

      if (result.length === 0) {
        // Caller is an accepted member (acceptedAt set). They should use /leave
        // with a rotation, not /decline.
        return c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400);
      }

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('member:removed', {
          conversationId,
          memberId: requesterMember.id,
          userId: user.id,
        })
      );

      return c.json({ declined: true }, 200);
    }
  )
  .patch(
    '/:conversationId/accept',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      // Atomic conditional update — idempotent: already accepted → still returns 200
      await db
        .update(conversationMembers)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        )
        .returning({ id: conversationMembers.id });

      return c.json({ accepted: true }, 200);
    }
  );
