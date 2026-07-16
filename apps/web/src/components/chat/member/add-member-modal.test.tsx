import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/realtime/use-user-search.js', () => ({
  useUserSearch: vi.fn(),
}));

import { MAX_CONVERSATION_MEMBERS } from '@hushbox/shared';
import { useUserSearch } from '@/hooks/realtime/use-user-search.js';
import { AddMemberModal } from '@/components/chat/member/add-member-modal';

const mockUseUserSearch = vi.mocked(useUserSearch);

describe('AddMemberModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    onAddMember: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUserSearch.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);
  });

  it('renders search input when open', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByTestId('add-member-search-input')).toBeInTheDocument();
  });

  it('shows search results when query >= 2 chars', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [
          { id: 'user-1', username: 'alice123', publicKey: 'AQID' },
          { id: 'user-2', username: 'bob_smith', publicKey: 'BAIE' },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    expect(screen.getByTestId('add-member-result-user-1')).toBeInTheDocument();
    expect(screen.getByTestId('add-member-result-user-2')).toBeInTheDocument();
    expect(screen.getByText('Alice123')).toBeInTheDocument();
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
  });

  it('selects a user when result is clicked', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    expect(screen.getByTestId('add-member-selected')).toBeInTheDocument();
    expect(screen.getByTestId('add-member-selected')).toHaveTextContent('Alice123');
  });

  it('shows selected user info after selection', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    const selected = screen.getByTestId('add-member-selected');
    expect(selected).toHaveTextContent('Alice123');
  });

  it('has Write as default privilege', () => {
    render(<AddMemberModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const select = screen.getByTestId('add-member-privilege-select') as HTMLSelectElement;
    expect(select.value).toBe('write');
  });

  it('disables Add Member button when no user selected', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByTestId('add-member-submit-button')).toBeDisabled();
  });

  it('enables Add Member button when user is selected', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    expect(screen.getByTestId('add-member-submit-button')).toBeEnabled();
  });

  it('calls onAddMember with correct params on submit', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');
    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    await userEvent.selectOptions(screen.getByTestId('add-member-privilege-select'), 'admin');

    await userEvent.click(screen.getByRole('checkbox'));

    await userEvent.click(screen.getByTestId('add-member-submit-button'));

    expect(defaultProps.onAddMember).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'alice123',
      publicKey: 'AQID',
      privilege: 'admin',
      giveFullHistory: true,
    });
  });

  it('closes modal after successful add', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');
    await userEvent.click(screen.getByTestId('add-member-result-user-1'));
    await userEvent.click(screen.getByTestId('add-member-submit-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('awaits an async onAddMember before closing', async () => {
    const onAddMember = vi.fn(() => Promise.resolve());
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} onAddMember={onAddMember} />);

    await userEvent.type(screen.getByTestId('add-member-search-input'), 'al');
    await userEvent.click(screen.getByTestId('add-member-result-user-1'));
    await userEvent.click(screen.getByTestId('add-member-submit-button'));

    expect(onAddMember).toHaveBeenCalledOnce();
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    render(<AddMemberModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('add-member-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('unchecked history checkbox by default', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByTestId('add-member-history-checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('allows toggling history checkbox', async () => {
    render(<AddMemberModal {...defaultProps} />);

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);

    expect(checkbox).toBeChecked();
  });

  it('clears search input when a user is selected', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    expect(input).toHaveValue('');
  });

  it('shows member limit alert and disables submit when at capacity', () => {
    render(<AddMemberModal {...defaultProps} memberCount={MAX_CONVERSATION_MEMBERS} />);

    expect(screen.getByText(/reached the maximum of 100 members/)).toBeInTheDocument();
    expect(screen.getByTestId('add-member-submit-button')).toBeDisabled();
  });

  it('does not show member limit alert when below capacity', () => {
    render(<AddMemberModal {...defaultProps} memberCount={50} />);

    expect(screen.queryByText(/reached the maximum of 100 members/)).not.toBeInTheDocument();
  });

  it('renders action buttons side-by-side with Cancel on left', () => {
    render(<AddMemberModal {...defaultProps} />);

    const submitButton = screen.getByTestId('add-member-submit-button');
    const cancelButton = screen.getByTestId('add-member-cancel-button');

    const container = submitButton.parentElement;
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('gap-2');
    expect(container).not.toHaveClass('flex-col');

    expect(submitButton).toHaveClass('flex-1');
    expect(cancelButton).toHaveClass('flex-1');

    const buttons = [...container!.children];
    expect(buttons.indexOf(cancelButton)).toBeLessThan(buttons.indexOf(submitButton));
  });
});
