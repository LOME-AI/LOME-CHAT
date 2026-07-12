import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { MODALITIES } from '@hushbox/shared';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import {
  contentItems,
  conversations,
  epochs,
  ledgerEntries,
  messages,
  payments,
  sharedMessages,
  usageRecords,
  users,
  wallets,
} from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The complete table inventory, plus nothing (absence is equality). */
const EXPECTED_TABLES = [
  'account_deletion_events',
  'admin_audit',
  'allowance_spending',
  'banner_config',
  'banner_dismissals',
  'content_items',
  'conversation_forks',
  'conversation_members',
  'conversation_spending',
  'conversations',
  'custom_instructions',
  'device_tokens',
  'epoch_members',
  'epochs',
  'idempotency_keys',
  'jobs',
  'ledger_entries',
  'llm_completions',
  'media_generations',
  'member_budgets',
  'messages',
  'model_catalog',
  'payments',
  'preferences',
  'service_evidence',
  'shared_links',
  'shared_messages',
  'usage_records',
  'users',
  'verification_tokens',
  'wallets',
];

/**
 * Tables the takeover migration deliberately dropped. service_evidence and
 * account_deletion_events were dropped with them but are retained by decision
 * (the service-evidence CI system and the deletion executor's anonymous
 * forensic record survive) and recreated by later in-chain migrations.
 */
const DELETED_TABLES = ['flow_runs', 'exports', 'admin_pending_actions', 'projects'];

/** Partial indexes whose predicate must be exactly `<col> IS NOT NULL`. */
const NOT_NULL_PARTIAL_INDEXES = [
  'ledger_entries_payment_id_idx',
  'ledger_entries_usage_record_id_idx',
  'usage_records_user_id_idx',
  'usage_records_content_item_id_idx',
  'usage_records_conversation_id_idx',
  'conversation_members_link_id_idx',
  'conversation_members_invited_by_user_id_idx',
  'conversation_forks_tip_message_id_idx',
  'messages_parent_message_id_idx',
  'content_items_model_id_idx',
  'epochs_previous_epoch_id_idx',
];

function rows(result: { rows: Record<string, unknown>[] }): Record<string, unknown>[] {
  return result.rows;
}

/**
 * Drizzle wraps driver errors ("Failed query: …") and puts the Postgres
 * error (constraint name, trigger message) on the cause chain.
 */
async function expectDbError(action: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the statement to be rejected').toBeInstanceOf(Error);
  const chain: string[] = [];
  let current: unknown = caught;
  while (current instanceof Error) {
    chain.push(current.message);
    current = current.cause;
  }
  expect(chain.join(' | ')).toMatch(pattern);
}

async function indexDefinition(db: Database, name: string): Promise<string> {
  const found = rows(
    await db.execute(
      sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`
    )
  );
  expect(found, `index ${name} missing from pg_indexes`).toHaveLength(1);
  return found[0]?.['indexdef'] as string;
}

describe('migrations against local Postgres', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
  });

  it('creates exactly the inventory tables in the public schema', async () => {
    // The dev-only __stack_* bookkeeping objects are created at runtime by
    // scripts/ensure-stack, not by migrations — exclude them from the census.
    const found = rows(
      await db.execute(
        sql`select table_name from information_schema.tables
            where table_schema = 'public'
              and table_name not like ${String.raw`\_\_%`}
            order by table_name`
      )
    ).map((r) => r['table_name']);
    expect(found).toEqual(EXPECTED_TABLES);
  });

  it.each(DELETED_TABLES)('%s is gone from the migrated database', async (name) => {
    const found = rows(
      await db.execute(
        sql`select 1 from information_schema.tables
            where table_schema = 'public' and table_name = ${name}`
      )
    );
    expect(found).toHaveLength(0);
  });

  it('creates the modality pgEnum with exactly the shared MODALITIES values', async () => {
    const values = rows(
      await db.execute(
        sql`select e.enumlabel from pg_enum e
            join pg_type t on t.oid = e.enumtypid
            join pg_namespace n on n.oid = t.typnamespace
            where n.nspname = 'public' and t.typname = 'modality'
            order by e.enumsortorder`
      )
    ).map((r) => r['enumlabel']);
    expect(values).toEqual([...MODALITIES]);
  });

  it('creates the job_status pgEnum', async () => {
    const values = rows(
      await db.execute(
        sql`select e.enumlabel from pg_enum e
            join pg_type t on t.oid = e.enumtypid
            join pg_namespace n on n.oid = t.typnamespace
            where n.nspname = 'public' and t.typname = 'job_status'
            order by e.enumsortorder`
      )
    ).map((r) => r['enumlabel']);
    expect(values).toEqual(['pending', 'running', 'succeeded', 'cancelled', 'dead']);
  });

  it('builds the jobs claim probe as a partial index over active rows', async () => {
    const definition = await indexDefinition(db, 'jobs_claim_idx');
    expect(definition).toContain('(shard, priority, next_attempt_at)');
    expect(definition).toMatch(/WHERE.*pending.*running/s);
  });

  it('builds the jobs dedupe key as a partial unique over active rows', async () => {
    const definition = await indexDefinition(db, 'jobs_dedupe_key_unique');
    expect(definition).toContain('CREATE UNIQUE INDEX');
    expect(definition).toMatch(/WHERE.*pending.*running/s);
  });

  it('builds the jobs prune index over succeeded rows', async () => {
    const definition = await indexDefinition(db, 'jobs_prune_idx');
    expect(definition).toContain('(finished_at)');
    expect(definition).toMatch(/WHERE.*succeeded/s);
  });

  it.each(NOT_NULL_PARTIAL_INDEXES)('%s has an IS NOT NULL predicate', async (name) => {
    expect(await indexDefinition(db, name)).toContain('IS NOT NULL');
  });

  it('installs the deferred ledger zero-sum constraint trigger', async () => {
    const trigger = rows(
      await db.execute(
        sql`select tgdeferrable, tginitdeferred from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'ledger_entries'
              and t.tgname = 'ledger_entries_zero_sum'`
      )
    );
    expect(trigger).toHaveLength(1);
    expect(trigger[0]?.['tgdeferrable']).toBe(true);
    expect(trigger[0]?.['tginitdeferred']).toBe(true);
  });

  it('scopes the zero-sum trigger to insert, delete, and the sum-bearing columns', async () => {
    const found = rows(
      await db.execute(
        sql`select pg_get_triggerdef(t.oid) as definition from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'ledger_entries'
              and t.tgname = 'ledger_entries_zero_sum'`
      )
    );
    // The UPDATE list must exclude payment_id / usage_record_id: hard deletion
    // of payments / usage_records cascades ON DELETE SET NULL onto those
    // columns, and the cascade must not re-fire the trigger.
    expect(found[0]?.['definition']).toContain(
      'AFTER INSERT OR DELETE OR UPDATE OF transaction_id, amount_nano_usd, wallet_id, house_account ON'
    );
  });

  it('pins the zero-sum trigger function search_path', async () => {
    const found = rows(
      await db.execute(
        sql`select array_to_string(proconfig, ';') as config from pg_proc
            where proname = 'assert_ledger_transaction_balanced'`
      )
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.['config']).toBe('search_path=pg_catalog, public');
  });

  describe('row behavior', () => {
    let suffix: string;
    let userId: string;
    let walletId: string;
    let conversationId: string;

    beforeAll(async () => {
      suffix = randomUUID().slice(0, 8);
      const blob = new Uint8Array([1, 2, 3]);
      const [user] = await db
        .insert(users)
        .values({
          email: `shape-${suffix}@test.hushbox.ai`,
          username: `shape_${suffix}`,
          opaqueRegistration: blob,
          publicKey: blob,
          passwordWrappedPrivateKey: blob,
          recoveryWrappedPrivateKey: blob,
        })
        .returning({ id: users.id });
      if (!user) throw new Error('user insert returned no row');
      userId = user.id;

      const [wallet] = await db
        .insert(wallets)
        .values({ userId, type: 'purchased' })
        .returning({ id: wallets.id });
      if (!wallet) throw new Error('wallet insert returned no row');
      walletId = wallet.id;

      const [conversation] = await db
        .insert(conversations)
        .values({ userId, title: blob })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('conversation insert returned no row');
      conversationId = conversation.id;

      await db.insert(epochs).values({
        conversationId,
        epochNumber: 1,
        epochPublicKey: blob,
        confirmationHash: blob,
      });
    }, 30_000);

    // Cleanup is scoped to this suite's own rows (suffix-prefixed idempotency
    // keys, tracked ids). The dev database is shared: a table-wide truncate
    // here destroys the fixtures of a concurrently running invocation.
    // Order respects RESTRICT FKs: ledger legs before the wallet,
    // usage records before the model catalog row; deleting the user cascades
    // conversations -> epochs/messages/content items.
    afterAll(async () => {
      const keyPrefix = `${suffix}-%`;
      await db.execute(sql`delete from "ledger_entries" where idempotency_key like ${keyPrefix}`);
      await db.execute(sql`delete from "usage_records" where idempotency_key like ${keyPrefix}`);
      await db.execute(sql`delete from "payments" where idempotency_key like ${keyPrefix}`);
      await db.execute(sql`delete from "users" where id = ${userId}::uuid`);
      await db.execute(sql`delete from "wallets" where id = ${walletId}::uuid`);
    }, 30_000);

    /** Commits a balanced two-leg transaction and returns the leg ids. */
    async function insertBalancedPair(amount: bigint): Promise<{
      transactionId: string;
      walletLegId: string;
      houseLegId: string;
    }> {
      const transactionId = randomUUID();
      return db.transaction(async (tx) => {
        const [walletLeg] = await tx
          .insert(ledgerEntries)
          .values({
            transactionId,
            walletId,
            kind: 'deposit',
            amountNanoUsd: amount,
            balanceAfterNanoUsd: amount,
            idempotencyKey: `${suffix}-pair-${transactionId}-wallet`,
          })
          .returning({ id: ledgerEntries.id });
        const [houseLeg] = await tx
          .insert(ledgerEntries)
          .values({
            transactionId,
            houseAccount: 'payments-in',
            kind: 'deposit',
            amountNanoUsd: -amount,
            idempotencyKey: `${suffix}-pair-${transactionId}-house`,
          })
          .returning({ id: ledgerEntries.id });
        if (!walletLeg || !houseLeg) throw new Error('ledger pair insert returned no row');
        return { transactionId, walletLegId: walletLeg.id, houseLegId: houseLeg.id };
      });
    }

    it('defaults primary keys to native uuidv7', async () => {
      const found = rows(await db.execute(sql`select id from "users" where id = ${userId}::uuid`));
      expect(found[0]?.['id']).toMatch(UUID_V7_PATTERN);
    });

    it('commits a balanced double-entry transaction', async () => {
      const transactionId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({
          transactionId,
          walletId,
          kind: 'deposit',
          amountNanoUsd: 5_000_000_000n,
          balanceAfterNanoUsd: 5_000_000_000n,
          idempotencyKey: `${suffix}-dep-${transactionId}-wallet`,
        });
        await tx.insert(ledgerEntries).values({
          transactionId,
          houseAccount: 'payments-in',
          kind: 'deposit',
          amountNanoUsd: -5_000_000_000n,
          idempotencyKey: `${suffix}-dep-${transactionId}-house`,
        });
      });
      const legs = rows(
        await db.execute(
          sql`select count(*)::int as n from "ledger_entries" where transaction_id = ${transactionId}::uuid`
        )
      );
      expect(legs[0]?.['n']).toBe(2);
    });

    it('rejects an unbalanced ledger transaction at commit', async () => {
      const transactionId = randomUUID();
      await expectDbError(
        db.transaction(async (tx) => {
          await tx.insert(ledgerEntries).values({
            transactionId,
            walletId,
            kind: 'charge',
            amountNanoUsd: -3n,
            balanceAfterNanoUsd: 4_999_999_997n,
            idempotencyKey: `${suffix}-chg-${transactionId}-wallet`,
          });
          await tx.insert(ledgerEntries).values({
            transactionId,
            houseAccount: 'revenue',
            kind: 'charge',
            amountNanoUsd: 2n,
            idempotencyKey: `${suffix}-chg-${transactionId}-house`,
          });
        }),
        /legs sum to -1 \(must be 0\)/
      );
    });

    it('rejects an update of a committed leg amount at commit', async () => {
      const pair = await insertBalancedPair(5n);
      await expectDbError(
        db
          .update(ledgerEntries)
          .set({ amountNanoUsd: 6n })
          .where(eq(ledgerEntries.id, pair.walletLegId)),
        /legs sum to 1 \(must be 0\)/
      );
    });

    it('rejects deleting one leg of a committed transaction at commit', async () => {
      const pair = await insertBalancedPair(5n);
      await expectDbError(
        db.delete(ledgerEntries).where(eq(ledgerEntries.id, pair.houseLegId)),
        /legs sum to 5 \(must be 0\)/
      );
    });

    it('allows moving every leg of a transaction to a new transaction id', async () => {
      const pair = await insertBalancedPair(5n);
      const target = randomUUID();
      await db
        .update(ledgerEntries)
        .set({ transactionId: target })
        .where(eq(ledgerEntries.transactionId, pair.transactionId));
      const moved = rows(
        await db.execute(
          sql`select count(*)::int as n from "ledger_entries" where transaction_id = ${target}::uuid`
        )
      );
      expect(moved[0]?.['n']).toBe(2);
    });

    it('rejects a transaction_id move that unbalances the old group', async () => {
      const pair = await insertBalancedPair(7n);
      const target = randomUUID();
      await expectDbError(
        db.transaction(async (tx) => {
          await tx
            .update(ledgerEntries)
            .set({ transactionId: target })
            .where(eq(ledgerEntries.id, pair.walletLegId));
          await tx.insert(ledgerEntries).values({
            transactionId: target,
            houseAccount: 'revenue',
            kind: 'charge',
            amountNanoUsd: -7n,
            idempotencyKey: `${suffix}-move-old-${target}`,
          });
        }),
        /legs sum to -7 \(must be 0\)/
      );
    });

    it('rejects a transaction_id move that unbalances the new group', async () => {
      const a = await insertBalancedPair(5n);
      const b = await insertBalancedPair(3n);
      await expectDbError(
        db.transaction(async (tx) => {
          await tx
            .update(ledgerEntries)
            .set({ transactionId: b.transactionId })
            .where(eq(ledgerEntries.id, a.walletLegId));
          await tx.insert(ledgerEntries).values({
            transactionId: a.transactionId,
            walletId,
            kind: 'deposit',
            amountNanoUsd: 5n,
            balanceAfterNanoUsd: 5n,
            idempotencyKey: `${suffix}-move-new-${a.transactionId}`,
          });
        }),
        /legs sum to 5 \(must be 0\)/
      );
    });

    it('keeps ledger legs intact when a payments deletion cascades SET NULL', async () => {
      const [payment] = await db
        .insert(payments)
        .values({
          userId,
          amountNanoUsd: 5_000_000_000n,
          idempotencyKey: `${suffix}-pay-${randomUUID()}`,
        })
        .returning({ id: payments.id });
      if (!payment) throw new Error('payment insert returned no row');
      const transactionId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({
          transactionId,
          walletId,
          kind: 'deposit',
          amountNanoUsd: 5_000_000_000n,
          balanceAfterNanoUsd: 5_000_000_000n,
          paymentId: payment.id,
          idempotencyKey: `${suffix}-paydep-${transactionId}-wallet`,
        });
        await tx.insert(ledgerEntries).values({
          transactionId,
          houseAccount: 'payments-in',
          kind: 'deposit',
          amountNanoUsd: -5_000_000_000n,
          idempotencyKey: `${suffix}-paydep-${transactionId}-house`,
        });
      });

      await db.delete(payments).where(eq(payments.id, payment.id));

      const legs = rows(
        await db.execute(
          sql`select payment_id from "ledger_entries" where transaction_id = ${transactionId}::uuid`
        )
      );
      expect(legs).toHaveLength(2);
      expect(legs.every((leg) => leg['payment_id'] === null)).toBe(true);
    });

    it('keeps ledger legs intact when a usage_records deletion cascades SET NULL', async () => {
      const [usageRecord] = await db
        .insert(usageRecords)
        .values({
          userId,
          runId: randomUUID(),
          modelId: `test/model-${suffix}`,
          providerName: 'test-provider',
          modality: 'text',
          costNanoUsd: 100n,
          isEstimated: true,
          idempotencyKey: `${suffix}-usage-${randomUUID()}`,
        })
        .returning({ id: usageRecords.id });
      if (!usageRecord) throw new Error('usage record insert returned no row');
      const transactionId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({
          transactionId,
          walletId,
          kind: 'charge',
          amountNanoUsd: -100n,
          balanceAfterNanoUsd: 4_999_999_900n,
          usageRecordId: usageRecord.id,
          idempotencyKey: `${suffix}-usagechg-${transactionId}-wallet`,
        });
        await tx.insert(ledgerEntries).values({
          transactionId,
          houseAccount: 'revenue',
          kind: 'charge',
          amountNanoUsd: 100n,
          idempotencyKey: `${suffix}-usagechg-${transactionId}-house`,
        });
      });

      await db.delete(usageRecords).where(eq(usageRecords.id, usageRecord.id));

      const legs = rows(
        await db.execute(
          sql`select usage_record_id from "ledger_entries" where transaction_id = ${transactionId}::uuid`
        )
      );
      expect(legs).toHaveLength(2);
      expect(legs.every((leg) => leg['usage_record_id'] === null)).toBe(true);
    });

    it('rejects a leg naming neither a wallet nor a house account', async () => {
      await expectDbError(
        db.insert(ledgerEntries).values({
          transactionId: randomUUID(),
          kind: 'promo',
          amountNanoUsd: 0n,
          idempotencyKey: `${suffix}-bad-${randomUUID()}`,
        }),
        /ledger_entries_one_account/
      );
    });

    it('rejects a running balance on a house-account leg', async () => {
      await expectDbError(
        db.insert(ledgerEntries).values({
          transactionId: randomUUID(),
          houseAccount: 'revenue',
          kind: 'promo',
          amountNanoUsd: 0n,
          balanceAfterNanoUsd: 0n,
          idempotencyKey: `${suffix}-bad-${randomUUID()}`,
        }),
        /ledger_entries_balance_on_wallet_legs/
      );
    });

    it('enforces UNIQUE(conversation_id, sequence_number) on messages', async () => {
      const blob = new Uint8Array([9]);
      await db.insert(messages).values({
        conversationId,
        senderType: 'user',
        wrappedContentKey: blob,
        epochNumber: 1,
        sequenceNumber: 1,
      });
      await expectDbError(
        db.insert(messages).values({
          conversationId,
          senderType: 'assistant',
          wrappedContentKey: blob,
          epochNumber: 1,
          sequenceNumber: 1,
        }),
        /messages_conversation_sequence_unique/
      );
    });

    it('rejects a message whose epoch row does not exist (composite FK)', async () => {
      await expectDbError(
        db.insert(messages).values({
          conversationId,
          senderType: 'user',
          wrappedContentKey: new Uint8Array([9]),
          epochNumber: 99,
          sequenceNumber: 2,
        }),
        /messages_conversation_epoch_fk/
      );
    });

    it('severs usage_records.content_item_id on content deletion, keeping the charge row', async () => {
      const blob = new Uint8Array([7]);
      const [message] = await db
        .insert(messages)
        .values({
          conversationId,
          senderType: 'assistant',
          wrappedContentKey: blob,
          epochNumber: 1,
          sequenceNumber: 3,
        })
        .returning({ id: messages.id });
      if (!message) throw new Error('message insert returned no row');
      const [contentItem] = await db
        .insert(contentItems)
        .values({
          messageId: message.id,
          contentType: 'text',
          encryptedBlob: blob,
        })
        .returning({ id: contentItems.id });
      if (!contentItem) throw new Error('content item insert returned no row');
      const [usageRecord] = await db
        .insert(usageRecords)
        .values({
          userId,
          contentItemId: contentItem.id,
          runId: randomUUID(),
          modelId: `test/model-${suffix}`,
          providerName: 'test-provider',
          modality: 'text',
          costNanoUsd: 100n,
          isEstimated: true,
          idempotencyKey: `${suffix}-usage-${randomUUID()}`,
        })
        .returning({ id: usageRecords.id });
      if (!usageRecord) throw new Error('usage record insert returned no row');

      await db.execute(sql`delete from "messages" where id = ${message.id}::uuid`);

      const after = rows(
        await db.execute(
          sql`select content_item_id from "usage_records" where id = ${usageRecord.id}::uuid`
        )
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.['content_item_id']).toBeNull();
    });

    it('cascades a standalone shared_message with its message', async () => {
      const blob = new Uint8Array([8]);
      const [message] = await db
        .insert(messages)
        .values({
          conversationId,
          senderType: 'user',
          wrappedContentKey: blob,
          epochNumber: 1,
          sequenceNumber: 4,
        })
        .returning({ id: messages.id });
      if (!message) throw new Error('message insert returned no row');
      const [share] = await db
        .insert(sharedMessages)
        .values({
          messageId: message.id,
          createdBy: userId,
          wrappedContentKey: blob,
        })
        .returning({ id: sharedMessages.id });
      if (!share) throw new Error('shared message insert returned no row');

      await db.delete(messages).where(eq(messages.id, message.id));

      const after = await db.select().from(sharedMessages).where(eq(sharedMessages.id, share.id));
      expect(after).toHaveLength(0);
    });
  });
});
