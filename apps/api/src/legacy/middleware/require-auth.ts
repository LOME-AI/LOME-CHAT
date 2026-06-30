import { ERROR_CODE_NOT_AUTHENTICATED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

/**
 * Middleware that requires authentication.
 * Returns 401 if no user is set on context.
 * Sets `callerId = user.id` so downstream middleware (rate limiters, etc.)
 * can address the principal uniformly with `requirePrivilege`-served routes.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }
    c.set('callerId', user.id);
    return next();
  };
}
