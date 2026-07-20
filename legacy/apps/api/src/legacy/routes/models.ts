import { Hono } from 'hono';
import { z } from 'zod';
import { modelSchema } from '@hushbox/shared';
import { getProcessedCatalog } from '../lib/processed-catalog.js';
import type { AppEnv } from '../types.js';

const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

export const modelsRoute = new Hono<AppEnv>().get('/', async (c) => {
  const { models, premiumIds } = await getProcessedCatalog(c);
  const response = modelsListResponseSchema.parse({
    models,
    premiumModelIds: premiumIds,
  });
  return c.json(response, 200);
});
