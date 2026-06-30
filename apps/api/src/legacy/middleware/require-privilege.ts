import { eq, and, isNull, inArray } from 'drizzle-orm';
import { conversationMembers, conversations } from '@hushbox/db';
import {
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  getPrivilegeLevel,
} from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { resolveLinkGuest } from './resolve-link-guest.js';
import { LINK_PUBLIC_KEY_HEADER } from './constants.js';
import type { AppEnv } from '../types.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { Context, MiddlewareHandler, Next } from 'hono';

interface PrivilegeOptions {
  /** When true, allows link guests (via x-link-public-key header) when no session user is present. Only valid for single-conversation requests. */
  allowLinkGuest?: boolean;
  /** When true, queries conversation owner and sets `c.set('conversationOwnerId', ownerId)`. Only valid for single-conversation requests. */
  includeOwnerId?: boolean;
  /** Extracts conversation IDs from the request. Defaults to reading `:conversationId` route param. */
  resolve?: (c: Context<AppEnv>) => string[];
}

/** Looks up the conversation owner userId. Returns null if conversation not found. */
async function lookupConversationOwner(
  db: Database,
  conversationId: string
): Promise<string | null> {
  const row = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .then((rows) => rows[0]);
  return row?.userId ?? null;
}

/**
 * Sets conversationOwnerId on context. Returns 404 response if conversation not found.
 */
async function setConversationOwner(
  c: Context<AppEnv>,
  db: Database,
  conversationId: string
): Promise<Response | undefined> {
  const ownerId = await lookupConversationOwner(db, conversationId);
  if (!ownerId) {
    return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
  }
  c.set('conversationOwnerId', ownerId);
  return undefined;
}

/**
 * Batch membership lookup. Returns a map of conversationId → member row
 * for all conversations where the user is an active member.
 */
async function lookupMembers(
  db: Database,
  conversationIds: string[],
  userId: string
): Promise<Map<string, { id: string; privilege: string; visibleFromEpoch: number }>> {
  const rows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      id: conversationMembers.id,
      privilege: conversationMembers.privilege,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, conversationIds),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt)
      )
    );

  const map = new Map<string, { id: string; privilege: string; visibleFromEpoch: number }>();
  for (const row of rows) {
    map.set(row.conversationId, {
      id: row.id,
      privilege: row.privilege,
      visibleFromEpoch: row.visibleFromEpoch,
    });
  }
  return map;
}

/**
 * Attempts to resolve a link guest and set context variables.
 * Returns a Response (error or next()) on success/failure, or null if resolution fails entirely.
 */
interface ResolveLinkGuestOptions {
  c: Context<AppEnv>;
  conversationId: string;
  minLevel: MemberPrivilege;
  includeOwnerId: boolean;
  next: Next;
}

async function tryResolveLinkGuest(
  options: ResolveLinkGuestOptions
): Promise<Response | null | undefined> {
  const { c, conversationId, minLevel, includeOwnerId, next } = options;
  const resolved = await resolveLinkGuest(c);
  if (!resolved) {
    return null;
  }
  if (getPrivilegeLevel(resolved.member.privilege) < getPrivilegeLevel(minLevel)) {
    return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
  }
  c.set('linkGuest', { linkId: resolved.linkId, publicKey: resolved.publicKey });
  c.set('callerId', resolved.linkId);
  c.set('members', new Map([[conversationId, resolved.member]]));

  if (includeOwnerId) {
    const errorResponse = await setConversationOwner(c, c.get('db'), conversationId);
    if (errorResponse) return errorResponse;
  }

  // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition -- Hono's next() returns void | Response; we must propagate the response
  return (await next()) ?? undefined;
}

interface LinkGuestFallbackOptions {
  c: Context<AppEnv>;
  conversationId: string;
  minLevel: MemberPrivilege;
  includeOwnerId: boolean;
  allowLinkGuest: boolean;
  next: Next;
}

/** Attempts link guest fallback. Returns a response/next result, or null if it fails. */
async function tryLinkGuestFallback(
  options: LinkGuestFallbackOptions
): Promise<Response | null | undefined> {
  if (!options.allowLinkGuest) return null;
  return tryResolveLinkGuest({
    c: options.c,
    conversationId: options.conversationId,
    minLevel: options.minLevel,
    includeOwnerId: options.includeOwnerId,
    next: options.next,
  });
}

function defaultResolve(c: Context<AppEnv>): string[] {
  const conversationId = c.req.param('conversationId');
  return conversationId ? [conversationId] : [];
}

/**
 * Middleware that verifies the authenticated user is a member of the conversation(s)
 * and holds at least `minLevel` privilege in each.
 *
 * Conversation IDs are obtained via the `resolve` option (defaults to reading
 * `:conversationId` route param). The middleware always works with an array of IDs.
 *
 * When `allowLinkGuest` is true and a single conversation ID is resolved, falls back
 * to resolving a link guest via the `x-link-public-key` header.
 *
 * On success, sets `c.set('members', Map<conversationId, Member>)` for downstream handlers.
 */
export function requirePrivilege(
  minLevel: MemberPrivilege,
  options?: PrivilegeOptions
): MiddlewareHandler<AppEnv> {
  const {
    allowLinkGuest = false,
    includeOwnerId = false,
    resolve = defaultResolve,
  } = options ?? {};

  return async (c, next) => {
    const user = c.get('user');
    const conversationIds = resolve(c);

    if (conversationIds.length === 0) {
      return c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400);
    }

    if (!user) {
      return handleUnauthenticated(c, conversationIds, {
        minLevel,
        includeOwnerId,
        allowLinkGuest,
        next,
      });
    }

    const db = c.get('db');

    // Link guest takes priority when link key is present (single-conversation only)
    if (conversationIds.length === 1 && allowLinkGuest) {
      const hasLinkKey = Boolean(
        c.req.header(LINK_PUBLIC_KEY_HEADER) ?? c.req.query('linkPublicKey')
      );
      if (hasLinkKey) {
        const [singleId] = conversationIds;
        if (singleId) {
          return handleLinkGuestOnly(c, singleId, {
            minLevel,
            includeOwnerId,
            allowLinkGuest,
            next,
          });
        }
      }
    }

    return handleAuthenticatedUser(c, {
      db,
      conversationIds,
      user,
      minLevel,
      includeOwnerId,
      allowLinkGuest,
      next,
    });
  };
}

/** Handles the case where no session user exists. */
async function handleUnauthenticated(
  c: Context<AppEnv>,
  conversationIds: string[],
  options: {
    minLevel: MemberPrivilege;
    includeOwnerId: boolean;
    allowLinkGuest: boolean;
    next: Next;
  }
): Promise<Response | undefined> {
  const [singleId] = conversationIds;
  if (singleId && conversationIds.length === 1 && options.allowLinkGuest) {
    const fallback = await tryLinkGuestFallback({
      c,
      conversationId: singleId,
      ...options,
    });
    if (fallback !== null) return fallback;
  }
  return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
}

/** Handles the link-key-first path (link key present, allowLinkGuest true, single conversation). */
async function handleLinkGuestOnly(
  c: Context<AppEnv>,
  conversationId: string,
  options: {
    minLevel: MemberPrivilege;
    includeOwnerId: boolean;
    allowLinkGuest: boolean;
    next: Next;
  }
): Promise<Response | undefined> {
  const fallback = await tryLinkGuestFallback({
    c,
    conversationId,
    ...options,
  });
  if (fallback !== null) return fallback;
  return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
}

interface AuthenticatedUserOptions {
  db: Database;
  conversationIds: string[];
  user: { id: string };
  minLevel: MemberPrivilege;
  includeOwnerId: boolean;
  allowLinkGuest: boolean;
  next: Next;
}

/** Handles the authenticated-user membership path. */
async function handleAuthenticatedUser(
  c: Context<AppEnv>,
  options: AuthenticatedUserOptions
): Promise<Response | undefined> {
  const members = await lookupMembers(options.db, options.conversationIds, options.user.id);

  // All-or-nothing: if any requested conversation is missing, deny the request
  if (members.size !== options.conversationIds.length) {
    // For single-conversation requests, try link guest fallback before denying
    const [singleId] = options.conversationIds;
    if (singleId && options.conversationIds.length === 1 && options.allowLinkGuest) {
      const fallback = await tryLinkGuestFallback({
        c,
        conversationId: singleId,
        minLevel: options.minLevel,
        includeOwnerId: options.includeOwnerId,
        allowLinkGuest: options.allowLinkGuest,
        next: options.next,
      });
      if (fallback !== null) return fallback;
    }
    return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
  }

  // Check privilege level for all members
  for (const member of members.values()) {
    if (getPrivilegeLevel(member.privilege) < getPrivilegeLevel(options.minLevel)) {
      return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
    }
  }

  c.set('callerId', options.user.id);
  c.set('members', members);

  return finalizeMemberContext({
    c,
    db: options.db,
    conversationIds: options.conversationIds,
    includeOwnerId: options.includeOwnerId,
    next: options.next,
  });
}

interface FinalizeMemberContextOptions {
  c: Context<AppEnv>;
  db: Database;
  conversationIds: string[];
  includeOwnerId: boolean;
  next: Next;
}

/** Sets conversation owner if needed (single-conversation only), then calls next(). */
async function finalizeMemberContext(
  options: FinalizeMemberContextOptions
): Promise<Response | undefined> {
  const [singleConvId] = options.conversationIds;
  if (options.includeOwnerId && singleConvId && options.conversationIds.length === 1) {
    const errorResponse = await setConversationOwner(options.c, options.db, singleConvId);
    if (errorResponse) return errorResponse;
  }
  // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition -- Hono's next() returns void | Response; we must propagate the response
  return (await options.next()) ?? undefined;
}
