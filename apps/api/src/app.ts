import { Hono } from 'hono';
import { cors, errorHandler } from './middleware/index.js';
import { healthRoute, authRoute, conversationsRoute, chatRoute } from './routes/index.js';

export interface Bindings {
  DATABASE_URL: string;
  NODE_ENV?: string;
}

export function createApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use('*', cors());
  app.onError(errorHandler);

  app.route('/health', healthRoute);
  app.route('/auth', authRoute);
  app.route('/conversations', conversationsRoute);
  app.route('/chat', chatRoute);

  return app;
}
