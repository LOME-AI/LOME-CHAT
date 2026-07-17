import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { adminAudit } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

let db: Database;
const insertedAuditIds: string[] = [];

async function insertAuditRow(): Promise<string> {
  const [row] = await db
    .insert(adminAudit)
    .values({ actor: 'admin@example.com', action: 'test.noop' })
    .returning({ id: adminAudit.id });
  if (!row) throw new Error('insert returned no row');
  insertedAuditIds.push(row.id);
  return row.id;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join(' | ');
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  // The trigger blocks DELETE; scrub test rows with the trigger disabled so
  // repeated local runs never accumulate. session_replication_role skips
  // user triggers without dropping them.
  if (insertedAuditIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      for (const id of insertedAuditIds) {
        await tx.execute(sql`DELETE FROM admin_audit WHERE id = ${id}`);
      }
    });
  }
  await db.$client.end();
});

describe('admin_audit append-only trigger', () => {
  it('INSERT succeeds', async () => {
    const id = await insertAuditRow();
    const rows = await db.select().from(adminAudit).where(eq(adminAudit.id, id));
    expect(rows).toHaveLength(1);
  });

  it('UPDATE raises', async () => {
    const id = await insertAuditRow();
    const error = await captureError(
      db.update(adminAudit).set({ action: 'test.mutated' }).where(eq(adminAudit.id, id))
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/append-only/);
  });

  it('DELETE raises', async () => {
    const id = await insertAuditRow();
    const error = await captureError(db.delete(adminAudit).where(eq(adminAudit.id, id)));
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/append-only/);
  });

  it('TRUNCATE raises', async () => {
    const error = await captureError(db.execute(sql`TRUNCATE admin_audit`));
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/append-only/);
  });
});

describe('admin_audit undo claim', () => {
  it('a second undo of the same audit row fails the unique claim', async () => {
    const originalId = await insertAuditRow();
    const [first] = await db
      .insert(adminAudit)
      .values({ actor: 'admin@example.com', action: 'test.undo', undoes: originalId })
      .returning({ id: adminAudit.id });
    if (!first) throw new Error('insert returned no row');
    insertedAuditIds.push(first.id);

    const error = await captureError(
      db
        .insert(adminAudit)
        .values({ actor: 'admin@example.com', action: 'test.undo', undoes: originalId })
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/unique/i);
  });
});

describe('admin_sql_panel role', () => {
  it('SELECT succeeds through the role', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
      const result = await tx.execute(sql`SELECT count(*) AS n FROM users`);
      expect(result.rows).toHaveLength(1);
    });
  });

  it('cannot select from verification_tokens (plaintext bearer tokens)', async () => {
    const error = await captureError(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
        await tx.execute(sql`SELECT token FROM verification_tokens`);
      })
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/permission denied/i);
  });

  it('cannot select users.opaque_registration (OPAQUE server record)', async () => {
    const error = await captureError(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
        await tx.execute(sql`SELECT opaque_registration FROM users`);
      })
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/permission denied/i);
  });

  it('cannot select device_tokens.token (push credential material)', async () => {
    const error = await captureError(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
        await tx.execute(sql`SELECT token FROM device_tokens`);
      })
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/permission denied/i);
  });

  it('cannot SELECT * from device_tokens (star expands to the refused token column)', async () => {
    const error = await captureError(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
        await tx.execute(sql`SELECT * FROM device_tokens`);
      })
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/permission denied/i);
  });

  it('can select the remaining device_tokens columns', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
      const result = await tx.execute(
        sql`SELECT id, user_id, platform, created_at, updated_at FROM device_tokens LIMIT 1`
      );
      expect(Array.isArray(result.rows)).toBe(true);
    });
  });

  it('can select the remaining users columns', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
      const result = await tx.execute(
        sql`SELECT id, email, username, totp_secret_encrypted, locked_at, created_at FROM users LIMIT 1`
      );
      expect(Array.isArray(result.rows)).toBe(true);
    });
  });

  it('a write through the role is refused', async () => {
    const error = await captureError(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
        await tx.execute(
          sql`INSERT INTO admin_audit (actor, action) VALUES ('intruder', 'test.write')`
        );
      })
    );
    expect(error).toBeDefined();
    expect(errorChainText(error)).toMatch(/permission denied/i);
  });
});
