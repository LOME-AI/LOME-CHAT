import type { MiddlewareHandler } from 'hono';

interface SessionData {
  user: unknown;
  session: unknown;
}

interface Auth {
  api: {
    getSession: (options: { headers: Headers }) => Promise<SessionData | null>;
  };
}

export function createSessionMiddleware(auth: Auth): MiddlewareHandler {
  return async (c, next) => {
    const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });

    if (sessionData) {
      c.set('user', sessionData.user);
      c.set('session', sessionData.session);
    } else {
      c.set('user', null);
      c.set('session', null);
    }

    await next();
  };
}
