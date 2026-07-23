import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  conversations,
  epochs,
  jobs,
  messages,
  users,
} from '@hushbox/db';
import {
  createOpaqueClient,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
} from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../media/index.js';
import {
  PREFIX,
  createApp,
  db,
  deletionPurge,
  enrollTotp,
  evictedUserIds,
  get,
  manifestDeps,
  post,
  redis,
  registerLoginFull,
  sentAccountDeleted,
  stepUpKe3,
} from './routes.integration.setup.js';
import type { ExecutionContext } from 'hono';

// This file seeds `conversations` (a cross-slice table) via `seedOwnedMedia`, so
// it reclaims them itself: a PREFIX-scoped delete whose cascade clears the
// membership rows the shared `users` delete would otherwise trip over. Registered
// here (not in the shared setup) it runs BEFORE the setup module's afterAll
// (vitest runs afterAll LIFO), and keeps the cross-slice write inside a
// `*.test.ts` file, which the single-writer-per-table arch rule exempts.
afterAll(async () => {
  const prefixPattern = `${PREFIX}%`;
  await db
    .delete(conversations)
    .where(
      sql`${conversations.userId} IN (SELECT ${users.id} FROM ${users} WHERE ${users.username} LIKE ${prefixPattern})`
    );
});

describe('identity routes: account-deletion request', () => {
  async function deleteInit(
    cookie: string,
    password: string
  ): Promise<{ ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> }> {
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, password);
    const res = await post('/auth/account/delete/init', { ke1 }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json<{ ke2: number[]; deleteAccountSessionId: string }>();
    return { ke2: body.ke2, sessionId: body.deleteAccountSessionId, client };
  }

  async function deleteFinish(
    cookie: string,
    init: { ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> },
    extra: { ke3?: number[]; confirmationPhrase?: string; totpCode?: string } = {}
  ): Promise<Response> {
    const ke3 = extra.ke3 ?? (await stepUpKe3(init.ke2, init.client));
    return post(
      '/auth/account/delete/finish',
      {
        ke3,
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: extra.confirmationPhrase ?? DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        ...(extra.totpCode !== undefined && { totpCode: extra.totpCode }),
      },
      cookie
    );
  }

  /** Seeds an owned conversation carrying one media content item. */
  async function seedOwnedMedia(userId: string): Promise<{ storageKey: string }> {
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title: new Uint8Array([1]) })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation seed failed');
    await db.insert(epochs).values({
      conversationId: conversation.id,
      epochNumber: 1,
      epochPublicKey: new Uint8Array([1]),
      confirmationHash: new Uint8Array([1]),
    });
    await db
      .insert(conversationMembers)
      .values({ conversationId: conversation.id, userId, visibleFromEpoch: 1 });
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: userId,
        wrappedContentKey: new Uint8Array([1]),
        epochNumber: 1,
        sequenceNumber: 1,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('message seed failed');
    const storageKey = `media/${conversation.id}/${message.id}/${crypto.randomUUID()}`;
    await db.insert(contentItems).values({
      messageId: message.id,
      contentType: 'image',
      storageKey,
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    return { storageKey };
  }

  async function reclaimJobsFor(userId: string): Promise<{ shard: string; payload: unknown }[]> {
    return db
      .select({ shard: jobs.shard, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
  }

  it('hard-deletes the account after a verified step-up: rows gone, media reclaimed, session dead', async () => {
    const { account, cookie } = await registerLoginFull();
    const { storageKey } = await seedOwnedMedia(account.userId);
    const userAgent = `${PREFIX}-delete-agent-${crypto.randomUUID()}`;
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);

    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3,
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { headers: { 'user-agent': userAgent, 'cf-connecting-ip': '198.51.100.4' } }
    );
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The users row is gone; the deletion executed synchronously.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    // The anonymous forensic event recorded the request fingerprint only.
    const events = await db
      .select({ ipAddress: accountDeletionEvents.ipAddress })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, userAgent));
    expect(events).toEqual([{ ipAddress: '198.51.100.4' }]);
    // The bulk-shard reclaim job carries exactly the owned storage keys.
    const jobRows = await reclaimJobsFor(account.userId);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.shard).toBe('bulk');
    expect((jobRows[0]?.payload as { storageKeys: string[] }).storageKeys).toEqual([storageKey]);
    // Post-commit tail: eviction fan-out + confirmation to the captured email.
    expect(evictedUserIds).toContain(account.userId);
    expect(sentAccountDeleted).toContainEqual({ to: account.email });
    // Prompt cleanup: a committed pending bulk row must not linger where a
    // concurrent jobs-suite bulk pass could claim it.
    await db
      .delete(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.userId}`
        )
      );
    // The old cookie is dead (pw-changed watermark stales it) — repeat-finish
    // cannot even reach the flow again.
    const repeat = await post('/auth/account/delete/init', { ke1: [1, 2, 3] }, cookie);
    expect(repeat.status).toBe(401);
  });

  it('does not freeze deletion for a day after a short fumble under the guessing cap', async () => {
    const { account, cookie } = await registerLoginFull();
    const { maxAttempts } = IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts - 1; attempt += 1) {
      const init = await deleteInit(cookie, account.password);
      const bad = await post(
        '/auth/account/delete/finish',
        {
          ke3: [0, 1, 2],
          deleteAccountSessionId: init.sessionId,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      );
      expect(bad.status).toBe(401);
    }
    // No hard lock has engaged, so a correct step-up still deletes the account.
    expect(
      await redis.get(IDENTITY_KEYS.deleteAccountHardLock.buildKey(account.userId))
    ).toBeNull();
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
  });

  it('enqueues no reclaim job for an account that stored no media', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    expect(await reclaimJobsFor(account.userId)).toHaveLength(0);
  });

  it('rolls the whole deletion back when a step inside the transaction fails', async () => {
    const { account, cookie } = await registerLoginFull();
    const userAgent = `${PREFIX}-rollback-agent-${crypto.randomUUID()}`;
    const failingApp = createApp({
      ...manifestDeps,
      deletionPurge: () => ({
        ...deletionPurge,
        detachMessageSendersWithinTx: () => {
          throw new Error('injected failure before the users delete');
        },
      }),
    });
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { app: failingApp, headers: { 'user-agent': userAgent } }
    );
    expect(finish.status).toBe(503);

    // Atomicity: the account survives untouched — no event, no job, live session.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(1);
    expect(
      await db
        .select({ id: accountDeletionEvents.id })
        .from(accountDeletionEvents)
        .where(eq(accountDeletionEvents.userAgent, userAgent))
    ).toHaveLength(0);
    expect(await reclaimJobsFor(account.userId)).toHaveLength(0);
    const stillAlive = await get('/t/session', cookie);
    expect(stillAlive.status).toBe(200);
  });

  it('nudges the bulk dispatcher via waitUntil after the deletion commits', async () => {
    const { account, cookie } = await registerLoginFull();
    const wakes: string[] = [];
    const waited: Promise<unknown>[] = [];
    const wakingApp = createApp({
      ...manifestDeps,
      wakeReclaimDispatcher: () => {
        wakes.push(account.userId);
      },
    });
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
      passThroughOnException: () => {},
    } as ExecutionContext;
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { app: wakingApp, executionCtx }
    );
    expect(finish.status).toBe(200);
    await Promise.all(waited);
    expect(wakes).toEqual([account.userId]);
  });

  it('treats a vanished user after a verified step-up as a defect (500)', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await deleteFinish(cookie, init, { ke3 });
    expect(res.status).toBe(500);
  });

  it('hard-deletes the account after a verified step-up and valid TOTP code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
  });

  it('treats a 2FA-enabled account with no configured secret as a defect (500) at deletion', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    await db.update(users).set({ totpSecretEncrypted: null }).where(eq(users.id, account.userId));
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(500);
  });
});
