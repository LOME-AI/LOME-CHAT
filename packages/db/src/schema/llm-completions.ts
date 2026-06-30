import { integer, jsonb, pgTable, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { usageRecords } from './usage-records';
import type { PersistedToolStep } from '@hushbox/shared';

export const llmCompletions = pgTable('llm_completions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  usageRecordId: uuid('usage_record_id')
    .notNull()
    .unique()
    .references(() => usageRecords.id, { onDelete: 'cascade' }),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
  // One gateway generation per agentic step with that step's tool activity
  toolSteps: jsonb('tool_steps')
    .$type<PersistedToolStep[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
});
