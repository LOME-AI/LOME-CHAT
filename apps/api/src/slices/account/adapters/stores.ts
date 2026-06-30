import { and, asc, eq, ilike, isNull, lte, ne } from 'drizzle-orm';
import { conversationMembers, customInstructions, preferences, users } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { AccountStores } from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('account store query failed', cause);
}

/**
 * Drizzle implementation of the account stores. Single-writer: this slice
 * owns `custom_instructions` and `preferences`; `users` and
 * `conversation_members` are read-only here.
 */
export function createAccountStores(db: Database): AccountStores {
  return {
    users: {
      isActiveMember: ({ conversationId, userId }) =>
        fromPromise(
          db
            .select({ id: conversationMembers.id })
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.userId, userId),
                isNull(conversationMembers.leftAt)
              )
            )
            .limit(1),
          storeFailure
        ).map((rows) => rows.length > 0),
      searchInvitable: ({ usernamePattern, excludeUserId, conversationId, limit }) =>
        fromPromise(
          db
            .select({ id: users.id, username: users.username, publicKey: users.publicKey })
            .from(users)
            .leftJoin(
              conversationMembers,
              and(
                eq(conversationMembers.userId, users.id),
                eq(conversationMembers.conversationId, conversationId),
                isNull(conversationMembers.leftAt)
              )
            )
            .where(
              and(
                ilike(users.username, usernamePattern),
                ne(users.id, excludeUserId),
                isNull(conversationMembers.id)
              )
            )
            .orderBy(asc(users.username))
            .limit(limit),
          storeFailure
        ),
    },
    instructions: {
      read: (userId) =>
        fromPromise(
          db
            .select({ encryptedInstructions: customInstructions.encryptedInstructions })
            .from(customInstructions)
            .where(eq(customInstructions.userId, userId)),
          storeFailure
        ).map((rows) => rows[0]?.encryptedInstructions ?? null),
      upsert: (userId, encryptedInstructions) =>
        fromPromise(
          db
            .insert(customInstructions)
            .values({ userId, encryptedInstructions })
            .onConflictDoUpdate({
              target: customInstructions.userId,
              set: { encryptedInstructions, updatedAt: new Date() },
            }),
          storeFailure
        ).map(() => null),
      remove: (userId) =>
        fromPromise(
          db
            .delete(customInstructions)
            .where(eq(customInstructions.userId, userId))
            .returning({ id: customInstructions.id }),
          storeFailure
        ).map((rows) => (rows.length > 0 ? { removed: true as const } : null)),
    },
    preferences: {
      read: (userId) =>
        fromPromise(
          db
            .select({ accessibility: preferences.accessibility, updatedAt: preferences.updatedAt })
            .from(preferences)
            .where(eq(preferences.userId, userId)),
          storeFailure
        ).map((rows) => rows[0] ?? null),
      upsertIfNewer: (userId, accessibility, updatedAt) =>
        fromPromise(
          db
            .insert(preferences)
            .values({ userId, accessibility, updatedAt })
            .onConflictDoUpdate({
              target: preferences.userId,
              set: { accessibility, updatedAt },
              // The LWW guard: `<=` lets an equal timestamp win, so replaying
              // the same write converges instead of flapping to rejected.
              setWhere: lte(preferences.updatedAt, updatedAt),
            })
            .returning({
              accessibility: preferences.accessibility,
              updatedAt: preferences.updatedAt,
            }),
          storeFailure
        ).map((rows) => rows[0] ?? null),
    },
  };
}
