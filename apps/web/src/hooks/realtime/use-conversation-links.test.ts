import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/auth.js', () => ({
  useAuthStore: vi.fn((selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: 'user-1' } })
  ),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    conversations: {
      ':conversationId': {
        links: {
          $get: vi.fn(),
          $post: vi.fn(),
          ':linkId': {
            revoke: { $post: vi.fn() },
            privilege: { $patch: vi.fn() },
          },
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
  linkKeys,
  useConversationLinks,
  useCreateLink,
  useRevokeLink,
  useChangeLinkPrivilege,
} from '@/hooks/realtime/use-conversation-links.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import { useAuthStore } from '@/lib/auth.js';

const mockedUseAuthStore = vi.mocked(useAuthStore);

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);
const mockedUseQueryClient = vi.mocked(useQueryClient);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client);

describe('linkKeys', () => {
  it('produces all key', () => {
    expect(linkKeys.all).toEqual(['links']);
  });

  it('produces list key with conversationId', () => {
    expect(linkKeys.list('conv-1')).toEqual(['links', 'conv-1']);
  });
});

describe('useConversationLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables the query when conversationId is provided', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationLinks('conv-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: linkKeys.list('conv-1'),
        enabled: true,
      })
    );
  });

  it('disables the query when conversationId is null', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationLinks(null));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: linkKeys.list(''),
        enabled: false,
      })
    );
  });

  it('enables the query when conversationId is set even though the auth-store user is null', () => {
    // The session cookie authorizes a logged-in member server-side, and the
    // api-client attaches X-Link-Public-Key for a guest — neither depends on
    // the async-lagging client `user` store. So the gate must not wait on `user`.
    mockedUseAuthStore.mockImplementation((selector) =>
      selector({ user: null } as Parameters<typeof selector>[0])
    );
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationLinks('conv-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: linkKeys.list('conv-1'),
        enabled: true,
      })
    );
  });

  it('calls the correct client path in queryFn', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationLinks('conv-1'));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.conversations[':conversationId'].links.$get).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('falls back to an empty conversationId in queryFn when null', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationLinks(null));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.conversations[':conversationId'].links.$get).toHaveBeenCalledWith({
      param: { conversationId: '' },
    });
  });
});

describe('useCreateLink', () => {
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

    renderHook(() => useCreateLink());

    expect(mockedUseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: expect.any(Function),
      })
    );
  });

  it('passes correct parameters to the client', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useCreateLink());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      linkPublicKey: string;
      memberWrap: string;
      privilege: string;
      giveFullHistory: boolean;
      expectedEpoch?: number;
    }) => Promise<unknown>;

    await mutationFunction({
      conversationId: 'conv-1',
      linkPublicKey: 'pubkey',
      memberWrap: 'wrap',
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 4,
    });

    expect(mockedClient.conversations[':conversationId'].links.$post).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: {
          linkPublicKey: 'pubkey',
          memberWrap: 'wrap',
          privilege: 'read',
          giveFullHistory: true,
          expectedEpoch: 4,
        },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('includes displayName and rotation when provided, omitting expectedEpoch', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useCreateLink());

    const testRotation = {
      expectedEpoch: 2,
      epochPublicKey: 'ep-pub',
      confirmationHash: 'conf-hash',
      chainLink: 'chain',
      encryptedTitle: 'enc-title',
      memberWraps: [],
    };

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      linkPublicKey: string;
      memberWrap: string;
      privilege: string;
      giveFullHistory: boolean;
      displayName?: string;
      rotation?: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({
      conversationId: 'conv-1',
      linkPublicKey: 'pubkey',
      memberWrap: 'wrap',
      privilege: 'write',
      giveFullHistory: false,
      displayName: 'Reviewer',
      rotation: testRotation,
    });

    expect(mockedClient.conversations[':conversationId'].links.$post).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: {
          linkPublicKey: 'pubkey',
          memberWrap: 'wrap',
          privilege: 'write',
          giveFullHistory: false,
          displayName: 'Reviewer',
          rotation: testRotation,
        },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
  });

  it('invalidates link list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useCreateLink());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: {
        conversationId: string;
        linkPublicKey: string;
        memberWrap: string;
        privilege: string;
        giveFullHistory: boolean;
      },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      {
        conversationId: 'conv-1',
        linkPublicKey: 'pk',
        memberWrap: 'w',
        privilege: 'read',
        giveFullHistory: true,
      },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: linkKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useRevokeLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes linkId without rotation when not provided', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRevokeLink());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      linkId: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', linkId: 'link-1' });

    expect(
      mockedClient.conversations[':conversationId'].links[':linkId'].revoke.$post
    ).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1', linkId: 'link-1' },
        json: { rotation: undefined },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('passes rotation with linkId when provided', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRevokeLink());

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
      linkId: string;
      rotation?: typeof testRotation;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', linkId: 'link-1', rotation: testRotation });

    expect(
      mockedClient.conversations[':conversationId'].links[':linkId'].revoke.$post
    ).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1', linkId: 'link-1' },
        json: { rotation: testRotation },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates link list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useRevokeLink());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; linkId: string },
      context: unknown
    ) => Promise<void>;

    // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
    await onSuccess({}, { conversationId: 'conv-1', linkId: 'link-1' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: linkKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});

describe('useChangeLinkPrivilege', () => {
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

    renderHook(() => useChangeLinkPrivilege());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      linkId: string;
      privilege: string;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', linkId: 'link-1', privilege: 'write' });

    expect(
      mockedClient.conversations[':conversationId'].links[':linkId'].privilege.$patch
    ).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1', linkId: 'link-1' },
        json: { privilege: 'write' },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates link list and budget cache on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useChangeLinkPrivilege());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; linkId: string; privilege: string },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      { conversationId: 'conv-1', linkId: 'link-1', privilege: 'write' },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: linkKeys.list('conv-1'),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});
