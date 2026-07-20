import { and, eq, isNull } from 'drizzle-orm';
import { conversationMembers, sharedLinks } from '@hushbox/db';
import { fromBase64 } from '@hushbox/shared';
import { findActiveSharedLink } from '../lib/db-helpers.js';
import { LINK_PUBLIC_KEY_HEADER } from './constants.js';
import type { AppEnv } from '../types.js';
import type { Context } from 'hono';

export interface ResolvedLinkGuest {
  linkId: string;
  publicKey: Uint8Array;
  displayName: string | null;
  member: { id: string; privilege: string; visibleFromEpoch: number };
}

export interface ResolvedLinkGuestByKey {
  linkId: string;
  publicKey: Uint8Array;
  conversationId: string;
  member: { id: string; privilege: string; visibleFromEpoch: number };
}

/**
 * Resolves a link guest from the request context.
 *
 * Reads `x-link-public-key` header and `conversationId` route param,
 * looks up the shared link and associated member row.
 *
 * Returns null if any lookup step fails (missing header, no shared link, no member).
 */
export async function resolveLinkGuest(c: Context<AppEnv>): Promise<ResolvedLinkGuest | null> {
  const linkPublicKeyBase64 = c.req.header(LINK_PUBLIC_KEY_HEADER) ?? c.req.query('linkPublicKey');
  const conversationId = c.req.param('conversationId');
  if (!linkPublicKeyBase64 || !conversationId) {
    return null;
  }

  const db = c.get('db');
  const linkPublicKeyBytes = fromBase64(linkPublicKeyBase64);
  const sharedLink = await findActiveSharedLink(db, conversationId, linkPublicKeyBytes);
  if (!sharedLink) {
    return null;
  }

  const member = await db
    .select({
      id: conversationMembers.id,
      privilege: conversationMembers.privilege,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.linkId, sharedLink.id), isNull(conversationMembers.leftAt)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!member) {
    return null;
  }

  return {
    linkId: sharedLink.id,
    publicKey: linkPublicKeyBytes,
    displayName: sharedLink.displayName,
    member,
  };
}

/**
 * Resolves a link guest using ONLY the `x-link-public-key` header / query
 * parameter — does not require a `:conversationId` route param. Useful for
 * routes that key off a different identifier (e.g. `/api/media/:contentItemId`)
 * but still need to admit link-guest callers. The link's `conversationId` is
 * returned in the result so the caller can scope downstream queries.
 *
 * `sharedLinks.linkPublicKey` is globally unique (see schema unique index
 * `shared_links_public_key_unique`), so this lookup is unambiguous.
 */
export async function resolveLinkGuestByKey(
  c: Context<AppEnv>
): Promise<ResolvedLinkGuestByKey | null> {
  const linkPublicKeyBase64 = c.req.header(LINK_PUBLIC_KEY_HEADER) ?? c.req.query('linkPublicKey');
  if (!linkPublicKeyBase64) return null;

  const db = c.get('db');
  const linkPublicKeyBytes = fromBase64(linkPublicKeyBase64);

  const [link] = await db
    .select({ id: sharedLinks.id, conversationId: sharedLinks.conversationId })
    .from(sharedLinks)
    .where(and(eq(sharedLinks.linkPublicKey, linkPublicKeyBytes), isNull(sharedLinks.revokedAt)))
    .limit(1);

  if (!link) return null;

  const [member] = await db
    .select({
      id: conversationMembers.id,
      privilege: conversationMembers.privilege,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.linkId, link.id), isNull(conversationMembers.leftAt)))
    .limit(1);

  if (!member) return null;

  return {
    linkId: link.id,
    publicKey: linkPublicKeyBytes,
    conversationId: link.conversationId,
    member,
  };
}
