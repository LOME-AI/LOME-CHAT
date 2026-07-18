import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatPricePer1k, type Model } from '@hushbox/shared';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { useModelStore } from '@/stores/model';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';

function withTouchOverride(override: boolean | null, children: React.ReactNode): React.JSX.Element {
  return <TouchDeviceOverrideContext value={override}>{children}</TouchDeviceOverrideContext>;
}

/**
 * Force the model store into a known picker mode for the active text modality
 * before each test. Tests start in 'single' unless they call switchToMulti().
 */
function switchToMulti(): void {
  useModelStore.getState().setPickerMode('text', 'multi');
}

function switchToSingle(): void {
  useModelStore.getState().setPickerMode('text', 'single');
}

// Mock the api module to break the import chain that requires VITE_API_URL
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

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a href={to} className={className} onClick={onClick} data-testid="signup-link">
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

async function setIsMobile(value: boolean): Promise<void> {
  const module_ = await import('@hushbox/ui');
  vi.mocked(module_.useIsMobile).mockReturnValue(value);
}

function first<T>(array: T[]): T {
  const item = array[0];
  if (item === undefined) {
    throw new Error('Expected array to have at least one element');
  }
  return item;
}

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    description: 'A powerful language model from OpenAI.',
    supportedParameters: [],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    modality: 'text' as const,
    contextLength: 200_000,
    pricePerInputToken: 0.000_003,
    pricePerOutputToken: 0.000_015,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    description: 'Anthropic most intelligent model.',
    supportedParameters: [],
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B',
    provider: 'Meta',
    modality: 'text' as const,
    contextLength: 131_072,
    pricePerInputToken: 0.000_000_59,
    pricePerOutputToken: 0.000_000_79,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    description: 'Open-weight model offering excellent performance.',
    supportedParameters: [],
  },
];

describe('ModelSelectorModal', () => {
  beforeEach(async () => {
    // Reset picker mode to default 'single' between tests so mode preference
    // doesn't leak via the persisted model store.
    switchToSingle();
    // Reset isMobile to desktop default so per-test overrides don't bleed.
    await setIsMobile(false);
  });

  it('renders all models when open', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.getByText('Llama 3.1 70B')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <ModelSelectorModal
        open={false}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
  });

  it('filters models when searching', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const searchInputs = screen.getAllByPlaceholderText('Search models');
    await user.type(first(searchInputs), 'Claude');

    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
    expect(screen.queryByText('Llama 3.1 70B')).not.toBeInTheDocument();
  });

  it('filters models by provider', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const searchInputs = screen.getAllByPlaceholderText('Search models');
    await user.type(first(searchInputs), 'openai');

    expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    expect(screen.queryByText('Claude 3.5 Sonnet')).not.toBeInTheDocument();
  });

  it('shows model details when model is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    await user.hover(screen.getByText('Claude 3.5 Sonnet'));

    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic most intelligent model/)).toBeInTheDocument();
  });

  it('single-mode click commits + closes immediately with the picked model', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    expect(onSelect).toHaveBeenCalledWith([
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('multi-mode click toggles + Use confirms with both old + new model', async () => {
    switchToMulti();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));
    await user.click(screen.getByTestId('use-models-button'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ])
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render Quick Select section', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByText(/quick select model/i)).not.toBeInTheDocument();
  });

  it('renders the model rows inside a container with role="listbox"', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const listbox = screen.getByRole('listbox', { name: /models/i });
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    for (const option of options) {
      expect(listbox.contains(option)).toBe(true);
    }
  });

  it('renders sections in order: Sort, Search', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const sortLabel = first(screen.getAllByText('Sort:'));
    const searchInput = first(screen.getAllByPlaceholderText('Search models'));

    expect(
      sortLabel.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('displays Memory capacity prefix with context length in model rows', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
    expect(gpt4Item).toHaveTextContent('Capacity: 128k');
  });

  describe('pinned model labels', () => {
    const pinnedModels: Model[] = [
      {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude Opus 4.6',
        provider: 'Anthropic',
        modality: 'text' as const,
        contextLength: 200_000,
        pricePerInputToken: 0.000_015,
        pricePerOutputToken: 0.000_075,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Most capable model.',
        supportedParameters: [],
        // Most-popular so it lands in the top-50% half; priciest there ⇒ Strongest.
        popularityRank: 0,
      },
      {
        id: 'openai/gpt-5-nano',
        name: 'GPT-5 Nano',
        provider: 'OpenAI',
        modality: 'text' as const,
        contextLength: 128_000,
        pricePerInputToken: 0.000_000_1,
        pricePerOutputToken: 0.000_000_4,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Cheapest tier-1 text model.',
        supportedParameters: [],
        // In the top-50% half; cheapest there ⇒ Best value.
        popularityRank: 1,
      },
      {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        provider: 'OpenAI',
        modality: 'text' as const,
        contextLength: 128_000,
        pricePerInputToken: 0.000_005,
        pricePerOutputToken: 0.000_015,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Fast and capable model.',
        supportedParameters: [],
        // Least-popular ⇒ dropped from the top-50% half, so it is neither pin.
        popularityRank: 2,
      },
    ];

    it('shows "Strongest" label on strongest model subtitle row', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const strongestItem = screen.getByTestId('model-item-anthropic/claude-opus-4.6');
      expect(strongestItem).toHaveTextContent('Strongest');
    });

    it('shows "Best value" label on value model subtitle row', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const valueItem = screen.getByTestId('model-item-openai/gpt-5-nano');
      expect(valueItem).toHaveTextContent('Best value');
    });

    it('pins strongest and value models at top when no sort or filter is active', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Claude Opus 4.6');
      expect(modelItems[1]).toHaveTextContent('GPT-5 Nano');
      expect(modelItems[2]).toHaveTextContent('GPT-4o');
    });

    it('does not pin models when sort is active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      // Sorted by price ascending — DeepSeek R1 is cheapest
      expect(modelItems[0]).toHaveTextContent('GPT-5 Nano');
    });

    it('shows labels regardless of sort state', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const strongestItem = screen.getByTestId('model-item-anthropic/claude-opus-4.6');
      expect(strongestItem).toHaveTextContent('Strongest');

      const valueItem = screen.getByTestId('model-item-openai/gpt-5-nano');
      expect(valueItem).toHaveTextContent('Best value');
    });
  });

  describe('per-modality pinned model labels', () => {
    const imageModels: Model[] = [
      {
        id: 'google/imagen-4.0-ultra-generate-001',
        name: 'Imagen 4 Ultra',
        provider: 'Google',
        modality: 'image' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.06,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Top quality image generation.',
        supportedParameters: [],
      },
      {
        id: 'google/imagen-4.0-fast-generate-001',
        name: 'Imagen 4 Fast',
        provider: 'Google',
        modality: 'image' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.02,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Cheaper, faster image generation.',
        supportedParameters: [],
      },
    ];
    const videoModels: Model[] = [
      {
        id: 'google/veo-3.1-generate-001',
        name: 'Veo 3.1',
        provider: 'Google',
        modality: 'video' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0.5,
        capabilities: [],
        description: 'Video generation.',
        supportedParameters: [],
      },
      {
        id: 'google/veo-3.1-fast-generate-001',
        name: 'Veo 3.1 Fast',
        provider: 'Google',
        modality: 'video' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0.25,
        capabilities: [],
        description: 'Fast video generation.',
        supportedParameters: [],
      },
    ];

    // Strongest/Best value pins are a text-only signal (derived from popularity);
    // media modalities carry no popularity signal, so they get no pins.
    it('does not pin image models — media has no Strongest/Best value markers', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={imageModels}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
          activeModality="image"
        />
      );

      const ultraItem = screen.getByTestId('model-item-google/imagen-4.0-ultra-generate-001');
      expect(ultraItem).not.toHaveTextContent('Strongest');
      expect(ultraItem).not.toHaveTextContent('Best value');

      const fastItem = screen.getByTestId('model-item-google/imagen-4.0-fast-generate-001');
      expect(fastItem).not.toHaveTextContent('Strongest');
      expect(fastItem).not.toHaveTextContent('Best value');
    });

    it('does not pin video models — media has no Strongest/Best value markers', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={videoModels}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
          activeModality="video"
        />
      );

      const veoItem = screen.getByTestId('model-item-google/veo-3.1-generate-001');
      expect(veoItem).not.toHaveTextContent('Strongest');
      expect(veoItem).not.toHaveTextContent('Best value');

      const veoFastItem = screen.getByTestId('model-item-google/veo-3.1-fast-generate-001');
      expect(veoFastItem).not.toHaveTextContent('Strongest');
      expect(veoFastItem).not.toHaveTextContent('Best value');
    });
  });

  it('shows selected model highlighted', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const selectedItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
    expect(selectedItem).toHaveAttribute('data-selected', 'true');
  });

  it('shows details for initially selected model', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText(/A powerful language model/)).toBeInTheDocument();
  });

  it('formats context length correctly', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
  });

  it('displays fee-inclusive per-token prices (Model.pricePer* contract)', () => {
    // Model fixtures carry FEE-INCLUSIVE per-token prices per the
    // `processModels` contract. The component reads them directly without
    // re-applying fees.
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const expectedInput = formatPricePer1k(0.000_01);
    const expectedOutput = formatPricePer1k(0.000_03);
    expect(screen.getByText(`${expectedInput} / 1k`)).toBeInTheDocument();
    expect(screen.getByText(`${expectedOutput} / 1k`)).toBeInTheDocument();
  });

  it('closes on Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('does not render any footer button in single mode (row click commits)', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByTestId('use-models-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
  });

  it('multi-mode confirms local pending selection and closes when Use button is clicked', async () => {
    switchToMulti();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));
    await user.click(screen.getByTestId('use-models-button'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ])
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('sorting', () => {
    it('renders inline Sort label with Price and Capacity buttons', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getAllByText('Sort:').length).toBeGreaterThan(0);
      expect(screen.queryByText(/sort by/i)).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /price/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('button', { name: /capacity/i }).length).toBeGreaterThan(0);
    });

    it('highlights Price button when clicked', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const priceButtons = screen.getAllByRole('button', { name: /price/i });
      await user.click(first(priceButtons));

      expect(first(priceButtons)).toHaveAttribute('data-active', 'true');
    });

    it('toggles arrow direction when active button is clicked again', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const priceButtons = screen.getAllByRole('button', { name: /price/i });

      await user.click(first(priceButtons));
      expect(first(priceButtons)).toHaveAttribute('data-direction', 'asc');

      await user.click(first(priceButtons));
      expect(first(priceButtons)).toHaveAttribute('data-direction', 'desc');
    });

    it('sorts models by price (input + output) ascending', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      expect(first(modelItems)).toHaveTextContent('Llama 3.1 70B');
    });

    it('sorts models by context length ascending', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /capacity/i })));

      const modelItems = screen.getAllByRole('option');
      expect(first(modelItems)).toHaveTextContent('GPT-4 Turbo');
    });
  });

  it('uses ScrollArea for right panel scrolling', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const rightPanel = screen.getByTestId('model-details-panel');
    expect(rightPanel).toHaveAttribute('data-slot', 'scroll-area');
  });

  describe('mobile layout split', () => {
    it('model list panel uses flex-[9] when mobile', async () => {
      await setIsMobile(true);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const modelListPanel = screen.getByTestId('model-list-panel');
      expect(modelListPanel).toHaveClass('flex-[9]');
    });

    it('mobile does not render the side info panel (info moves into row inline expansion)', async () => {
      await setIsMobile(true);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('model-details-panel')).not.toBeInTheDocument();
    });

    it('desktop renders the side info panel', async () => {
      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('model-details-panel')).toBeInTheDocument();
    });

    it('renders a row chevron for each row on mobile, no info icon', async () => {
      await setIsMobile(true);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getAllByTestId('row-expand-chevron')).toHaveLength(mockModels.length);
      expect(screen.queryByTestId('row-info-icon')).not.toBeInTheDocument();
    });

    it('expands the row info panel inline when the chevron is clicked on mobile', async () => {
      await setIsMobile(true);
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('row-expanded-info')).not.toBeInTheDocument();

      const chevrons = screen.getAllByTestId('row-expand-chevron');
      await user.click(first(chevrons));

      const expanded = screen.getByTestId('row-expanded-info');
      expect(expanded).toBeInTheDocument();
      expect(screen.getByTestId('row-expanded-use-button')).toBeInTheDocument();
    });

    it('commits the model via the expanded Use button on mobile in single mode', async () => {
      await setIsMobile(true);
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
        />
      );

      const row = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      await user.click(row.querySelector('[data-testid="row-expand-chevron"]')!);

      await user.click(screen.getByTestId('row-expanded-use-button'));

      expect(onSelect).toHaveBeenCalledWith([
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('renders the touch-desktop info icon when the touch override is true', async () => {
      await setIsMobile(false);
      render(
        withTouchOverride(
          true,
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={mockModels}
            selectedIds={new Set(['openai/gpt-4-turbo'])}
            onSelect={vi.fn()}
          />
        )
      );

      const icons = screen.getAllByTestId('row-info-icon');
      expect(icons).toHaveLength(mockModels.length);
    });

    it('does not render the info icon when the touch override is false', async () => {
      await setIsMobile(false);
      render(
        withTouchOverride(
          false,
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={mockModels}
            selectedIds={new Set(['openai/gpt-4-turbo'])}
            onSelect={vi.fn()}
          />
        )
      );

      expect(screen.queryByTestId('row-info-icon')).not.toBeInTheDocument();
    });

    it('does not render the info icon on a non-touch desktop (no override, jsdom matchMedia false)', async () => {
      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('row-info-icon')).not.toBeInTheDocument();
    });

    it('does not render the info icon on mobile (the chevron replaces it)', async () => {
      await setIsMobile(true);
      render(
        withTouchOverride(
          true,
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={mockModels}
            selectedIds={new Set(['openai/gpt-4-turbo'])}
            onSelect={vi.fn()}
          />
        )
      );

      expect(screen.queryByTestId('row-info-icon')).not.toBeInTheDocument();
    });

    it('clicking the touch-desktop info icon focuses that model in the side panel', async () => {
      await setIsMobile(false);
      render(
        withTouchOverride(
          true,
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={mockModels}
            selectedIds={new Set(['openai/gpt-4-turbo'])}
            onSelect={vi.fn()}
          />
        )
      );

      const claudeRow = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      const infoIcon = claudeRow.querySelector('[data-testid="row-info-icon"]')!;
      // fireEvent.click avoids the pointer-event chain that Vaul (used when
      // isTouchDevice is true) intercepts and crashes on in jsdom.
      fireEvent.click(infoIcon);

      const detailsPanel = screen.getByTestId('model-details-panel');
      expect(detailsPanel).toHaveTextContent('Anthropic');
      expect(detailsPanel).toHaveTextContent(/Anthropic most intelligent model/);
    });

    it('collapses the expanded row when the chevron is clicked again on mobile', async () => {
      await setIsMobile(true);
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const chevrons = screen.getAllByTestId('row-expand-chevron');
      await user.click(first(chevrons));
      expect(screen.getByTestId('row-expanded-info')).toBeInTheDocument();

      await user.click(first(screen.getAllByTestId('row-expand-chevron')));
      expect(screen.queryByTestId('row-expanded-info')).not.toBeInTheDocument();
    });

    it('renders a border-b on both desktop top-quadrants for the divider line', async () => {
      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const quadrants = screen.getAllByTestId('desktop-top-quadrant');
      expect(quadrants).toHaveLength(2);
      for (const quadrant of quadrants) {
        expect(quadrant.className).toMatch(/\bborder-b\b/);
      }
    });

    it('desktop left-top and right-top quadrants enforce the same fixed height', async () => {
      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const quadrants = screen.getAllByTestId('desktop-top-quadrant');
      expect(quadrants).toHaveLength(2);

      const heightOf = (element: HTMLElement): string | undefined =>
        /h-\[[^\]]+\]/.exec(element.className)?.[0];

      const leftHeight = heightOf(first(quadrants));
      const rightHeight = heightOf(quadrants[1]!);

      expect(leftHeight).toBeDefined();
      expect(rightHeight).toBeDefined();
      expect(leftHeight).toBe(rightHeight);
    });
  });

  describe('premium models', () => {
    const premiumIds = new Set(['openai/gpt-4-turbo']);

    it('does not show Premium badge on any models (badges removed)', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item).not.toHaveTextContent('Premium');
    });

    it('shows lock icon on premium models for non-paid users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="lock-icon"]')).toBeInTheDocument();
    });

    it('does not show lock icon on basic models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const claudeItem = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      expect(claudeItem.querySelector('[data-testid="lock-icon"]')).not.toBeInTheDocument();
    });

    it('does not show lock icon for paid users on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="lock-icon"]')).not.toBeInTheDocument();
    });

    it('shows "Sign up to access" for trial users on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item).toHaveTextContent('Sign up');
      expect(gpt4Item).toHaveTextContent('to access');
    });

    it('renders "Sign up" as a clickable link for trial users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const signupLink = screen.getByTestId('signup-link');
      expect(signupLink).toHaveAttribute('href', '/signup');
      expect(signupLink).toHaveTextContent('Sign up');
      expect(signupLink).toHaveClass('text-primary');
    });

    it('shows "Top up to unlock" for free users on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item).toHaveTextContent('Top up');
      expect(gpt4Item).toHaveTextContent('to unlock');
    });

    it('renders "Top up" as a clickable link for free users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={true}
        />
      );

      const topUpLink = screen.getByRole('link', { name: 'Top up' });
      expect(topUpLink).toHaveAttribute('href', '/billing');
      expect(topUpLink).toHaveClass('text-primary');
    });

    it('shows tinted overlay on premium models for non-paid users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="premium-overlay"]')).toBeInTheDocument();
    });

    it('does not show overlay for paid users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="premium-overlay"]')).not.toBeInTheDocument();
    });

    it('link guests select a premium model without triggering onPremiumClick', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
          isLinkGuest={true}
          onPremiumClick={onPremiumClick}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));
      await user.click(screen.getByTestId('use-models-button'));

      expect(onPremiumClick).not.toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        ])
      );
    });

    it('does not show overlay for link guests on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-3.5-turbo'])}
          onSelect={vi.fn()}
          premiumIds={new Set(['openai/gpt-4-turbo'])}
          canAccessPremium={false}
          isAuthenticated={false}
          isLinkGuest={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="premium-overlay"]')).not.toBeInTheDocument();
    });

    it('multi-mode: paid user can add a premium model alongside their existing pick', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={true}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));
      await user.click(screen.getByTestId('use-models-button'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        ])
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('calls onPremiumClick instead of onSelect when canAccessPremium is false', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));

      expect(onPremiumClick).toHaveBeenCalledWith('openai/gpt-4-turbo');
      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('multi-mode: free user can still add basic models alongside their existing pick', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      await user.click(screen.getByText('Claude 3.5 Sonnet'));
      await user.click(screen.getByTestId('use-models-button'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ])
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onPremiumClick).not.toHaveBeenCalled();
    });

    it('calls onPremiumClick when premium model is single-clicked by non-paid user', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      // Single click on premium model triggers onPremiumClick instead of committing
      await user.click(screen.getByText('GPT-4 Turbo'));

      expect(onPremiumClick).toHaveBeenCalledWith('openai/gpt-4-turbo');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not show Premium badge in model details panel (badges removed)', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));

      const detailsPanel = screen.getByTestId('model-details-panel');
      expect(detailsPanel).not.toHaveTextContent('Premium');
    });

    it('defaults canAccessPremium to true for backward compatibility', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));
      await user.click(screen.getByTestId('use-models-button'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        ])
      );
    });

    describe('interlacing during sorting', () => {
      // GPT-4 is premium, Claude and Llama are basic
      const interlaceModels: Model[] = [
        {
          id: 'basic-1',
          name: 'Basic Model 1',
          provider: 'Provider A',
          modality: 'text' as const,
          contextLength: 100_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_02,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Basic model 1',
          supportedParameters: [],
        },
        {
          id: 'basic-2',
          name: 'Basic Model 2',
          provider: 'Provider B',
          modality: 'text' as const,
          contextLength: 200_000,
          pricePerInputToken: 0.000_03,
          pricePerOutputToken: 0.000_04,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Basic model 2',
          supportedParameters: [],
        },
        {
          id: 'premium-1',
          name: 'Premium Model 1',
          provider: 'Provider C',
          modality: 'text' as const,
          contextLength: 150_000,
          pricePerInputToken: 0.000_05,
          pricePerOutputToken: 0.000_06,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Premium model 1',
          supportedParameters: [],
        },
        {
          id: 'premium-2',
          name: 'Premium Model 2',
          provider: 'Provider D',
          modality: 'text' as const,
          contextLength: 250_000,
          pricePerInputToken: 0.000_07,
          pricePerOutputToken: 0.000_08,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Premium model 2',
          supportedParameters: [],
        },
      ];
      const interlacePremiumIds = new Set(['premium-1', 'premium-2']);

      it('interlaces basic and premium models during sorting for non-paid users', async () => {
        const user = userEvent.setup();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={interlaceModels}
            selectedIds={new Set(['basic-1'])}
            onSelect={vi.fn()}
            premiumIds={interlacePremiumIds}
            canAccessPremium={false}
            isAuthenticated={false}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /price/i })));

        const modelItems = screen.getAllByRole('option');
        expect(modelItems[0]).toHaveTextContent('Basic Model 1');
        expect(modelItems[1]).toHaveTextContent('Premium Model 1');
        expect(modelItems[2]).toHaveTextContent('Basic Model 2');
        expect(modelItems[3]).toHaveTextContent('Premium Model 2');
      });

      it('does not interlace models for paid users during sorting', async () => {
        const user = userEvent.setup();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={interlaceModels}
            selectedIds={new Set(['basic-1'])}
            onSelect={vi.fn()}
            premiumIds={interlacePremiumIds}
            canAccessPremium={true}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /price/i })));

        const modelItems = screen.getAllByRole('option');
        expect(modelItems[0]).toHaveTextContent('Basic Model 1');
        expect(modelItems[1]).toHaveTextContent('Basic Model 2');
        expect(modelItems[2]).toHaveTextContent('Premium Model 1');
        expect(modelItems[3]).toHaveTextContent('Premium Model 2');
      });

      it('interlaces in descending order when sort is descending for non-paid users', async () => {
        const user = userEvent.setup();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={interlaceModels}
            selectedIds={new Set(['basic-1'])}
            onSelect={vi.fn()}
            premiumIds={interlacePremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /price/i })));
        await user.click(first(screen.getAllByRole('button', { name: /price/i })));

        const modelItems = screen.getAllByRole('option');
        expect(modelItems[0]).toHaveTextContent('Basic Model 2');
        expect(modelItems[1]).toHaveTextContent('Premium Model 2');
        expect(modelItems[2]).toHaveTextContent('Basic Model 1');
        expect(modelItems[3]).toHaveTextContent('Premium Model 1');
      });
    });

    describe('pinned labels for non-paid users', () => {
      const quickSelectModels: Model[] = [
        {
          id: 'basic-cheap',
          name: 'Basic Cheap Model',
          provider: 'Provider A',
          modality: 'text' as const,
          contextLength: 100_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_02,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Cheap basic model',
          supportedParameters: [],
          // Top-50% half; cheapest there ⇒ Best value.
          popularityRank: 0,
        },
        {
          id: 'basic-expensive',
          name: 'Basic Expensive Model',
          provider: 'Provider B',
          modality: 'text' as const,
          contextLength: 200_000,
          pricePerInputToken: 0.000_05,
          pricePerOutputToken: 0.000_06,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Expensive basic model',
          supportedParameters: [],
          // Top-50% half; priciest there ⇒ Strongest.
          popularityRank: 1,
        },
        {
          // Least-popular non-premium filler: keeps the two targets above inside
          // the top-50% half (2 non-premium candidates alone would collapse the
          // half to one model, leaving Strongest and Best value indistinguishable).
          id: 'basic-filler',
          name: 'Basic Filler Model',
          provider: 'Provider D',
          modality: 'text' as const,
          contextLength: 120_000,
          pricePerInputToken: 0.000_03,
          pricePerOutputToken: 0.000_04,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Filler basic model',
          supportedParameters: [],
          popularityRank: 2,
        },
        {
          id: 'premium-model',
          name: 'Premium Model',
          provider: 'Provider C',
          modality: 'text' as const,
          contextLength: 150_000,
          pricePerInputToken: 0.0001,
          pricePerOutputToken: 0.000_12,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Premium model',
          supportedParameters: [],
        },
      ];
      const quickSelectPremiumIds = new Set(['premium-model']);

      it('shows "Strongest" label on highest cost basic model for non-paid users', () => {
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={quickSelectModels}
            selectedIds={new Set(['basic-cheap'])}
            onSelect={vi.fn()}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        const strongestItem = screen.getByTestId('model-item-basic-expensive');
        expect(strongestItem).toHaveTextContent('Strongest');
      });

      it('shows "Best value" label on lowest cost basic model for non-paid users', () => {
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={quickSelectModels}
            selectedIds={new Set(['basic-cheap'])}
            onSelect={vi.fn()}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        const valueItem = screen.getByTestId('model-item-basic-cheap');
        expect(valueItem).toHaveTextContent('Best value');
      });

      it('excludes premium models from strongest/value label calculation', () => {
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={quickSelectModels}
            selectedIds={new Set(['basic-cheap'])}
            onSelect={vi.fn()}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={false}
          />
        );

        // Premium model should NOT have the Strongest label even though it's most expensive
        const premiumItem = screen.getByTestId('model-item-premium-model');
        expect(premiumItem).not.toHaveTextContent('Strongest');
        expect(premiumItem).not.toHaveTextContent('Best value');
      });
    });
  });

  describe('web search removed (universal)', () => {
    it('never shows a "Web Search" subtitle on a model row (universal across text models)', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const gptItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gptItem).not.toHaveTextContent('Web Search');
      const llamaItem = screen.getByTestId('model-item-meta-llama/llama-3.1-70b-instruct');
      expect(llamaItem).not.toHaveTextContent('Web Search');
    });

    it('does not render a Web Search filter button', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: /web search/i })).not.toBeInTheDocument();
    });
  });

  describe('Smart Model pin + details', () => {
    const smartModelEntry: Model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      modality: 'text' as const,
      contextLength: 2_000_000,
      pricePerInputToken: 0.000_000_039,
      pricePerOutputToken: 0.000_000_19,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'Uses the best model for your task',
      supportedParameters: [],
      isSmartModel: true,
      minPricePerInputToken: 0.000_000_039,
      minPricePerOutputToken: 0.000_000_19,
      maxPricePerInputToken: 0.000_06,
      maxPricePerOutputToken: 0.000_18,
    };

    const modelsWithSmart: Model[] = [smartModelEntry, ...mockModels];

    it('pins Smart Model at the very top in default view', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Smart Model');
    });

    it('pins Smart Model to top when sort is active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Smart Model');
    });

    it('pins Smart Model to top when search is active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const searchInputs = screen.getAllByPlaceholderText('Search models');
      await user.type(first(searchInputs), 'GPT');

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Smart Model');
    });

    it('shows price ranges instead of single prices in details panel', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Smart Model'));

      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
      expect(screen.getByText('Output Price Range')).toBeInTheDocument();
    });

    it('shows "How it works" section in details panel', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Smart Model'));

      expect(screen.getByText('How It Works')).toBeInTheDocument();
    });

    it('does not show expensive model warning for the Smart Model', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('hides Smart Model when activeModality is image', () => {
      const imageModel: Model = {
        ...smartModelEntry,
        id: 'google/imagen-4',
        name: 'Imagen 4',
        modality: 'image',
        provider: 'Google',
        isSmartModel: false,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.04,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        contextLength: 0,
      };
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[smartModelEntry, imageModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );
      expect(screen.queryByText('Smart Model')).not.toBeInTheDocument();
    });

    it('hides Smart Model when activeModality is video', () => {
      const videoModel: Model = {
        ...smartModelEntry,
        id: 'google/veo-3.1',
        name: 'Veo 3.1',
        modality: 'video',
        provider: 'Google',
        isSmartModel: false,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        contextLength: 0,
      };
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[smartModelEntry, videoModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="video"
        />
      );
      expect(screen.queryByText('Smart Model')).not.toBeInTheDocument();
    });

    it('shows subtitle in list item', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      const smartModelItem = screen.getByTestId('model-item-smart-model');
      expect(smartModelItem).toHaveTextContent('Auto-picks the best model');
    });
  });

  describe('modal sizing', () => {
    it('uses desktop dvh height when not mobile', async () => {
      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const modal = screen.getByTestId('model-selector-modal');
      expect(modal.className).toMatch(/h-\[85dvh\]/);
      expect(modal.className).not.toMatch(/h-\[92dvh\]/);
    });

    it('uses mobile dvh height when mobile', async () => {
      await setIsMobile(true);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const modal = screen.getByTestId('model-selector-modal');
      expect(modal.className).toMatch(/h-\[92dvh\]/);
      expect(modal.className).not.toMatch(/h-\[85dvh\]/);
    });
  });

  describe('checkbox toggle', () => {
    it('does not render checkboxes in single mode', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryAllByTestId('model-checkbox')).toHaveLength(0);
    });

    it('renders a checkbox icon for each model in multi mode', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const checkboxes = screen.getAllByTestId('model-checkbox');
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('toggles model selection when row body is clicked in multi mode', async () => {
      switchToMulti();
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Claude 3.5 Sonnet'));

      const claudeItem = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      expect(claudeItem).toHaveAttribute('data-selected', 'true');
    });
  });

  describe('footer buttons', () => {
    it('does not render any footer in single mode', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('use-models-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
    });

    it('renders Use 1 model button in multi mode with one selection', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('use-models-button')).toHaveTextContent('Use 1 model');
    });

    it('renders Use 2 models button in multi mode with two selections', async () => {
      switchToMulti();
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Claude 3.5 Sonnet'));

      expect(screen.getByTestId('use-models-button')).toHaveTextContent('Use 2 models');
    });

    it('shows Clear button in multi mode header when ≥1 model is selected', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('clear-selection-button')).toHaveTextContent('Clear');
    });

    it('renders the count chip OUTSIDE the picker-mode-toggle (no button-in-button)', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const toggle = screen.getByTestId('picker-mode-toggle');
      expect(toggle).not.toContainElement(screen.queryByTestId('picker-mode-counter'));
      expect(toggle).not.toContainElement(screen.queryByTestId('clear-selection-button'));
    });

    it('renders the count chip inside the search-and-sort section', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const counter = screen.getByTestId('picker-mode-counter');
      const searchInput = screen.getByPlaceholderText('Search models');
      const searchRow = searchInput.closest('[data-testid="search-and-sort-row"]');
      expect(searchRow).not.toBeNull();
      expect(searchRow).toContainElement(counter);
    });

    it('does not render the count chip in single mode', () => {
      switchToSingle();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('picker-mode-counter')).not.toBeInTheDocument();
    });

    it('Clear button empties local selection so next toggle results in single model', async () => {
      switchToMulti();
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Claude 3.5 Sonnet'));
      expect(screen.getByTestId('use-models-button')).toHaveTextContent('Use 2 models');

      await user.click(first(screen.getAllByTestId('clear-selection-button')));

      await user.click(screen.getByText('Llama 3.1 70B'));
      expect(screen.getByTestId('use-models-button')).toHaveTextContent('Use 1 model');
    });

    it('renders selection counter "· N of 5" in multi mode', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const counters = screen.getAllByTestId('picker-mode-counter');
      expect(first(counters)).toHaveTextContent('1 of 5');
    });
  });

  describe('expensive model warning', () => {
    const expensiveModels: Model[] = [
      {
        id: 'cheap-model',
        name: 'Cheap Model',
        provider: 'Provider A',
        modality: 'text' as const,
        contextLength: 100_000,
        // $0.01/1k input + $0.03/1k output = $0.046/1k with fees (below $0.10 threshold)
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'A cheap model',
        supportedParameters: [],
      },
      {
        id: 'expensive-model',
        name: 'Expensive Model',
        provider: 'Provider B',
        modality: 'text' as const,
        contextLength: 200_000,
        // $0.05/1k input + $0.05/1k output = $0.115/1k with fees (above $0.10 threshold)
        pricePerInputToken: 0.000_05,
        pricePerOutputToken: 0.000_05,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'An expensive model',
        supportedParameters: [],
      },
    ];

    it('shows warning for expensive models', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={expensiveModels}
          selectedIds={new Set(['cheap-model'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Expensive Model'));

      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();
      expect(screen.getByText('Long chats with this model can be costly')).toBeInTheDocument();
    });

    it('does not show warning for cheap models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={expensiveModels}
          selectedIds={new Set(['cheap-model'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('hides warning when switching from expensive to cheap model', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={expensiveModels}
          selectedIds={new Set(['expensive-model'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();

      await user.click(screen.getByText('Cheap Model'));

      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });
  });

  describe('deselecting last model in multi mode', () => {
    it('allows deselecting the last model via row click', async () => {
      switchToMulti();
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      // Row body click toggles in multi mode
      await user.click(screen.getByText('GPT-4 Turbo'));

      const gptItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gptItem).toHaveAttribute('data-selected', 'false');
    });

    it('Cancel button closes modal without calling onSelect when local selection is empty', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
        />
      );

      await user.click(first(screen.getAllByTestId('clear-selection-button')));
      await user.click(screen.getByTestId('cancel-button'));

      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('Cancel button discards local changes (does not call onSelect)', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
        />
      );

      // Add Claude to local selection then cancel — should not commit to store
      await user.click(screen.getByText('Claude 3.5 Sonnet'));
      await user.click(screen.getByTestId('cancel-button'));

      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('multi-model gating', () => {
    it('shows signup modal for unauthenticated user selecting second non-premium model', async () => {
      switchToMulti();
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
          isAuthenticated={false}
        />
      );

      await user.click(screen.getByText('Claude 3.5 Sonnet'));

      expect(screen.getByTestId('multi-model-signup-modal')).toBeInTheDocument();
    });

    it('link guests add a second model without the signup modal', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
          isAuthenticated={false}
          isLinkGuest={true}
        />
      );

      await user.click(screen.getByText('Claude 3.5 Sonnet'));

      const claudeItem = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      expect(screen.queryByTestId('multi-model-signup-modal')).not.toBeInTheDocument();
      expect(claudeItem).toHaveAttribute('data-selected', 'true');
    });
  });

  describe('per-modality row subtitle', () => {
    const textRowModel: Model = {
      id: 'openai/gpt-text',
      name: 'Text Row Model',
      provider: 'OpenAI',
      modality: 'text' as const,
      contextLength: 128_000,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'Text row model.',
      supportedParameters: [],
    };
    const imageRowModel: Model = {
      id: 'google/imagen-row',
      name: 'Imagen Row Model',
      provider: 'Google',
      modality: 'image' as const,
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'Image row model.',
      supportedParameters: [],
    };
    const videoRowModel: Model = {
      id: 'google/veo-row',
      name: 'Veo Row Model',
      provider: 'Google',
      modality: 'video' as const,
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.2, '1080p': 0.4, '4k': 0.8 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'Video row model.',
      supportedParameters: [],
    };
    const audioRowModel: Model = {
      id: 'openai/tts-row',
      name: 'TTS Row Model',
      provider: 'OpenAI',
      modality: 'audio' as const,
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'Audio row model.',
      supportedParameters: [],
    };

    it('text row shows provider and capacity', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[textRowModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="text"
        />
      );
      const row = screen.getByTestId('model-item-openai/gpt-text');
      expect(row).toHaveTextContent('OpenAI');
      expect(row).toHaveTextContent('Capacity: 128k');
    });

    it('image row shows provider and price-per-image, no capacity', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[imageRowModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );
      const row = screen.getByTestId('model-item-google/imagen-row');
      expect(row).toHaveTextContent('Google');
      expect(row).toHaveTextContent('$0.040/image');
      expect(row).not.toHaveTextContent('Capacity:');
    });

    it('video row shows provider and cheapest resolution price-per-second, no capacity', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[videoRowModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="video"
        />
      );
      const row = screen.getByTestId('model-item-google/veo-row');
      expect(row).toHaveTextContent('Google');
      expect(row).toHaveTextContent('$0.20/s');
      expect(row).not.toHaveTextContent('Capacity:');
    });

    it('audio row shows provider and price-per-second, no capacity', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[audioRowModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="audio"
        />
      );
      const row = screen.getByTestId('model-item-openai/tts-row');
      expect(row).toHaveTextContent('OpenAI');
      expect(row).toHaveTextContent('$0.015/s');
      expect(row).not.toHaveTextContent('Capacity:');
    });

    it('Smart Model keeps "Auto-picks the best model" subtitle regardless of modality changes', () => {
      const smart: Model = {
        ...textRowModel,
        id: 'smart-model',
        name: 'Smart Model',
        isSmartModel: true,
      };
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[smart]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="text"
        />
      );
      const row = screen.getByTestId('model-item-smart-model');
      expect(row).toHaveTextContent('Auto-picks the best model');
    });
  });

  describe('per-modality price sort', () => {
    const imageSortModels: Model[] = [
      {
        id: 'image-cheap',
        name: 'Image Cheap',
        provider: 'Provider A',
        modality: 'image' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.01,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Cheapest image model',
        supportedParameters: [],
      },
      {
        id: 'image-mid',
        name: 'Image Mid',
        provider: 'Provider B',
        modality: 'image' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.05,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Mid image model',
        supportedParameters: [],
      },
      {
        id: 'image-pricey',
        name: 'Image Pricey',
        provider: 'Provider C',
        modality: 'image' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.2,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Pricey image model',
        supportedParameters: [],
      },
    ];

    const videoSortModels: Model[] = [
      {
        id: 'video-cheap',
        name: 'Video Cheap',
        provider: 'Provider A',
        modality: 'video' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.3 },
        pricePerSecond: 0,
        capabilities: [],
        description: 'Cheapest video model',
        supportedParameters: [],
      },
      {
        id: 'video-mid',
        name: 'Video Mid',
        provider: 'Provider B',
        modality: 'video' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: { '720p': 0.25, '1080p': 0.5 },
        pricePerSecond: 0,
        capabilities: [],
        description: 'Mid video model',
        supportedParameters: [],
      },
      {
        id: 'video-pricey',
        name: 'Video Pricey',
        provider: 'Provider C',
        modality: 'video' as const,
        contextLength: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.9 },
        pricePerSecond: 0,
        capabilities: [],
        description: 'Pricey video model',
        supportedParameters: [],
      },
    ];

    it('sorts image models by pricePerImage ascending when Price clicked', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={imageSortModels}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Image Cheap');
      expect(modelItems[1]).toHaveTextContent('Image Mid');
      expect(modelItems[2]).toHaveTextContent('Image Pricey');
    });

    it('sorts image models by pricePerImage descending on second click', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={imageSortModels}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );

      const priceButton = first(screen.getAllByRole('button', { name: /price/i }));
      await user.click(priceButton);
      await user.click(priceButton);

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Image Pricey');
      expect(modelItems[1]).toHaveTextContent('Image Mid');
      expect(modelItems[2]).toHaveTextContent('Image Cheap');
    });

    it('sorts video models by cheapest-resolution pricePerSecond ascending when Price clicked', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={videoSortModels}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="video"
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Video Cheap');
      expect(modelItems[1]).toHaveTextContent('Video Mid');
      expect(modelItems[2]).toHaveTextContent('Video Pricey');
    });
  });

  describe('per-modality Capacity sort button', () => {
    const textModel: Model = {
      id: 'text-only',
      name: 'Text Only',
      provider: 'OpenAI',
      modality: 'text' as const,
      contextLength: 128_000,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'Text model.',
      supportedParameters: [],
    };
    const imageModel: Model = {
      id: 'image-only',
      name: 'Image Only',
      provider: 'Google',
      modality: 'image' as const,
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'Image model.',
      supportedParameters: [],
    };
    const videoModel: Model = {
      id: 'video-only',
      name: 'Video Only',
      provider: 'Google',
      modality: 'video' as const,
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.2 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'Video model.',
      supportedParameters: [],
    };
    const audioModel: Model = {
      id: 'audio-only',
      name: 'Audio Only',
      provider: 'OpenAI',
      modality: 'audio' as const,
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.01,
      capabilities: [],
      description: 'Audio model.',
      supportedParameters: [],
    };

    it('renders Capacity sort button when activeModality is text', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[textModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="text"
        />
      );
      expect(screen.getAllByRole('button', { name: /capacity/i }).length).toBeGreaterThan(0);
    });

    it('hides Capacity sort button when activeModality is image', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[imageModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );
      expect(screen.queryByRole('button', { name: /capacity/i })).not.toBeInTheDocument();
    });

    it('hides Capacity sort button when activeModality is video', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[videoModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="video"
        />
      );
      expect(screen.queryByRole('button', { name: /capacity/i })).not.toBeInTheDocument();
    });

    it('hides Capacity sort button when activeModality is audio', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[audioModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="audio"
        />
      );
      expect(screen.queryByRole('button', { name: /capacity/i })).not.toBeInTheDocument();
    });

    it('still renders Price sort button for non-text modalities', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[imageModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );
      expect(screen.getAllByRole('button', { name: /price/i }).length).toBeGreaterThan(0);
    });
  });

  describe('checkbox cascade animation', () => {
    it('does not render any checkboxes in single mode', () => {
      switchToSingle();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryAllByTestId('model-checkbox')).toHaveLength(0);
    });

    it('renders one checkbox per row in multi mode with incrementing cascade indices', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const checkboxes = screen.getAllByTestId('model-checkbox');
      expect(checkboxes).toHaveLength(mockModels.length);
      // Cascade indices are 0, 1, 2... — they drive the stagger delay.
      for (const [index, checkbox] of checkboxes.entries()) {
        expect(checkbox).toHaveAttribute('data-cascade-index', String(index));
      }
    });
  });

  describe('mobile chevron tap target', () => {
    it('uses a full-row-height tap target wide enough for thumbs', async () => {
      await setIsMobile(true);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const chevron = first(screen.getAllByTestId('row-expand-chevron'));
      // Width: at least w-12 (48px) — Apple's 44px minimum + padding
      expect(chevron.className).toMatch(/\bw-12\b/);
      // Height: stretches to fill the row, not a fixed 24px square
      expect(chevron.className).toMatch(/\bself-stretch\b/);
      expect(chevron.className).not.toMatch(/\bh-6\b/);
    });
  });

  describe('list scrollbar clearance', () => {
    it('reserves right padding inside the model list so rows do not overlap the scrollbar', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const list = screen.getByRole('listbox', { name: /models/i });
      expect(list.className).toMatch(/\bpr-[34]\b/);
    });
  });

  describe('footer animation', () => {
    it('wraps the footer in a motion container that slides up from below', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const footer = screen.getByTestId('model-selector-footer-motion');
      expect(footer).toBeInTheDocument();
    });
  });

  describe('mode transitions', () => {
    it('auto-collapses to first selection when switching multi → single with >1 selected', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo', 'anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
        />
      );

      await user.click(screen.getByTestId('picker-mode-single'));

      expect(onSelect).toHaveBeenCalledWith([{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]);
    });

    it('does not commit when switching multi → single with 1 selected', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
        />
      );

      await user.click(screen.getByTestId('picker-mode-single'));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not commit when switching multi → single with 0 selected', async () => {
      switchToMulti();
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set()}
          onSelect={onSelect}
        />
      );

      await user.click(screen.getByTestId('picker-mode-single'));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('pulses the previously-committed row when switching from single to multi', async () => {
      switchToSingle();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByTestId('picker-mode-multi'));

      const row = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(row).toHaveAttribute('data-pulsing', 'true');

      vi.useRealTimers();
    });

    it('does not pulse any row when opening the modal in multi mode (no transition)', () => {
      switchToMulti();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('model-item-openai/gpt-4-turbo')).not.toHaveAttribute(
        'data-pulsing',
        'true'
      );
    });

    it('clears the pulse data attribute after the 600ms animation completes', async () => {
      switchToSingle();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByTestId('picker-mode-multi'));
      vi.advanceTimersByTime(800);
      await waitFor(() => {
        expect(screen.getByTestId('model-item-openai/gpt-4-turbo')).not.toHaveAttribute(
          'data-pulsing',
          'true'
        );
      });

      vi.useRealTimers();
    });

    it('does not pulse on reopen-in-multi after a close-then-reopen cycle', async () => {
      // Start in single mode so the upcoming switch is a real single → multi
      // transition that should pulse.
      switchToSingle();
      const user = userEvent.setup();
      const selectedIds = new Set(['openai/gpt-4-turbo']);
      const { rerender } = render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={selectedIds}
          onSelect={vi.fn()}
        />
      );

      // Sanity check: switching to multi pulses the carryover row.
      await user.click(screen.getByTestId('picker-mode-multi'));
      expect(screen.getByTestId('model-item-openai/gpt-4-turbo')).toHaveAttribute(
        'data-pulsing',
        'true'
      );

      // Close the modal — the hook should reset its previous-mode reference.
      rerender(
        <ModelSelectorModal
          open={false}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={selectedIds}
          onSelect={vi.fn()}
        />
      );

      // Reopen in multi mode (no transition this time).
      rerender(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={selectedIds}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('model-item-openai/gpt-4-turbo')).not.toHaveAttribute(
        'data-pulsing',
        'true'
      );
    });
  });

  describe('breakpoint behavior', () => {
    afterEach(async () => {
      await setIsMobile(false);
    });

    it('renders exactly one picker-mode-toggle (vertical) when isMobile is false', async () => {
      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const toggles = screen.getAllByTestId('picker-mode-toggle');
      expect(toggles).toHaveLength(1);
      expect(first(toggles)).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('renders exactly one picker-mode-toggle (horizontal) when isMobile is true', async () => {
      await setIsMobile(true);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const toggles = screen.getAllByTestId('picker-mode-toggle');
      expect(toggles).toHaveLength(1);
      expect(first(toggles)).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('renders exactly one Search models input regardless of breakpoint', async () => {
      await setIsMobile(true);
      const { unmount } = render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );
      expect(screen.getAllByPlaceholderText('Search models')).toHaveLength(1);
      unmount();

      await setIsMobile(false);
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );
      expect(screen.getAllByPlaceholderText('Search models')).toHaveLength(1);
    });
  });
});
