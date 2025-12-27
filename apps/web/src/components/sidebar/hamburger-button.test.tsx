import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HamburgerButton } from './hamburger-button';
import { useUIStore } from '@/stores/ui';

describe('HamburgerButton', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileSidebarOpen: false });
  });

  it('renders hamburger button', () => {
    render(<HamburgerButton />);
    expect(screen.getByTestId('hamburger-button')).toBeInTheDocument();
  });

  it('has accessible label', () => {
    render(<HamburgerButton />);
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
  });

  it('opens mobile sidebar when clicked', async () => {
    const user = userEvent.setup();
    render(<HamburgerButton />);

    await user.click(screen.getByTestId('hamburger-button'));

    expect(useUIStore.getState().mobileSidebarOpen).toBe(true);
  });

  it('has md:hidden class for mobile-only visibility', () => {
    render(<HamburgerButton />);
    expect(screen.getByTestId('hamburger-button')).toHaveClass('md:hidden');
  });
});
