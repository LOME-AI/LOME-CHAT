import { ERROR_CODE_UNAUTHORIZED, ERROR_CODE_LINK_NOT_FOUND } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { resolveLinkGuest } from './resolve-link-guest.js';
import { LINK_PUBLIC_KEY_HEADER } from './constants.js';
import type { AppEnv } from '../types.js';
import type { Context, Next, MiddlewareHandler } from 'hono';

async function linkGuestHandler(c: Context<AppEnv>, next: Next): Promise<Response | undefined> {
  const linkPublicKeyBase64 = c.req.header(LINK_PUBLIC_KEY_HEADER);
  if (!linkPublicKeyBase64) {
    return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
  }

  const resolved = await resolveLinkGuest(c);
  if (!resolved) {
    // Differentiate: header was present but link/member not found
    const conversationId = c.req.param('conversationId');
    if (!conversationId) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
  }

  c.set('linkGuest', { linkId: resolved.linkId, publicKey: resolved.publicKey });
  const conversationId = c.req.param('conversationId');
  if (!conversationId) throw new Error('conversationId param required for requireLinkGuest');
  c.set(
    'members',
    new Map([
      [
        conversationId,
        {
          id: resolved.member.id,
          privilege: resolved.member.privilege,
          visibleFromEpoch: resolved.member.visibleFromEpoch,
        },
      ],
    ])
  );

  // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition -- Hono's next() returns void | Response; we must propagate the response
  return (await next()) ?? undefined;
}

/**
 * Standalone middleware for link-guest-only endpoints.
 *
 * Reads `x-link-public-key` header and `conversationId` route param.
 * Resolves the shared link and associated member.
 *
 * On success, sets `c.set('linkGuest', ...)` and `c.set('members', Map)`.
 * Returns 401 if no header, 404 if link or member not found.
 */
export function requireLinkGuest(): MiddlewareHandler<AppEnv> {
  return linkGuestHandler;
}
