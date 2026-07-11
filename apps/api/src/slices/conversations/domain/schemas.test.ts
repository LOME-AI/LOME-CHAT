import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import {
  addMemberBodySchema,
  createConversationBodySchema,
  createForkBodySchema,
  createLinkBodySchema,
  createSharedMessageBodySchema,
  linkIdParameterSchema,
  linkParameterSchema,
  listConversationsQuerySchema,
  muteBodySchema,
  pinBodySchema,
  removeMemberBodySchema,
  renameForkBodySchema,
  revokeLinkBodySchema,
  rotationBodySchema,
  updateForkTipBodySchema,
} from './schemas.js';

const B64 = toBase64(new Uint8Array([1, 2, 3]));
const UUID = '0197a000-0000-7000-8000-000000000001';

const rotation = {
  expectedEpoch: 1,
  epochPublicKey: B64,
  confirmationHash: B64,
  chainLink: B64,
  memberWraps: [{ memberPublicKey: B64, wrap: B64 }],
  encryptedTitle: B64,
};

describe('createConversationBodySchema', () => {
  const body = {
    id: UUID,
    title: B64,
    epochPublicKey: B64,
    confirmationHash: B64,
    memberWrap: B64,
  };

  it('accepts a complete create body', () => {
    expect(createConversationBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts an absent title (untitled conversation)', () => {
    const rest: Record<string, unknown> = { ...body };
    delete rest['title'];
    expect(createConversationBodySchema.safeParse(rest).success).toBe(true);
  });

  it('rejects a non-uuid id', () => {
    expect(createConversationBodySchema.safeParse({ ...body, id: 'nope' }).success).toBe(false);
  });

  it('rejects a non-base64 epoch public key', () => {
    expect(createConversationBodySchema.safeParse({ ...body, epochPublicKey: '!!!' }).success).toBe(
      false
    );
  });
});

describe('rotationBodySchema', () => {
  it('accepts a complete rotation', () => {
    expect(rotationBodySchema.safeParse(rotation).success).toBe(true);
  });

  it('rejects an expectedEpoch below 1', () => {
    expect(rotationBodySchema.safeParse({ ...rotation, expectedEpoch: 0 }).success).toBe(false);
  });

  it('rejects an empty wrap set', () => {
    expect(rotationBodySchema.safeParse({ ...rotation, memberWraps: [] }).success).toBe(false);
  });
});

describe('addMemberBodySchema', () => {
  const base = { userId: UUID, privilege: 'write', giveFullHistory: true };

  it('accepts a full-history add carrying a wrap and the expected epoch', () => {
    expect(addMemberBodySchema.safeParse({ ...base, wrap: B64, expectedEpoch: 1 }).success).toBe(
      true
    );
  });

  it('rejects a full-history add without a wrap', () => {
    expect(addMemberBodySchema.safeParse({ ...base, expectedEpoch: 1 }).success).toBe(false);
  });

  it('rejects a full-history add without an expected epoch', () => {
    expect(addMemberBodySchema.safeParse({ ...base, wrap: B64 }).success).toBe(false);
  });

  it('accepts a rotation add without history', () => {
    expect(
      addMemberBodySchema.safeParse({ ...base, giveFullHistory: false, rotation }).success
    ).toBe(true);
  });

  it('rejects a no-history add without a rotation', () => {
    expect(addMemberBodySchema.safeParse({ ...base, giveFullHistory: false }).success).toBe(false);
  });

  it('rejects granting the owner privilege', () => {
    expect(
      addMemberBodySchema.safeParse({ ...base, privilege: 'owner', wrap: B64, expectedEpoch: 1 })
        .success
    ).toBe(false);
  });
});

describe('removeMemberBodySchema', () => {
  it('requires a rotation', () => {
    expect(removeMemberBodySchema.safeParse({}).success).toBe(false);
    expect(removeMemberBodySchema.safeParse({ rotation }).success).toBe(true);
  });
});

describe('mute and pin bodies', () => {
  it('requires a boolean muted flag', () => {
    expect(muteBodySchema.safeParse({ muted: true }).success).toBe(true);
    expect(muteBodySchema.safeParse({ muted: 'yes' }).success).toBe(false);
  });

  it('requires a boolean pinned flag', () => {
    expect(pinBodySchema.safeParse({ pinned: false }).success).toBe(true);
    expect(pinBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('fork bodies', () => {
  it('accepts a create with a client-generated id and source message', () => {
    expect(createForkBodySchema.safeParse({ id: UUID, fromMessageId: UUID }).success).toBe(true);
  });

  it('rejects a blank fork name', () => {
    expect(
      createForkBodySchema.safeParse({ id: UUID, fromMessageId: UUID, name: '' }).success
    ).toBe(false);
  });

  it('rejects a rename over the length cap', () => {
    expect(renameForkBodySchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
  });

  it('accepts a tip update expecting no prior tip', () => {
    expect(
      updateForkTipBodySchema.safeParse({ tipMessageId: UUID, expectedTipMessageId: null }).success
    ).toBe(true);
  });

  it('rejects a tip update without the expected-state field', () => {
    expect(updateForkTipBodySchema.safeParse({ tipMessageId: UUID }).success).toBe(false);
  });
});

describe('listConversationsQuerySchema', () => {
  it('coerces the limit and bounds it at 100', () => {
    expect(listConversationsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listConversationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('accepts an absent cursor', () => {
    expect(listConversationsQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe('createLinkBodySchema', () => {
  const fullHistory = {
    linkPublicKey: B64,
    privilege: 'read' as const,
    giveFullHistory: true,
    memberWrap: B64,
    expectedEpoch: 1,
  };

  it('accepts a full-history mint with a display name and ISO expiry', () => {
    expect(
      createLinkBodySchema.safeParse({
        ...fullHistory,
        displayName: 'My share',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }).success
    ).toBe(true);
  });

  it('accepts a rotation mint carrying a rotation and no full history', () => {
    expect(
      createLinkBodySchema.safeParse({
        linkPublicKey: B64,
        privilege: 'write',
        giveFullHistory: false,
        rotation,
      }).success
    ).toBe(true);
  });

  it('rejects a full-history mint missing its wrap material', () => {
    expect(
      createLinkBodySchema.safeParse({
        linkPublicKey: B64,
        privilege: 'read',
        giveFullHistory: true,
      }).success
    ).toBe(false);
  });

  it('rejects a mint without full history and without a rotation', () => {
    expect(
      createLinkBodySchema.safeParse({
        linkPublicKey: B64,
        privilege: 'read',
        giveFullHistory: false,
      }).success
    ).toBe(false);
  });

  it('rejects an admin privilege grant for a link guest', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, privilege: 'admin' }).success).toBe(
      false
    );
  });

  it('rejects a non-base64 public key', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, linkPublicKey: '@@@' }).success).toBe(
      false
    );
  });

  it('rejects a non-ISO expiry', () => {
    expect(createLinkBodySchema.safeParse({ ...fullHistory, expiresAt: 'tomorrow' }).success).toBe(
      false
    );
  });
});

describe('revokeLinkBodySchema', () => {
  it('requires a departure rotation', () => {
    expect(revokeLinkBodySchema.safeParse({ rotation }).success).toBe(true);
    expect(revokeLinkBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('createSharedMessageBodySchema', () => {
  it('accepts a message id, link id, and wrapped content key', () => {
    expect(
      createSharedMessageBodySchema.safeParse({
        messageId: UUID,
        linkId: UUID,
        wrappedContentKey: B64,
      }).success
    ).toBe(true);
  });

  it('rejects a non-uuid message id', () => {
    expect(
      createSharedMessageBodySchema.safeParse({
        messageId: 'nope',
        linkId: UUID,
        wrappedContentKey: B64,
      }).success
    ).toBe(false);
  });

  it('rejects a body without a link id', () => {
    expect(
      createSharedMessageBodySchema.safeParse({ messageId: UUID, wrappedContentKey: B64 }).success
    ).toBe(false);
  });

  it('rejects a non-uuid link id', () => {
    expect(
      createSharedMessageBodySchema.safeParse({
        messageId: UUID,
        linkId: 'nope',
        wrappedContentKey: B64,
      }).success
    ).toBe(false);
  });
});

describe('link parameter schemas', () => {
  it('accepts a conversation id and link id pair', () => {
    expect(linkParameterSchema.safeParse({ conversationId: UUID, linkId: UUID }).success).toBe(
      true
    );
  });

  it('accepts a bare link id for the public read', () => {
    expect(linkIdParameterSchema.safeParse({ linkId: UUID }).success).toBe(true);
  });

  it('rejects a non-uuid link id', () => {
    expect(linkIdParameterSchema.safeParse({ linkId: 'nope' }).success).toBe(false);
  });
});
