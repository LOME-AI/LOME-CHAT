import { createEnvUtilities, ERROR_CODE_NOT_FOUND } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { MiddlewareHandler } from 'hono';

interface DevOnlyBindings {
  NODE_ENV?: string;
}

export function devOnly(): MiddlewareHandler<{ Bindings: DevOnlyBindings }> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next): Promise<Response | undefined> => {
    const env = createEnvUtilities(c.env);
    // Fail closed: only an explicit development mode unlocks dev-only routes.
    // Any non-dev mode (production, or an unrecognized NODE_ENV) is denied, so a
    // misconfigured or unknown environment never silently exposes these routes.
    if (!env.isDev) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }
    await next();
    return undefined;
  };
}
