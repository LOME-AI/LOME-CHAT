import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarActionButton } from './sidebar-action-button';

describe('SidebarActionButton', () => {
  describe('expanded mode', () => {
    it('renders button with label and icon', () => {
      render(
        <SidebarActionButton
          icon={<span data-testid="test-icon">+</span>}
          label="New Chat"
          onClick={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: 'New Chat' })).toBeInTheDocument();
      expect(screen.getByTestId('test-icon')).toBeInTheDocument();
      expect(screen.getByText('New Chat')).toBeInTheDocument();
    });

    it('defaults to expanded when collapsed is undefined', () => {
      render(
        <SidebarActionButton
          icon={<span data-testid="test-icon">+</span>}
          label="New Chat"
          onClick={vi.fn()}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-full');
      expect(screen.getByText('New Chat')).toBeInTheDocument();
    });

    it('has the brand fill class', () => {
      render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-primary');
    });

    it('has clip-path style', () => {
      render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button.style.clipPath).toBe('polygon(0 0, 100% 0, 95% 100%, 0 100%)');
    });
  });

  describe('collapsed mode', () => {
    it('renders icon only without label', () => {
      render(
        <SidebarActionButton
          icon={<span data-testid="test-icon">+</span>}
          label="New Chat"
          onClick={vi.fn()}
          collapsed={true}
        />
      );

      expect(screen.getByTestId('test-icon')).toBeInTheDocument();
      expect(screen.queryByText('New Chat')).not.toBeInTheDocument();
    });

    it('has compact size classes', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="Action"
          onClick={vi.fn()}
          collapsed={true}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9');
      expect(button).toHaveClass('w-9');
    });
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={onClick} />);

    await user.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('has aria-label matching label prop', () => {
    render(<SidebarActionButton icon={<span>+</span>} label="My Action" onClick={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'My Action');
  });

  it('applies testId as data-testid', () => {
    render(
      <SidebarActionButton
        icon={<span>+</span>}
        label="Action"
        onClick={vi.fn()}
        testId="custom-btn"
      />
    );

    expect(screen.getByTestId('custom-btn')).toBeInTheDocument();
  });

  it('renders shine animation div', () => {
    render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

    const button = screen.getByRole('button');
    const shineDiv = button.querySelector('[aria-hidden="true"]');
    expect(shineDiv).not.toBeNull();
    expect(shineDiv).toHaveClass('pointer-events-none', 'absolute', 'inset-0');
  });

  describe('href', () => {
    it('renders an anchor pointing to href when provided', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="New Chat"
          onClick={vi.fn()}
          href="/chat"
        />
      );

      const link = screen.getByRole('link', { name: 'New Chat' });
      expect(link).toHaveAttribute('href', '/chat');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('keeps gradient and clip-path styling on the anchor', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="New Chat"
          onClick={vi.fn()}
          href="/chat"
        />
      );

      const link = screen.getByRole('link');
      expect(link).toHaveClass('bg-primary', 'w-full');
      expect(link.style.clipPath).toBe('polygon(0 0, 100% 0, 95% 100%, 0 100%)');
    });

    it('calls onClick when the anchor is clicked', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="New Chat"
          onClick={onClick}
          href="/chat"
        />
      );

      await user.click(screen.getByRole('link'));

      expect(onClick).toHaveBeenCalledOnce();
    });

    it('renders an icon-only anchor when collapsed', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="New Chat"
          onClick={vi.fn()}
          href="/chat"
          collapsed={true}
        />
      );

      const link = screen.getByRole('link');
      expect(link).toHaveClass('h-9', 'w-9');
      expect(screen.queryByText('New Chat')).not.toBeInTheDocument();
    });
  });

  describe('focus ring', () => {
    it('uses project-default focus-visible:ring-ring/50 in expanded mode', () => {
      render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass(
        'focus-visible:ring-ring/50',
        'focus-visible:ring-2',
        'focus-visible:outline-none'
      );
      expect(button).not.toHaveClass('focus-visible:ring-primary');
    });

    it('uses project-default focus-visible:ring-ring/50 in collapsed mode', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="Action"
          onClick={vi.fn()}
          collapsed={true}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass(
        'focus-visible:ring-ring/50',
        'focus-visible:ring-2',
        'focus-visible:outline-none'
      );
      expect(button).not.toHaveClass('focus-visible:ring-primary');
    });
  });

  describe('shine animation', () => {
    it('applies shine animation style (expanded)', () => {
      render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

      const button = screen.getByRole('button');
      const shineDiv = button.querySelector<HTMLElement>('[aria-hidden="true"]')!;
      expect(shineDiv.style.animation).toContain('shine');
    });

    it('applies shine animation style (collapsed)', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="Action"
          onClick={vi.fn()}
          collapsed={true}
        />
      );

      const button = screen.getByRole('button');
      const shineDiv = button.querySelector<HTMLElement>('[aria-hidden="true"]')!;
      expect(shineDiv.style.animation).toContain('shine');
    });
  });
});
