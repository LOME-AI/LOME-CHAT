import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { friendlyErrorMessage } from '@hushbox/shared';

vi.mock('@/hooks/billing/use-conversation-budgets.js', () => ({
  useConversationBudgets: vi.fn(),
  useUpdateMemberBudget: vi.fn(),
  useUpdateConversationBudget: vi.fn(),
}));

import {
  useConversationBudgets,
  useUpdateMemberBudget,
  useUpdateConversationBudget,
} from '@/hooks/billing/use-conversation-budgets.js';
import { BudgetSettingsModal } from '@/components/chat/budget/budget-settings-modal.js';

const mockUseConversationBudgets = vi.mocked(useConversationBudgets);
const mockUseUpdateMemberBudget = vi.mocked(useUpdateMemberBudget);
const mockUseUpdateConversationBudget = vi.mocked(useUpdateConversationBudget);

const mockMutateAsync = vi.fn();
const mockConvBudgetMutateAsync = vi.fn();

const MEMBERS_WITH_BUDGETS = [
  {
    memberId: 'mem-2',
    userId: 'user-2',
    username: 'bob',
    privilege: 'write',
    capNanoUsd: '25000000000',
    spentNanoUsd: '8000000000',
    effectiveRemainingNanoUsd: '17000000000',
  },
  {
    memberId: 'mem-3',
    userId: null,
    username: null,
    privilege: 'read',
    capNanoUsd: '10000000000',
    spentNanoUsd: '0',
    effectiveRemainingNanoUsd: '10000000000',
  },
];

const BUDGET_DATA_WITH_CONV_BUDGET = {
  conversationCapNanoUsd: '100000000000',
  conversationSpentNanoUsd: '42500000000',
  ownerBalanceNanoUsd: '500000000000',
  members: MEMBERS_WITH_BUDGETS,
};

const BUDGET_DATA = {
  conversationCapNanoUsd: '0',
  conversationSpentNanoUsd: '42500000000',
  ownerBalanceNanoUsd: '500000000000',
  members: MEMBERS_WITH_BUDGETS,
};

const MEMBERS_DATA = [
  { id: 'mem-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
  { id: 'mem-2', userId: 'user-2', username: 'bob', privilege: 'write' },
  { id: 'mem-3', userId: null, linkId: 'link-1', username: null, privilege: 'read' },
];

describe('BudgetSettingsModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    members: MEMBERS_DATA,
    currentUserPrivilege: 'owner',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);
    mockUseUpdateMemberBudget.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateMemberBudget>);
    mockMutateAsync.mockResolvedValue({ updated: true });
    mockConvBudgetMutateAsync.mockResolvedValue({ updated: true });
    mockUseUpdateConversationBudget.mockReturnValue({
      mutateAsync: mockConvBudgetMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateConversationBudget>);
  });

  it('renders the modal with title', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const modal = screen.getByTestId('budget-settings-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveTextContent('Budget Settings');
  });

  it('shows loading state when budgets are loading', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-loading')).toBeInTheDocument();
  });

  it('displays total spent amount', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-total-spent')).toHaveTextContent('$42.50');
  });

  it('displays member budget rows with names', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-member-mem-2')).toHaveTextContent('Bob');
  });

  it('shows Guest Link label for link-based members', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-member-mem-3')).toHaveTextContent('Guest Link');
  });

  it('falls back to the budget row username and to Unknown for members missing from the roster', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: {
        conversationCapNanoUsd: '0',
        conversationSpentNanoUsd: '0',
        ownerBalanceNanoUsd: '500000000000',
        members: [
          {
            memberId: 'mem-90',
            userId: 'user-90',
            username: 'zoe',
            privilege: 'read',
            capNanoUsd: '5000000000',
            spentNanoUsd: '0',
            effectiveRemainingNanoUsd: '5000000000',
          },
          {
            memberId: 'mem-91',
            userId: 'user-91',
            username: null,
            privilege: 'read',
            capNanoUsd: '5000000000',
            spentNanoUsd: '0',
            effectiveRemainingNanoUsd: '5000000000',
          },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-member-mem-90')).toHaveTextContent('Zoe');
    expect(screen.getByTestId('budget-member-mem-91')).toHaveTextContent('Unknown');
  });

  it('displays spent amounts for each member', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const row2 = screen.getByTestId('budget-member-mem-2');
    expect(within(row2).getByTestId('budget-spent')).toHaveTextContent('$8.00');
  });

  it('populates budget inputs with current values in dollars', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const input2 = screen.getByTestId('budget-input-mem-2') as HTMLInputElement;
    expect(input2.value).toBe('25.00');
  });

  it('enables Save button only when values are changed', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const saveButton = screen.getByTestId('budget-save-button');
    expect(saveButton).toBeDisabled();

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    expect(saveButton).toBeEnabled();
  });

  it('calls updateMemberBudget for changed budgets on save', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    await userEvent.click(screen.getByTestId('budget-save-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-123',
      memberId: 'mem-2',
      budgetCents: 3000,
    });
  });

  it('does not call updateMemberBudget for unchanged budgets', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    await userEvent.click(screen.getByTestId('budget-save-button'));

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'mem-2' }));
  });

  it('surfaces a BUDGET_BELOW_SPENT rejection with the shared copy, inline', async () => {
    // The server refuses a cap below the accrued spend with the typed 400;
    // the thrown ApiError carries the code in `.message`, and useAsyncAction
    // maps it through friendlyErrorMessage — the copy comes from the ONE
    // shared code→copy map, never a hardcoded string here.
    mockMutateAsync.mockRejectedValue(new Error('BUDGET_BELOW_SPENT'));
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');
    await userEvent.click(screen.getByTestId('budget-save-button'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(friendlyErrorMessage('BUDGET_BELOW_SPENT'));
  });

  it('closes modal when Cancel is clicked', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('budget-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('displays total allocated amount', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-total-allocated')).toHaveTextContent('$35.00');
  });

  it('renders conversation section with limit row', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    const section = screen.getByTestId('budget-conversation-section');
    expect(section).toBeInTheDocument();
    expect(section).toHaveTextContent('Conversation');
    expect(section).toHaveTextContent('Funding limit');
  });

  it('shows conversation budget input with value from data', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const input = screen.getByTestId('budget-conversation-input') as HTMLInputElement;
    expect(input.value).toBe('100.00');
  });

  it('shows budget values as plain text for non-owners', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    expect(screen.getByTestId('budget-conversation-value')).toHaveTextContent('$100.00');
    expect(screen.getByTestId('budget-value-mem-2')).toHaveTextContent('$25.00');
  });

  it('does not render input fields for non-owners', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    expect(screen.queryByTestId('budget-conversation-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('budget-input-mem-2')).not.toBeInTheDocument();
  });

  it('hides save button when privilege is not owner', () => {
    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    expect(screen.queryByTestId('budget-save-button')).not.toBeInTheDocument();
  });

  it('shows Close instead of Cancel when privilege is not owner', () => {
    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    const cancelButton = screen.getByTestId('budget-cancel-button');
    expect(cancelButton).toHaveTextContent('Close');
  });

  it('allows editing conversation budget for owner', async () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const convInput = screen.getByTestId('budget-conversation-input') as HTMLInputElement;
    expect(convInput).not.toHaveAttribute('readOnly');

    await userEvent.clear(convInput);
    await userEvent.type(convInput, '200.00');

    expect(convInput.value).toBe('200.00');
  });

  it('calls updateConversationBudget when conversation budget changed on save', async () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    const convInput = screen.getByTestId('budget-conversation-input');
    await userEvent.clear(convInput);
    await userEvent.type(convInput, '200.00');

    await userEvent.click(screen.getByTestId('budget-save-button'));

    expect(mockConvBudgetMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-123',
      budgetCents: 20_000,
    });
  });

  it('shows subtitle explaining budget funding source', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByText(/The owner can fund AI usage for members/)).toBeInTheDocument();
    expect(screen.getByText(/When exhausted, members use their own balance/)).toBeInTheDocument();
  });

  it('renders action buttons side by side', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const cancelButton = screen.getByTestId('budget-cancel-button');
    expect(cancelButton.className).toContain('flex-1');
  });

  it('computes allocated as min of conversation budget and sum of member budgets', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: {
        conversationCapNanoUsd: '20000000000',
        conversationSpentNanoUsd: '5000000000',
        ownerBalanceNanoUsd: '500000000000',
        members: [
          {
            memberId: 'mem-2',
            userId: 'user-2',
            username: 'bob',
            privilege: 'write',
            capNanoUsd: '25000000000',
            spentNanoUsd: '3000000000',
            effectiveRemainingNanoUsd: '15000000000',
          },
          {
            memberId: 'mem-3',
            userId: null,
            username: null,
            privilege: 'read',
            capNanoUsd: '10000000000',
            spentNanoUsd: '2000000000',
            effectiveRemainingNanoUsd: '8000000000',
          },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    // sum(member caps) = $35, convBudget = $20 → min = $20
    expect(screen.getByTestId('budget-total-allocated')).toHaveTextContent('$20.00');
  });

  it('uses sum of member budgets as allocated when conversation budget is zero', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    // BUDGET_DATA has conversationCapNanoUsd '0', member caps sum: $35
    // 0 means "no limit" so allocated = sum = $35
    expect(screen.getByTestId('budget-total-allocated')).toHaveTextContent('$35.00');
  });

  it('applies both text-sm and font-medium to the summary label', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const allocatedRow = screen.getByTestId('budget-total-allocated');
    const label = within(allocatedRow).getByText('Allocated');

    expect(label).toHaveClass('text-sm', 'font-medium');
    expect(label.className).not.toContain('text-smfont-medium');
  });

  it('shows total spent on the allocated row', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const allocatedRow = screen.getByTestId('budget-total-allocated');
    expect(allocatedRow).toHaveTextContent('$42.50 spent');
  });

  it('shows total spent inline on the conversation row', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const section = screen.getByTestId('budget-conversation-section');
    expect(section).toHaveTextContent('$42.50 spent');
  });

  it('renders member list in scrollable container', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const scrollContainer = screen.getByTestId('budget-members-list');
    expect(scrollContainer.className).toContain('max-h-60');
    expect(scrollContainer.className).toContain('overflow-y-auto');
  });

  it('Enter on last budget input triggers save', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    const lastInput = screen.getByTestId('budget-input-mem-3');
    lastInput.focus();

    lastInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        memberId: 'mem-2',
        budgetCents: 3000,
      });
    });
  });

  it('rejects non-numeric characters in budget input', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const input = screen.getByTestId('budget-input-mem-2') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'abc');

    expect(input.value).toBe('');
  });

  it('rejects negative values in budget input', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const input = screen.getByTestId('budget-input-mem-2') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '-5');

    expect(input.value).toBe('5');
  });

  it('does not enable Save when the entered value is cents-equal to the original', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const saveButton = screen.getByTestId('budget-save-button');
    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    // Original is '25.00'; '25' is the same number of cents — must stay a no-op.
    await userEvent.type(input, '25');

    expect(saveButton).toBeDisabled();
  });

  it('enables Save when a value changes by at least one cent', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const saveButton = screen.getByTestId('budget-save-button');
    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '25.01');

    expect(saveButton).toBeEnabled();
  });

  it('hides member budgets section when no non-owner members', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: {
        conversationCapNanoUsd: '50000000000',
        conversationSpentNanoUsd: '1000000000',
        ownerBalanceNanoUsd: '500000000000',
        members: [] as typeof BUDGET_DATA.members,
      },
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(screen.queryByTestId('budget-total-allocated')).not.toBeInTheDocument();
    expect(screen.getByTestId('budget-conversation-section')).toBeInTheDocument();
    expect(screen.getByTestId('budget-total-spent')).toBeInTheDocument();
  });
});
