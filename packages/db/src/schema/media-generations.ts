import { pgTable, integer, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { modalityEnum } from './enums';
import { usageRecords } from './usage-records';

export const mediaGenerations = pgTable('media_generations', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  usageRecordId: uuid('usage_record_id')
    .notNull()
    .unique()
    .references(() => usageRecords.id, { onDelete: 'cascade' }),
  modality: modalityEnum('modality').notNull(),
  imageCount: integer('image_count'),
  durationMs: integer('duration_ms'),
  resolution: text('resolution'),
});
