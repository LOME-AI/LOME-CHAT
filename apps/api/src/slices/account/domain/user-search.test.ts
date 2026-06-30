import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import {
  USER_SEARCH_MAX_RESULTS,
  escapeLikePrefix,
  searchInvitableUsers,
  searchUsersQuerySchema,
} from './user-search.js';
import type { InvitableUserRow, UserDirectory } from '../ports/index.js';

function directoryCapturing(
  rows: readonly InvitableUserRow[],
  calls: {
    params?: Parameters<UserDirectory['searchInvitable']>[0];
    membership?: Parameters<UserDirectory['isActiveMember']>[0];
  },
  isMember = true
): UserDirectory {
  return {
    isActiveMember: (params) => {
      calls.membership = params;
      return okAsync(isMember);
    },
    searchInvitable: (params) => {
      calls.params = params;
      return okAsync(rows);
    },
  };
}

const CONVERSATION_ID = '0197a000-0000-7000-8000-000000000001';
const CALLER_ID = '0197a000-0000-7000-8000-000000000002';

describe('escapeLikePrefix', () => {
  it('escapes LIKE metacharacters so an underscore matches literally', () => {
    expect(escapeLikePrefix(String.raw`a_b%c\d`)).toBe(String.raw`a\_b\%c\\d`);
  });
});

describe('searchInvitableUsers', () => {
  it('normalizes the query into an escaped prefix pattern', async () => {
    const calls: { params?: Parameters<UserDirectory['searchInvitable']>[0] } = {};
    const result = await searchInvitableUsers(directoryCapturing([], calls), {
      query: '  John D  ',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result.isOk()).toBe(true);
    expect(calls.params?.usernamePattern).toBe(String.raw`john\_d%`);
  });

  it('passes the caller and conversation through as exclusions', async () => {
    const calls: { params?: Parameters<UserDirectory['searchInvitable']>[0] } = {};
    const result = await searchInvitableUsers(directoryCapturing([], calls), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result.isOk()).toBe(true);
    expect(calls.params?.excludeUserId).toBe(CALLER_ID);
    expect(calls.params?.conversationId).toBe(CONVERSATION_ID);
  });

  it('defaults the limit to the maximum result count', async () => {
    const calls: { params?: Parameters<UserDirectory['searchInvitable']>[0] } = {};
    const result = await searchInvitableUsers(directoryCapturing([], calls), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result.isOk()).toBe(true);
    expect(calls.params?.limit).toBe(USER_SEARCH_MAX_RESULTS);
  });

  it('honors an explicit limit', async () => {
    const calls: { params?: Parameters<UserDirectory['searchInvitable']>[0] } = {};
    const result = await searchInvitableUsers(directoryCapturing([], calls), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
      limit: 3,
    });
    expect(result.isOk()).toBe(true);
    expect(calls.params?.limit).toBe(3);
  });

  it('verifies the caller’s membership in the target conversation', async () => {
    const calls: { membership?: Parameters<UserDirectory['isActiveMember']>[0] } = {};
    const result = await searchInvitableUsers(directoryCapturing([], calls), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result.isOk()).toBe(true);
    expect(calls.membership).toEqual({ conversationId: CONVERSATION_ID, userId: CALLER_ID });
  });

  it('returns forbidden when the caller is not an active member', async () => {
    const result = await searchInvitableUsers(directoryCapturing([], {}, false), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('never runs the search for a non-member caller', async () => {
    const calls: { params?: Parameters<UserDirectory['searchInvitable']>[0] } = {};
    const result = await searchInvitableUsers(directoryCapturing([], calls, false), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result.isErr()).toBe(true);
    expect(calls.params).toBeUndefined();
  });

  it('encodes each public key as base64', async () => {
    const row: InvitableUserRow = {
      id: '0197a000-0000-7000-8000-000000000003',
      username: 'john_doe',
      publicKey: new Uint8Array([1, 2, 3]),
    };
    const result = await searchInvitableUsers(directoryCapturing([row], {}), {
      query: 'jo',
      conversationId: CONVERSATION_ID,
      callerUserId: CALLER_ID,
    });
    expect(result._unsafeUnwrap()).toEqual([
      { id: row.id, username: 'john_doe', publicKey: 'AQID' },
    ]);
  });
});

describe('searchUsersQuerySchema', () => {
  it('rejects a query longer than 50 characters', () => {
    const parsed = searchUsersQuerySchema.safeParse({
      q: 'a'.repeat(51),
      conversationId: CONVERSATION_ID,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-uuid conversationId', () => {
    const parsed = searchUsersQuerySchema.safeParse({ q: 'jo', conversationId: 'nope' });
    expect(parsed.success).toBe(false);
  });

  it('coerces the limit from a query-string value', () => {
    const parsed = searchUsersQuerySchema.parse({
      q: 'jo',
      conversationId: CONVERSATION_ID,
      limit: '5',
    });
    expect(parsed.limit).toBe(5);
  });

  it('rejects a limit above the maximum', () => {
    const parsed = searchUsersQuerySchema.safeParse({
      q: 'jo',
      conversationId: CONVERSATION_ID,
      limit: '21',
    });
    expect(parsed.success).toBe(false);
  });
});
