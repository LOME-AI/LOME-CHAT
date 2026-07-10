import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';

import {
  column,
  findForeignKey,
  findIndex,
  foreignKeyShapes,
  hasDefault,
  checkNames,
  uniqueShapes,
} from './__tests__/shape-helpers';
import * as schema from './index';

/**
 * Shape-tests for every table in the data model — one describe per table.
 * A table absent from ALL_TABLES does not exist (completeness is checkable),
 * with one exception: service_evidence keeps its retained legacy shape (text
 * PK with a client-side uuid default, predating the uuidv7 convention) and is
 * shape-tested in its own describe below ALL_TABLES' uuidv7 rule.
 */

const ALL_TABLES: Record<string, PgTable> = {
  users: schema.users,
  wallets: schema.wallets,
  ledger_entries: schema.ledgerEntries,
  usage_records: schema.usageRecords,
  llm_completions: schema.llmCompletions,
  media_generations: schema.mediaGenerations,
  payments: schema.payments,
  member_budgets: schema.memberBudgets,
  conversation_spending: schema.conversationSpending,
  allowance_spending: schema.allowanceSpending,
  messages: schema.messages,
  content_items: schema.contentItems,
  conversations: schema.conversations,
  conversation_members: schema.conversationMembers,
  conversation_forks: schema.conversationForks,
  epochs: schema.epochs,
  epoch_members: schema.epochMembers,
  shared_links: schema.sharedLinks,
  shared_messages: schema.sharedMessages,
  model_catalog: schema.modelCatalog,
  idempotency_keys: schema.idempotencyKeys,
  jobs: schema.jobs,
  admin_audit: schema.adminAudit,
  device_tokens: schema.deviceTokens,
  custom_instructions: schema.customInstructions,
  preferences: schema.preferences,
  verification_tokens: schema.verificationTokens,
};

describe('schema namespace', () => {
  it.each(Object.entries(ALL_TABLES))('%s lives in the public pg schema', (_name, table) => {
    expect(getTableConfig(table).schema).toBeUndefined();
  });

  it.each(Object.entries(ALL_TABLES))(
    '%s has a uuid primary key defaulting to uuidv7()',
    (_name, table) => {
      const id = column(table, 'id');
      expect(id.primary).toBe(true);
      expect(id.getSQLType()).toBe('uuid');
      expect(hasDefault(table, 'id')).toBe(true);
    }
  );
});

describe('service_evidence', () => {
  it('lives in the public pg schema', () => {
    expect(getTableConfig(schema.serviceEvidence).schema).toBeUndefined();
  });

  it('keeps the retained legacy text primary key with an application-side default', () => {
    const id = column(schema.serviceEvidence, 'id');
    expect(id.primary).toBe(true);
    expect(id.getSQLType()).toBe('text');
    expect(hasDefault(schema.serviceEvidence, 'id')).toBe(true);
  });

  it('requires the service name', () => {
    const c = column(schema.serviceEvidence, 'service');
    expect(c.getSQLType()).toBe('text');
    expect(c.notNull).toBe(true);
  });

  it('stores optional details as jsonb', () => {
    const c = column(schema.serviceEvidence, 'details');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(false);
  });

  it('timestamps every row by default', () => {
    const c = column(schema.serviceEvidence, 'created_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(true);
    expect(hasDefault(schema.serviceEvidence, 'created_at')).toBe(true);
  });

  it('carries no foreign keys into domain data (append-only CI evidence)', () => {
    expect(getTableConfig(schema.serviceEvidence).foreignKeys).toHaveLength(0);
  });
});

describe('users', () => {
  it('has a nullable locked_at timestamptz', () => {
    const c = column(schema.users, 'locked_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(false);
  });

  it('has a nullable lock_reason pgEnum column', () => {
    const c = column(schema.users, 'lock_reason');
    expect(c.getSQLType()).toBe('user_lock_reason');
    expect(c.notNull).toBe(false);
  });

  it('has a nullable deletion_requested_at timestamptz', () => {
    const c = column(schema.users, 'deletion_requested_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(false);
  });

  it('keeps email unique', () => {
    expect(column(schema.users, 'email').isUnique).toBe(true);
  });

  it('keeps username unique', () => {
    expect(column(schema.users, 'username').isUnique).toBe(true);
  });

  it('ties locked_at and lock_reason together with a check constraint', () => {
    expect(checkNames(schema.users)).toContain('users_lock_consistency');
  });
});

describe('wallets', () => {
  it('enforces UNIQUE(userId, type)', () => {
    expect(uniqueShapes(schema.wallets)).toContainEqual({
      name: 'wallets_user_type_unique',
      columns: ['user_id', 'type'],
    });
  });

  it('types wallet type as a pgEnum', () => {
    expect(column(schema.wallets, 'type').getSQLType()).toBe('wallet_type');
  });

  it('severs the user link on deletion (financial retention)', () => {
    expect(findForeignKey(schema.wallets, ['user_id']).onDelete).toBe('set null');
  });
});

describe('ledger_entries', () => {
  it('groups signed legs by a non-null transaction_id', () => {
    const c = column(schema.ledgerEntries, 'transaction_id');
    expect(c.getSQLType()).toBe('uuid');
    expect(c.notNull).toBe(true);
  });

  it('discriminates legs with the ledger_entry_kind pgEnum', () => {
    const c = column(schema.ledgerEntries, 'kind');
    expect(c.getSQLType()).toBe('ledger_entry_kind');
    expect(c.notNull).toBe(true);
  });

  it('carries house accounts as a nullable pgEnum beside the wallet FK', () => {
    const c = column(schema.ledgerEntries, 'house_account');
    expect(c.getSQLType()).toBe('house_account');
    expect(c.notNull).toBe(false);
  });

  it('requires exactly one of wallet_id or house_account per leg', () => {
    expect(checkNames(schema.ledgerEntries)).toContain('ledger_entries_one_account');
  });

  it('allows a running balance only on user-wallet legs', () => {
    expect(checkNames(schema.ledgerEntries)).toContain('ledger_entries_balance_on_wallet_legs');
    expect(column(schema.ledgerEntries, 'balance_after_nano_usd').notNull).toBe(false);
  });

  it('enforces a unique idempotency key on every leg', () => {
    const c = column(schema.ledgerEntries, 'idempotency_key');
    expect(c.isUnique).toBe(true);
    expect(c.notNull).toBe(true);
  });

  it('never deletes a wallet out from under its legs', () => {
    expect(findForeignKey(schema.ledgerEntries, ['wallet_id']).onDelete).toBe('restrict');
  });

  it('severs payment and usage-record links instead of losing legs', () => {
    expect(findForeignKey(schema.ledgerEntries, ['payment_id']).onDelete).toBe('set null');
    expect(findForeignKey(schema.ledgerEntries, ['usage_record_id']).onDelete).toBe('set null');
  });
});

describe('usage_records', () => {
  it('points at the settlement-anchor content item via a nullable FK', () => {
    const c = column(schema.usageRecords, 'content_item_id');
    expect(c.notNull).toBe(false);
    expect(findForeignKey(schema.usageRecords, ['content_item_id']).onDelete).toBe('set null');
  });

  it('groups a run with a plain non-null run_id uuid (no parent table)', () => {
    const c = column(schema.usageRecords, 'run_id');
    expect(c.getSQLType()).toBe('uuid');
    expect(c.notNull).toBe(true);
  });

  it('attributes a charge to its conversation via a nullable FK (per-conversation spend)', () => {
    const c = column(schema.usageRecords, 'conversation_id');
    expect(c.notNull).toBe(false);
    // Financial retention survives hard conversation deletion — the row stays,
    // its conversation link is severed (like user_id / content_item_id).
    expect(findForeignKey(schema.usageRecords, ['conversation_id']).onDelete).toBe('set null');
  });

  it('enforces a unique idempotency key per charge row', () => {
    const c = column(schema.usageRecords, 'idempotency_key');
    expect(c.isUnique).toBe(true);
    expect(c.notNull).toBe(true);
  });

  it('records the modality for per-modality invoice reconciliation', () => {
    const c = column(schema.usageRecords, 'modality');
    expect(c.getSQLType()).toBe('modality');
    expect(c.notNull).toBe(true);
  });

  it('flags an estimated cost (image and the pathological missing-cost path)', () => {
    expect(column(schema.usageRecords, 'is_estimated').getSQLType()).toBe('boolean');
  });

  it('carries the gateway generation id (one per generation under the run)', () => {
    expect(column(schema.usageRecords, 'generation_id').notNull).toBe(false);
  });

  it('survives user deletion via SET NULL (financial retention)', () => {
    expect(findForeignKey(schema.usageRecords, ['user_id']).onDelete).toBe('set null');
  });

  it('captures the model and provider as plain strings with no catalog FK', () => {
    expect(column(schema.usageRecords, 'model_id').getSQLType()).toBe('text');
    expect(column(schema.usageRecords, 'model_id').notNull).toBe(true);
    expect(column(schema.usageRecords, 'provider_name').getSQLType()).toBe('text');
    expect(column(schema.usageRecords, 'provider_name').notNull).toBe(true);
    expect(
      foreignKeyShapes(schema.usageRecords).some((fk) => fk.foreignTable === 'model_catalog')
    ).toBe(false);
  });
});

describe('llm_completions', () => {
  it('is 1:1 with usage_records', () => {
    const c = column(schema.llmCompletions, 'usage_record_id');
    expect(c.isUnique).toBe(true);
    expect(c.notNull).toBe(true);
    expect(findForeignKey(schema.llmCompletions, ['usage_record_id']).onDelete).toBe('cascade');
  });

  it('persists tool steps as a non-null jsonb list', () => {
    const c = column(schema.llmCompletions, 'tool_steps');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(true);
    expect(hasDefault(schema.llmCompletions, 'tool_steps')).toBe(true);
  });

  it('records token usage as integers', () => {
    expect(column(schema.llmCompletions, 'input_tokens').getSQLType()).toBe('integer');
    expect(column(schema.llmCompletions, 'output_tokens').getSQLType()).toBe('integer');
    expect(column(schema.llmCompletions, 'reasoning_tokens').getSQLType()).toBe('integer');
    expect(column(schema.llmCompletions, 'cached_input_tokens').getSQLType()).toBe('integer');
  });
});

describe('media_generations', () => {
  it('is 1:1 with usage_records', () => {
    const c = column(schema.mediaGenerations, 'usage_record_id');
    expect(c.isUnique).toBe(true);
    expect(findForeignKey(schema.mediaGenerations, ['usage_record_id']).onDelete).toBe('cascade');
  });

  it('types the generated modality with the modality pgEnum', () => {
    const c = column(schema.mediaGenerations, 'modality');
    expect(c.getSQLType()).toBe('modality');
    expect(c.notNull).toBe(true);
  });
});

describe('payments', () => {
  it('enforces a unique non-null idempotency key', () => {
    const c = column(schema.payments, 'idempotency_key');
    expect(c.isUnique).toBe(true);
    expect(c.notNull).toBe(true);
  });

  it('tracks the pre-claim lifecycle with the payment_status pgEnum', () => {
    const c = column(schema.payments, 'status');
    expect(c.getSQLType()).toBe('payment_status');
    expect(c.notNull).toBe(true);
  });

  it('keeps the Helcim transaction id unique', () => {
    expect(column(schema.payments, 'helcim_transaction_id').isUnique).toBe(true);
  });

  it('records the webhook arrival time', () => {
    expect(column(schema.payments, 'webhook_received_at').notNull).toBe(false);
  });

  it('survives user deletion via SET NULL (financial retention)', () => {
    expect(findForeignKey(schema.payments, ['user_id']).onDelete).toBe('set null');
  });
});

describe('member_budgets', () => {
  it('keeps one durable budget row per member (cumulative forever, no period)', () => {
    expect(uniqueShapes(schema.memberBudgets)).toContainEqual({
      name: 'member_budgets_member_unique',
      columns: ['member_id'],
    });
  });

  it('carries no month period column', () => {
    expect(getTableConfig(schema.memberBudgets).columns.map((c) => c.name)).not.toContain('month');
  });

  it('has no month-format check', () => {
    expect(checkNames(schema.memberBudgets)).not.toContain('member_budgets_month_format');
  });

  it('requires the owner-set per-member cap (config independent of spend)', () => {
    expect(column(schema.memberBudgets, 'budget_nano_usd').notNull).toBe(true);
  });

  it('accumulates spend cumulatively with a zero default', () => {
    expect(column(schema.memberBudgets, 'spent_nano_usd').notNull).toBe(true);
    expect(hasDefault(schema.memberBudgets, 'spent_nano_usd')).toBe(true);
  });
});

describe('conversation_spending', () => {
  it('keeps one durable spending row per conversation (cumulative forever, no period)', () => {
    expect(uniqueShapes(schema.conversationSpending)).toContainEqual({
      name: 'conversation_spending_conversation_unique',
      columns: ['conversation_id'],
    });
  });

  it('carries no month period column', () => {
    expect(getTableConfig(schema.conversationSpending).columns.map((c) => c.name)).not.toContain(
      'month'
    );
  });

  it('has no month-format check', () => {
    expect(checkNames(schema.conversationSpending)).not.toContain(
      'conversation_spending_month_format'
    );
  });

  it('accumulates spend cumulatively with a zero default; the cap lives on conversations', () => {
    expect(column(schema.conversationSpending, 'spent_nano_usd').notNull).toBe(true);
    expect(hasDefault(schema.conversationSpending, 'spent_nano_usd')).toBe(true);
    expect(getTableConfig(schema.conversationSpending).columns.map((c) => c.name)).not.toContain(
      'budget_nano_usd'
    );
  });
});

describe('allowance_spending', () => {
  it('keys allowance rows by (user_id, day)', () => {
    expect(uniqueShapes(schema.allowanceSpending)).toContainEqual({
      name: 'allowance_spending_user_day_unique',
      columns: ['user_id', 'day'],
    });
  });

  it('constrains day to the UTC YYYY-MM-DD period key', () => {
    expect(checkNames(schema.allowanceSpending)).toContain('allowance_spending_day_format');
  });
});

describe('messages', () => {
  it('enforces UNIQUE(conversation_id, sequence_number)', () => {
    expect(uniqueShapes(schema.messages)).toContainEqual({
      name: 'messages_conversation_sequence_unique',
      columns: ['conversation_id', 'sequence_number'],
    });
  });

  it('references its parent message with a self-FK', () => {
    const fk = findForeignKey(schema.messages, ['parent_message_id']);
    expect(fk.foreignTable).toBe('messages');
    expect(fk.onDelete).toBe('set null');
  });

  it('references its epoch via the composite (conversation_id, epoch_number) FK', () => {
    const fk = findForeignKey(schema.messages, ['conversation_id', 'epoch_number']);
    expect(fk.foreignTable).toBe('epochs');
    expect(fk.foreignColumns).toEqual(['conversation_id', 'epoch_number']);
  });

  it('types sender_type with a pgEnum', () => {
    expect(column(schema.messages, 'sender_type').getSQLType()).toBe('message_sender_type');
  });
});

describe('content_items', () => {
  it('cascades with its message', () => {
    expect(findForeignKey(schema.contentItems, ['message_id']).onDelete).toBe('cascade');
  });

  it('types content_type with a pgEnum', () => {
    expect(column(schema.contentItems, 'content_type').getSQLType()).toBe('content_item_type');
  });

  it('captures the generating model and provider as plain strings with no catalog FK', () => {
    expect(column(schema.contentItems, 'model_id').getSQLType()).toBe('text');
    expect(column(schema.contentItems, 'provider_name').getSQLType()).toBe('text');
    expect(
      foreignKeyShapes(schema.contentItems).some((fk) => fk.foreignTable === 'model_catalog')
    ).toBe(false);
  });

  it('keeps the text-vs-media column consistency check', () => {
    expect(checkNames(schema.contentItems)).toContain('content_items_type_consistency');
  });
});

describe('conversations', () => {
  it('cascades with its owner', () => {
    expect(findForeignKey(schema.conversations, ['user_id']).onDelete).toBe('cascade');
  });

  it('carries no project FK (projects is deleted)', () => {
    expect(getTableConfig(schema.conversations).columns.map((c) => c.name)).not.toContain(
      'project_id'
    );
  });

  it('carries no per-member budget column', () => {
    expect(getTableConfig(schema.conversations).columns.map((c) => c.name)).not.toContain(
      'budget_nano_usd'
    );
  });

  it('carries the durable owner-set per-conversation cap', () => {
    const c = column(schema.conversations, 'conversation_budget_nano_usd');
    expect(c.getSQLType()).toBe('bigint');
    expect(c.notNull).toBe(true);
    expect(hasDefault(schema.conversations, 'conversation_budget_nano_usd')).toBe(true);
  });

  it('tracks current epoch and next sequence for the DO serialization', () => {
    expect(column(schema.conversations, 'current_epoch').notNull).toBe(true);
    expect(column(schema.conversations, 'next_sequence').notNull).toBe(true);
  });
});

describe('conversation_members', () => {
  it('types privilege with a pgEnum', () => {
    expect(column(schema.conversationMembers, 'privilege').getSQLType()).toBe('member_privilege');
  });

  it('keeps the one-active-membership partial uniques', () => {
    expect(findIndex(schema.conversationMembers, 'conversation_members_user_active')).toEqual({
      name: 'conversation_members_user_active',
      unique: true,
      partial: true,
      columns: ['conversation_id', 'user_id'],
    });
    expect(findIndex(schema.conversationMembers, 'conversation_members_link_active')).toEqual({
      name: 'conversation_members_link_active',
      unique: true,
      partial: true,
      columns: ['conversation_id', 'link_id'],
    });
  });

  it('keeps the identity-or-left check', () => {
    expect(checkNames(schema.conversationMembers)).toContain(
      'conversation_members_identity_or_left_check'
    );
  });
});

describe('conversation_forks', () => {
  it('keeps fork names unique per conversation', () => {
    expect(uniqueShapes(schema.conversationForks)).toContainEqual({
      name: 'conversation_forks_conversation_name_unique',
      columns: ['conversation_id', 'name'],
    });
  });

  it('severs the tip message link instead of losing the fork', () => {
    expect(findForeignKey(schema.conversationForks, ['tip_message_id']).onDelete).toBe('set null');
  });
});

describe('epochs', () => {
  it('chains epochs referentially via previous_epoch_id', () => {
    const fk = findForeignKey(schema.epochs, ['previous_epoch_id']);
    expect(fk.foreignTable).toBe('epochs');
    expect(column(schema.epochs, 'previous_epoch_id').notNull).toBe(false);
  });

  it('keys epochs by (conversation_id, epoch_number)', () => {
    expect(uniqueShapes(schema.epochs)).toContainEqual({
      name: 'epochs_conversation_epoch_unique',
      columns: ['conversation_id', 'epoch_number'],
    });
  });
});

describe('epoch_members', () => {
  it('keys wraps by (epoch_id, member_public_key)', () => {
    expect(uniqueShapes(schema.epochMembers)).toContainEqual({
      name: 'epoch_members_epoch_key_unique',
      columns: ['epoch_id', 'member_public_key'],
    });
  });
});

describe('shared_links', () => {
  it('has a nullable revoked_at timestamptz (lazy revoke at read)', () => {
    const c = column(schema.sharedLinks, 'revoked_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(false);
  });

  it('has a nullable expires_at timestamptz (lazy expiry at read)', () => {
    const c = column(schema.sharedLinks, 'expires_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(false);
  });

  it('keeps the link public key unique', () => {
    expect(column(schema.sharedLinks, 'link_public_key').isUnique).toBe(true);
  });
});

describe('shared_messages', () => {
  it('cascades shares with their creator (deletion severs public shares)', () => {
    const fk = findForeignKey(schema.sharedMessages, ['created_by']);
    expect(fk.foreignTable).toBe('users');
    expect(fk.onDelete).toBe('cascade');
    expect(column(schema.sharedMessages, 'created_by').notNull).toBe(true);
  });

  it('scopes shares to their minting link (cascade on link deletion)', () => {
    const fk = findForeignKey(schema.sharedMessages, ['link_id']);
    expect(fk.foreignTable).toBe('shared_links');
    expect(fk.onDelete).toBe('cascade');
    expect(column(schema.sharedMessages, 'link_id').notNull).toBe(true);
  });

  it('indexes the link FK', () => {
    expect(findIndex(schema.sharedMessages, 'shared_messages_link_id_idx')).toEqual({
      name: 'shared_messages_link_id_idx',
      unique: false,
      partial: false,
      columns: ['link_id'],
    });
  });
});

describe('modelCatalog', () => {
  it('keys catalog rows by surrogate uuid PK', () => {
    expect(column(schema.modelCatalog, 'id').primary).toBe(true);
  });

  it('enforces UNIQUE(model_id) — one row per model', () => {
    expect(uniqueShapes(schema.modelCatalog)).toContainEqual({
      name: 'model_catalog_model_id_unique',
      columns: ['model_id'],
    });
  });

  it('has no version column', () => {
    expect(getTableConfig(schema.modelCatalog).columns.map((c) => c.name)).not.toContain('version');
  });

  it('persists the descriptor as jsonb', () => {
    expect(column(schema.modelCatalog, 'descriptor').getSQLType()).toBe('jsonb');
  });
});

describe('idempotency_keys', () => {
  it('scopes keys by (user_id, route, key)', () => {
    expect(uniqueShapes(schema.idempotencyKeys)).toContainEqual({
      name: 'idempotency_keys_scope_unique',
      columns: ['user_id', 'route', 'key'],
    });
  });

  it('splits the dual lifecycle with the kind pgEnum', () => {
    expect(column(schema.idempotencyKeys, 'kind').getSQLType()).toBe('idempotency_key_kind');
  });

  it('tracks the outcome state machine with a pgEnum', () => {
    expect(column(schema.idempotencyKeys, 'status').getSQLType()).toBe('idempotency_key_status');
  });

  it('stores the canonical body hash', () => {
    expect(column(schema.idempotencyKeys, 'body_hash').notNull).toBe(true);
  });

  it('carries the claims/claimedBy completion fence', () => {
    expect(column(schema.idempotencyKeys, 'claims').getSQLType()).toBe('integer');
    expect(column(schema.idempotencyKeys, 'claims').notNull).toBe(true);
    expect(column(schema.idempotencyKeys, 'claimed_by').notNull).toBe(true);
  });

  it('anchors the heartbeat lease on claimed_at', () => {
    const c = column(schema.idempotencyKeys, 'claimed_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(true);
  });

  it('carries a plain run_id for kind=run rows', () => {
    const c = column(schema.idempotencyKeys, 'run_id');
    expect(c.getSQLType()).toBe('uuid');
    expect(c.notNull).toBe(false);
  });

  it('stores the replayable response', () => {
    expect(column(schema.idempotencyKeys, 'response').getSQLType()).toBe('jsonb');
  });
});

describe('admin_audit', () => {
  it('records actor, action, and target', () => {
    expect(column(schema.adminAudit, 'actor').notNull).toBe(true);
    expect(column(schema.adminAudit, 'action').notNull).toBe(true);
    expect(column(schema.adminAudit, 'target_type').notNull).toBe(false);
    expect(column(schema.adminAudit, 'target_id').notNull).toBe(false);
  });

  it('timestamps every entry', () => {
    expect(column(schema.adminAudit, 'created_at').notNull).toBe(true);
  });
});

describe('device_tokens', () => {
  it('types platform with a pgEnum', () => {
    expect(column(schema.deviceTokens, 'platform').getSQLType()).toBe('device_platform');
  });

  it('keeps tokens unique', () => {
    expect(column(schema.deviceTokens, 'token').isUnique).toBe(true);
  });

  it('cascades with its user', () => {
    expect(findForeignKey(schema.deviceTokens, ['user_id']).onDelete).toBe('cascade');
  });
});

describe('custom_instructions', () => {
  it('keeps one encrypted instruction row per user', () => {
    const c = column(schema.customInstructions, 'user_id');
    expect(c.isUnique).toBe(true);
    expect(findForeignKey(schema.customInstructions, ['user_id']).onDelete).toBe('cascade');
  });

  it('stores the instructions as an encrypted blob', () => {
    const c = column(schema.customInstructions, 'encrypted_instructions');
    expect(c.getSQLType()).toBe('bytea');
    expect(c.notNull).toBe(true);
  });
});

describe('preferences', () => {
  it('keeps one preferences row per user', () => {
    const c = column(schema.preferences, 'user_id');
    expect(c.isUnique).toBe(true);
    expect(findForeignKey(schema.preferences, ['user_id']).onDelete).toBe('cascade');
  });

  it('stores accessibility preferences as non-null jsonb with a default', () => {
    const c = column(schema.preferences, 'accessibility');
    expect(c.getSQLType()).toBe('jsonb');
    expect(c.notNull).toBe(true);
    expect(hasDefault(schema.preferences, 'accessibility')).toBe(true);
  });
});

describe('verification_tokens', () => {
  it('keeps tokens unique', () => {
    expect(column(schema.verificationTokens, 'token').isUnique).toBe(true);
  });

  it('types purpose with a pgEnum', () => {
    expect(column(schema.verificationTokens, 'purpose').getSQLType()).toBe('verification_purpose');
  });

  it('expires', () => {
    expect(column(schema.verificationTokens, 'expires_at').notNull).toBe(true);
  });

  it('cascades with its user', () => {
    expect(findForeignKey(schema.verificationTokens, ['user_id']).onDelete).toBe('cascade');
  });
});
