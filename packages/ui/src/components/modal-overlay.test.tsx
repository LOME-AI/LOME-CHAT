import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ModalOverlay } from './modal-overlay';

describe('ModalOverlay', () => {
  it('renders children when open', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()}>
        <div>Modal content</div>
      </ModalOverlay>
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <ModalOverlay open={false} onOpenChange={vi.fn()}>
        <div>Modal content</div>
      </ModalOverlay>
    );
    expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
  });

  it('calls onOpenChange with false when overlay is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModalOverlay open={true} onOpenChange={onOpenChange}>
        <div>Modal content</div>
      </ModalOverlay>
    );

    // Click the overlay (outside the content)
    const overlay = screen.getByTestId('modal-overlay-backdrop');
    await user.click(overlay);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('closes on Escape key press', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModalOverlay open={true} onOpenChange={onOpenChange}>
        <div>Modal content</div>
      </ModalOverlay>
    );

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('has blur effect on overlay', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()}>
        <div>Modal content</div>
      </ModalOverlay>
    );

    const overlay = screen.getByTestId('modal-overlay-backdrop');
    expect(overlay).toHaveClass('backdrop-blur-sm');
  });

  it('applies custom className to content wrapper', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} className="custom-class">
        <div>Modal content</div>
      </ModalOverlay>
    );

    const content = screen.getByTestId('modal-overlay-content');
    expect(content).toHaveClass('custom-class');
  });

  it('centers content on screen', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()}>
        <div>Modal content</div>
      </ModalOverlay>
    );

    const content = screen.getByTestId('modal-overlay-content');
    expect(content).toHaveClass('fixed');
    expect(content).toHaveClass('top-[50%]');
    expect(content).toHaveClass('left-[50%]');
  });

  it('has data-slot attributes', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()}>
        <div>Modal content</div>
      </ModalOverlay>
    );

    expect(screen.getByTestId('modal-overlay-backdrop')).toHaveAttribute(
      'data-slot',
      'modal-overlay-backdrop'
    );
    expect(screen.getByTestId('modal-overlay-content')).toHaveAttribute(
      'data-slot',
      'modal-overlay-content'
    );
  });
});
