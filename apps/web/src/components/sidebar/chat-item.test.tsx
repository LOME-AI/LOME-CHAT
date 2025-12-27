import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatItem } from './chat-item';
import { useUIStore } from '@/stores/ui';

// Mock Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { conversationId: string };
    className?: string;
  }) => (
    <a
      href={params ? to.replace('$conversationId', params.conversationId) : to}
      className={className}
      data-testid="chat-link"
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

// Mock chat hooks
const mockDeleteMutate = vi.fn();
const mockUpdateMutate = vi.fn();

vi.mock('@/hooks/chat', () => ({
  useDeleteConversation: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: mockUpdateMutate,
    isPending: false,
  }),
}));

describe('ChatItem', () => {
  const mockConversation = {
    id: 'conv-123',
    title: 'Test Conversation',
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutate.mockClear();
    mockUpdateMutate.mockClear();
    useUIStore.setState({ sidebarOpen: true });
  });

  describe('expanded state', () => {
    it('renders conversation title', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
    });

    it('links to conversation page', () => {
      render(<ChatItem conversation={mockConversation} />);
      const link = screen.getByTestId('chat-link');
      expect(link).toHaveAttribute('href', '/chat/conv-123');
    });

    it('truncates long titles', () => {
      const longTitle = {
        ...mockConversation,
        title: 'This is a very long conversation title that should be truncated',
      };
      render(<ChatItem conversation={longTitle} />);
      const title = screen.getByText(longTitle.title);
      expect(title).toHaveClass('truncate');
    });

    it('hides message icon when expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId('message-icon')).not.toBeInTheDocument();
    });

    it('highlights when active', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      const link = screen.getByTestId('chat-link');
      // The active styling is on the parent wrapper div, not the link
      expect(link.parentElement).toHaveClass('bg-sidebar-border');
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('shows only icon when collapsed', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId('message-icon')).toBeInTheDocument();
      expect(screen.queryByText('Test Conversation')).not.toBeInTheDocument();
    });

    it('hides more options button when collapsed', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId('chat-item-more-button')).not.toBeInTheDocument();
    });
  });

  describe('actions dropdown', () => {
    it('shows more options button when sidebar is expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId('chat-item-more-button')).toBeInTheDocument();
    });

    it('opens dropdown menu on more button click', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('prevents navigation when clicking more button', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      const moreButton = screen.getByTestId('chat-item-more-button');
      await user.click(moreButton);

      // Dropdown should be open, link navigation should not have occurred
      expect(screen.getByText('Rename')).toBeInTheDocument();
    });
  });

  describe('delete action', () => {
    it('shows delete confirmation dialog when delete is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Delete'));

      expect(screen.getByText('Delete conversation?')).toBeInTheDocument();
      expect(screen.getByText(/This will permanently delete/)).toBeInTheDocument();
    });

    it('calls delete mutation when confirmed', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId('confirm-delete-button'));

      expect(mockDeleteMutate).toHaveBeenCalledWith('conv-123', expect.any(Object));
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId('cancel-delete-button'));

      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
      expect(mockDeleteMutate).not.toHaveBeenCalled();
    });
  });

  describe('rename action', () => {
    it('shows rename dialog when rename is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));

      expect(screen.getByText('Rename conversation')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Test Conversation')).toBeInTheDocument();
    });

    it('calls update mutation with new title when saved', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId('save-rename-button'));

      expect(mockUpdateMutate).toHaveBeenCalledWith(
        { conversationId: 'conv-123', data: { title: 'New Title' } },
        expect.any(Object)
      );
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));
      await user.click(screen.getByTestId('cancel-rename-button'));

      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
      expect(mockUpdateMutate).not.toHaveBeenCalled();
    });

    it('disables save button when title is empty', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);

      expect(screen.getByTestId('save-rename-button')).toBeDisabled();
    });
  });
});
