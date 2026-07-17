import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceholderScreen } from './placeholder-screen.js';

describe('PlaceholderScreen', () => {
  it('renders the screen title as a heading', () => {
    render(<PlaceholderScreen title="Jobs" />);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
  });

  it('sizes the heading at least 19px so bold brand red counts as large text', () => {
    render(<PlaceholderScreen title="Jobs" />);
    const heading = screen.getByRole('heading', { name: 'Jobs' });
    // 1.2rem = 19.2px even at a 16px mobile root — above WCAG's 18.66px bold
    // large-text line, so the 3:1 large-text contrast ratio applies.
    expect(heading.className).toContain('text-[1.2rem]');
    expect(heading.className).not.toContain('text-lg');
  });

  it('states that the screen is not built yet', () => {
    render(<PlaceholderScreen title="Jobs" />);
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
