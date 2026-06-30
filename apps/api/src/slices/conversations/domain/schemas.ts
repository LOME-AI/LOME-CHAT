import { z } from 'zod';
import { MAX_CONVERSATION_MEMBERS, fromBase64 } from '@hushbox/shared';

/**
 * Request bodies for the conversations surface. All ciphertext and key
 * material travels base64-encoded and stays opaque to the API; ids the
 * client supplies are validated as uuids but never trusted for identity —
 * the caller is always `c.var.principal`.
 */

/** Encoded-length caps bound payloads; decode is the real validity check. */
function base64Field(maxLength: number): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => {
      try {
        fromBase64(value);
        return true;
      } catch {
        return false;
      }
    }, 'must be valid base64');
}

const KEY_MATERIAL_MAX = 4096;
const TITLE_MAX = 65_536;
export const FORK_NAME_MAX_LENGTH = 100;

export const createConversationBodySchema = z.object({
  /** Client-generated uuid: the natural idempotency key of the bootstrap. */
  id: z.uuid(),
  title: base64Field(TITLE_MAX).optional(),
  epochPublicKey: base64Field(KEY_MATERIAL_MAX),
  confirmationHash: base64Field(KEY_MATERIAL_MAX),
  /** The owner's ECIES wrap of the first epoch key. */
  memberWrap: base64Field(KEY_MATERIAL_MAX),
});

export const rotationBodySchema = z.object({
  expectedEpoch: z.number().int().min(1),
  epochPublicKey: base64Field(KEY_MATERIAL_MAX),
  confirmationHash: base64Field(KEY_MATERIAL_MAX),
  chainLink: base64Field(KEY_MATERIAL_MAX),
  memberWraps: z
    .array(
      z.object({
        memberPublicKey: base64Field(KEY_MATERIAL_MAX),
        wrap: base64Field(KEY_MATERIAL_MAX),
      })
    )
    .min(1)
    .max(MAX_CONVERSATION_MEMBERS),
  encryptedTitle: base64Field(TITLE_MAX),
});

export type RotationBody = z.infer<typeof rotationBodySchema>;

export const addMemberBodySchema = z
  .object({
    userId: z.uuid(),
    /** Owner is unreachable by grant: a conversation has exactly one. */
    privilege: z.enum(['read', 'write', 'admin']),
    giveFullHistory: z.boolean(),
    /**
     * Full-history path: the epoch the wrap was built for. A rotation between
     * the client wrapping and the server applying makes the wrap garbage, so
     * the server asserts this against `currentEpoch` in-transaction.
     */
    expectedEpoch: z.number().int().min(1).optional(),
    wrap: base64Field(KEY_MATERIAL_MAX).optional(),
    rotation: rotationBodySchema.optional(),
  })
  .refine((body) => !body.giveFullHistory || (body.wrap !== undefined && body.expectedEpoch !== undefined), {
    message: 'full history requires wrap and expectedEpoch',
  })
  .refine((body) => body.giveFullHistory || body.rotation !== undefined, {
    message: 'adding without history requires a rotation',
  });

export type AddMemberBody = z.infer<typeof addMemberBodySchema>;

export const removeMemberBodySchema = z.object({
  rotation: rotationBodySchema,
});

export const leaveBodySchema = z.object({
  /** Required for non-owners; the owner's leave deletes the conversation. */
  rotation: rotationBodySchema.optional(),
});

export const muteBodySchema = z.object({ muted: z.boolean() });

export const pinBodySchema = z.object({ pinned: z.boolean() });

export const createForkBodySchema = z.object({
  /** Client-generated uuid: the natural idempotency key of the fork. */
  id: z.uuid(),
  fromMessageId: z.uuid(),
  name: z.string().min(1).max(FORK_NAME_MAX_LENGTH).optional(),
});

export const renameForkBodySchema = z.object({
  name: z.string().min(1).max(FORK_NAME_MAX_LENGTH),
});

export const updateForkTipBodySchema = z.object({
  tipMessageId: z.uuid(),
  /** The expected-state guard: null asserts the fork currently has no tip. */
  expectedTipMessageId: z.uuid().nullable(),
});

export const listConversationsQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const conversationIdParamSchema = z.object({ conversationId: z.uuid() });

export const memberParamSchema = z.object({
  conversationId: z.uuid(),
  memberId: z.uuid(),
});

export const forkParamSchema = z.object({
  conversationId: z.uuid(),
  forkId: z.uuid(),
});
