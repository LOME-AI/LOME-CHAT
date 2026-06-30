import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './legacy_client';
import { users } from './schema/index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

function testBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = index % 256;
  }
  return bytes;
}

describe('createDb integration', () => {
  let db: Database;
  const testEmail = `test-${String(Date.now())}@example.com`;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, testEmail));
  });

  it('inserts and selects a user', async () => {
    const [inserted] = await db
      .insert(users)
      .values({
        email: testEmail,
        username: 'test_user',
        opaqueRegistration: testBytes(64),
        publicKey: testBytes(32),
        passwordWrappedPrivateKey: testBytes(48),
        recoveryWrappedPrivateKey: testBytes(48),
      })
      .returning();

    if (inserted === undefined) {
      throw new Error('Insert failed - no record returned');
    }

    expect(inserted.id).toBeDefined();
    expect(inserted.email).toBe(testEmail);
    expect(inserted.username).toBe('test_user');
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.updatedAt).toBeInstanceOf(Date);

    const [selected] = await db.select().from(users).where(eq(users.email, testEmail));

    if (selected === undefined) {
      throw new Error('Select failed - no record returned');
    }

    expect(selected.id).toBe(inserted.id);
    expect(selected.email).toBe(testEmail);
  });

  it('updates a user', async () => {
    const [updated] = await db
      .update(users)
      .set({ username: 'updated_name' })
      .where(eq(users.email, testEmail))
      .returning();

    if (updated === undefined) {
      throw new Error('Update failed - no record returned');
    }

    expect(updated.username).toBe('updated_name');
  });
});
