import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  accountDeletionEvents,
  conversationMembers,
  conversations,
  contentItems,
  messages,
  users,
  type Database,
} from '@hushbox/db';

import { accountDeletedEmail } from '../email/templates/index.js';

import type { EmailClient } from '../email/index.js';
import type { MediaStorage } from '../storage/index.js';

export interface DeleteUserArgs {
  db: Database;
  storage: MediaStorage;
  email: EmailClient;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  now: Date;
  /** Hard cap on R2 deletes per invocation; remainder is left to runR2Gc. */
  maxR2Deletes?: number;
}

export type DeleteUserResult = { ok: true } | { ok: false; reason: 'user-not-found' };

interface SagaCapture {
  email: string | null;
  storageKeys: string[];
}

// Matches r2-gc.ts: fans deletes out in parallel while staying under the
// Cloudflare Workers concurrent-fetch ceiling.
const R2_DELETE_BATCH_SIZE = 50;

// Worst-case ceiling on R2 subrequests in one /delete-account/finish invocation.
// The Workers paid plan caps subrequests at 1000; we leave headroom for the
// DB transaction, email send, and saga overhead. Anything above this gets
// picked up by the daily runR2Gc orphan sweep.
const DEFAULT_MAX_R2_DELETES = 900;

// Ordering invariants enforced inside the transaction:
//   1. Capture user.email + content_items.storageKey BEFORE the cascade nukes them.
//   2. Set conversation_members.leftAt BEFORE deleting users so the FK cascade
//      to userId=null satisfies the `userId OR linkId OR leftAt` check constraint.
//   3. Null messages.senderId for non-owned conversations BEFORE deleting users
//      so no row violates downstream invariants after the user vanishes.
async function runSaga(
  args: DeleteUserArgs
): Promise<{ found: true; capture: SagaCapture } | { found: false }> {
  return args.db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, args.userId))
      .for('update');

    if (!user) {
      return { found: false } as const;
    }

    const storageRows = await tx
      .selectDistinct({ key: contentItems.storageKey })
      .from(contentItems)
      .innerJoin(messages, eq(contentItems.messageId, messages.id))
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.userId, args.userId), isNotNull(contentItems.storageKey)));

    const storageKeys = storageRows
      .map((row) => row.key)
      .filter((key): key is string => key !== null);

    await tx
      .update(conversationMembers)
      .set({ leftAt: args.now })
      .where(and(eq(conversationMembers.userId, args.userId), isNull(conversationMembers.leftAt)));

    await tx
      .update(messages)
      .set({ senderId: null })
      .where(
        and(
          eq(messages.senderId, args.userId),
          inArray(
            messages.conversationId,
            sql`(SELECT ${conversations.id} FROM ${conversations} WHERE ${ne(conversations.userId, args.userId)})`
          )
        )
      );

    await tx.insert(accountDeletionEvents).values({
      deletedAt: args.now,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    });

    await tx.delete(users).where(eq(users.id, args.userId));

    return {
      found: true as const,
      capture: { email: user.email, storageKeys },
    };
  });
}

async function deleteStorageObjects(
  storage: MediaStorage,
  keys: string[],
  maxDeletes: number
): Promise<void> {
  const target = keys.slice(0, maxDeletes);
  for (let index = 0; index < target.length; index += R2_DELETE_BATCH_SIZE) {
    const chunk = target.slice(index, index + R2_DELETE_BATCH_SIZE);
    const results = await Promise.allSettled(chunk.map((key) => storage.delete(key)));
    for (const [chunkIndex, result] of results.entries()) {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason;
        console.warn('delete-user storage delete failed', {
          key: chunk[chunkIndex],
          error: reason,
        });
      }
    }
  }
  if (keys.length > maxDeletes) {
    // Remaining orphans are picked up by the daily runR2Gc sweep.
    console.warn('delete-user R2 delete cap reached; remainder deferred to GC', {
      total: keys.length,
      deleted: target.length,
      deferred: keys.length - target.length,
    });
  }
}

async function sendDeletionEmail(email: EmailClient, recipient: string | null): Promise<void> {
  if (recipient === null || recipient.length === 0) return;
  try {
    const content = accountDeletedEmail({});
    await email.sendEmail({
      to: recipient,
      subject: 'Your HushBox account has been deleted',
      html: content.html,
      text: content.text,
    });
  } catch (error) {
    console.warn('delete-user notification email failed', { error });
  }
}

export async function deleteUser(args: DeleteUserArgs): Promise<DeleteUserResult> {
  const sagaResult = await runSaga(args);
  if (!sagaResult.found) {
    return { ok: false, reason: 'user-not-found' };
  }

  // Email first: the R2 loop can exhaust the Workers subrequest budget, so
  // sending the notification first guarantees the user is told the account is
  // gone even if cleanup later trips the cap (the GC sweep handles the tail).
  await sendDeletionEmail(args.email, sagaResult.capture.email);
  await deleteStorageObjects(
    args.storage,
    sagaResult.capture.storageKeys,
    args.maxR2Deletes ?? DEFAULT_MAX_R2_DELETES
  );

  return { ok: true };
}
