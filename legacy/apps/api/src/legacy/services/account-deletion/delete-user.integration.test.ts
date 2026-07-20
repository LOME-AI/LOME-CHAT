import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { asc, eq, gte, inArray } from 'drizzle-orm';
import {
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  deviceTokens,
  epochs,
  LOCAL_NEON_DEV_CONFIG,
  messages,
  payments,
  projects,
  usageRecords,
  users,
  wallets,
  type Database,
} from '@hushbox/db';
import {
  conversationFactory,
  conversationMemberFactory,
  epochFactory,
  messageFactory,
  paymentFactory,
  projectFactory,
  usageRecordFactory,
  userFactory,
  walletFactory,
  contentItemFactory,
  imageContentItemFactory,
} from '@hushbox/db/factories';
import { createMediaStorage } from '../storage/media-storage.js';
import { createMockEmailClient } from '../email/index.js';
import { deleteUser } from './delete-user.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const R2_S3_ENDPOINT = process.env['R2_S3_ENDPOINT'];
const R2_ACCESS_KEY_ID = process.env['R2_ACCESS_KEY_ID'];
const R2_SECRET_ACCESS_KEY = process.env['R2_SECRET_ACCESS_KEY'];
const R2_BUCKET_MEDIA = process.env['R2_BUCKET_MEDIA'];

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for delete-user integration tests — run pnpm ensure-stack from the repo root'
  );
}
if (!R2_S3_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_MEDIA) {
  throw new Error(
    'R2 env vars (R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_MEDIA) are required for delete-user integration tests — run pnpm ensure-stack from the repo root'
  );
}

const STORAGE_ENV = {
  R2_S3_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_MEDIA,
} as const;

interface SeedHandle {
  user: typeof users.$inferSelect;
  otherUser: typeof users.$inferSelect;
  ownedConversationIds: string[];
  nonOwnedConversationId: string;
  nonOwnedSenderMessageIds: string[];
  storageKeys: string[];
  walletId: string;
  paymentId: string;
  usageRecordId: string;
  projectId: string;
  deviceTokenId: string;
}

async function uploadEncryptedBytes(
  storage: ReturnType<typeof createMediaStorage>,
  key: string
): Promise<void> {
  await storage.put(key, new Uint8Array([1, 2, 3, 4, 5]), 'application/octet-stream');
}

function uniqueStorageKey(prefix: string): string {
  return `${prefix}/${crypto.randomUUID()}/${crypto.randomUUID()}.enc`;
}

async function insertReturning<T>(promise: Promise<T[]>, label: string): Promise<T> {
  const [row] = await promise;
  if (!row) throw new Error(`${label} insert failed`);
  return row;
}

async function seedOwnedConversation(
  db: Database,
  storage: ReturnType<typeof createMediaStorage>,
  userId: string
): Promise<{ conversationId: string; storageKey: string }> {
  const conv = await insertReturning(
    db.insert(conversations).values(conversationFactory.build({ userId })).returning(),
    'owned conversation'
  );
  await insertReturning(
    db
      .insert(epochs)
      .values(epochFactory.build({ conversationId: conv.id, epochNumber: 1 }))
      .returning(),
    'owned epoch'
  );
  const msg = await insertReturning(
    db
      .insert(messages)
      .values(
        messageFactory.build({
          conversationId: conv.id,
          senderType: 'user',
          senderId: userId,
          sequenceNumber: 1,
          epochNumber: 1,
        })
      )
      .returning(),
    'owned message'
  );
  await db
    .insert(contentItems)
    .values(contentItemFactory.build({ messageId: msg.id, contentType: 'text' }));
  const storageKey = uniqueStorageKey(`media/${conv.id}/${msg.id}`);
  await uploadEncryptedBytes(storage, storageKey);
  await db
    .insert(contentItems)
    .values(imageContentItemFactory.build({ messageId: msg.id, position: 1, storageKey }));
  return { conversationId: conv.id, storageKey };
}

async function seedNonOwnedMembership(
  db: Database,
  conversationId: string,
  userId: string
): Promise<string[]> {
  await db.insert(conversationMembers).values(
    conversationMemberFactory.build({
      conversationId,
      userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      leftAt: null,
    })
  );
  const ids: string[] = [];
  for (let sequenceNumber = 1; sequenceNumber <= 2; sequenceNumber++) {
    const m = await insertReturning(
      db
        .insert(messages)
        .values(
          messageFactory.build({
            conversationId,
            senderType: 'user',
            senderId: userId,
            sequenceNumber,
            epochNumber: 1,
          })
        )
        .returning(),
      'non-owned message'
    );
    ids.push(m.id);
  }
  return ids;
}

async function seedDeletableUser(
  db: Database,
  storage: ReturnType<typeof createMediaStorage>
): Promise<SeedHandle> {
  const user = await insertReturning(
    db.insert(users).values(userFactory.build()).returning(),
    'user'
  );
  const otherUser = await insertReturning(
    db.insert(users).values(userFactory.build()).returning(),
    'other user'
  );

  const ownedConversationIds: string[] = [];
  const storageKeys: string[] = [];
  for (let convIndex = 0; convIndex < 2; convIndex++) {
    const { conversationId, storageKey } = await seedOwnedConversation(db, storage, user.id);
    ownedConversationIds.push(conversationId);
    storageKeys.push(storageKey);
  }

  const nonOwnedConv = await insertReturning(
    db
      .insert(conversations)
      .values(conversationFactory.build({ userId: otherUser.id }))
      .returning(),
    'non-owned conversation'
  );
  await insertReturning(
    db
      .insert(epochs)
      .values(epochFactory.build({ conversationId: nonOwnedConv.id, epochNumber: 1 }))
      .returning(),
    'non-owned epoch'
  );
  const nonOwnedSenderMessageIds = await seedNonOwnedMembership(db, nonOwnedConv.id, user.id);

  const wallet = await insertReturning(
    db
      .insert(wallets)
      .values(
        walletFactory.build({
          userId: user.id,
          type: 'purchased',
          balance: '12.34567890',
          priority: 0,
        })
      )
      .returning(),
    'wallet'
  );
  const payment = await insertReturning(
    db
      .insert(payments)
      .values(paymentFactory.build({ userId: user.id, status: 'completed' }))
      .returning(),
    'payment'
  );
  const usage = await insertReturning(
    db
      .insert(usageRecords)
      .values(usageRecordFactory.build({ userId: user.id }))
      .returning(),
    'usage'
  );
  const project = await insertReturning(
    db
      .insert(projects)
      .values(projectFactory.build({ userId: user.id }))
      .returning(),
    'project'
  );
  const deviceToken = await insertReturning(
    db
      .insert(deviceTokens)
      .values({ userId: user.id, token: `token-${crypto.randomUUID()}`, platform: 'ios' as const })
      .returning(),
    'device token'
  );

  return {
    user,
    otherUser,
    ownedConversationIds,
    nonOwnedConversationId: nonOwnedConv.id,
    nonOwnedSenderMessageIds,
    storageKeys,
    walletId: wallet.id,
    paymentId: payment.id,
    usageRecordId: usage.id,
    projectId: project.id,
    deviceTokenId: deviceToken.id,
  };
}

async function assertTombstoneRow(
  db: Database,
  conversationId: string,
  testStart: Date
): Promise<void> {
  const rows = await db
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  expect(rows).toHaveLength(1);
  const tombstone = rows[0];
  if (!tombstone) throw new Error('tombstone row missing');
  expect(tombstone.userId).toBeNull();
  expect(tombstone.linkId).toBeNull();
  expect(tombstone.conversationId).toBe(conversationId);
  expect(tombstone.leftAt).toBeInstanceOf(Date);
  const leftAtMs = tombstone.leftAt?.getTime() ?? 0;
  expect(leftAtMs).toBeGreaterThanOrEqual(testStart.getTime());
  expect(leftAtMs).toBeLessThanOrEqual(Date.now() + 1000);
}

async function cleanupTestUsers(
  db: Database,
  storage: ReturnType<typeof createMediaStorage>,
  handles: SeedHandle[]
): Promise<void> {
  for (const handle of handles) {
    for (const key of handle.storageKeys) {
      try {
        await storage.delete(key);
      } catch {
        // best effort
      }
    }
    // Saga nulls these tables' userId via FK; delete by primary key so the
    // CI database doesn't accumulate orphans across runs.
    await db.delete(payments).where(eq(payments.id, handle.paymentId));
    await db.delete(wallets).where(eq(wallets.id, handle.walletId));
    await db.delete(usageRecords).where(eq(usageRecords.id, handle.usageRecordId));
    await db.delete(conversations).where(eq(conversations.userId, handle.user.id));
    await db.delete(conversations).where(eq(conversations.userId, handle.otherUser.id));
    await db.delete(users).where(eq(users.id, handle.user.id));
    await db.delete(users).where(eq(users.id, handle.otherUser.id));
  }
}

describe('deleteUser integration (real Postgres + MinIO)', () => {
  let db: Database;
  let storage: ReturnType<typeof createMediaStorage>;
  const handles: SeedHandle[] = [];
  let testStart: Date = new Date(0);

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    storage = createMediaStorage(STORAGE_ENV);
  });

  afterEach(async () => {
    await cleanupTestUsers(db, storage, handles);
    handles.length = 0;
    await db.delete(accountDeletionEvents).where(gte(accountDeletionEvents.deletedAt, testStart));
  });

  it('cascades owned conversations, projects, device tokens; nulls financials; logs event; deletes R2 objects; sends email', async () => {
    testStart = new Date(Date.now() - 1000);
    const handle = await seedDeletableUser(db, storage);
    handles.push(handle);

    const mockEmail = createMockEmailClient();
    const now = new Date();

    const result = await deleteUser({
      db,
      storage,
      email: mockEmail,
      userId: handle.user.id,
      ipAddress: '198.51.100.7',
      userAgent: 'integration-test-agent/1.0',
      now,
    });

    expect(result).toEqual({ ok: true });

    const remainingUser = await db.select().from(users).where(eq(users.id, handle.user.id));
    expect(remainingUser).toHaveLength(0);

    const remainingConvs = await db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, handle.ownedConversationIds));
    expect(remainingConvs).toHaveLength(0);

    const remainingProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.id, handle.projectId));
    expect(remainingProjects).toHaveLength(0);

    const remainingDevice = await db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.id, handle.deviceTokenId));
    expect(remainingDevice).toHaveLength(0);

    const [walletRow] = await db.select().from(wallets).where(eq(wallets.id, handle.walletId));
    expect(walletRow).toBeDefined();
    expect(walletRow?.userId).toBeNull();

    const [paymentRow] = await db.select().from(payments).where(eq(payments.id, handle.paymentId));
    expect(paymentRow).toBeDefined();
    expect(paymentRow?.userId).toBeNull();

    const [usageRow] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, handle.usageRecordId));
    expect(usageRow).toBeDefined();
    expect(usageRow?.userId).toBeNull();

    await assertTombstoneRow(db, handle.nonOwnedConversationId, testStart);

    const nonOwnedMessages = await db
      .select()
      .from(messages)
      .where(inArray(messages.id, handle.nonOwnedSenderMessageIds))
      .orderBy(asc(messages.sequenceNumber));
    expect(nonOwnedMessages).toHaveLength(2);
    for (const msg of nonOwnedMessages) {
      expect(msg.senderId).toBeNull();
    }

    for (const key of handle.storageKeys) {
      const url = await storage.mintDownloadUrl({ key });
      const response = await fetch(url.url);
      expect(response.status).toBe(404);
    }

    const events = await db
      .select()
      .from(accountDeletionEvents)
      .where(gte(accountDeletionEvents.deletedAt, testStart));
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.ipAddress).toBe('198.51.100.7');
    expect(event?.userAgent).toBe('integration-test-agent/1.0');
    expect(event?.deletedAt.getTime()).toBeGreaterThanOrEqual(testStart.getTime());

    const sent = mockEmail.getSentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(handle.user.email);
  });

  it('returns user-not-found on a second run and does not insert another event or call R2/email', async () => {
    testStart = new Date(Date.now() - 1000);
    const handle = await seedDeletableUser(db, storage);
    handles.push(handle);

    const first = await deleteUser({
      db,
      storage,
      email: createMockEmailClient(),
      userId: handle.user.id,
      ipAddress: null,
      userAgent: null,
      now: new Date(),
    });
    expect(first).toEqual({ ok: true });

    const eventsAfterFirst = await db
      .select()
      .from(accountDeletionEvents)
      .where(gte(accountDeletionEvents.deletedAt, testStart));
    expect(eventsAfterFirst).toHaveLength(1);

    const secondEmail = createMockEmailClient();
    const second = await deleteUser({
      db,
      storage,
      email: secondEmail,
      userId: handle.user.id,
      ipAddress: null,
      userAgent: null,
      now: new Date(),
    });
    expect(second).toEqual({ ok: false, reason: 'user-not-found' });
    expect(secondEmail.getSentEmails()).toHaveLength(0);

    const eventsAfterSecond = await db
      .select()
      .from(accountDeletionEvents)
      .where(gte(accountDeletionEvents.deletedAt, testStart));
    expect(eventsAfterSecond).toHaveLength(1);
  });

  it('serializes concurrent saga runs so exactly one succeeds; the other reports user-not-found', async () => {
    testStart = new Date(Date.now() - 1000);
    const handle = await seedDeletableUser(db, storage);
    handles.push(handle);

    const emailA = createMockEmailClient();
    const emailB = createMockEmailClient();
    const now = new Date();

    const settled = await Promise.allSettled([
      deleteUser({
        db,
        storage,
        email: emailA,
        userId: handle.user.id,
        ipAddress: null,
        userAgent: null,
        now,
      }),
      deleteUser({
        db,
        storage,
        email: emailB,
        userId: handle.user.id,
        ipAddress: null,
        userAgent: null,
        now,
      }),
    ]);

    const okCount = settled.filter((s) => s.status === 'fulfilled' && s.value.ok).length;
    const notFoundCount = settled.filter((s) => s.status === 'fulfilled' && !s.value.ok).length;
    expect(okCount).toBe(1);
    expect(notFoundCount).toBe(1);

    const events = await db
      .select()
      .from(accountDeletionEvents)
      .where(gte(accountDeletionEvents.deletedAt, testStart));
    expect(events).toHaveLength(1);

    const totalSent = emailA.getSentEmails().length + emailB.getSentEmails().length;
    expect(totalSent).toBe(1);
  });

  // Two separate Database instances (separate pools/connections) so the
  // serialization comes from Postgres's row lock, not from a single-slot pool
  // queuing the second saga behind the first.
  it('FOR UPDATE serializes parallel sagas across distinct DB connections', async () => {
    testStart = new Date(Date.now() - 1000);
    const handle = await seedDeletableUser(db, storage);
    handles.push(handle);

    const dbA = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    const dbB = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    const emailA = createMockEmailClient();
    const emailB = createMockEmailClient();
    const now = new Date();

    const settled = await Promise.allSettled([
      deleteUser({
        db: dbA,
        storage,
        email: emailA,
        userId: handle.user.id,
        ipAddress: null,
        userAgent: null,
        now,
      }),
      deleteUser({
        db: dbB,
        storage,
        email: emailB,
        userId: handle.user.id,
        ipAddress: null,
        userAgent: null,
        now,
      }),
    ]);

    const okCount = settled.filter((s) => s.status === 'fulfilled' && s.value.ok).length;
    const notFoundCount = settled.filter((s) => s.status === 'fulfilled' && !s.value.ok).length;
    expect(okCount).toBe(1);
    expect(notFoundCount).toBe(1);

    const events = await db
      .select()
      .from(accountDeletionEvents)
      .where(gte(accountDeletionEvents.deletedAt, testStart));
    expect(events).toHaveLength(1);
  });
});
