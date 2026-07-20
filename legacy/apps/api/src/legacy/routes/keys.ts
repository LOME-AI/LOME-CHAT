import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_NOT_AUTHENTICATED,
  toBase64,
} from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { requirePrivilege } from '../middleware/index.js';
import {
  getKeyChain,
  getKeyChainBatch,
  getMemberKeys,
  verifyMembership,
  type KeyChainResult,
} from '../services/keys/index.js';
import type { AppEnv } from '../types.js';

interface SerializedKeyChain {
  wraps: {
    epochNumber: number;
    wrap: string;
    confirmationHash: string;
    visibleFromEpoch: number;
  }[];
  chainLinks: { epochNumber: number; chainLink: string; confirmationHash: string }[];
  currentEpoch: number;
}

function serializeKeyChain(result: KeyChainResult): SerializedKeyChain {
  return {
    wraps: result.wraps.map((w) => ({
      epochNumber: w.epochNumber,
      wrap: toBase64(w.wrap),
      confirmationHash: toBase64(w.confirmationHash),
      visibleFromEpoch: w.visibleFromEpoch,
    })),
    chainLinks: result.chainLinks.map((cl) => ({
      epochNumber: cl.epochNumber,
      chainLink: toBase64(cl.chainLink),
      confirmationHash: toBase64(cl.confirmationHash),
    })),
    currentEpoch: result.currentEpoch,
  };
}

export const keysRoute = new Hono<AppEnv>()
  // Partial-result endpoint: returns per-conversation results plus a `missing`
  // array for ids the caller cannot access. The frontend's conversation list
  // refreshes asynchronously after WebSocket-driven membership changes; an
  // all-or-nothing 404 would surface as a transient error on every epoch
  // rotation, leave, or remove. Membership is enforced by `getKeyChainBatch`
  // (filters wraps by `epochMembers.memberPublicKey`), so unauthorized ids
  // never appear in `keys`.
  .post(
    '/batch',
    zValidator('json', z.object({ conversationIds: z.array(z.string()).min(1).max(100) })),
    async (c) => {
      const user = c.get('user');
      if (!user) return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
      const db = c.get('db');
      const { conversationIds } = c.req.valid('json');

      const batchResults = await getKeyChainBatch(db, conversationIds, user.publicKey);
      const keys: Record<string, SerializedKeyChain> = {};
      const missing: string[] = [];
      for (const id of conversationIds) {
        const result = batchResults.get(id);
        if (result) {
          keys[id] = serializeKeyChain(result);
        } else {
          missing.push(id);
        }
      }
      return c.json({ keys, missing }, 200);
    }
  )
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const publicKey = c.get('user')?.publicKey ?? c.get('linkGuest')?.publicKey;
      if (!publicKey) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const result = await getKeyChain(db, conversationId, publicKey);
      if (!result) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      return c.json(serializeKeyChain(result), 200);
    }
  )
  .get(
    '/:conversationId/member-keys',
    zValidator('param', z.object({ conversationId: z.string() })),
    // 'read' (not 'admin') — non-owner leave generates a rotation client-side,
    // and that rotation needs every active member's public key to re-wrap the
    // new epoch key. Locking this to admin+ blocks regular members from
    // leaving. The response is non-sensitive: every field except `publicKey`
    // is already on `GET /:conversationId` for read-level members, and public
    // keys are public crypto material by design. Mutations that USE the
    // returned keys (add/remove/revoke) keep their own `requirePrivilege`
    // gates independently.
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const membership = await verifyMembership(db, conversationId, user.id);
      if (!membership) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      const memberKeys = await getMemberKeys(db, conversationId);

      return c.json(
        {
          members: memberKeys.map((m) => ({
            memberId: m.memberId,
            userId: m.userId,
            linkId: m.linkId,
            publicKey: toBase64(m.publicKey),
            privilege: m.privilege,
            visibleFromEpoch: m.visibleFromEpoch,
          })),
        },
        200
      );
    }
  );
