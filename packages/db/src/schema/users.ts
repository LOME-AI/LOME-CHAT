import { pgTable, boolean, check, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { userLockReasonEnum } from './enums';

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').notNull().unique(),
    username: varchar('username', { length: 20 }).notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),

    // OPAQUE authentication
    opaqueRegistration: bytea('opaque_registration').notNull(),

    // TOTP 2FA
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),

    // Recovery phrase acknowledgment
    hasAcknowledgedPhrase: boolean('has_acknowledged_phrase').notNull().default(false),

    // E2E encryption keys
    publicKey: bytea('public_key').notNull(),
    passwordWrappedPrivateKey: bytea('password_wrapped_private_key').notNull(),
    recoveryWrappedPrivateKey: bytea('recovery_wrapped_private_key').notNull(),

    // Chargeback auto-defense / admin lock — reversible, no delete
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockReason: userLockReasonEnum('lock_reason'),

    // Chunked-deletion fallback marker
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'users_lock_consistency',
      sql`(${table.lockedAt} IS NULL) = (${table.lockReason} IS NULL)`
    ),
  ]
);
