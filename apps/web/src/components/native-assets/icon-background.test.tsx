// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { IconBackground } from './icon-background';

describe('IconBackground', () => {
  it('renders a container with data-testid', () => {
    render(<IconBackground />);
    expect(screen.getByTestId(TEST_IDS.iconBackground)).toBeInTheDocument();
  });

  it('fills the viewport', () => {
    render(<IconBackground />);
    const container = screen.getByTestId(TEST_IDS.iconBackground);
    expect(container).toHaveStyle({ width: '100vw', height: '100vh' });
  });

  it('has solid dark background', () => {
    render(<IconBackground />);
    const container = screen.getByTestId(TEST_IDS.iconBackground);
    expect(container).toHaveStyle({ backgroundColor: '#0a0a0a' });
  });

  it('has no children', () => {
    render(<IconBackground />);
    const container = screen.getByTestId(TEST_IDS.iconBackground);
    expect(container.children).toHaveLength(0);
  });
});
