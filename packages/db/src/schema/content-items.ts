import {
  pgTable,
  bigint,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { contentItemTypeEnum } from './enums';
import { messages } from './messages';

export const contentItems = pgTable(
  'content_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    contentType: contentItemTypeEnum('content_type').notNull(),
    position: integer('position').notNull().default(0),

    encryptedBlob: bytea('encrypted_blob'),

    // Storage keys are uuid-keyed R2 paths, never content-addressed
    storageKey: text('storage_key'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),

    // The generating model and provider as plain strings — no FK into
    // model_catalog (mirrors usage_records; the models slice no longer owns a
    // row this content depends on).
    modelId: text('model_id'),
    providerName: text('provider_name'),
    costNanoUsd: bigint('cost_nano_usd', { mode: 'bigint' }),
    isSmartModel: boolean('is_smart_model').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('content_items_message_id_position_idx').on(table.messageId, table.position),
    uniqueIndex('content_items_storage_key_unique')
      .on(table.storageKey)
      .where(isNotNull(table.storageKey)),
    index('content_items_model_id_idx').on(table.modelId).where(isNotNull(table.modelId)),
    check(
      'content_items_type_consistency',
      sql`
        (${table.contentType} = 'text'
          AND ${table.encryptedBlob} IS NOT NULL
          AND ${table.storageKey} IS NULL
          AND ${table.mimeType} IS NULL
          AND ${table.sizeBytes} IS NULL)
        OR (${table.contentType} IN ('image', 'audio', 'video')
          AND ${table.storageKey} IS NOT NULL
          AND ${table.mimeType} IS NOT NULL
          AND ${table.sizeBytes} IS NOT NULL
          AND ${table.encryptedBlob} IS NULL)
      `
    ),
  ]
);
