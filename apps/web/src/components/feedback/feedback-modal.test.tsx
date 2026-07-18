import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, ERROR_CODES, friendlyErrorMessage } from '@hushbox/shared';
import { ApiError } from '@/lib/api';
import { FeedbackModal } from './feedback-modal';

const { mockMutateAsync, mockToastSuccess } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('@/hooks/feedback/use-submit-feedback', () => ({
  useSubmitFeedback: () => ({ mutateAsync: mockMutateAsync }),
}));

vi.mock('@hushbox/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui')>()),
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}));

describe('FeedbackModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockImplementation(() => Promise.resolve());
  });

  it('renders the three type options and a message textarea', () => {
    render(<FeedbackModal {...defaultProps} />);

    expect(screen.getByTestId(TEST_IDS.feedbackTypeBug)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.feedbackTypeIdea)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.feedbackTypePraise)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.feedbackBody)).toBeInTheDocument();
  });

  it('defaults the active type to Bug', () => {
    render(<FeedbackModal {...defaultProps} />);

    expect(screen.getByTestId(TEST_IDS.feedbackTypeBug)).toHaveAttribute('data-state', 'on');
    expect(screen.getByTestId(TEST_IDS.feedbackTypeIdea)).toHaveAttribute('data-state', 'off');
  });

  it('switches the active type when another option is selected', async () => {
    render(<FeedbackModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId(TEST_IDS.feedbackTypeIdea));

    expect(screen.getByTestId(TEST_IDS.feedbackTypeIdea)).toHaveAttribute('data-state', 'on');
    expect(screen.getByTestId(TEST_IDS.feedbackTypeBug)).toHaveAttribute('data-state', 'off');
  });

  it('keeps a type selected when the active option is clicked again', async () => {
    render(<FeedbackModal {...defaultProps} />);

    // Clicking the already-active toggle fires onValueChange('') in Radix; the
    // guard must keep the current kind rather than clear the selection.
    await userEvent.click(screen.getByTestId(TEST_IDS.feedbackTypeBug));

    expect(screen.getByTestId(TEST_IDS.feedbackTypeBug)).toHaveAttribute('data-state', 'on');
  });

  it('disables Send while the body is empty', () => {
    render(<FeedbackModal {...defaultProps} />);

    expect(screen.getByTestId(TEST_IDS.feedbackSubmit)).toBeDisabled();
  });

  it('keeps Send disabled for a whitespace-only body', async () => {
    render(<FeedbackModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId(TEST_IDS.feedbackBody), '   ');

    expect(screen.getByTestId(TEST_IDS.feedbackSubmit)).toBeDisabled();
  });

  it('enables Send once the body has text', async () => {
    render(<FeedbackModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId(TEST_IDS.feedbackBody), 'great app');

    expect(screen.getByTestId(TEST_IDS.feedbackSubmit)).toBeEnabled();
  });

  it('submits the chosen kind and trimmed body', async () => {
    render(<FeedbackModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId(TEST_IDS.feedbackTypeIdea));
    await userEvent.type(screen.getByTestId(TEST_IDS.feedbackBody), '  ship dark mode  ');
    fireEvent.click(screen.getByTestId(TEST_IDS.feedbackSubmit));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ kind: 'idea', body: 'ship dark mode' });
    });
  });

  it('closes the modal and shows a thank-you toast on success', async () => {
    render(<FeedbackModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId(TEST_IDS.feedbackBody), 'nice');
    fireEvent.click(screen.getByTestId(TEST_IDS.feedbackSubmit));

    await waitFor(() => {
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Thanks — we read every one.');
  });

  it('shows the inline friendly error and stays open on failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('boom'));

    render(<FeedbackModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId(TEST_IDS.feedbackBody), 'nice');
    fireEvent.click(screen.getByTestId(TEST_IDS.feedbackSubmit));

    await waitFor(() => {
      expect(
        screen.getByText(friendlyErrorMessage(ERROR_CODES.FEEDBACK_SUBMIT_FAILED))
      ).toBeInTheDocument();
    });
    expect(defaultProps.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('shows the duplicate-specific message and stays open on a FEEDBACK_DUPLICATE error', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError(ERROR_CODES.FEEDBACK_DUPLICATE, 409, { code: ERROR_CODES.FEEDBACK_DUPLICATE })
    );

    render(<FeedbackModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId(TEST_IDS.feedbackBody), 'nice');
    fireEvent.click(screen.getByTestId(TEST_IDS.feedbackSubmit));

    await waitFor(() => {
      expect(
        screen.getByText(friendlyErrorMessage(ERROR_CODES.FEEDBACK_DUPLICATE))
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(friendlyErrorMessage(ERROR_CODES.FEEDBACK_SUBMIT_FAILED))).toBeNull();
    expect(defaultProps.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('renders nothing when open is false', () => {
    render(<FeedbackModal {...defaultProps} open={false} />);

    expect(screen.queryByTestId(TEST_IDS.feedbackModal)).toBeNull();
  });

  it('renders the character counter', () => {
    render(<FeedbackModal {...defaultProps} />);

    expect(screen.getByText('0 / 4,000')).toBeInTheDocument();
  });

  it('shows the truncation notice when the body exceeds the limit', () => {
    render(<FeedbackModal {...defaultProps} />);

    fireEvent.change(screen.getByTestId(TEST_IDS.feedbackBody), {
      target: { value: 'x'.repeat(4001) },
    });

    expect(screen.getByText('Only the first 4,000 characters will be used.')).toBeInTheDocument();
  });

  it('sends only the first 4000 characters when the body is over the limit', async () => {
    render(<FeedbackModal {...defaultProps} />);

    fireEvent.change(screen.getByTestId(TEST_IDS.feedbackBody), {
      target: { value: 'x'.repeat(4005) },
    });
    fireEvent.click(screen.getByTestId(TEST_IDS.feedbackSubmit));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ kind: 'bug', body: 'x'.repeat(4000) });
    });
  });
});
