import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarFooterBase } from './sidebar-footer-base';

describe('SidebarFooterBase', () => {
  it('renders icon inside avatar circle', () => {
    render(
      <SidebarFooterBase
        icon={<span data-testid="test-icon">I</span>}
        label="Test User"
        testId="test"
      />
    );

    const icon = screen.getByTestId('test-icon');
    expect(icon).toBeInTheDocument();
    expect(icon.closest('.rounded-full')).not.toBeNull();
  });

  it('shows label and sublabel when not collapsed', () => {
    render(
      <SidebarFooterBase icon={<span>I</span>} label="Test User" sublabel="$5.00" testId="test" />
    );

    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('$5.00')).toBeInTheDocument();
  });

  it('hides label and sublabel when collapsed', () => {
    render(
      <SidebarFooterBase
        icon={<span>I</span>}
        label="Test User"
        sublabel="$5.00"
        collapsed={true}
        testId="test"
      />
    );

    expect(screen.queryByText('Test User')).not.toBeInTheDocument();
    expect(screen.queryByText('$5.00')).not.toBeInTheDocument();
  });

  it('calls onClick when trigger is clicked (no dropdown)', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <SidebarFooterBase icon={<span>I</span>} label="Test User" onClick={onClick} testId="test" />
    );

    await user.click(screen.getByTestId('test-trigger'));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders dropdown menu when dropdownContent provided', async () => {
    const user = userEvent.setup();
    render(
      <SidebarFooterBase
        icon={<span>I</span>}
        label="Test User"
        dropdownContent={<div data-testid="dropdown-item">Menu Item</div>}
        testId="test"
      />
    );

    await user.click(screen.getByTestId('test-trigger'));

    expect(screen.getByTestId('dropdown-item')).toBeInTheDocument();
  });

  it('has border-t class on container', () => {
    render(<SidebarFooterBase icon={<span>I</span>} label="Test User" testId="test" />);

    const container = screen.getByTestId('test-footer');
    expect(container).toHaveClass('border-t');
  });

  it('uses flex justify-center when collapsed', () => {
    render(
      <SidebarFooterBase icon={<span>I</span>} label="Test User" collapsed={true} testId="test" />
    );

    const container = screen.getByTestId('test-footer');
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('justify-center');
  });

  it('does not use justify-center when not collapsed', () => {
    render(
      <SidebarFooterBase icon={<span>I</span>} label="Test User" collapsed={false} testId="test" />
    );

    const container = screen.getByTestId('test-footer');
    expect(container).not.toHaveClass('justify-center');
  });

  it('renders sublabel with muted text style', () => {
    render(
      <SidebarFooterBase icon={<span>I</span>} label="Test User" sublabel="$5.00" testId="test" />
    );

    const sublabel = screen.getByText('$5.00');
    expect(sublabel).toHaveClass('text-muted-foreground');
  });

  it('does not render sublabel when undefined', () => {
    render(<SidebarFooterBase icon={<span>I</span>} label="Test User" testId="test" />);

    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  describe('chevron icon', () => {
    it('renders ChevronUp icon when expanded', () => {
      render(<SidebarFooterBase icon={<span>I</span>} label="Test User" testId="test" />);

      const trigger = screen.getByTestId('test-trigger');
      const svg = trigger.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveClass('text-muted-foreground');
      expect(svg).toHaveClass('size-4');
    });

    it('hides chevron when collapsed', () => {
      render(
        <SidebarFooterBase icon={<span>I</span>} label="Test User" collapsed={true} testId="test" />
      );

      const trigger = screen.getByTestId('test-trigger');
      const svg = trigger.querySelector('svg');
      expect(svg).toBeNull();
    });
  });

  describe('hover and cursor styles', () => {
    it('applies cursor-pointer to trigger button', () => {
      render(<SidebarFooterBase icon={<span>I</span>} label="Test User" testId="test" />);

      const trigger = screen.getByTestId('test-trigger');
      expect(trigger).toHaveClass('cursor-pointer');
    });

    it('applies hover ring classes to trigger button', () => {
      render(<SidebarFooterBase icon={<span>I</span>} label="Test User" testId="test" />);

      const trigger = screen.getByTestId('test-trigger');
      expect(trigger).toHaveClass('hover:ring-1');
      expect(trigger).toHaveClass('hover:ring-sidebar-border');
    });
  });

  it('renders without test ids when no testId prefix is provided', () => {
    // Exercises makeTestId's `prefix === undefined` branch.
    render(<SidebarFooterBase icon={<span>I</span>} label="Anon User" />);

    expect(screen.getByText('Anon User')).toBeInTheDocument();
  });
});
