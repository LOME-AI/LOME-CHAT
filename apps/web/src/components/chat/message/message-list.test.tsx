import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import * as React from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

const { envRef } = vi.hoisted(() => ({
  envRef: {
    current: { isLocalDev: false, isE2E: false } as { isLocalDev: boolean; isE2E: boolean },
  },
}));
vi.mock('@/lib/env', () => ({ env: envRef.current }));
import { usePreInferenceActivityStore } from '@/stores/pre-inference-activity';
import { useStreamCycleActivityStore } from '@/stores/stream-cycle-activity';

// Break the import chain that requires VITE_API_URL at module load time.
// Without these mocks, frontendEnvSchema.parse() runs in src/lib/api.ts and
// throws ZodError, preventing every test in this file from loading.
vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));

import { MessageList, type MessageListHandle } from '@/components/chat/message/message-list';
import type { Message } from '@/lib/api';

// Mock mermaid to avoid actual rendering
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg>Diagram</svg>',
      bindFunctions: vi.fn(),
    }),
  },
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
}));

let capturedVirtuosoProps: Record<string, unknown> = {};
// Module-level imperative-handle mocks so tests can observe calls across
// re-renders (useImperativeHandle's factory runs each render, so per-render
// vi.fn()s lose their call history).
const virtuosoMockHandle = {
  scrollToIndex: vi.fn(),
  scrollTo: vi.fn(),
  scrollBy: vi.fn(),
  scrollIntoView: vi.fn(),
  getState: vi.fn(),
  autoscrollToBottom: vi.fn(),
};

// Mock Virtuoso to render items directly (virtualization doesn't work in jsdom)
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    props: Record<string, unknown>,
    ref: React.Ref<VirtuosoHandle>
  ) {
    Object.assign(capturedVirtuosoProps, props);
    const data = props['data'] as unknown[];
    const itemContent = props['itemContent'] as (index: number, item: unknown) => React.ReactNode;
    const components = props['components'] as
      | {
          Footer?: () => React.ReactNode;
          Header?: () => React.ReactNode;
          Scroller?: React.ComponentType<React.HTMLAttributes<HTMLDivElement>>;
        }
      | undefined;
    const scrollerRefCallback = props['scrollerRef'] as
      | ((el: HTMLElement | Window | null) => void)
      | undefined;
    React.useImperativeHandle(ref, () => virtuosoMockHandle);
    // Forward the scroller DOM node so tests can dispatch wheel/touchmove/
    // keydown events on it the way MessageList expects in production.
    const scrollerRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        scrollerRefCallback?.(el);
      },
      [scrollerRefCallback]
    );
    const Scroller = components?.Scroller ?? 'div';
    const computeItemKey = props['computeItemKey'] as
      | ((index: number, item: unknown) => string)
      | undefined;
    return (
      <Scroller data-testid="virtuoso-mock" ref={scrollerRef}>
        {components?.Header?.()}
        {data.map((item, index) => (
          <div key={computeItemKey ? computeItemKey(index, item) : index}>
            {itemContent(index, item)}
          </div>
        ))}
        {components?.Footer?.()}
      </Scroller>
    );
  }),
}));

const messages = [
  {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello!',
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'Hi there!',
    createdAt: '2024-01-01T00:00:01Z',
  },
  {
    id: '3',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'How are you?',
    createdAt: '2024-01-01T00:00:02Z',
  },
];

describe('MessageList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders all messages', () => {
    render(<MessageList messages={messages} />);

    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
    expect(screen.getByText('How are you?')).toBeInTheDocument();
  });

  it('renders empty state when no messages', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByTestId('message-list-empty')).toBeInTheDocument();
  });

  it('renders role="log" on empty state so waitForConversationLoaded works', () => {
    render(<MessageList messages={[]} />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('role', 'log');
    expect(emptyState).toHaveAttribute('aria-label', 'Chat messages');
  });

  it('renders container with correct test id', () => {
    render(<MessageList messages={messages} />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('displays messages in order', () => {
    render(<MessageList messages={messages} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  it('container takes full height with min-h-0 for flex', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveClass('flex-1');
    expect(container).toHaveClass('min-h-0');
  });

  it('passes streamingMessageIds to mark streaming message', () => {
    render(<MessageList messages={messages} streamingMessageIds={new Set(['2'])} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  it('exposes data-message-count matching messages.length', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-message-count', '3');
  });

  it('exposes data-decrypted-count equal to messages.length when every message has plaintext content', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-decrypted-count', '3');
  });

  it('exposes data-at-bottom reflecting Virtuoso atBottomStateChange', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    // Pinned at the latest message on mount (initialTopMostItemIndex="LAST").
    expect(container).toHaveAttribute('data-at-bottom', 'true');

    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });
    expect(container).toHaveAttribute('data-at-bottom', 'false');

    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(true);
    });
    expect(container).toHaveAttribute('data-at-bottom', 'true');
  });

  it('re-pins to the last row when atBottom drops while auto-follow is engaged', () => {
    render(<MessageList messages={messages} />);
    virtuosoMockHandle.scrollToIndex.mockClear();

    // A late last-item resize (the cost true-up badge growing the final reply
    // after the stream has settled) drops atBottom with no user scroll. Auto-
    // follow is still engaged, so the list must re-pin to the latest row —
    // Virtuoso's followOutput re-pins on new items only, not on a resize.
    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });

    expect(virtuosoMockHandle.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end' });
  });

  it('does not re-pin when the user scrolled away from the bottom', () => {
    render(<MessageList messages={messages} />);
    const scroller = screen.getByTestId('virtuoso-mock');
    virtuosoMockHandle.scrollToIndex.mockClear();

    // A real user scroll followed by atBottom dropping is the user deliberately
    // leaving the bottom — auto-follow disengages and must not yank them back.
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });

    expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not re-pin while a turn is still streaming', () => {
    render(<MessageList messages={messages} streamingMessageIds={new Set(['streaming-id'])} />);
    virtuosoMockHandle.scrollToIndex.mockClear();

    // While streaming, Virtuoso's followOutput owns the bottom-pin; an explicit
    // re-pin here would fight its smooth follow, so the effect stays out.
    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });

    expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
  });

  it('re-pins when message content grows after a turn settles off the bottom', () => {
    const { rerender } = render(
      <MessageList messages={messages} streamingMessageIds={new Set()} />
    );
    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });
    virtuosoMockHandle.scrollToIndex.mockClear();

    // A late cost true-up grows the last reply after streaming settled — a fresh
    // messages reference with the viewport already off the bottom and auto-follow
    // engaged must re-pin, since followOutput won't fire on an in-place growth.
    rerender(<MessageList messages={[...messages]} streamingMessageIds={new Set()} />);

    expect(virtuosoMockHandle.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end' });
  });

  it('excludes messages with a decryption-failure fallback content from data-decrypted-count', () => {
    const partiallyDecrypted = [
      { ...messages[0]!, content: '[decryption failed: missing epoch key]' },
      messages[1]!,
      messages[2]!,
    ];
    render(<MessageList messages={partiallyDecrypted} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-message-count', '3');
    expect(container).toHaveAttribute('data-decrypted-count', '2');
  });

  it('reports data-decrypted-count of 0 on the empty-state log', () => {
    render(<MessageList messages={[]} />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('data-decrypted-count', '0');
    expect(emptyState).toHaveAttribute('data-message-count', '0');
  });

  it('renders data-messages-ready="false" by default so tests can wait for parent readiness', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-messages-ready', 'false');
  });

  it('renders data-messages-ready="true" when the parent passes messagesReady', () => {
    render(<MessageList messages={messages} messagesReady />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-messages-ready', 'true');
  });

  it('exposes data-messages-ready on the empty-state log too', () => {
    render(<MessageList messages={[]} messagesReady />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('data-messages-ready', 'true');
  });

  it('exposes data-message-id on every rendered message item', () => {
    render(<MessageList messages={messages} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems[0]).toHaveAttribute('data-message-id', '1');
    expect(messageItems[1]).toHaveAttribute('data-message-id', '2');
    expect(messageItems[2]).toHaveAttribute('data-message-id', '3');
  });

  describe('memoized message counts', () => {
    const mixed: Message[] = [
      { ...messages[0]!, id: 'm1', role: 'user', content: 'Plain user' },
      { ...messages[1]!, id: 'm2', role: 'assistant', content: 'Priced reply', cost: '0.01' },
      {
        ...messages[2]!,
        id: 'm3',
        role: 'assistant',
        content: '[decryption failed: missing epoch key]',
      },
      { ...messages[0]!, id: 'm4', role: 'assistant', content: 'Free reply' },
    ];

    it('exposes data-assistant-count equal to the number of assistant-role messages', () => {
      render(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-assistant-count', '3');
    });

    it('exposes data-cost-count equal to the number of messages with a non-null cost', () => {
      render(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-cost-count', '1');
    });

    it('exposes data-decrypted-count excluding decryption-failure fallbacks', () => {
      render(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-decrypted-count', '3');
    });

    it('keeps all three counts stable across a re-render with the same messages reference', () => {
      const { rerender } = render(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-assistant-count', '3');
      expect(container).toHaveAttribute('data-cost-count', '1');
      expect(container).toHaveAttribute('data-decrypted-count', '3');

      rerender(<MessageList messages={mixed} streamingMessageIds={new Set(['m2'])} />);
      expect(container).toHaveAttribute('data-assistant-count', '3');
      expect(container).toHaveAttribute('data-cost-count', '1');
      expect(container).toHaveAttribute('data-decrypted-count', '3');
    });
  });

  describe('streaming / error state baked into Virtuoso data', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('bakes isStreaming into each row based on streamingMessageIds', () => {
      render(<MessageList messages={messages} streamingMessageIds={new Set(['2'])} />);
      const data = capturedVirtuosoProps['data'] as { key: string; isStreaming: boolean }[];
      expect(data).toHaveLength(3);
      const streamingRow = data.find((r) => r.key === '2');
      expect(streamingRow?.isStreaming).toBe(true);
      const nonStreamingRow = data.find((r) => r.key === '1');
      expect(nonStreamingRow?.isStreaming).toBe(false);
    });

    it('bakes isError into the row matching errorMessageId', () => {
      render(<MessageList messages={messages} errorMessageId="2" />);
      const data = capturedVirtuosoProps['data'] as { key: string; isError: boolean }[];
      const errorRow = data.find((r) => r.key === '2');
      expect(errorRow?.isError).toBe(true);
      const okRow = data.find((r) => r.key === '1');
      expect(okRow?.isError).toBe(false);
    });

    it('produces a new data array reference when streamingMessageIds changes', () => {
      // Regression test for the stale-isStreaming bug that caused regenerate
      // buttons to go missing after streaming completed. Baking streaming
      // state into the data array ensures Virtuoso's data-identity check sees
      // a change and re-renders items.
      const { rerender } = render(
        <MessageList messages={messages} streamingMessageIds={new Set(['2'])} />
      );
      const firstData = capturedVirtuosoProps['data'];

      rerender(<MessageList messages={messages} streamingMessageIds={new Set()} />);
      const secondData = capturedVirtuosoProps['data'];

      expect(firstData).not.toBe(secondData);
    });

    it('exposes data-streams-completed reflecting the stream-cycle store', () => {
      useStreamCycleActivityStore.setState({ streamsCompleted: 5 });
      render(<MessageList messages={messages} persistingMessageIds={new Set()} />);
      expect(screen.getByTestId('message-list')).toHaveAttribute('data-streams-completed', '5');
      act(() => {
        useStreamCycleActivityStore.setState({ streamsCompleted: 0 });
      });
    });

    it('exposes data-pre-inference-stages-seen reflecting the pre-inference store', () => {
      usePreInferenceActivityStore.setState({ preInferenceStagesSeen: 3 });
      render(<MessageList messages={messages} persistingMessageIds={new Set()} />);
      expect(screen.getByTestId('message-list')).toHaveAttribute(
        'data-pre-inference-stages-seen',
        '3'
      );
      act(() => {
        usePreInferenceActivityStore.setState({ preInferenceStagesSeen: 0 });
      });
    });

    // DOM attributes (test signals) read from persistingMessageIds; per-row
    // isStreaming (UX signal) reads from streamingMessageIds. The two
    // diverge during the cost-settlement window: streamingMessageIds clears
    // on the early flip so the toolbar appears immediately, but
    // persistingMessageIds stays populated until the server commits.
    it('data-streaming-count reflects persistingMessageIds, NOT streamingMessageIds', () => {
      render(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set(['2'])}
        />
      );
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-streaming-count', '1');
    });

    it('data-streaming-count reflects persistingMessageIds size, not streamingMessageIds', () => {
      const { rerender } = render(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set(['2'])}
          persistingMessageIds={new Set(['2'])}
        />
      );
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-streaming-count', '1');

      // Early flip: streamingMessageIds clears but persistingMessageIds stays —
      // the count tracks persistence (server-committed), so it stays 1.
      rerender(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set(['2'])}
        />
      );
      expect(container).toHaveAttribute('data-streaming-count', '1');

      // SSE done arrives: persistingMessageIds clears.
      rerender(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set()}
        />
      );
      expect(container).toHaveAttribute('data-streaming-count', '0');
    });

    it('per-row isStreaming still reads from streamingMessageIds, not persistingMessageIds', () => {
      render(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set(['2'])}
        />
      );
      const data = capturedVirtuosoProps['data'] as { key: string; isStreaming: boolean }[];
      // Message 2 is in persisting (server hasn't committed yet) but NOT in
      // streaming (token stream ended). Per-row isStreaming should be false
      // so the toolbar renders immediately.
      const row2 = data.find((r) => r.key === '2');
      expect(row2?.isStreaming).toBe(false);
    });

    it('clearing streamingMessageIds re-renders items without isStreaming so action buttons appear', () => {
      // End-to-end check of the fix: start with an assistant message streaming
      // (no action buttons), clear streaming, action buttons should appear.
      const singleAssistant: Message[] = [
        {
          id: 'u1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hi',
          createdAt: '2024-01-01T00:00:00Z',
          parentMessageId: null,
        },
        {
          id: 'a1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'hello back',
          createdAt: '2024-01-01T00:00:01Z',
          parentMessageId: 'u1',
        },
      ];
      const onRegenerate = vi.fn();

      const { rerender } = render(
        <MessageList
          messages={singleAssistant}
          streamingMessageIds={new Set(['a1'])}
          onRegenerate={onRegenerate}
        />
      );
      expect(screen.queryByLabelText('Regenerate')).not.toBeInTheDocument();

      rerender(
        <MessageList
          messages={singleAssistant}
          streamingMessageIds={new Set()}
          onRegenerate={onRegenerate}
        />
      );
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
    });
  });

  describe('initial scroll position', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('mounts Virtuoso with initialTopMostItemIndex pointing at the last row', () => {
      render(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['initialTopMostItemIndex']).toEqual({
        index: 'LAST',
        align: 'end',
      });
    });

    it('mounts Virtuoso with initialItemCount of 1 so a row renders before the scroller is measured', () => {
      // Seeds the first paint against the WebKit zero-height stall (scroller
      // measures 0 before the flex chain resolves, so Virtuoso would render no
      // rows). Pinned at 1: the seed renders forward from the `LAST` anchor, so
      // any higher count overruns `data` and crashes computeItemKey — the real
      // behavior is covered in message-list.initial-paint.test.tsx.
      render(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['initialItemCount']).toBe(1);
    });
  });

  describe('conversationKey transitions (no-flash refactor)', () => {
    beforeEach(() => {
      virtuosoMockHandle.scrollToIndex.mockClear();
    });

    it('keeps the underlying virtuoso-mock DOM node identity across conversationKey changes', () => {
      // Previously the parent passed `key={conversationId}`, which forced
      // unmount/remount on every conversation switch — including the
      // welcome → first-real-id case, producing a visible blank-frame flash.
      const { rerender } = render(<MessageList messages={messages} conversationKey="init-main" />);
      const before = screen.getByTestId('virtuoso-mock');

      rerender(<MessageList messages={messages} conversationKey="real-id-main" />);

      // Same DOM node — React preserved the instance because nothing above
      // it keyed on conversationId.
      expect(screen.getByTestId('virtuoso-mock')).toBe(before);
    });

    it('snaps Virtuoso to the last row when conversationKey changes', () => {
      const { rerender } = render(
        <MessageList messages={messages} conversationKey="conv-a-main" />
      );
      // Initial mount registers the conversationKey but should not scroll —
      // Virtuoso already starts at LAST via initialTopMostItemIndex.
      expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();

      rerender(<MessageList messages={messages} conversationKey="conv-b-main" />);

      expect(virtuosoMockHandle.scrollToIndex).toHaveBeenCalledWith({
        index: 'LAST',
        align: 'end',
      });
    });

    it('does not snap on re-render when conversationKey is unchanged', () => {
      const { rerender } = render(
        <MessageList messages={messages} conversationKey="conv-a-main" />
      );
      rerender(
        <MessageList
          messages={[...messages, { ...messages[0]!, id: '4' }]}
          conversationKey="conv-a-main"
        />
      );
      expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
    });
  });

  describe('forwardRef', () => {
    it('exposes MessageListHandle via ref', () => {
      const ref = React.createRef<MessageListHandle>();
      render(<MessageList ref={ref} messages={messages} />);

      expect(ref.current).toBeDefined();
    });
  });

  describe('error message identification', () => {
    it('passes isError to MessageItem when errorMessageId matches', () => {
      const errorMessages = [
        {
          id: 'err-1',
          conversationId: 'conv-1',
          role: 'assistant' as const,
          content: 'You ran out of messages. [Sign up](/signup) to continue!',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
      render(<MessageList messages={errorMessages} errorMessageId="err-1" />);

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveAttribute('data-error', 'true');
    });

    it('does not pass isError when errorMessageId does not match', () => {
      render(<MessageList messages={messages} errorMessageId="nonexistent" />);

      const messageItems = screen.getAllByTestId('message-item');
      for (const item of messageItems) {
        expect(item).not.toHaveAttribute('data-error');
      }
    });
  });

  describe('onShare', () => {
    it('passes onShare to assistant message items', () => {
      const onShare = vi.fn();
      render(<MessageList messages={messages} onShare={onShare} />);

      const shareButtons = screen.getAllByLabelText('Share');
      expect(shareButtons).toHaveLength(1);
    });

    it('does not render share buttons when onShare is not provided', () => {
      render(<MessageList messages={messages} />);

      expect(screen.queryByLabelText('Share')).not.toBeInTheDocument();
    });
  });

  describe('action callbacks', () => {
    it('passes onRegenerate to MessageItem so retry button renders on user messages', () => {
      const onRegenerate = vi.fn();
      render(<MessageList messages={messages} onRegenerate={onRegenerate} />);

      const retryButtons = screen.getAllByLabelText('Retry');
      expect(retryButtons.length).toBeGreaterThan(0);
    });

    it('passes onEdit to MessageItem so edit button renders on user messages', () => {
      const onEdit = vi.fn();
      render(<MessageList messages={messages} onEdit={onEdit} />);

      const editButtons = screen.getAllByLabelText('Edit');
      expect(editButtons.length).toBeGreaterThan(0);
    });

    it('passes onFork to MessageItem so fork button renders', () => {
      const onFork = vi.fn();
      render(<MessageList messages={messages} onFork={onFork} />);

      const forkButtons = screen.getAllByLabelText('Fork');
      expect(forkButtons.length).toBeGreaterThan(0);
    });

    it('does not render action buttons when callbacks are not provided', () => {
      render(<MessageList messages={messages} />);

      expect(screen.queryByLabelText('Retry')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Fork')).not.toBeInTheDocument();
    });
  });

  describe('multi-model regeneration', () => {
    const multiModelMessages: Message[] = [
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Compare models',
        createdAt: '2024-01-01T00:00:00Z',
        parentMessageId: null,
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'GPT response',
        createdAt: '2024-01-01T00:00:01Z',
        parentMessageId: 'u1',
        modelName: 'GPT-4o',
      },
      {
        id: 'a2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Claude response',
        createdAt: '2024-01-01T00:00:02Z',
        parentMessageId: 'u1',
        modelName: 'Claude 3.5',
      },
    ];

    it('shows per-tile regenerate buttons on multi-model assistant messages (regenerate-one)', () => {
      const onRegenerate = vi.fn();
      render(<MessageList messages={multiModelMessages} onRegenerate={onRegenerate} />);

      // One regenerate icon button per assistant tile.
      expect(screen.getAllByLabelText('Regenerate')).toHaveLength(2);
    });

    it('shows retry/edit buttons on user message with multiple assistant children (retry-all)', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <MessageList messages={multiModelMessages} onRegenerate={onRegenerate} onEdit={onEdit} />
      );

      expect(screen.getByLabelText('Retry')).toBeInTheDocument();
      expect(screen.getByLabelText('Edit')).toBeInTheDocument();
    });

    it('shows regenerate buttons on single-model messages', () => {
      const singleModelMessages: Message[] = [
        {
          id: 'u1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'Hello',
          createdAt: '2024-01-01T00:00:00Z',
          parentMessageId: null,
        },
        {
          id: 'a1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Hi there',
          createdAt: '2024-01-01T00:00:01Z',
          parentMessageId: 'u1',
        },
      ];
      const onRegenerate = vi.fn();
      render(<MessageList messages={singleModelMessages} onRegenerate={onRegenerate} />);

      expect(screen.getByLabelText('Retry')).toBeInTheDocument();
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
    });
  });

  describe('group chat mode', () => {
    const members = [
      { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
      { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
    ];

    const groupMessages: Message[] = [
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello from Alice',
        createdAt: '2024-01-01T00:00:00Z',
        senderId: 'user-1',
      },
      {
        id: 'a2',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Second from Alice',
        createdAt: '2024-01-01T00:00:01Z',
        senderId: 'user-1',
      },
      {
        id: 'b1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hi from Bob',
        createdAt: '2024-01-01T00:00:02Z',
        senderId: 'user-2',
      },
      {
        id: 'ai1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'AI response',
        createdAt: '2024-01-01T00:00:03Z',
      },
    ];

    it('groups consecutive same-sender messages into fewer Virtuoso rows', () => {
      render(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      // 4 messages should produce 3 groups: alice×2, bob×1, AI×1
      const messageItems = screen.getAllByTestId('message-item');
      expect(messageItems).toHaveLength(3);
    });

    it('shows sender labels in group chat mode', () => {
      render(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const labels = screen.getAllByTestId('sender-label');
      // Should have labels for: alice group ("You"), bob group ("bob")
      // AI messages don't have labels
      expect(labels).toHaveLength(2);
      expect(labels[0]).toHaveTextContent('You');
      expect(labels[1]).toHaveTextContent('bob');
    });

    it('does not group messages when not in group chat mode', () => {
      render(<MessageList messages={groupMessages} />);

      const messageItems = screen.getAllByTestId('message-item');
      expect(messageItems).toHaveLength(4);
    });

    it('renders both messages within a grouped bubble', () => {
      render(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      expect(screen.getByText('Hello from Alice')).toBeInTheDocument();
      expect(screen.getByText('Second from Alice')).toBeInTheDocument();
    });
  });

  describe('scroll breakaway behavior', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('passes atBottomStateChange callback to Virtuoso', () => {
      render(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['atBottomStateChange']).toBeDefined();
      expect(typeof capturedVirtuosoProps['atBottomStateChange']).toBe('function');
    });

    it('followOutput returns true when user is at bottom', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      expect(followOutput(true)).toBe(true);
    });

    it('followOutput returns true regardless of isAtBottom when user has not scrolled away', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      expect(followOutput(false)).toBe(true);
    });

    it('followOutput returns false after user-driven scroll-away even when isAtBottom is true', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      // Simulate user scrolling on the scroller, then Virtuoso reports
      // the user is no longer at the bottom.
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });

      // Even if Virtuoso reports isAtBottom=true (e.g. smooth scroll animation),
      // followOutput should respect the breakaway state.
      expect(followOutput(true)).toBe(false);
    });

    it('followOutput re-engages once Virtuoso reports atBottom=true again', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(false);

      // Whether followOutput catches up or the user scrolled back, the
      // atBottom=true notification should re-engage auto-follow.
      act(() => {
        atBottomStateChange(true);
      });
      expect(followOutput(true)).toBe(true);
    });

    it('does NOT mark scrolled-away on atBottomStateChange(false) without prior user input', () => {
      // Regression: streaming content growth can push the view past the
      // bottom threshold for one frame. Without user input, the auto-follow
      // must keep chasing the bottom — not disengage.
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;

      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(true);
    });

    it('marks scrolled-away on touchmove + atBottomStateChange(false)', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });

      expect(followOutput(true)).toBe(false);
    });

    it.each([['PageDown'], ['PageUp'], ['Home'], ['End'], ['ArrowDown'], ['ArrowUp'], [' ']])(
      'marks scrolled-away on keydown "%s" + atBottomStateChange(false)',
      (key) => {
        render(<MessageList messages={messages} />);
        const followOutput = capturedVirtuosoProps['followOutput'] as (
          isAtBottom: boolean
        ) => boolean;
        const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
          atBottom: boolean
        ) => void;
        const scroller = screen.getByTestId('virtuoso-mock');

        scroller.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        act(() => {
          atBottomStateChange(false);
        });

        expect(followOutput(true)).toBe(false);
      }
    );

    it('does NOT mark scrolled-away on non-scroll keydown (e.g. typing letters)', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });

      expect(followOutput(true)).toBe(true);
    });

    it('user-input flag decays so a later atBottom(false) without input does not mark scrolled-away', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      // First user input then immediate atBottom(false) sticks.
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(false);

      // Re-engage at bottom.
      act(() => {
        atBottomStateChange(true);
      });
      expect(followOutput(true)).toBe(true);

      // Decay window passes — a later content-growth-only atBottom(false)
      // must NOT mark scrolled-away.
      vi.advanceTimersByTime(500);
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(true);
    });

    it('exposes resetScrollBreakaway via ref', () => {
      const ref = React.createRef<MessageListHandle>();
      render(<MessageList ref={ref} messages={messages} />);

      expect(ref.current).toBeDefined();
      expect(typeof ref.current?.resetScrollBreakaway).toBe('function');
    });

    it('resetScrollBreakaway re-enables auto-scroll after breakaway', () => {
      const ref = React.createRef<MessageListHandle>();
      render(<MessageList ref={ref} messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(false);

      ref.current?.resetScrollBreakaway();
      expect(followOutput(true)).toBe(true);
    });
  });

  describe('dev scroll hatch and user-scroll decay', () => {
    afterEach(() => {
      envRef.current.isLocalDev = false;
    });

    it('installs a dev-only scroll-to-index hatch and tears it down on unmount', () => {
      envRef.current.isLocalDev = true;
      const scrollHatch = (): ((index: number) => Promise<void>) | undefined =>
        (globalThis as { __virtuosoScrollToIndex?: (index: number) => Promise<void> })
          .__virtuosoScrollToIndex;

      const { unmount } = render(<MessageList messages={messages} />);

      expect(typeof scrollHatch()).toBe('function');
      void scrollHatch()?.(1);
      expect(virtuosoMockHandle.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ index: 1, align: 'start' })
      );

      unmount();
      expect(scrollHatch()).toBeUndefined();
    });

    it('marks a user scroll, decays it after the timeout, and clears a pending timer on unmount', () => {
      const { unmount } = render(<MessageList messages={messages} />);
      const scroller = screen.getByTestId('virtuoso-mock');

      fireEvent.wheel(scroller);
      fireEvent.keyDown(scroller, { key: 'ArrowDown' });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      // A fresh scroll leaves a pending decay timer that unmount must clear.
      fireEvent.keyDown(scroller, { key: 'PageDown' });
      expect(() => {
        unmount();
      }).not.toThrow();
    });

    it('reflects Virtuoso isScrolling transitions', () => {
      render(<MessageList messages={messages} />);
      expect(() => {
        (capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void)(true);
      }).not.toThrow();
      (capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void)(false);
    });
  });
});
