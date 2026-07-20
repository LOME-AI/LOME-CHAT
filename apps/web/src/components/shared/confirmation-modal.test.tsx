import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmationModal } from './confirmation-modal';

describe('ConfirmationModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Remove Alice?',
    warning: 'This member will lose access to the conversation.',
    confirmLabel: 'Remove',
    onConfirm: vi.fn(),
    ariaLabel: 'Remove Member',
    testIdPrefix: 'remove-member',
  };

  it('renders title', () => {
    render(<ConfirmationModal {...defaultProps} />);

    const title = screen.getByTestId('remove-member-title');
    expect(title).toHaveTextContent('Remove Alice?');
  });

  it('renders warning message', () => {
    render(<ConfirmationModal {...defaultProps} />);

    const warning = screen.getByTestId('remove-member-warning');
    expect(warning).toHaveTextContent('This member will lose access to the conversation.');
  });

  it('renders confirm button with custom label', () => {
    render(<ConfirmationModal {...defaultProps} />);

    const confirmButton = screen.getByTestId('remove-member-confirm');
    expect(confirmButton).toHaveTextContent('Remove');
  });

  it('calls onConfirm when confirm button is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmationModal {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByTestId('remove-member-confirm'));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onOpenChange(false) when confirm button is clicked', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmationModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByTestId('remove-member-confirm'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when cancel button is clicked', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmationModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByTestId('remove-member-cancel'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render when open is false', () => {
    render(<ConfirmationModal {...defaultProps} open={false} />);

    expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
  });

  it('confirm button has destructive variant', () => {
    render(<ConfirmationModal {...defaultProps} />);

    expect(screen.getByTestId('remove-member-confirm')).toHaveAttribute(
      'data-variant',
      'destructive'
    );
  });

  it('uses testIdPrefix for all test IDs', () => {
    render(
      <ConfirmationModal
        {...defaultProps}
        testIdPrefix="revoke-link"
        title="Revoke Team Link?"
        warning="Anyone with this link will lose access."
        confirmLabel="Revoke"
        ariaLabel="Revoke Link"
      />
    );

    expect(screen.getByTestId('revoke-link-modal')).toBeInTheDocument();
    expect(screen.getByTestId('revoke-link-title')).toHaveTextContent('Revoke Team Link?');
    expect(screen.getByTestId('revoke-link-warning')).toHaveTextContent(
      'Anyone with this link will lose access.'
    );
    expect(screen.getByTestId('revoke-link-confirm')).toHaveTextContent('Revoke');
    expect(screen.getByTestId('revoke-link-cancel')).toHaveTextContent('Cancel');
  });

  describe('async onConfirm', () => {
    it('accepts a Promise-returning onConfirm and closes on resolve', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      const onConfirm = vi.fn(() => Promise.resolve());

      render(
        <ConfirmationModal {...defaultProps} onOpenChange={onOpenChange} onConfirm={onConfirm} />
      );
      await user.click(screen.getByTestId('remove-member-confirm'));

      // The mutation fires and the modal closes.
      expect(onConfirm).toHaveBeenCalledOnce();
      // Allow microtasks to flush
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('stays open with inline error when onConfirm rejects', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      const onConfirm = vi.fn(() => Promise.reject(new Error('STALE_EPOCH')));

      render(
        <ConfirmationModal {...defaultProps} onOpenChange={onOpenChange} onConfirm={onConfirm} />
      );
      await user.click(screen.getByTestId('remove-member-confirm'));

      // Inline error appears, modal does not close. The warning Alert has
      // role="alert" too — filter by the specific text we expect.
      const errorMessage = await screen.findByText(
        'The conversation keys changed. Refresh and try again.'
      );
      expect(errorMessage).toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
  });
});
