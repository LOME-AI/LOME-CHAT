import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  IdentityStores,
  IdentityUserRecord,
  InsertRegisteredOutcome,
  RegistrationValues,
} from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('identity store query failed', cause);
}

const RECORD_COLUMNS = {
  id: users.id,
  email: users.email,
  username: users.username,
  opaqueRegistration: users.opaqueRegistration,
  passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
  totpEnabled: users.totpEnabled,
  lockedAt: users.lockedAt,
} as const;

/**
 * Walks an insert rejection (drivers nest the Postgres error under `cause`)
 * for a unique violation (SQLSTATE 23505) and returns the constraint name.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && typeof candidate.constraint === 'string') {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return null;
}

async function insertRegisteredUser(
  db: Database,
  values: RegistrationValues
): Promise<InsertRegisteredOutcome> {
  try {
    const rows = await db
      .insert(users)
      .values({ ...values, emailVerified: false })
      .returning({ id: users.id });
    const created = rows[0];
    if (created === undefined) {
      throw new Error('identity: INSERT … RETURNING produced no row (driver defect)');
    }
    return { kind: 'created', userId: created.id };
  } catch (error) {
    // The two discriminable unique violations are expected outcomes (the
    // unique constraint is the duplicate arbiter — byUpsert contract);
    // everything else stays a rejection for the unavailable mapper.
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'users_email_unique') return { kind: 'email-taken' };
    if (constraint === 'users_username_unique') return { kind: 'username-taken' };
    throw error;
  }
}

/**
 * Drizzle implementation of the identity stores. Single-writer: the identity
 * slice owns the `users` table; other slices read it through their own
 * published surfaces.
 */
export function createIdentityStores(db: Database): IdentityStores {
  function findOne(condition: SQL): ResultAsync<IdentityUserRecord | null, DomainError> {
    return fromPromise(
      db.select(RECORD_COLUMNS).from(users).where(condition).limit(1),
      storeFailure
    ).map((rows) => rows[0] ?? null);
  }

  return {
    users: {
      findByEmail: (email) => findOne(eq(users.email, email)),
      findByUsername: (username) => findOne(eq(users.username, username)),
      findById: (userId) => findOne(eq(users.id, userId)),
      insertRegistered: (values) => fromPromise(insertRegisteredUser(db, values), storeFailure),
    },
  };
}
