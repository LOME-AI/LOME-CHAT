import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export const healthRoute = new Hono<AppEnv>().get('/', (c) => {
  return c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  });
});
