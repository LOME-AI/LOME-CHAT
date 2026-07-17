import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './share.c.$conversationId';

const {
  mockDeriveKeysFromLinkSecret,
  mockFromBase64,
  mockToBase64,
  mockSetLinkGuestAuth,
  mockClearLinkGuestAuth,
  mockAuthenticatedChatPage,
} = vi.hoisted(() => ({
  mockDeriveKeysFromLinkSecret: vi.fn(),
  mockFromBase64: vi.fn<(b64: string) => Uint8Array>(),
  mockToBase64: vi.fn<(bytes: Uint8Array) => string>(),
  mockSetLinkGuestAuth: vi.fn(),
  mockClearLinkGuestAuth: vi.fn(),
  mockAuthenticatedChatPage: vi.fn(),
}));

vi.mock('@hushbox/crypto', () => ({
  deriveKeysFromLinkSecret: (...args: unknown[]) => mockDeriveKeysFromLinkSecret(...args),
}));

// Keep the real @hushbox/shared (TEST_IDS etc.); override only the base64 codecs.
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    fromBase64: (b64: string) => mockFromBase64(b64),
    toBase64: (bytes: Uint8Array) => mockToBase64(bytes),
  };
});

// Keep the real router (createFileRoute must run for the route file); mock only useParams.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useParams: () => ({ conversationId: 'conv-shared' }),
  };
});

vi.mock('../lib/link-guest-auth.js', () => ({
  setLinkGuestAuth: (...args: unknown[]) => mockSetLinkGuestAuth(...args),
  clearLinkGuestAuth: (...args: unknown[]) => mockClearLinkGuestAuth(...args),
}));

vi.mock('../components/shared/app-shell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock('@/components/chat/page/authenticated-chat-page.js', () => ({
  AuthenticatedChatPage: (props: Record<string, unknown>): React.JSX.Element => {
    mockAuthenticatedChatPage(props);
    return (
      <div
        data-testid="authenticated-chat-page"
        data-conversation-id={props['routeConversationId'] as string}
        data-has-private-key={props['privateKeyOverride'] ? 'true' : 'false'}
      />
    );
  },
}));

const FAKE_PUBLIC_KEY = new Uint8Array(32).fill(42);
const FAKE_PRIVATE_KEY = new Uint8Array(32).fill(43);

describe('/share/c/$conversationId route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(QueryClient.prototype, 'invalidateQueries').mockImplementation(() =>
      Promise.resolve()
    );
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#bGluay1zZWNyZXQtYjY0' },
      writable: true,
    });
    mockFromBase64.mockImplementation(() => new Uint8Array(32));
    mockToBase64.mockImplementation(() => 'base64-public-key');
    mockDeriveKeysFromLinkSecret.mockReturnValue({
      publicKey: FAKE_PUBLIC_KEY,
      privateKey: FAKE_PRIVATE_KEY,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders AppShell wrapping AuthenticatedChatPage', () => {
    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    expect(screen.getByTestId('authenticated-chat-page')).toBeInTheDocument();
  });

  it('passes conversationId to AuthenticatedChatPage', () => {
    renderRoute(Route);

    expect(screen.getByTestId('authenticated-chat-page')).toHaveAttribute(
      'data-conversation-id',
      'conv-shared'
    );
  });

  it('passes privateKeyOverride to AuthenticatedChatPage', () => {
    renderRoute(Route);

    expect(mockAuthenticatedChatPage).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyOverride: FAKE_PRIVATE_KEY,
      })
    );
  });

  it('derives keys from the URL hash fragment', () => {
    renderRoute(Route);

    expect(mockFromBase64).toHaveBeenCalledWith('bGluay1zZWNyZXQtYjY0');
    expect(mockDeriveKeysFromLinkSecret).toHaveBeenCalled();
  });

  it('sets link guest auth with the derived public key', () => {
    renderRoute(Route);

    expect(mockSetLinkGuestAuth).toHaveBeenCalledWith('base64-public-key');
  });

  it('clears link guest auth on unmount', () => {
    const { unmount } = renderRoute(Route);

    expect(mockClearLinkGuestAuth).not.toHaveBeenCalled();
    unmount();
    expect(mockClearLinkGuestAuth).toHaveBeenCalled();
  });

  it('passes has-private-key data attribute', () => {
    renderRoute(Route);

    expect(screen.getByTestId('authenticated-chat-page')).toHaveAttribute(
      'data-has-private-key',
      'true'
    );
  });

  it('invalidates all query cache on mount', () => {
    renderRoute(Route);

    expect(QueryClient.prototype.invalidateQueries).toHaveBeenCalledWith();
  });

  it('renders error state when key derivation fails', () => {
    mockDeriveKeysFromLinkSecret.mockImplementation(() => {
      throw new Error('invalid key');
    });

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedConversationError)).toBeInTheDocument();
    expect(screen.queryByTestId('authenticated-chat-page')).not.toBeInTheDocument();
  });

  it('renders error state when the link secret is the wrong length', () => {
    // A secret that is not exactly 32 bytes fails the length check and yields
    // no derived keys, short-circuiting before deriveKeysFromLinkSecret.
    mockFromBase64.mockImplementation(() => new Uint8Array(16));

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedConversationError)).toBeInTheDocument();
    expect(mockDeriveKeysFromLinkSecret).not.toHaveBeenCalled();
  });

  it('remounts the inner page when the URL hash changes', () => {
    renderRoute(Route);

    expect(mockFromBase64).toHaveBeenLastCalledWith('bGluay1zZWNyZXQtYjY0');

    // A hash-only navigation does not re-render the route, so the wrapper listens
    // for hashchange and remounts the inner component via key={hash}, which
    // re-derives keys from the new fragment.
    (globalThis.location as { hash: string }).hash = '#bmV3LXNlY3JldA';
    act(() => {
      globalThis.dispatchEvent(new Event('hashchange'));
    });

    expect(mockFromBase64).toHaveBeenLastCalledWith('bmV3LXNlY3JldA');
  });
});
