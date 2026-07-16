import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock auth to break transitive import chain: chat.js → auth.ts → api.ts (env parse)
vi.mock('@/lib/auth', () => ({
  useAuthStore: vi.fn((selector: (s: { privateKey: null }) => unknown) =>
    selector({ privateKey: null })
  ),
}));

// Mock crypto and epoch-key-cache (transitive deps of chat.js)
vi.mock('@hushbox/crypto', () => ({
  decryptTextFromEpoch: vi.fn(),
  fromBase64: vi.fn(),
}));

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => {}),
  processKeyChain: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    conversations: {
      ':conversationId': {
        members: {
          $get: vi.fn(),
          $post: vi.fn(),
          ':memberId': {
            remove: { $post: vi.fn() },
          },
        },
        member: {
          ':memberId': {
            privilege: { $patch: vi.fn() },
          },
        },
        leave: { $post: vi.fn() },
        membership: {
          accept: { $patch: vi.fn() },
          decline: { $post: vi.fn() },
          mute: { $patch: vi.fn() },
          pin: { $patch: vi.fn() },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
    useMutation: vi.fn(actual.useMutation),
    useQueryClient: vi.fn(actual.useQueryClient),
  };
});

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import {
  memberKeys,
  useConversationMembers,
  useAddMember,
  useRemoveMember,
  useChangePrivilege,
  useLeaveConversation,
  useAcceptMembership,
  useDeclineInvitation,
  useMuteConversation,
  usePinConversation,
} from '@/hooks/realtime/use-conversation-members.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import { chatKeys } from '@/hooks/chat/chat.js';

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);
const mockedUseQueryClient = vi.mocked(useQueryClient);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client);

describe('memberKeys', () => {
  it('produces all key', () => {
    expect(memberKeys.all).toEqual(['members']);
  });

  it('produces list key with conversationId', () => {
    expect(memberKeys.list('conv-1')).toEqual(['members', 'conv-1']);
  });
});

describe('useConversationMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables the query when conversationId is provided', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers('conv-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: memberKeys.list('conv-1'),
        enabled: true,
      })
    );
  });

  it('disables the query when conversationId is null', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers(null));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: memberKeys.list(''),
        enabled: false,
      })
    );
  });

  it('calls the correct client path in queryFn', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers('conv-1'));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.conversations[':conversationId'].members.$get).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('falls back to an empty conversationId in queryFn when null', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationMembers(null));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.conversations[':conversationId'].members.$get).toHaveBeenCalledWith({
      param: { conversationId: '' },
    });
  });
});

describe('useAddMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls useMutation with correct mutationFn', () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    expect(mockedUseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: expect.any(Function),
      })
    );
  });

  it('passes wrap when giveFullHistory is true', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      userId: string;
      privilege: string;
      giveFullHistory: boolean;
      wrap?: string;
      expectedEpoch?: number;
    }) => Promise<unknown>;

    await mutationFunction({
      conversationId: 'conv-1',
      userId: 'user-2',
      wrap: 'base64wrap',
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 4,
    });

    expect(mockedClient.conversations[':conversationId'].members.$post).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: {
          userId: 'user-2',
          wrap: 'base64wrap',
          privilege: 'read',
          giveFullHistory: true,
          expectedEpoch: 4,
        },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('passes rotation when giveFullHistory is false', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    const testRotation = {
      expectedEpoch: 1,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w', privilege: 'admin', visibleFromEpoch: 1 }],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      userId: string;
      privilege: string;
      giveFullHistory: boolean;
      rotation?: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({
      conversationId: 'conv-1',
      userId: 'user-2',
      privilege: 'write',
      giveFullHistory: false,
      rotation: testRotation,
    });

    expect(mockedClient.conversations[':conversationId'].members.$post).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: {
          userId: 'user-2',
          privilege: 'write',
          giveFullHistory: false,
          rotation: testRotation,
        },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates member list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAddMember());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      {
        conversationId: 'conv-1',
      },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useRemoveMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct parameters to the client including rotation', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRemoveMember());

    const testRotation = {
      expectedEpoch: 1,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w', privilege: 'admin', visibleFromEpoch: 1 }],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      memberId: string;
      rotation: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', memberId: 'mem-1', rotation: testRotation });

    expect(
      mockedClient.conversations[':conversationId'].members[':memberId'].remove.$post
    ).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1', memberId: 'mem-1' },
        json: { rotation: testRotation },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates member list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRemoveMember());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; memberId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1', memberId: 'mem-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useChangePrivilege', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct parameters to the client', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useChangePrivilege());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      memberId: string;
      privilege: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', memberId: 'mem-1', privilege: 'admin' });

    expect(
      mockedClient.conversations[':conversationId'].member[':memberId'].privilege.$patch
    ).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1', memberId: 'mem-1' },
        json: { privilege: 'admin' },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates member list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useChangePrivilege());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; memberId: string; privilege: string },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      { conversationId: 'conv-1', memberId: 'mem-1', privilege: 'admin' },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useLeaveConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends empty json body when no rotation provided', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1' });

    expect(mockedClient.conversations[':conversationId'].leave.$post).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: {},
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('sends rotation in json body when provided', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const testRotation = {
      expectedEpoch: 1,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w', privilege: 'admin', visibleFromEpoch: 1 }],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      rotation?: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', rotation: testRotation });

    expect(mockedClient.conversations[':conversationId'].leave.$post).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: { rotation: testRotation },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates conversations list, member list, and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    const removeQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
      removeQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });

  it('removes conversation and messages from cache on success', async () => {
    const invalidateQueries = vi.fn();
    const removeQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
      removeQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useLeaveConversation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversation('conv-1'),
    });
  });
});

describe('useAcceptMembership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct parameters to the client', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAcceptMembership());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1' });

    expect(
      mockedClient.conversations[':conversationId'].membership.accept.$patch
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates conversations list on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useAcceptMembership());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
  });
});

describe('useDeclineInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
      removeQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the decline endpoint with the conversationId', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useDeclineInvitation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1' });

    expect(
      mockedClient.conversations[':conversationId'].membership.decline.$post
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates the conversations list on success', async () => {
    const invalidateQueries = vi.fn();
    const removeQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
      removeQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useDeclineInvitation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
  });

  it('removes the conversation from cache on success', async () => {
    const invalidateQueries = vi.fn();
    const removeQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
      removeQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useDeclineInvitation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1' }, undefined);

    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversation('conv-1'),
    });
  });
});

describe('useMuteConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls useMutation with correct mutationFn', () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useMuteConversation());

    expect(mockedUseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: expect.any(Function),
      })
    );
  });

  it('passes correct parameters to mute endpoint', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useMuteConversation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      muted: boolean;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', muted: true });

    expect(
      mockedClient.conversations[':conversationId'].membership.mute.$patch
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { muted: true },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('passes muted: false to unmute', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useMuteConversation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      muted: boolean;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', muted: false });

    expect(
      mockedClient.conversations[':conversationId'].membership.mute.$patch
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { muted: false },
    });
  });

  it('invalidates conversations list on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useMuteConversation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; muted: boolean },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1', muted: true }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
  });
});

describe('usePinConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls useMutation with correct mutationFn', () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => usePinConversation());

    expect(mockedUseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: expect.any(Function),
      })
    );
  });

  it('passes correct parameters to pin endpoint', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => usePinConversation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      pinned: boolean;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', pinned: true });

    expect(
      mockedClient.conversations[':conversationId'].membership.pin.$patch
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { pinned: true },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('passes pinned: false to unpin', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => usePinConversation());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      pinned: boolean;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', pinned: false });

    expect(
      mockedClient.conversations[':conversationId'].membership.pin.$patch
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { pinned: false },
    });
  });

  it('invalidates conversations list on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => usePinConversation());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; pinned: boolean },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1', pinned: true }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
  });
});
