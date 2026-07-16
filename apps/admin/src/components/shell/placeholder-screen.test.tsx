import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceholderScreen } from './placeholder-screen.js';

describe('PlaceholderScreen', () => {
  it('renders the screen title as a heading', () => {
    render(<PlaceholderScreen title="Jobs" />);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
  });

  it('states that the screen is not built yet', () => {
    render(<PlaceholderScreen title="Jobs" />);
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
