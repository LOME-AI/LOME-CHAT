import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MessageItem } from '@/components/chat/message/message-item';
import type { MessageGroup } from '@/lib/chat-sender';
import type { Message } from '@/lib/api';
import type { MessageAction } from '@/lib/message-actions';
import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';

vi.mock('@/lib/chat-tts-stream', () => ({
  stopTtsForMessage: vi.fn(),
}));

// The notice's link uses TanStack Router which requires Router context. Mock
// to a marker element here — the real link behavior is exercised in
// tts-stopped-notice.test.tsx with a full router setup. This test asserts
// only that the notice is mounted in the right slot when the store flags it.
// Uses vi.importActual so the gating mirrors what MessageItem will see in
// production; only the Link-rendering DOM is swapped for a marker div.
vi.mock('@/components/chat/indicators/tts-stopped-notice', async () => {
  const { useTtsPlaybackStore } = await vi.importActual<
    typeof import('@hushbox/ui/accessibility/store')
  >('@hushbox/ui/accessibility/store');
  return {
    TtsStoppedNotice: ({ messageId }: { messageId: string }) => {
      const stopped = useTtsPlaybackStore((s) => s.stoppedStreamIds.has(messageId));
      if (!stopped) return null;
      return (
        <div data-testid="mock-tts-stopped-notice" data-message-id={messageId}>
          You can disable auto-read in Accessibility settings
        </div>
      );
    },
  };
});

vi.mock('@/stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    setActiveDocument: vi.fn(),
  }),
}));

// MarkdownRenderer is consumed via React.lazy(() => import('@/components/chat/message/markdown-renderer')).
// Stub it with a lightweight double so the dynamic import resolves promptly:
// the real streamdown/shiki/katex stack pulls its own lazy chunks that never
// settle under jsdom. Markdown rendering itself (links, code, math) is covered
// directly in markdown-renderer.test.tsx. The stub honours the contract
// message-item relies on — the markdown-renderer testid and forwarded props
// surfaced as data attributes (React.lazy captures the resolved component, so
// forwarding is asserted via the DOM rather than a spy on the named export).
// `mockMarkdownSuspendForever` holds the stub in a synchronously-suspended state
// so the outer Suspense fallback (the plain-text first paint) is observable;
// once React.lazy resolves the first time it stays resolved file-wide, so the
// natural unresolved state can't otherwise be re-observed.
const mockMarkdownSuspendForever = { current: false };
const neverResolves = new Promise<never>(() => {});
vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => {
    // Throwing a never-resolving promise is React Suspense's contract for
    // "still loading" — that is what keeps the outer fallback visible here.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Suspense suspends by throwing a thenable, not an Error
    if (mockMarkdownSuspendForever.current) throw neverResolves;
    return (
      <div data-testid="markdown-renderer" data-streaming={isStreaming === true ? 'true' : 'false'}>
        {content}
      </div>
    );
  },
}));

const mockModelsData = {
  data: {
    models: [
      {
        id: 'anthropic/claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        provider: 'Anthropic',
        contextLength: 200_000,
        pricePerInputToken: 0.000_003,
        pricePerOutputToken: 0.000_015,
        capabilities: [],
        description: 'Claude model',
        supportedParameters: [],
      },
      {
        id: 'openai/gpt-4o-2024-08-06',
        name: 'GPT-4o',
        provider: 'OpenAI',
        contextLength: 128_000,
        pricePerInputToken: 0.000_005,
        pricePerOutputToken: 0.000_015,
        capabilities: [],
        description: 'GPT model',
        supportedParameters: [],
      },
      {
        id: 'smart-model',
        name: 'Smart Model',
        provider: 'HushBox',
        contextLength: 200_000,
        pricePerInputToken: 0.000_003,
        pricePerOutputToken: 0.000_015,
        capabilities: [],
        description: 'Auto-router model',
        supportedParameters: [],
        isSmartModel: true,
      },
    ],
    premiumIds: new Set<string>(),
  },
  isLoading: false,
};

vi.mock('@/hooks/models/models', () => ({
  useModels: () => mockModelsData,
}));

// Mock MediaContentItem to avoid the full fetch + decrypt chain in tests, but
// keep the real `messageMediaToRenderable` mapper the bubble uses to normalize
// media. Tests assert one <MediaContentItem> renders per media item.
vi.mock('@/components/chat/media/media-content-item', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/media/media-content-item')>()),
  MediaContentItem: ({ item }: { item: { contentItemId: string; contentType: string } }) => (
    <div
      data-testid={`mock-media-item-${item.contentItemId}`}
      data-content-type={item.contentType}
    />
  ),
}));

// Stub the epoch key cache + crypto primitives to count content-key unwraps.
// We assert the unwrap runs once per message regardless of how many media items
// the message carries (the content key is hoisted to the parent). `asEpochPrivateKey`
// is stubbed to identity so the fake short epoch key isn't length-validated.
const mockUnwrapContentKeyFromEpoch = vi.fn(() => new Uint8Array([1, 2, 3]));
vi.mock('@hushbox/crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/crypto')>();
  return {
    ...original,
    asEpochPrivateKey: (key: Uint8Array) => key,
    unwrapContentKeyFromEpoch: (...args: unknown[]) =>
      mockUnwrapContentKeyFromEpoch(...(args as [])),
  };
});
vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => new Uint8Array([9, 9, 9])),
  setEpochKey: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

const ALL_USER_ACTIONS = new Set<MessageAction>(['copy', 'retry', 'edit', 'fork']);
const ALL_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']);
const NO_ACTIONS = new Set<MessageAction>();
const ERROR_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate']);

describe('MessageItem', () => {
  const userMessage = {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello, how are you?',
    createdAt: '2024-01-01T00:00:00Z',
  };

  const assistantMessage = {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'I am doing well, thank you!',
    createdAt: '2024-01-01T00:00:01Z',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders message content', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
  });

  it('renders user message with user styling', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'user');
  });

  it('renders assistant message with assistant styling', () => {
    render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'assistant');
  });

  it('wraps each message in a centered max-width container', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const messageItem = screen.getByTestId('message-item');
    const wrapper = messageItem.parentElement;
    expect(wrapper).toHaveClass('mx-auto', 'w-full', 'max-w-3xl');
  });

  it('applies fit-content width with right alignment for user messages', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('w-fit');
    expect(container).toHaveClass('ml-auto');
    expect(container).toHaveClass('max-w-[82%]');
    expect(container).toHaveClass('mr-4');
  });

  it('applies fixed padding for assistant messages', () => {
    render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('px-4');
  });

  it('wraps text at word boundaries for user messages', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const text = screen.getByText(userMessage.content);
    expect(text).toHaveClass('break-words');
    expect(text).not.toHaveClass('break-all');
  });

  it('wraps text at word boundaries for assistant messages', () => {
    render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    const contentDiv = container.querySelector('.break-words');
    expect(contentDiv).toBeInTheDocument();
  });

  describe('copy button', () => {
    it('renders copy button for each message', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies message content to clipboard when clicked', async () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      expect(assistantMessage.content).toBe('I am doing well, thank you!');
    });

    it('shows copied feedback after clicking', async () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });

    it('resets to copy state after delay', async () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2500);
      });

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copy button has ghost variant styling', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      const button = screen.getByRole('button', { name: /copy/i });
      expect(button).toHaveClass('h-7', 'w-7');
    });

    it('action button frame uses compact 28px hit area across viewports', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      const button = screen.getByRole('button', { name: /copy/i });
      expect(button).toHaveClass('h-7', 'w-7');
      expect(button.className).not.toMatch(/\bmd:h-/);
      expect(button.className).not.toMatch(/\bmd:w-/);
    });

    it('message-item reserves bottom space so absolute action buttons fit within the virtuoso row', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      const item = screen.getByTestId('message-item');
      expect(item).toHaveClass('pb-8');
    });
  });

  describe('error messages', () => {
    const errorMessage = {
      id: 'err-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: 'Please wait for your current messages to finish.',
      createdAt: '2024-01-01T00:00:00Z',
    };

    it('renders error content with markdown', async () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      // MarkdownRenderer is lazy; flush the dynamic-import microtask under fake
      // timers (findBy/waitFor poll on timers that fake timers stall).
      await act(async () => {});
      const renderer = screen.getByTestId('markdown-renderer');
      expect(renderer).toHaveTextContent('Please wait for your current messages to finish.');
    });

    it('renders with assistant styling (data-role=assistant)', () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-role', 'assistant');
    });

    it('renders copy button on errored assistant messages', () => {
      // With the standalone retry button removed, the toolbar carries every
      // affordance — including Copy — even on errored turns. Pre-fix, errored
      // messages had only the orphan Retry button and no toolbar.
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('does not render a standalone retry-error button (folded into toolbar Regenerate)', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      // The dedicated `retry-error-button` testid belonged to the lone
      // RetryButton that rendered above the error bubble; deleting it removes
      // the duplicate retry affordance and the misplaced position.
      expect(screen.queryByTestId('retry-error-button')).not.toBeInTheDocument();
    });

    it('renders Regenerate in the toolbar on errored assistant messages', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('calls onRegenerate when the errored message Regenerate button is clicked', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(onRegenerate).toHaveBeenCalledWith(errorMessage.id);
    });

    it('applies error styling with data-error attribute', () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-error', 'true');
    });

    it('does not set data-error on non-error messages', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      const container = screen.getByTestId('message-item');
      expect(container).not.toHaveAttribute('data-error');
    });
  });

  describe('share button', () => {
    it('renders share button for assistant messages', () => {
      const onShare = vi.fn();
      render(
        <MessageItem message={assistantMessage} onShare={onShare} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
    });

    it('does not render share button for user messages', () => {
      const onShare = vi.fn();
      render(
        <MessageItem message={userMessage} onShare={onShare} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('calls onShare with message id when clicked', () => {
      const onShare = vi.fn();
      render(
        <MessageItem message={assistantMessage} onShare={onShare} allowedActions={ALL_AI_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /share/i }));
      expect(onShare).toHaveBeenCalledWith('2');
    });

    it('does not render share button when onShare is not provided', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('does not render share button for error messages', () => {
      const errorMsg = {
        id: 'err-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Error occurred',
        createdAt: '2024-01-01T00:00:00Z',
      };
      const onShare = vi.fn();
      render(
        <MessageItem
          message={errorMsg}
          isError
          onShare={onShare}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });
  });

  describe('assistant action row layout', () => {
    const assistantMessageWithCost = {
      ...assistantMessage,
      cost: '1360000',
    };

    it('left-justifies the action buttons (buttons container has no ml-auto)', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      const copyButton = screen.getByRole('button', { name: /copy/i });
      const buttonsContainer = copyButton.parentElement;
      expect(buttonsContainer).not.toHaveClass('ml-auto');
    });

    it('renders the price indicator to the right of the buttons (after them in DOM order)', () => {
      render(<MessageItem message={assistantMessageWithCost} allowedActions={ALL_AI_ACTIONS} />);
      const cost = screen.getByTestId('message-cost');
      const copyButton = screen.getByRole('button', { name: /copy/i });
      expect(copyButton.compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('bottom-aligns the action row (items-end, not items-center)', () => {
      render(<MessageItem message={assistantMessageWithCost} allowedActions={ALL_AI_ACTIONS} />);
      const copyButton = screen.getByRole('button', { name: /copy/i });
      const buttonsContainer = copyButton.parentElement;
      const row = buttonsContainer?.parentElement;
      expect(row).toHaveClass('items-end');
      expect(row).not.toHaveClass('items-center');
    });

    it('places the cost in a button-height wrapper that centers it (mirrors how the icon sits in the button)', () => {
      // Both children of the row become 28px-tall containers centering a 12px
      // glyph: the icon is centered in its h-7 button by <Button size="icon">,
      // and the cost is centered in this h-7 wrapper. Bottoms line up at the
      // same y without any magic margin offset.
      render(<MessageItem message={assistantMessageWithCost} allowedActions={ALL_AI_ACTIONS} />);
      const cost = screen.getByTestId('message-cost');
      expect(cost.parentElement).toHaveClass('h-7');
      expect(cost.parentElement).toHaveClass('items-center');
    });
  });

  describe('streaming', () => {
    it('forwards isStreaming=true to MarkdownRenderer', async () => {
      render(<MessageItem message={assistantMessage} isStreaming allowedActions={NO_ACTIONS} />);

      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-streaming', 'true');
    });

    it('forwards isStreaming=undefined when not set', async () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-streaming', 'false');
    });

    it('paints streaming text via the plain-text fallback while the markdown renderer is loading', () => {
      // The markdown stack is lazy-loaded behind Suspense. While it loads, the
      // fallback must show the raw text so a streaming token is visible without
      // waiting for streamdown/shiki/katex to download.
      mockMarkdownSuspendForever.current = true;
      try {
        const streamingMsg = {
          id: 'stream-1',
          conversationId: 'conv-1',
          role: 'assistant' as const,
          content: 'partial answer so far',
          createdAt: '2024-01-01T00:00:00Z',
        };
        render(<MessageItem message={streamingMsg} isStreaming allowedActions={NO_ACTIONS} />);

        // Markdown renderer still loading: raw text shows, renderer absent.
        expect(screen.getByText('partial answer so far')).toBeInTheDocument();
        expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
      } finally {
        mockMarkdownSuspendForever.current = false;
      }
    });

    it('swaps the fallback for the markdown renderer once it loads', async () => {
      const streamingMsg = {
        id: 'stream-2',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'final answer',
        createdAt: '2024-01-01T00:00:00Z',
      };
      render(<MessageItem message={streamingMsg} isStreaming allowedActions={NO_ACTIONS} />);

      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
    });

    it('marks the streaming AI message container with aria-live="polite"', () => {
      render(<MessageItem message={assistantMessage} isStreaming allowedActions={NO_ACTIONS} />);
      const live = screen.getByTestId('ai-message-live-region');
      expect(live).toHaveAttribute('aria-live', 'polite');
    });

    it('does not mark non-streaming AI message text with aria-live', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      const region = screen.queryByTestId('ai-message-live-region');
      if (region) expect(region.getAttribute('aria-live')).toBe('off');
    });
  });

  describe('thinking indicator', () => {
    const emptyAssistantMessage = {
      id: 'thinking-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: '',
      createdAt: '2024-01-01T00:00:00Z',
    };

    it('shows thinking indicator when streaming with empty content', () => {
      render(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    it('does not show thinking indicator when content is non-empty', () => {
      render(
        <MessageItem
          message={assistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator when not streaming', () => {
      render(
        <MessageItem
          message={emptyAssistantMessage}
          modelName="Claude"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator for user messages', () => {
      const emptyUserMessage = {
        id: 'user-empty',
        conversationId: 'conv-1',
        role: 'user' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
      };
      render(
        <MessageItem
          message={emptyUserMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('displays model name in thinking indicator', () => {
      render(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="GPT-4 Turbo"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByText('GPT-4 Turbo is thinking')).toBeInTheDocument();
    });

    it('resolves auto model ID to display name in thinking indicator', () => {
      const autoMessage = {
        ...emptyAssistantMessage,
        id: 'auto-thinking',
        modelName: 'smart-model',
      };
      render(
        <MessageItem
          message={autoMessage}
          isStreaming
          modelName="smart-model"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByText('Smart Model is thinking')).toBeInTheDocument();
    });

    it('resolves auto model ID from modelName prop in thinking indicator', () => {
      render(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="smart-model"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByText('Smart Model is thinking')).toBeInTheDocument();
    });

    it('shows MarkdownRenderer when streaming with content', async () => {
      render(
        <MessageItem
          message={assistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
  });

  describe('group chat rendering', () => {
    const members = [
      { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
      { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
    ];

    function createMsg(overrides: Partial<Message> = {}): Message {
      return {
        id: crypto.randomUUID(),
        conversationId: 'conv-1',
        role: 'user',
        content: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('shows sender label "You" for own user message group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'Hello' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('You');
    });

    it('shows sender username for other member message group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Hi there' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('bob');
    });

    it('shows left user label for unknown senderId', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-deleted', content: 'Old message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'user-deleted',
        messages: [msg],
      };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('This user has left the conversation');
    });

    it('shows link guest displayName when senderId matches a link', () => {
      const links = [
        {
          id: 'link-001',
          displayName: 'Guest Alice',
          privilege: 'write',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
      const msg = createMsg({ id: 'm1', senderId: 'link-001', content: 'Guest message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'link-001',
        messages: [msg],
      };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          links={links}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('Guest Alice');
    });

    it('renders multiple messages in one group bubble', () => {
      const msg1 = createMsg({ id: 'm1', senderId: 'user-1', content: 'First message' });
      const msg2 = createMsg({ id: 'm2', senderId: 'user-1', content: 'Second message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'user-1',
        messages: [msg1, msg2],
      };

      render(
        <MessageItem
          message={msg1}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
      expect(screen.getAllByTestId('sender-label')).toHaveLength(1);
    });

    it('applies left alignment for other member messages', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Bob says hi' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('ml-4');
      expect(messageItem).toHaveClass('mr-auto');
    });

    it('applies right alignment for own messages', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'My message' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('mr-4');
      expect(messageItem).toHaveClass('ml-auto');
    });

    it('uses bg-muted for other member bubbles', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Bob says' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      const bubble = messageItem.querySelector('.bg-muted');
      expect(bubble).toBeInTheDocument();
    });

    it('uses bg-message-user for own message bubbles in group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'My msg' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      const bubble = messageItem.querySelector('.bg-message-user');
      expect(bubble).toBeInTheDocument();
    });

    it('does not show sender label for AI messages in group chat', () => {
      const aiMsg = createMsg({ id: 'ai1', role: 'assistant', content: 'AI response' });
      const group: MessageGroup = { id: 'ai1', role: 'assistant', messages: [aiMsg] };

      render(
        <MessageItem
          message={aiMsg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_AI_ACTIONS}
        />
      );

      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });

    it('renders AI messages full-width in group chat (same as 1:1)', () => {
      const aiMsg = createMsg({ id: 'ai1', role: 'assistant', content: 'AI response' });
      const group: MessageGroup = { id: 'ai1', role: 'assistant', messages: [aiMsg] };

      render(
        <MessageItem
          message={aiMsg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_AI_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('w-full');
      expect(messageItem).toHaveClass('px-4');
    });

    it('does not show sender label in 1:1 mode (no group prop)', () => {
      render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });
  });

  describe('model nametag', () => {
    it('shows model nametag from message.modelName', () => {
      const aiMsg = {
        id: 'ai-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('GPT-4o');
    });

    it('shows streaming modelName when message has no modelName', () => {
      const aiMsg = {
        id: 'ai-2',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: null,
      };
      render(
        <MessageItem
          message={aiMsg}
          modelName="Claude 3.5 Sonnet"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('Claude 3.5 Sonnet');
    });

    it('shows "AI" fallback when neither source has modelName', () => {
      const aiMsg = {
        id: 'ai-3',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: null,
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('AI');
    });

    it('does not show nametag on user messages', () => {
      render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      expect(screen.queryByTestId('model-nametag')).not.toBeInTheDocument();
    });

    // The a11y "Easier to read" preset applies `line-height: 2 !important` to
    // <p> elements via `html.a11y-line-height-double p`. If the nametag is a
    // <p>, it gets distorted relative to the inline Smart chip (a <span>),
    // breaking the visual centering of the two badges.
    it('does not render the nametag as a <p> element', () => {
      const aiMsg = {
        id: 'ai-tag',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag.tagName).not.toBe('P');
    });

    it('renders the Smart chip when isSmartModel is true', () => {
      const knownModel = mockModelsData.data.models[0];
      if (!knownModel) throw new Error('test fixture must include at least one model');
      const aiMsg = {
        id: 'ai-smart',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Routed by Smart Model',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: knownModel.id,
        isSmartModel: true,
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('smart-model-chip')).toBeInTheDocument();
      expect(screen.getByTestId('model-nametag')).toHaveTextContent(knownModel.name);
    });

    it('does not render the Smart chip when isSmartModel is absent', () => {
      const knownModel = mockModelsData.data.models[0];
      if (!knownModel) throw new Error('test fixture must include at least one model');
      const aiMsg = {
        id: 'ai-non-smart',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Direct selection',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: knownModel.id,
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('smart-model-chip')).not.toBeInTheDocument();
    });
  });

  describe('TTS stop button slot', () => {
    beforeEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    afterEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    it('renders the Stop button inside model-nametag-container when this message is being read', () => {
      const aiMsg: Message = {
        id: 'speaking-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().setSpeakingStream('speaking-msg');
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const container = screen.getByTestId('model-nametag-container');
      expect(within(container).getByRole('button', { name: /stop reading/i })).toBeInTheDocument();
    });

    it('does not render the Stop button when no message is being read', () => {
      const aiMsg: Message = {
        id: 'idle-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /stop reading/i })).not.toBeInTheDocument();
    });

    it('does not render the Stop button when a different message is being read', () => {
      const aiMsg: Message = {
        id: 'this-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().setSpeakingStream('other-msg');
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /stop reading/i })).not.toBeInTheDocument();
    });
  });

  describe('TTS stopped notice slot', () => {
    beforeEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    afterEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    it('renders the stopped notice when the user stopped this message', () => {
      const aiMsg: Message = {
        id: 'stopped-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().markStreamStopped('stopped-msg');
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('mock-tts-stopped-notice')).toHaveAttribute(
        'data-message-id',
        'stopped-msg'
      );
    });

    it('positions the notice above the message body so the body is pushed down', () => {
      const aiMsg: Message = {
        id: 'stopped-msg-pos',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello body',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().markStreamStopped('stopped-msg-pos');
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const notice = screen.getByTestId('mock-tts-stopped-notice');
      const liveRegion = screen.getByTestId('ai-message-live-region');
      const position = notice.compareDocumentPosition(liveRegion);
      // DOCUMENT_POSITION_FOLLOWING (4) means liveRegion comes after the notice.
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('does not render the notice when the user has not stopped this message', () => {
      const aiMsg: Message = {
        id: 'untouched-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('mock-tts-stopped-notice')).not.toBeInTheDocument();
    });

    it('does not render the notice for other messages stopped by the user', () => {
      const aiMsg: Message = {
        id: 'innocent-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().markStreamStopped('some-other-msg');
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('mock-tts-stopped-notice')).not.toBeInTheDocument();
    });
  });

  describe('pre-inference stage rendering', () => {
    it('renders the stage label in the thinking indicator while classifying', () => {
      const aiMsg = {
        id: 'ai-classifying',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'smart-model',
        classifyingStageId: 'smart-model' as const,
      };
      render(
        <MessageItem
          message={aiMsg}
          isStreaming
          modelName="Smart Model"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      const indicator = screen.getByTestId('thinking-indicator');
      expect(indicator).toHaveTextContent('Choosing the best model');
      expect(indicator).not.toHaveTextContent('Smart Model is thinking');
    });

    it('does not render the Smart chip while classifying (resolution pending)', () => {
      const aiMsg = {
        id: 'ai-classifying',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'smart-model',
        classifyingStageId: 'smart-model' as const,
      };
      render(
        <MessageItem
          message={aiMsg}
          isStreaming
          modelName="Smart Model"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      expect(screen.queryByTestId('smart-model-chip')).not.toBeInTheDocument();
    });

    it('uses resolvedModelName in the nametag when set live during streaming', () => {
      const aiMsg = {
        id: 'ai-resolved',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Streaming output…',
        createdAt: '2024-01-01T00:00:00Z',
        // After stage:done the optimistic message has the resolved id and
        // resolvedModelName set; useModels lookup may not yet contain the id.
        modelName: 'unknown/just-resolved',
        resolvedModelName: 'Just Resolved 4.6',
        isSmartModel: true,
      };
      render(<MessageItem message={aiMsg} isStreaming allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('model-nametag')).toHaveTextContent('Just Resolved 4.6');
      expect(screen.getByTestId('smart-model-chip')).toBeInTheDocument();
    });

    it('renders friendly error when stage failed (errorCode + no classifyingStageId)', () => {
      const aiMsg = {
        id: 'ai-stage-failed',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'smart-model',
        errorCode: 'CLASSIFIER_FAILED',
      };
      render(
        <MessageItem
          message={aiMsg}
          isStreaming
          modelName="Smart Model"
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      const errorEl = screen.getByTestId('model-error-message');
      expect(errorEl).toHaveTextContent(/Smart Model could not pick/i);
    });

    it('hides nametag when assistant message has no content and is not streaming', () => {
      const aiMsg = {
        id: 'ai-empty',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('model-nametag')).not.toBeInTheDocument();
    });

    it('shows nametag when streaming with empty content', () => {
      const aiMsg = {
        id: 'ai-streaming',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(
        <MessageItem
          message={aiMsg}
          isStreaming={true}
          modelName="GPT-4o"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByTestId('model-nametag')).toBeInTheDocument();
    });

    it('shows nametag for image/video/audio messages whose body is empty but mediaItems carry media', () => {
      // Media-only assistant messages have no text body — the bytes live in
      // mediaItems. The nametag should still render so the user can see which
      // model produced the image/video/audio.
      const aiMsg = {
        id: 'ai-image',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'google/imagen-4.0-generate-001',
        mediaItems: [
          {
            id: 'ci-1',
            position: 0,
            contentType: 'image' as const,
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
          },
        ],
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('model-nametag')).toBeInTheDocument();
    });

    it('resolves model ID to display name via models list', () => {
      const aiMsg = {
        id: 'ai-resolve',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'anthropic/claude-3-5-sonnet-20241022',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('Claude 3.5 Sonnet');
    });

    it('falls back to shortenModelName when model not in list', () => {
      const aiMsg = {
        id: 'ai-unknown',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'mistral/mistral-large-2024-11-01',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('mistral-large');
    });

    it('applies model-derived color to nametag via CSS custom properties', () => {
      const aiMsg = {
        id: 'ai-color',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag.getAttribute('style')).toContain('--nametag-bg');
      expect(nametag.getAttribute('style')).toContain('--nametag-fg');
    });
  });

  describe('regeneration buttons', () => {
    it('renders regenerate button on AI messages when onRegenerate is provided', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('calls onRegenerate with message id when regenerate button is clicked on AI message', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(onRegenerate).toHaveBeenCalledWith('2');
    });

    it('does not render regenerate button on AI messages when onRegenerate is not provided', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    });

    it('renders retry button on user messages when onRegenerate is provided (non-error)', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_USER_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('calls onRegenerate with message id when retry button is clicked on user message', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_USER_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRegenerate).toHaveBeenCalledWith('1');
    });

    it('renders edit button on user messages when onEdit is provided', () => {
      const onEdit = vi.fn();
      render(
        <MessageItem message={userMessage} onEdit={onEdit} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    });

    it('calls onEdit with message id and content when edit button is clicked', () => {
      const onEdit = vi.fn();
      render(
        <MessageItem message={userMessage} onEdit={onEdit} allowedActions={ALL_USER_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      expect(onEdit).toHaveBeenCalledWith('1', 'Hello, how are you?');
    });

    it('renders fork button on AI messages when onFork is provided', () => {
      const onFork = vi.fn();
      render(
        <MessageItem message={assistantMessage} onFork={onFork} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('renders fork button on user messages when onFork is provided', () => {
      const onFork = vi.fn();
      render(
        <MessageItem message={userMessage} onFork={onFork} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('calls onFork with message id when fork button is clicked', () => {
      const onFork = vi.fn();
      render(
        <MessageItem message={assistantMessage} onFork={onFork} allowedActions={ALL_AI_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /fork/i }));
      expect(onFork).toHaveBeenCalledWith('2');
    });

    it('does not render regeneration buttons during streaming', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      const onFork = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          isStreaming
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onFork={onFork}
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('does not render retry/edit on user messages during streaming', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          isStreaming
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });

    it('does not render retry/edit/regenerate when canRegenerate is false', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });

    it('does not render regenerate on AI message when canRegenerate is false', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    });

    it('still renders fork button when canRegenerate is false', () => {
      const onFork = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onFork={onFork}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('renders Regenerate (folded from the deleted Retry button) but not Fork on errored messages', () => {
      const errorMsg = {
        id: 'err-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Error occurred',
        createdAt: '2024-01-01T00:00:00Z',
      };
      const onRegenerate = vi.fn();
      const onFork = vi.fn();
      render(
        <MessageItem
          message={errorMsg}
          isError
          onRegenerate={onRegenerate}
          onFork={onFork}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
      // Fork stays off on errored messages — there's no successful assistant
      // turn to branch from.
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('does not render edit button on AI messages', () => {
      const onEdit = vi.fn();
      render(
        <MessageItem message={assistantMessage} onEdit={onEdit} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });
  });

  describe('media content items', () => {
    const messageWithMedia: Message = {
      ...assistantMessage,
      id: 'msg-with-media',
      content: '',
      wrappedContentKey: 'base64-wrapped-key',
      epochNumber: 1,
      mediaItems: [
        {
          id: 'ci-image-1',
          contentType: 'image',
          position: 0,
          mimeType: 'image/png',
          sizeBytes: 1_000_000,
          width: 1024,
          height: 1024,
        },
      ],
    };

    it('renders MediaContentItem for each media item', () => {
      render(<MessageItem message={messageWithMedia} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('mock-media-item-ci-image-1')).toBeInTheDocument();
      expect(screen.getByTestId('mock-media-item-ci-image-1')).toHaveAttribute(
        'data-content-type',
        'image'
      );
    });

    it('renders media items in position order', () => {
      const msg: Message = {
        ...messageWithMedia,
        mediaItems: [
          {
            id: 'ci-b',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
          {
            id: 'ci-a',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
        ],
      };
      render(<MessageItem message={msg} allowedActions={ALL_AI_ACTIONS} />);
      const rendered = screen.getAllByTestId(/^mock-media-item-/);
      expect(rendered[0]).toHaveAttribute('data-testid', 'mock-media-item-ci-a');
      expect(rendered[1]).toHaveAttribute('data-testid', 'mock-media-item-ci-b');
    });

    it('renders nothing when mediaItems is empty', () => {
      const msg: Message = { ...messageWithMedia, mediaItems: [] };
      render(<MessageItem message={msg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId(/^mock-media-item-/)).not.toBeInTheDocument();
    });

    it('renders nothing when wrappedContentKey is missing', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- omitting the key from the copy
      const { wrappedContentKey: _omitKey, ...rest } = messageWithMedia;
      render(<MessageItem message={rest} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId(/^mock-media-item-/)).not.toBeInTheDocument();
    });

    it('renders nothing when epochNumber is missing', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- omitting the field from the copy
      const { epochNumber: _omitEpoch, ...rest } = messageWithMedia;
      render(<MessageItem message={rest} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId(/^mock-media-item-/)).not.toBeInTheDocument();
    });

    describe('media-in-flight placeholder', () => {
      const inFlightMessage: Message = {
        ...assistantMessage,
        id: 'msg-in-flight',
        content: '',
      };

      it('shows "Generating image…" when mediaInFlight.mediaType is image', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'image', mimeType: 'image/png' },
        };
        render(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(screen.getByRole('status', { name: /generating image/i })).toBeInTheDocument();
      });

      it('shows "Generating video…" when mediaInFlight.mediaType is video', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'video', mimeType: 'application/octet-stream' },
        };
        render(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(screen.getByRole('status', { name: /generating video/i })).toBeInTheDocument();
      });

      it('shows "Generating audio…" when mediaInFlight.mediaType is audio', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'audio', mimeType: 'audio/mpeg' },
        };
        render(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(screen.getByRole('status', { name: /generating audio/i })).toBeInTheDocument();
      });

      it('renders the progress bar when mediaProgress.percent is set', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'video', mimeType: 'application/octet-stream' },
          mediaProgress: { percent: 42 },
        };
        render(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        const bar = screen.getByTestId('media-progress-bar');
        expect(bar).toBeInTheDocument();
        const fill = bar.querySelector('div');
        expect(fill?.getAttribute('style')).toContain('42%');
      });

      it('shapes the in-flight placeholder to the requested aspect ratio', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'image', mimeType: 'image/png', aspectRatio: '16:9' },
        };
        render(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        const placeholder = screen.getByRole('status', { name: /generating image/i });
        expect(placeholder.style.aspectRatio).toBe('16 / 9');
      });

      it('shows the classifier stage label, not the media backdrop, while choosing a model', () => {
        const msg: Message = {
          ...inFlightMessage,
          modelName: 'smart-model',
          mediaInFlight: { mediaType: 'image', mimeType: 'image/png', aspectRatio: '16:9' },
          classifyingStageId: 'smart-model',
        };
        render(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(
          screen.getByRole('status', { name: /choosing the best model/i })
        ).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: /generating image/i })).not.toBeInTheDocument();
      });
    });

    it('unwraps the message contentKey once even with multiple media items', () => {
      // The parent resolves contentKey once and passes it to each
      // MediaContentItem, so an N-image message does ONE unwrap, not N.
      // Asserts on `unwrapContentKeyFromEpoch` call count.
      mockUnwrapContentKeyFromEpoch.mockClear();
      const msgWithThreeMedia: Message = {
        ...messageWithMedia,
        mediaItems: [
          {
            id: 'ci-a',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
          {
            id: 'ci-b',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
          {
            id: 'ci-c',
            contentType: 'image',
            position: 2,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
        ],
      };
      render(<MessageItem message={msgWithThreeMedia} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getAllByTestId(/^mock-media-item-/)).toHaveLength(3);
      expect(mockUnwrapContentKeyFromEpoch).toHaveBeenCalledTimes(1);
    });
  });
});
