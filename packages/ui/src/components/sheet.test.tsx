import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from './sheet';

describe('Sheet', () => {
  it('renders trigger element', () => {
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByText('Open Sheet')).toBeInTheDocument();
  });

  it('opens sheet when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet Title</SheetTitle>
          <SheetDescription>Sheet description</SheetDescription>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
      expect(screen.getByText('Sheet description')).toBeInTheDocument();
    });
  });

  it('closes sheet when close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByText('Sheet Title')).not.toBeInTheDocument();
    });
  });

  it('has cursor-pointer on close button', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Sheet Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
    });

    const closeButton = screen.getByRole('button', { name: /close/i });
    expect(closeButton).toHaveClass('cursor-pointer');
  });

  it('renders with different sides', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent side="left">
          <SheetTitle>Left Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Left Sheet')).toBeInTheDocument();
    });
  });

  it('can hide close button', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Sheet Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      expect(screen.getByText('Sheet Title')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('scrolls internally so tall content keeps actions reachable', () => {
    render(
      <Sheet open={true}>
        <SheetContent>
          <SheetTitle>Scrollable Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole('dialog')).toHaveClass('overflow-y-auto');
  });

  it.each(['top', 'bottom'] as const)('caps %s-anchored sheet height to the viewport', (side) => {
    render(
      <Sheet open={true}>
        <SheetContent side={side}>
          <SheetTitle>Capped Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole('dialog')).toHaveClass('max-h-[calc(100dvh-2rem)]');
  });

  it('renders controlled sheet', () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open={true} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetTitle>Controlled Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByText('Controlled Sheet')).toBeInTheDocument();
  });
});

describe('SheetHeader', () => {
  it('renders children', () => {
    render(<SheetHeader>Header content</SheetHeader>);
    expect(screen.getByText('Header content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<SheetHeader data-testid="header">Content</SheetHeader>);
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'sheet-header');
  });

  it('applies custom className', () => {
    render(
      <SheetHeader className="custom-class" data-testid="header">
        Content
      </SheetHeader>
    );
    expect(screen.getByTestId('header')).toHaveClass('custom-class');
  });
});

describe('SheetFooter', () => {
  it('renders children', () => {
    render(<SheetFooter>Footer content</SheetFooter>);
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<SheetFooter data-testid="footer">Content</SheetFooter>);
    expect(screen.getByTestId('footer')).toHaveAttribute('data-slot', 'sheet-footer');
  });

  it('applies custom className', () => {
    render(
      <SheetFooter className="custom-class" data-testid="footer">
        Content
      </SheetFooter>
    );
    expect(screen.getByTestId('footer')).toHaveClass('custom-class');
  });
});

describe('SheetClose', () => {
  it('closes sheet when clicked', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
          <SheetClose>Custom Close</SheetClose>
        </SheetContent>
      </Sheet>
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

  it.each([
    ['left', 'slide-in-from-left'],
    ['top', 'slide-in-from-top'],
    ['bottom', 'slide-in-from-bottom'],
  ] as const)('renders %s-side content with the matching slide animation', async (side, cls) => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent side={side}>
          <SheetTitle>Side Title</SheetTitle>
        </SheetContent>
      </Sheet>
    );
    await user.click(screen.getByText('Open Sheet'));
    await waitFor(() => {
      const content = document.querySelector('[data-slot="sheet-content"]');
      expect(content).not.toBeNull();
      expect(content!.className).toContain(cls);
    });
  });
});
