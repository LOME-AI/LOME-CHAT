import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './chat.$id';

const { mockRequireAuth, authenticatedChatPageMock, mountSpy, mockUseLocation } = vi.hoisted(
  () => ({
    mockRequireAuth: vi.fn(),
    authenticatedChatPageMock: vi.fn(),
    mountSpy: vi.fn(),
    mockUseLocation: vi.fn(() => ({ state: {} })),
  })
);

// The chat route reads the create→real history marker via the standalone
// `useLocation` hook, but `renderRoute` has no real router for it to read from —
// stub it. Spread the rest so `createFileRoute` (which builds `Route`) stays
// real and its `useParams`/`useSearch` remain spyable.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useLocation: () => mockUseLocation() };
});

// `Route.useParams`/`Route.useSearch` call the router's bundled internals (not
// the module's standalone hook exports), so importActual+override does not reach
// them — spy on the Route methods directly, as the other renderRoute tests do.
function setParams(params: { id: string }): void {
  vi.spyOn(Route, 'useParams').mockReturnValue(params);
}
function setSearch(search: { fork: string | undefined }): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
}
function setLocationState(state: { fromCreate?: boolean }): void {
  mockUseLocation.mockReturnValue({ state });
}

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock('@/components/shared/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

function MockAuthenticatedChatPage({
  routeConversationId,
  initialForkId,
}: Readonly<{
  routeConversationId: string;
  initialForkId?: string | undefined;
}>): React.JSX.Element {
  React.useEffect(() => {
    mountSpy();
  }, []);
  return (
    <div
      data-testid="authenticated-chat"
      data-conv-id={routeConversationId}
      data-fork-id={initialForkId ?? ''}
    >
      chat page
    </div>
  );
}

vi.mock('@/components/chat/page/authenticated-chat-page', () => ({
  AuthenticatedChatPage: (props: {
    routeConversationId: string;
    initialForkId?: string | undefined;
  }) => {
    authenticatedChatPageMock(props);
    return (
      <MockAuthenticatedChatPage
        routeConversationId={props.routeConversationId}
        initialForkId={props.initialForkId}
      />
    );
  },
}));

const mockConversationOptions = {
  queryKey: ['chat', 'conversations', 'test-id'],
  queryFn: vi.fn(),
};
const mockKeyChainOptions = {
  queryKey: ['keys', 'test-id'],
  queryFn: vi.fn(),
  staleTime: 3_600_000,
};
vi.mock('@/hooks/chat/chat', () => ({
  conversationQueryOptions: vi.fn(() => mockConversationOptions),
}));
vi.mock('@/hooks/crypto/keys', () => ({
  keyChainQueryOptions: vi.fn(() => mockKeyChainOptions),
}));

const redirectError = new Error('REDIRECT');

interface BeforeLoadArgs {
  params: { id: string };
  context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
}

function getBeforeLoad(): (args: BeforeLoadArgs) => Promise<void> {
  const beforeLoad = Route.options.beforeLoad as
    | ((args: BeforeLoadArgs) => Promise<void>)
    | undefined;
  expect(beforeLoad).toBeDefined();
  return beforeLoad!;
}

describe('chat.$id route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls requireAuth in beforeLoad', async () => {
    mockRequireAuth.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      },
    });

    await getBeforeLoad()({
      params: { id: 'conv-123' },
      context: { queryClient: { prefetchQuery: vi.fn() } },
    });
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('fires conversation + key-chain prefetch concurrently with the auth check', async () => {
    // The prefetches must start before requireAuth resolves, so the `/auth/me`
    // round-trip overlaps the conversation/key-chain fetches instead of
    // serializing ahead of them. A still-pending auth promise lets us observe
    // that the prefetches already fired.
    let resolveAuth!: (value: { user: { id: string } }) => void;
    mockRequireAuth.mockReturnValue(
      new Promise<{ user: { id: string } }>((resolve) => {
        resolveAuth = resolve;
      })
    );
    const mockPrefetchQuery = vi.fn();

    const pending = getBeforeLoad()({
      params: { id: 'conv-123' },
      context: { queryClient: { prefetchQuery: mockPrefetchQuery } },
    });

    expect(mockPrefetchQuery).toHaveBeenCalledTimes(2);
    expect(mockPrefetchQuery).toHaveBeenCalledWith(mockConversationOptions);
    expect(mockPrefetchQuery).toHaveBeenCalledWith(mockKeyChainOptions);

    resolveAuth({ user: { id: 'user-1' } });
    await pending;
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('redirects to login when auth fails, even though prefetch was already fired', async () => {
    // Security lock: overlapping the prefetch with the auth check must not
    // weaken the gate. An unauthenticated boot still rejects in beforeLoad, so
    // the route component never mounts and no message content can render.
    // Server-side authorization (membership 404, key-wrap filtering) and the
    // private-key decryption gate make the fired prefetches harmless.
    mockRequireAuth.mockRejectedValue(redirectError);

    await expect(
      getBeforeLoad()({
        params: { id: 'conv-123' },
        context: { queryClient: { prefetchQuery: vi.fn() } },
      })
    ).rejects.toThrow('REDIRECT');
  });

  it('does not prefetch when id is the "new" sentinel', async () => {
    // The "new" segment in /chat/new is a create-mode marker, not a real
    // conversation id. Treating it as an id triggers GET /conversations/new
    // and GET /conversations/new/keychain, both of which 404 and polluted production
    // observability with phantom errors on every welcome-page send.
    mockRequireAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const mockPrefetchQuery = vi.fn();

    await getBeforeLoad()({
      params: { id: 'new' },
      context: { queryClient: { prefetchQuery: mockPrefetchQuery } },
    });

    expect(mockPrefetchQuery).not.toHaveBeenCalled();
  });

  it('has no separate loader — the prefetch moved into beforeLoad to overlap auth', () => {
    expect(Route.options.loader).toBeUndefined();
  });
});

describe('chat.$id validateSearch', () => {
  function validateSearch(search: Record<string, unknown>): { fork: string | undefined } {
    return (
      Route.options.validateSearch as (s: Record<string, unknown>) => { fork: string | undefined }
    )(search);
  }

  it('extracts fork param when provided as a string', () => {
    expect(validateSearch({ fork: 'fork-123' })).toEqual({ fork: 'fork-123' });
  });

  it('returns undefined fork when not present', () => {
    expect(validateSearch({})).toEqual({ fork: undefined });
  });

  it('returns undefined when fork is not a string', () => {
    expect(validateSearch({ fork: 42 })).toEqual({ fork: undefined });
    expect(validateSearch({ fork: null })).toEqual({ fork: undefined });
    expect(validateSearch({ fork: ['x'] })).toEqual({ fork: undefined });
  });

  it('ignores unrelated search params', () => {
    expect(validateSearch({ fork: 'fork-x', extra: 'noise' })).toEqual({ fork: 'fork-x' });
  });

  it('drops an object-valued fork via zod validation', () => {
    expect(validateSearch({ fork: { nested: 'x' } })).toEqual({ fork: undefined });
  });
});

describe('chat.$id component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mountSpy.mockClear();
    authenticatedChatPageMock.mockClear();
    setLocationState({});
  });

  it('renders AuthenticatedChatPage inside an ErrorBoundary, forwarding params', () => {
    setParams({ id: 'conv-abc' });
    setSearch({ fork: 'fork-xyz' });

    renderRoute(Route);

    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    const chat = screen.getByTestId('authenticated-chat');
    expect(chat).toHaveAttribute('data-conv-id', 'conv-abc');
    expect(chat).toHaveAttribute('data-fork-id', 'fork-xyz');
    expect(authenticatedChatPageMock).toHaveBeenCalledWith({
      routeConversationId: 'conv-abc',
      initialForkId: 'fork-xyz',
    });
  });

  it('forwards undefined fork to AuthenticatedChatPage', () => {
    setParams({ id: 'conv-abc' });
    setSearch({ fork: undefined });

    renderRoute(Route);

    expect(authenticatedChatPageMock).toHaveBeenCalledWith({
      routeConversationId: 'conv-abc',
      initialForkId: undefined,
    });
  });

  it('remounts the chat subtree when the conversation id changes', () => {
    // Keying by the conversation id forces a fresh mount on navigation between
    // conversations, so per-conversation hook state cannot bleed across.
    setSearch({ fork: undefined });
    const paramsSpy = vi.spyOn(Route, 'useParams').mockReturnValue({ id: 'conv-a' });

    const { rerender } = renderRoute(Route);
    expect(mountSpy).toHaveBeenCalledTimes(1);

    paramsSpy.mockReturnValue({ id: 'conv-b' });
    const Component = Route.options.component as React.ComponentType;
    rerender(<Component />);

    expect(mountSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT remount across the create→real hop (new → realId with marker)', () => {
    // The post-stream `/chat/new` → `/chat/<realId>` navigation is the same
    // just-created conversation getting its id. Remounting there would discard
    // optimistic-only state (failed-model error tiles have no DB row), so the
    // key is held stable when the navigation carries the `fromCreate` marker.
    setSearch({ fork: undefined });
    const paramsSpy = vi.spyOn(Route, 'useParams').mockReturnValue({ id: 'new' });

    const { rerender } = renderRoute(Route);
    expect(mountSpy).toHaveBeenCalledTimes(1);

    paramsSpy.mockReturnValue({ id: 'real-1' });
    setLocationState({ fromCreate: true });
    const Component = Route.options.component as React.ComponentType;
    rerender(<Component />);

    expect(mountSpy).toHaveBeenCalledTimes(1);
    expect(authenticatedChatPageMock).toHaveBeenLastCalledWith({
      routeConversationId: 'real-1',
      initialForkId: undefined,
    });
  });

  it('remounts on a new → existing switch with no create marker', () => {
    // A user leaving a fresh /chat/new to open an existing conversation is a
    // genuine switch and must remount, since the hook only initialises its
    // per-conversation state at mount.
    setSearch({ fork: undefined });
    const paramsSpy = vi.spyOn(Route, 'useParams').mockReturnValue({ id: 'new' });

    const { rerender } = renderRoute(Route);
    expect(mountSpy).toHaveBeenCalledTimes(1);

    paramsSpy.mockReturnValue({ id: 'existing-1' });
    setLocationState({});
    const Component = Route.options.component as React.ComponentType;
    rerender(<Component />);

    expect(mountSpy).toHaveBeenCalledTimes(2);
  });
});
