import { Hono } from 'hono';
import type { createAuth } from '../auth/index.js';

type Auth = ReturnType<typeof createAuth>;

export function createAuthRoutes(auth: Auth): Hono {
  const app = new Hono();

  // Mount Better Auth handler to process all auth requests
  app.all('/*', (c) => auth.handler(c.req.raw));

  return app;
}

// Legacy placeholder export for backwards compatibility during migration
// This will be replaced once the app is refactored to use createAuthRoutes
export const authRoute = new Hono()
  .post('/signup', (c) => c.json({ error: 'Not implemented' }, 501))
  .post('/login', (c) => c.json({ error: 'Not implemented' }, 501))
  .post('/logout', (c) => c.json({ error: 'Not implemented' }, 501))
  .get('/session', (c) => c.json({ error: 'Not implemented' }, 501));
