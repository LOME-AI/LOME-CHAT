import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { users } from '../schema/index';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:4444/lome_chat';

describe('LOCAL_NEON_DEV_CONFIG', () => {
  it('has correct wsProxy function with string port', () => {
    const result = LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', '4444');
    expect(result).toBe('localhost:4444/v1');
  });

  it('has correct wsProxy function with number port', () => {
    const result = LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', 4444);
    expect(result).toBe('localhost:4444/v1');
  });

  it('has useSecureWebSocket set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.useSecureWebSocket).toBe(false);
  });

  it('has pipelineTLS set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.pipelineTLS).toBe(false);
  });

  it('has pipelineConnect set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.pipelineConnect).toBe(false);
  });
});

describe('createDb', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  it('creates a database instance', () => {
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
    expect(typeof db.insert).toBe('function');
    expect(typeof db.update).toBe('function');
    expect(typeof db.delete).toBe('function');
  });

  describe('integration tests', () => {
    const testEmail = `test-${String(Date.now())}@example.com`;

    afterAll(async () => {
      await db.delete(users).where(eq(users.email, testEmail));
    });

    it('inserts and selects a user', async () => {
      const [inserted] = await db
        .insert(users)
        .values({
          email: testEmail,
          name: 'Test User',
        })
        .returning();

      if (inserted === undefined) {
        throw new Error('Insert failed - no record returned');
      }

      expect(inserted.id).toBeDefined();
      expect(inserted.email).toBe(testEmail);
      expect(inserted.name).toBe('Test User');
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
        .set({ name: 'Updated Name' })
        .where(eq(users.email, testEmail))
        .returning();

      if (updated === undefined) {
        throw new Error('Update failed - no record returned');
      }

      expect(updated.name).toBe('Updated Name');
    });
  });
});
