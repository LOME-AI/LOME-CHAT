import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { usageRecords } from '../schema/usage-records';

type UsageRecord = typeof usageRecords.$inferSelect;

export const usageRecordFactory = Factory.define<UsageRecord>(({ params }) => {
  const status = params.status ?? 'completed';
  const now = faker.date.recent();

  return {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    type: 'llm_completion',
    status,
    cost: faker.number.float({ min: 0.001, max: 5, fractionDigits: 8 }).toFixed(8),
    isEstimated: false,
    sourceType: 'message',
    sourceId: crypto.randomUUID(),
    createdAt: now,
    completedAt: status === 'completed' ? faker.date.recent({ refDate: now }) : null,
  };
});
