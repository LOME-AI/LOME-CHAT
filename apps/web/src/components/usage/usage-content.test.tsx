import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';

const { usageHooks, mockUseDecryptedConversations } = vi.hoisted(() => ({
  usageHooks: {
    useUsageSummary: vi.fn(),
    useSpendingOverTime: vi.fn(),
    useCostByModel: vi.fn(),
    useTokenUsageOverTime: vi.fn(),
    useSpendingByConversation: vi.fn(),
    useBalanceHistory: vi.fn(),
    useUsageModels: vi.fn(),
  },
  mockUseDecryptedConversations: vi.fn(),
}));

vi.mock('@/hooks/billing/usage', () => usageHooks);

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: () => mockUseDecryptedConversations(),
}));

// Child components are stubbed so this test isolates UsageContent's own logic
// (date-range derivation, param memos, and range/model state wiring). The
// filters stub exposes buttons that drive the parent's setRange/setModel.
vi.mock('./usage-filters', () => ({
  UsageFilters: ({
    onRangeChange,
    onModelChange,
    availableModels,
  }: {
    onRangeChange: (r: string) => void;
    onModelChange: (m?: string) => void;
    availableModels: string[];
  }) => (
    <div data-testid="filters-stub">
      <button
        type="button"
        onClick={() => {
          onRangeChange('all');
        }}
        data-testid="set-all"
      />
      <button
        type="button"
        onClick={() => {
          onRangeChange('7d');
        }}
        data-testid="set-7d"
      />
      <button
        type="button"
        onClick={() => {
          onModelChange('GPT-4');
        }}
        data-testid="set-model"
      />
      <button
        type="button"
        onClick={() => {
          onModelChange();
        }}
        data-testid="clear-model"
      />
      <span data-testid="model-count">{availableModels.length}</span>
    </div>
  ),
}));

function chartStub(testId: string) {
  const Stub = () => <div data-testid={testId} />;
  Stub.displayName = `Stub-${testId}`;
  return Stub;
}

vi.mock('./usage-kpi-cards', () => ({ UsageKpiCards: chartStub('kpi-stub') }));
vi.mock('./spending-over-time-chart', () => ({
  SpendingOverTimeChart: chartStub('spend-time-stub'),
}));
vi.mock('./cost-by-model-chart', () => ({ CostByModelChart: chartStub('cost-model-stub') }));
vi.mock('./token-usage-chart', () => ({ TokenUsageChart: chartStub('token-stub') }));
vi.mock('./spending-by-conversation-chart', () => ({
  SpendingByConversationChart: chartStub('spend-conv-stub'),
}));
vi.mock('./balance-history-chart', () => ({ BalanceHistoryChart: chartStub('balance-stub') }));

import { UsageContent } from './usage-content';

beforeEach(() => {
  vi.clearAllMocks();
  for (const function_ of Object.values(usageHooks)) {
    function_.mockReturnValue({ data: undefined, isLoading: false });
  }
  usageHooks.useUsageModels.mockReturnValue({
    data: { models: ['GPT-4', 'Claude'] },
    isLoading: false,
  });
  mockUseDecryptedConversations.mockReturnValue({ data: undefined });
});

describe('UsageContent', () => {
  it('renders the page body with every child section', () => {
    render(<UsageContent />);
    expect(screen.getByTestId(TEST_IDS.usageContent)).toBeInTheDocument();
    expect(screen.getByTestId('kpi-stub')).toBeInTheDocument();
    expect(screen.getByTestId('spend-time-stub')).toBeInTheDocument();
    expect(screen.getByTestId('cost-model-stub')).toBeInTheDocument();
    expect(screen.getByTestId('token-stub')).toBeInTheDocument();
    expect(screen.getByTestId('spend-conv-stub')).toBeInTheDocument();
    expect(screen.getByTestId('balance-stub')).toBeInTheDocument();
  });

  it('passes available models through to the filters', () => {
    render(<UsageContent />);
    expect(screen.getByTestId('model-count')).toHaveTextContent('2');
  });

  it('defaults available models to an empty list when none are loaded', () => {
    usageHooks.useUsageModels.mockReturnValue({ data: undefined, isLoading: false });
    render(<UsageContent />);
    expect(screen.getByTestId('model-count')).toHaveTextContent('0');
  });

  it('queries with a bounded date range for a preset range', () => {
    render(<UsageContent />);
    const [params] = usageHooks.useUsageSummary.mock.calls.at(-1) as [
      { startDate: string; endDate: string },
    ];
    // Default 30d preset yields a real computed start earlier than the end.
    expect(params.startDate < params.endDate).toBe(true);
    expect(params.startDate).not.toBe('2020-01-01');
  });

  it('uses the sentinel start date for the "all" range', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-all'));
    const [params] = usageHooks.useUsageSummary.mock.calls.at(-1) as [{ startDate: string }];
    expect(params.startDate).toBe('2020-01-01');
  });

  it('recomputes the range for a non-"all" preset', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-7d'));
    const [params] = usageHooks.useUsageSummary.mock.calls.at(-1) as [{ startDate: string }];
    expect(params.startDate).not.toBe('2020-01-01');
  });

  it('includes the model in time-series params when one is selected', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-model'));
    const [params] = usageHooks.useSpendingOverTime.mock.calls.at(-1) as [{ model?: string }];
    expect(params.model).toBe('GPT-4');
  });

  it('omits the model from time-series params when cleared', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-model'));
    fireEvent.click(screen.getByTestId('clear-model'));
    const [params] = usageHooks.useSpendingOverTime.mock.calls.at(-1) as [{ model?: string }];
    expect(params.model).toBeUndefined();
  });

  it('forwards conversation titles when conversations are decrypted', () => {
    mockUseDecryptedConversations.mockReturnValue({
      data: [{ id: 'c1', title: 'First' }],
    });
    // Re-render should not throw and still shows the spending-by-conversation section.
    render(<UsageContent />);
    expect(screen.getByTestId('spend-conv-stub')).toBeInTheDocument();
  });
});
