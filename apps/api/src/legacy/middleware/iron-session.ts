import { getIronSession } from 'iron-session';
import { createEnvUtilities } from '@hushbox/shared';
import { getSessionOptions, type SessionData } from '../lib/session.js';
import type { MiddlewareHandler } from 'hono';

interface IronSessionRequiredEnv {
  Bindings: {
    IRON_SESSION_SECRET?: string;
    NODE_ENV?: string;
  };
  Variables: {
    sessionData: SessionData | null;
  };
}

function isValidSession(session: unknown): session is SessionData {
  if (!session || typeof session !== 'object') {
    return false;
  }

  const s = session as Record<string, unknown>;
  return typeof s['userId'] === 'string' && s['userId'].length > 0;
}

/**
 * Iron-session middleware for OPAQUE authentication.
 *
 * Extracts session data from encrypted cookie and sets it on context.
 * Sets `sessionData` to null if no valid session exists.
 * Uses getSessionOptions() from session.ts for consistent cookie config.
 */
const ironSessionHandler: MiddlewareHandler<IronSessionRequiredEnv> = async (c, next) => {
  const secret = c.env.IRON_SESSION_SECRET;

  if (!secret) {
    c.set('sessionData', null);
    return next();
  }

  const { isProduction } = createEnvUtilities(c.env);
  const options = getSessionOptions(secret, isProduction);

  const session = await getIronSession<SessionData>(c.req.raw, c.res, options);

  if (isValidSession(session)) {
    c.set('sessionData', session);
  } else {
    c.set('sessionData', null);
  }

  return next();
};

export function createIronSessionMiddleware(): MiddlewareHandler<IronSessionRequiredEnv> {
  return ironSessionHandler;
}
