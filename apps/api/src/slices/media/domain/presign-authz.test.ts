import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { authorizePresign } from './presign-authz.js';
import type { PresignAuthzDeps, PresignPrincipal } from './presign-authz.js';
import type { MediaTarget, MemberRef, MessageShare } from '../ports/index.js';

const ITEM_ID = '0190b56a-0000-7aaa-bbbb-0123456789ab';
const CONVERSATION_ID = '0190b56a-1111-7aaa-bbbb-0123456789ab';
const EPOCH_ID = '0190b56a-2222-7aaa-bbbb-0123456789ab';
const STORAGE_KEY = `media/${CONVERSATION_ID}/0190b56a-3333-7aaa-bbbb-0123456789ab/0190b56a-4444-7aaa-bbbb-0123456789ab`;
const NOW = new Date('2026-06-11T12:00:00Z');

const USER: PresignPrincipal = { kind: 'user', userId: 'user-1' };
const LINK_GUEST: PresignPrincipal = { kind: 'linkGuest', linkId: 'link-1' };
const SHARE: PresignPrincipal = { kind: 'share', shareId: 'share-1' };

function mediaTarget(overrides: Partial<MediaTarget> = {}): MediaTarget {
  return {
    contentItemId: ITEM_ID,
    conversationId: CONVERSATION_ID,
    epochId: EPOCH_ID,
    contentType: 'image',
    storageKey: STORAGE_KEY,
    ...overrides,
  };
}

interface DepsOverrides {
  readonly target?: MediaTarget | null;
  readonly isActiveMember?: boolean;
  readonly isEpochMember?: boolean;
  readonly share?: MessageShare | null;
}

function makeDeps(overrides: DepsOverrides = {}): PresignAuthzDeps {
  return {
    contentItems: {
      findMediaTarget: () =>
        okAsync(overrides.target === undefined ? mediaTarget() : overrides.target),
    },
    membership: {
      isActiveMember: () => okAsync(overrides.isActiveMember ?? true),
      isEpochMember: () => okAsync(overrides.isEpochMember ?? true),
    },
    shares: {
      findShare: () => okAsync(overrides.share ?? null),
    },
    now: () => NOW,
  };
}

describe('authorizePresign — member path', () => {
  it('returns the storage key for a member with epoch access', async () => {
    const result = await authorizePresign(USER, ITEM_ID, makeDeps());
    expect(result._unsafeUnwrap()).toEqual({ storageKey: STORAGE_KEY });
  });

  it('returns not_found when the content item does not exist', async () => {
    const result = await authorizePresign(USER, ITEM_ID, makeDeps({ target: null }));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('returns not_found when the caller is not a conversation member', async () => {
    const result = await authorizePresign(USER, ITEM_ID, makeDeps({ isActiveMember: false }));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('denies a conversation member without an epoch_members row for the message epoch', async () => {
    const result = await authorizePresign(USER, ITEM_ID, makeDeps({ isEpochMember: false }));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('checks epoch membership for the message epoch with the authenticated caller identity', async () => {
    const seen: { epochId?: string; member?: MemberRef } = {};
    const deps = makeDeps();
    deps.membership = {
      isActiveMember: () => okAsync(true),
      isEpochMember: (epochId, member) => {
        seen.epochId = epochId;
        seen.member = member;
        return okAsync(true);
      },
    };
    const result = await authorizePresign(USER, ITEM_ID, deps);
    expect(result.isOk()).toBe(true);
    expect(seen).toEqual({ epochId: EPOCH_ID, member: { kind: 'user', userId: 'user-1' } });
  });

  it('denies an active late-joiner whose identity holds no epoch row, regardless of any key they present', async () => {
    // The old gate was keyed by a caller-supplied public key. Public keys are
    // not secrets (every member receives the others' keys for key-wrapping),
    // so an active late-joiner could present an original member's key and
    // pass the gate for an epoch they were never in. The gate must consult
    // the authenticated caller identity only.
    const consulted: MemberRef[] = [];
    const deps = makeDeps();
    deps.membership = {
      isActiveMember: () => okAsync(true),
      // Grants only for the identity that actually holds the epoch row.
      isEpochMember: (_epochId, member) => {
        consulted.push(member);
        return okAsync(member.kind === 'user' && member.userId === 'original-member');
      },
    };
    const result = await authorizePresign(USER, ITEM_ID, deps);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    expect(consulted).toEqual([{ kind: 'user', userId: 'user-1' }]);
  });

  it('returns the storage key for a link guest with epoch access', async () => {
    const result = await authorizePresign(LINK_GUEST, ITEM_ID, makeDeps());
    expect(result._unsafeUnwrap()).toEqual({ storageKey: STORAGE_KEY });
  });

  it('keys conversation membership by linkId for a link guest', async () => {
    const seen: { member?: unknown } = {};
    const deps = makeDeps();
    deps.membership = {
      isActiveMember: (_conversationId, member) => {
        seen.member = member;
        return okAsync(true);
      },
      isEpochMember: () => okAsync(true),
    };
    const result = await authorizePresign(LINK_GUEST, ITEM_ID, deps);
    expect(result.isOk()).toBe(true);
    expect(seen.member).toEqual({ kind: 'linkGuest', linkId: 'link-1' });
  });

  it('denies a link guest without epoch access', async () => {
    const result = await authorizePresign(LINK_GUEST, ITEM_ID, makeDeps({ isEpochMember: false }));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('returns validation for an authorized member requesting a text item', async () => {
    const target = mediaTarget({ contentType: 'text', storageKey: null });
    const result = await authorizePresign(USER, ITEM_ID, makeDeps({ target }));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('returns validation for a media item with no storage key', async () => {
    const target = mediaTarget({ storageKey: null });
    const result = await authorizePresign(USER, ITEM_ID, makeDeps({ target }));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('stays blind for a non-member requesting a text item', async () => {
    const target = mediaTarget({ contentType: 'text', storageKey: null });
    const result = await authorizePresign(
      USER,
      ITEM_ID,
      makeDeps({ target, isActiveMember: false })
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});

describe('authorizePresign — share carve-out', () => {
  const validShare: MessageShare = {
    revokedAt: null,
    expiresAt: null,
    contentItemIds: [ITEM_ID],
  };

  function shareDeps(share: MessageShare | null): PresignAuthzDeps {
    // Membership readers deny everything: the share carve-out must grant
    // access without any membership (the share path is unauthenticated).
    return makeDeps({ share, isActiveMember: false, isEpochMember: false });
  }

  it('returns the storage key for a valid shareId covering the item', async () => {
    const result = await authorizePresign(SHARE, ITEM_ID, shareDeps(validShare));
    expect(result._unsafeUnwrap()).toEqual({ storageKey: STORAGE_KEY });
  });

  it('returns not_found when the shareId matches no share', async () => {
    const result = await authorizePresign(SHARE, ITEM_ID, shareDeps(null));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('denies a revoked share', async () => {
    const share: MessageShare = { ...validShare, revokedAt: new Date('2026-06-01T00:00:00Z') };
    const result = await authorizePresign(SHARE, ITEM_ID, shareDeps(share));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('denies a share whose expiry instant has passed', async () => {
    const share: MessageShare = { ...validShare, expiresAt: NOW };
    const result = await authorizePresign(SHARE, ITEM_ID, shareDeps(share));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('allows a share whose expiry is still in the future', async () => {
    const share: MessageShare = { ...validShare, expiresAt: new Date(NOW.getTime() + 1000) };
    const result = await authorizePresign(SHARE, ITEM_ID, shareDeps(share));
    expect(result._unsafeUnwrap()).toEqual({ storageKey: STORAGE_KEY });
  });

  it('denies a valid share for an item outside its scope', async () => {
    const share: MessageShare = { ...validShare, contentItemIds: ['other-item'] };
    const result = await authorizePresign(SHARE, ITEM_ID, shareDeps(share));
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('returns validation for a shared text item', async () => {
    const target = mediaTarget({ contentType: 'text', storageKey: null });
    const deps = makeDeps({ target, share: validShare, isActiveMember: false });
    const result = await authorizePresign(SHARE, ITEM_ID, deps);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('authorizePresign — reader failures', () => {
  it('propagates a content reader failure', async () => {
    const deps = makeDeps();
    deps.contentItems = {
      findMediaTarget: () => errAsync(unavailableError('db down')),
    };
    const result = await authorizePresign(USER, ITEM_ID, deps);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
