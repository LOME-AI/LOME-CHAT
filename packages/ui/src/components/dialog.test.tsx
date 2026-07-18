import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from './dialog';

describe('Dialog', () => {
  it('renders trigger element', () => {
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(screen.getByText('Open Dialog')).toBeInTheDocument();
  });

  it('opens dialog when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
      expect(screen.getByText('Dialog description')).toBeInTheDocument();
    });
  });

  it('closes dialog when close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByText('Dialog Title')).not.toBeInTheDocument();
    });
  });

  it('has cursor-pointer on close button', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
    });

    const closeButton = screen.getByRole('button', { name: /close/i });
    expect(closeButton).toHaveClass('cursor-pointer');
  });

  it('can hide close button', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open Dialog'));
    await waitFor(() => {
      expect(screen.getByText('Dialog Title')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('renders controlled dialog', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open={true} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Controlled Dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expect(screen.getByText('Controlled Dialog')).toBeInTheDocument();
  });

  it('caps its own height and scrolls internally by default', () => {
    render(
      <Dialog open={true}>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const content = screen.getByRole('dialog');
    expect(content).toHaveClass('max-h-[calc(100dvh-2rem)]');
    expect(content).toHaveClass('overflow-y-auto');
  });

  it('lets a consumer className override the default max-height with a single max-h class', () => {
    render(
      <Dialog open={true}>
        <DialogContent className="max-h-[90vh]">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const content = screen.getByRole('dialog');
    expect(content).toHaveClass('max-h-[90vh]');
    expect(content).not.toHaveClass('max-h-[calc(100dvh-2rem)]');
  });
});

describe('DialogHeader', () => {
  it('renders children', () => {
    render(<DialogHeader>Header content</DialogHeader>);
    expect(screen.getByText('Header content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<DialogHeader data-testid="header">Content</DialogHeader>);
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'dialog-header');
  });

  it('applies custom className', () => {
    render(
      <DialogHeader className="custom-class" data-testid="header">
        Content
      </DialogHeader>
    );
    expect(screen.getByTestId('header')).toHaveClass('custom-class');
  });
});

describe('DialogFooter', () => {
  it('renders children', () => {
    render(<DialogFooter>Footer content</DialogFooter>);
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<DialogFooter data-testid="footer">Content</DialogFooter>);
    expect(screen.getByTestId('footer')).toHaveAttribute('data-slot', 'dialog-footer');
  });

  it('applies custom className', () => {
    render(
      <DialogFooter className="custom-class" data-testid="footer">
        Content
      </DialogFooter>
    );
    expect(screen.getByTestId('footer')).toHaveClass('custom-class');
  });
});

describe('DialogClose', () => {
  it('closes dialog when clicked', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Title</DialogTitle>
          <DialogClose>Custom Close</DialogClose>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Title')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Custom Close'));
    await waitFor(() => {
      expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });
});
