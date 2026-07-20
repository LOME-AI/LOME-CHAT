import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import type { ChatModality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';

/**
 * Isolated harness that mocks ChatWelcome's heavy children as prop-capturers so
 * the page-level callbacks (modality switch, model select/remove, typing
 * complete) can be invoked directly and their store effects asserted — the real
 * model-selector modal is too heavy to drive reliably from this page.
 */
// Capture child props via vi.fn calls (a function call is allowed inside a
// component render, unlike a module-scope reassignment).
const headerSpy = vi.fn<(props: Record<string, unknown>) => void>();
const comparisonSpy = vi.fn<(props: Record<string, unknown>) => void>();
const promptSpy = vi.fn<(props: Record<string, unknown>) => void>();

function lastProps(spy: typeof headerSpy): Record<string, unknown> {
  return spy.mock.calls.at(-1)?.[0] ?? {};
}

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useVisualViewportHeight: () => 800,
    useIsMobile: () => false,
  };
});

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = Object.assign(
    (selector?: (s: ModelStoreStub) => unknown) =>
      selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current,
    {
      getState: () => modelStoreStubRef.current,
      setState: vi.fn(),
    }
  );
  return { ...actual, useModelStore: store };
});

vi.mock('@/hooks/models/use-resolve-default-model', () => ({
  useResolveDefaultModel: () => {},
}));

vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => ({ active: false, canUse: true, toggle: vi.fn() }),
}));

vi.mock('@/hooks/models/use-selected-model-capabilities', () => ({
  useSelectedModelCapabilities: () => ({ models: [], premiumIds: new Set<string>() }),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: () => ({ displayBalance: '5.00' }),
}));

vi.mock('@/components/chat/layout/chat-header', () => ({
  ChatHeader: (props: Record<string, unknown>) => {
    headerSpy(props);
    return <div data-testid="chat-header" />;
  },
}));

vi.mock('@/components/chat/layout/comparison-bar', () => ({
  ComparisonBar: (props: Record<string, unknown>) => {
    comparisonSpy(props);
    return <div data-testid="comparison-bar" />;
  },
}));

vi.mock('@/components/chat/input/prompt-input', () => ({
  PromptInput: React.forwardRef(function MockPromptInput(
    props: Record<string, unknown>,
    _ref: React.ForwardedRef<unknown>
  ) {
    promptSpy(props);
    return <div data-testid="prompt-input" data-search={props['searchProps'] ? 'yes' : 'no'} />;
  }),
}));

vi.mock('@/components/chat/input/suggestion-chips', () => ({
  SuggestionChips: () => <div data-testid="suggestion-chips" />,
}));

vi.mock('@/components/chat/indicators/typing-animation', () => ({
  TypingAnimation: ({ text, onComplete }: { text: string; onComplete?: () => void }) => {
    // Fire in an effect (not during render) so the parent's showSubtitle update
    // — and the greeting's subtitle-reveal branch — are exercised.
    React.useEffect(() => {
      onComplete?.();
    }, [onComplete]);
    return <span>{text}</span>;
  },
}));

import { ChatWelcome } from '@/components/chat/page/chat-welcome';

beforeEach(() => {
  headerSpy.mockClear();
  comparisonSpy.mockClear();
  promptSpy.mockClear();
  modelStoreStubRef.current = createModelStoreStub();
});

describe('ChatWelcome callbacks', () => {
  it('switches the active modality through the prompt input handler', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    (lastProps(promptSpy)['onSelectModality'] as (m: ChatModality) => void)('image');

    expect(modelStoreStubRef.current.setActiveModality).toHaveBeenCalledWith('image');
  });

  it('commits a model selection through the header handler', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    const entries: SelectedModelEntry[] = [{ id: 'gpt', name: 'GPT' }];
    (lastProps(headerSpy)['onModelSelect'] as (e: SelectedModelEntry[]) => void)(entries);

    expect(modelStoreStubRef.current.setSelectedModels).toHaveBeenCalledWith('text', entries);
  });

  it('removes a model through the comparison bar handler', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    (lastProps(comparisonSpy)['onRemoveModel'] as (id: string) => void)('gpt');

    expect(modelStoreStubRef.current.removeModel).toHaveBeenCalledWith('text', 'gpt');
  });

  it('omits searchProps for a non-text modality', () => {
    modelStoreStubRef.current.activeModality = 'image';

    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    expect(lastProps(promptSpy)['searchProps']).toBeUndefined();
  });

  it('passes searchProps for the text modality', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    expect(lastProps(promptSpy)['searchProps']).toBeDefined();
  });
});
