import { z } from 'zod';
import { MAX_CONVERSATION_MEMBERS, MEMBER_PRIVILEGES, fromBase64 } from '@hushbox/shared';

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
        // eslint-disable-next-line catch-swallow/no-silent-catch -- base64 validity predicate: a decode failure makes refine return false (zod surfaces it).
      } catch {
        return false;
      }
    }, 'must be valid base64');
}

const KEY_MATERIAL_MAX = 4096;
const TITLE_MAX = 65_536;
export const FORK_NAME_MAX_LENGTH = 100;
export const SHARE_DISPLAY_NAME_MAX_LENGTH = 200;

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
  .refine(
    (body) =>
      !body.giveFullHistory || (body.wrap !== undefined && body.expectedEpoch !== undefined),
    {
      message: 'full history requires wrap and expectedEpoch',
    }
  )
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

/**
 * The full privilege set is accepted (including `owner`) so a grant that
 * exceeds the caller is refused as `forbidden` by the privilege ladder — the
 * exact legacy behavior — rather than as a schema-validation error.
 */
export const changePrivilegeBodySchema = z.object({
  privilege: z.enum(MEMBER_PRIVILEGES),
});

/**
 * The owner's title update. `title` is opaque ciphertext (base64, decoded
 * in-domain, never inspected); `titleEpochNumber` is the epoch the client
 * encrypted the title under.
 */
export const updateTitleBodySchema = z.object({
  title: base64Field(TITLE_MAX),
  titleEpochNumber: z.number().int(),
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

export const conversationIdParameterSchema = z.object({ conversationId: z.uuid() });

/**
 * The batch keychain query: a comma-separated list of up to 100 conversation
 * ids. A read (no state change), so it is a GET with a query — POST would force
 * an Idempotency-Key or an exemption that no pure read honestly fits.
 */
export const memberKeysBatchQuerySchema = z.object({
  conversationIds: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    )
    .pipe(z.array(z.uuid()).min(1).max(100)),
});

/** Cursor-paginated message history: `cursor` is the last sequence number seen. */
export const messageHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * A shared link mints a public, revocable/expiring window into a conversation
 * AND seats a real link-guest member (epoch-wrapped, read/write), so guests
 * participate like any member. The client generates `linkPublicKey`; its
 * uniqueness is the natural idempotency guard. `expiresAt` is an ISO instant
 * enforced lazily at the read path. Seating the guest needs epoch key material
 * exactly like adding a member (`addMemberBodySchema`): a `giveFullHistory`
 * mint carries `memberWrap` + `expectedEpoch` (the wrap of the current epoch
 * key to the link key), and a rotation mint carries a full `rotation` whose
 * wrap set also seats the new link key. `privilege` is stored on the member
 * row (`shared_links` has no privilege column); admin/owner are unreachable by
 * grant, so a link guest is read or write only.
 */
export const createLinkBodySchema = z
  .object({
    linkPublicKey: base64Field(KEY_MATERIAL_MAX),
    displayName: z.string().min(1).max(SHARE_DISPLAY_NAME_MAX_LENGTH).optional(),
    expiresAt: z.iso.datetime().optional(),
    privilege: z.enum(['read', 'write']),
    giveFullHistory: z.boolean(),
    /**
     * Full-history path: the epoch the `memberWrap` was built for. A rotation
     * between the client wrapping and the server applying makes the wrap
     * garbage, so the server asserts this against `currentEpoch` in-transaction.
     */
    expectedEpoch: z.number().int().min(1).optional(),
    memberWrap: base64Field(KEY_MATERIAL_MAX).optional(),
    rotation: rotationBodySchema.optional(),
  })
  .refine(
    (body) =>
      !body.giveFullHistory || (body.memberWrap !== undefined && body.expectedEpoch !== undefined),
    { message: 'full history requires memberWrap and expectedEpoch' }
  )
  .refine((body) => body.giveFullHistory || body.rotation !== undefined, {
    message: 'minting without full history requires a rotation',
  });

/**
 * Revoking a link removes its guest member with a departure rotation, so the
 * body carries the same rotation shape a member removal does: the remaining
 * members re-wrap to a key the revoked guest never held.
 */
export const revokeLinkBodySchema = z.object({
  rotation: rotationBodySchema,
});

export const createSharedMessageBodySchema = z.object({
  messageId: z.uuid(),
  /** Wrap of the message content key under the share secret; opaque to the API. */
  wrappedContentKey: base64Field(KEY_MATERIAL_MAX),
});

export const linkParameterSchema = z.object({
  conversationId: z.uuid(),
  linkId: z.uuid(),
});

/**
 * Admin-driven link privilege change. A link's privilege lives on its guest
 * member row (not a `shared_links` column), and a link guest is only ever a
 * reader or writer — never an admin/owner — so the body is that narrowed set.
 */
export const changeLinkPrivilegeBodySchema = z.object({
  privilege: z.enum(['read', 'write']),
});

/** Admin-driven link display-name change. */
export const changeLinkNameBodySchema = z.object({
  displayName: z.string().min(1).max(SHARE_DISPLAY_NAME_MAX_LENGTH),
});

/** A link guest renaming its own display label (its link's `displayName`). */
export const setMyNameBodySchema = z.object({
  displayName: z.string().min(1).max(SHARE_DISPLAY_NAME_MAX_LENGTH),
});

/** The unauthenticated public-read parameter: a share id and nothing else. */
export const shareIdParameterSchema = z.object({ shareId: z.uuid() });

export const memberParameterSchema = z.object({
  conversationId: z.uuid(),
  memberId: z.uuid(),
});

export const forkParameterSchema = z.object({
  conversationId: z.uuid(),
  forkId: z.uuid(),
});
