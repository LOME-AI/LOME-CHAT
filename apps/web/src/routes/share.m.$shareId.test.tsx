import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { useSharedMessage } from '@/hooks/chat/use-shared-message.js';
import { Route } from './share.m.$shareId';
import type { LegacyContentKey } from '@hushbox/crypto';

vi.mock('@/hooks/chat/use-shared-message.js', () => ({
  useSharedMessage: vi.fn(),
}));

vi.mock('../components/shared/app-shell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

// ChatLayout is mocked for safety: this page does not use it, but if a stale
// reference slips through we want the test to fail on the assertion, not on a
// cascade of env-parsing side effects from the real ChatLayout tree.
vi.mock('@/components/chat/layout/chat-layout.js', () => ({
  ChatLayout: (): React.JSX.Element => <div data-testid="chat-layout-should-not-render" />,
}));

vi.mock('@/components/chat/message/markdown-renderer.js', () => ({
  MarkdownRenderer: ({ content }: { content: string }): React.JSX.Element => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

// The share page renders media through the same MediaContentItem the chat uses
// (via MessageBody → MessageMediaList). Mock the leaf to avoid the fetch +
// decrypt chain; MessageBody / MessageMediaList render for real.
vi.mock('@/components/chat/media/media-content-item.js', () => ({
  MediaContentItem: ({
    item,
  }: {
    item: {
      contentItemId: string;
      contentType: string;
      downloadUrl?: string;
    };
  }): React.JSX.Element => (
    <div
      data-testid={`shared-media-${item.contentItemId}`}
      data-content-type={item.contentType}
      data-download-url={item.downloadUrl}
    >
      Shared media: {item.contentItemId}
    </div>
  ),
}));

// Keep the real router (createFileRoute must run for the route file); mock only useParams.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useParams: () => ({ shareId: 'share-from-route' }),
  };
});

const mockUseSharedMessage = vi.mocked(useSharedMessage);

type SharedMessageData = NonNullable<ReturnType<typeof useSharedMessage>['data']>;

function mockData(overrides: Partial<SharedMessageData> = {}): SharedMessageData {
  return {
    createdAt: '2024-01-15T14:34:00Z',
    contentKey: new Uint8Array([1, 2, 3]) as LegacyContentKey,
    contentItems: [{ type: 'text', position: 0, content: 'Hello world' }],
    ...overrides,
  };
}

describe('/share/m/$shareId route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#c2hhcmUta2V5LWI2NA' },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders loading state when data is loading', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedMessageLoading)).toBeInTheDocument();
  });

  it('sizes the loading state to its container, not the viewport', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    // h-full, not h-dvh: the root route's h-dvh banner-row layout owns the
    // viewport height; h-dvh here would overflow by the banner's height when a
    // banner is active.
    expect(screen.getByTestId(TEST_IDS.sharedMessageLoading)).toHaveClass('h-full');
  });

  it('announces loading state via role="status" and aria-live="polite"', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const loading = screen.getByTestId(TEST_IDS.sharedMessageLoading);
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveAttribute('aria-live', 'polite');
  });

  it('renders error state wrapped in AppShell', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.sharedMessageError)).toBeInTheDocument();
  });

  it('announces error state via role="alert"', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedMessageError)).toHaveAttribute('role', 'alert');
  });

  it('shows AlertTriangle icon in error state', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const errorContainer = screen.getByTestId(TEST_IDS.sharedMessageError);
    const icon = errorContainer.querySelector('svg');
    expect(icon).toBeInTheDocument();
  });

  it('shows descriptive error messages', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByText('Unable to access message')).toBeInTheDocument();
    expect(screen.getByText('This share link may be invalid or expired.')).toBeInTheDocument();
  });

  it('renders AppShell with shared message content when data loads', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData(),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.sharedMessageContent)).toBeInTheDocument();
  });

  it('renders text content items via MarkdownRenderer', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          { type: 'text', position: 0, content: 'First paragraph' },
          { type: 'text', position: 1, content: 'Second paragraph' },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const renderers = screen.getAllByTestId(TEST_IDS.markdownRenderer);
    expect(renderers).toHaveLength(2);
    expect(renderers[0]).toHaveTextContent('First paragraph');
    expect(renderers[1]).toHaveTextContent('Second paragraph');
  });

  it('renders media content items via the shared media renderer', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          {
            type: 'media',
            position: 0,
            contentItemId: 'img-1',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
            durationMs: null,
            downloadUrl: 'https://signed.example/a',
            expiresAt: '2026-04-19T00:05:00.000Z',
          },
          {
            type: 'media',
            position: 1,
            contentItemId: 'vid-1',
            contentType: 'video',
            mimeType: 'video/mp4',
            sizeBytes: 4096,
            width: 1920,
            height: 1080,
            durationMs: 5000,
            downloadUrl: 'https://signed.example/b',
            expiresAt: '2026-04-19T00:05:00.000Z',
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const img = screen.getByTestId('shared-media-img-1');
    expect(img).toHaveAttribute('data-content-type', 'image');
    expect(img).toHaveAttribute('data-download-url', 'https://signed.example/a');
    const vid = screen.getByTestId('shared-media-vid-1');
    expect(vid).toHaveAttribute('data-content-type', 'video');
  });

  it('groups all text before media, matching how chat renders an assistant message', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          { type: 'text', position: 0, content: 'before' },
          {
            type: 'media',
            position: 1,
            contentItemId: 'img-mid',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1,
            width: 1,
            height: 1,
            durationMs: null,
            downloadUrl: 'https://signed.example/mid',
            expiresAt: '2026-04-19T00:05:00.000Z',
          },
          { type: 'text', position: 2, content: 'after' },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    // Text blocks render in position order, then the media tile — text-then-media
    // like a chat assistant message (not interleaved by raw position).
    const texts = screen.getAllByTestId(TEST_IDS.markdownRenderer);
    expect(texts.map((t) => t.textContent)).toEqual(['before', 'after']);

    const media = screen.getByTestId('shared-media-img-mid');
    expect(media).toBeInTheDocument();

    const lastText = texts.at(-1)!;
    expect(lastText.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('passes hash fragment as keyBase64 to hook', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(mockUseSharedMessage).toHaveBeenCalledWith('share-from-route', 'c2hhcmUta2V5LWI2NA');
  });
});
