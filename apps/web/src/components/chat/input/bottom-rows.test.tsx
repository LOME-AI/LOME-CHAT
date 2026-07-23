import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

const { mockUseIsMobile, mockUseModels } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(),
  mockUseModels: vi.fn(() => ({ data: { models: [], premiumIds: new Set<string>() } })),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: mockUseIsMobile,
  };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

// Lighten the budget hook: the real one pulls in TanStack Query.
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: () => ({
    hasContent: false,
    isOverCapacity: false,
    hasBlockingError: false,
    capacityCurrentUsage: 0,
    capacityMaxCapacity: 0,
    fundingSource: 'free',
    notifications: [],
  }),
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

import { TEST_IDS } from '@hushbox/shared';
import {
  ImageBottomRow,
  TextBottomRow,
  VideoBottomRow,
} from '@/components/chat/input/prompt-input';

const TOOLBAR = <div data-testid="test-toolbar">toolbar</div>;
const SEND = <button data-testid="test-send">send</button>;

describe('TextBottomRow', () => {
  const CAPACITY = { currentUsage: 100, maxCapacity: 1000 };

  it('lets the capacity bar wrap to its own line instead of shrinking under the toolbar', () => {
    render(<TextBottomRow capacity={CAPACITY} toolbar={TOOLBAR} sendButton={SEND} />);
    const bar = screen.getByTestId(TEST_IDS.capacityBar);
    expect(bar.parentElement?.className).toContain('flex-wrap');
    expect(bar.className).toContain('min-w-40');
    expect(bar.className).not.toContain('min-w-0');
  });

  it('keeps the toolbar and send button pushed to the right edge when the bar wraps', () => {
    render(<TextBottomRow capacity={CAPACITY} toolbar={TOOLBAR} sendButton={SEND} />);
    const group = screen.getByTestId('test-toolbar').parentElement;
    expect(group?.className).toContain('ml-auto');
  });
});

describe('ImageBottomRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({ data: { models: [], premiumIds: new Set<string>() } });
    resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
  });

  it('on desktop renders the inline aspect-ratio pills and the cost line', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /image settings/i })).not.toBeInTheDocument();
  });

  it('on mobile renders the summary chip, hiding the inline pills', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('button', { name: /image settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
  });

  it('on mobile opens the bottom sheet when the chip is tapped', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /image settings/i }));
    expect(screen.getByRole('dialog', { name: /image generation settings/i })).toBeInTheDocument();
  });

  it('renders the toolbar and send button on both desktop and mobile', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { unmount } = render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
    unmount();

    mockUseIsMobile.mockReturnValue(true);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
  });
});

describe('VideoBottomRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({ data: { models: [], premiumIds: new Set<string>() } });
    resetStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
  });

  it('on desktop renders the duration slider, aspect-ratio pills, and resolution chips', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /video settings/i })).not.toBeInTheDocument();
  });

  it('on mobile renders the summary chip, hiding the inline controls', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('button', { name: /video settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('on mobile opens the bottom sheet when the chip is tapped', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /video settings/i }));
    expect(screen.getByRole('dialog', { name: /video generation settings/i })).toBeInTheDocument();
  });

  it('renders the toolbar and send button on both desktop and mobile', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { unmount } = render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
    unmount();

    mockUseIsMobile.mockReturnValue(true);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
  });
});
