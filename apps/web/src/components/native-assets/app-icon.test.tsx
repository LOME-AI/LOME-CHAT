// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { AppIcon } from './app-icon';

mockLogoImport();

describe('AppIcon', () => {
  it('renders a container with data-testid', () => {
    render(<AppIcon />);
    expect(screen.getByTestId(TEST_IDS.appIcon)).toBeInTheDocument();
  });

  it('fills the viewport', () => {
    render(<AppIcon />);
    const container = screen.getByTestId(TEST_IDS.appIcon);
    expect(container).toHaveStyle({ width: '100vw', height: '100vh' });
  });

  it('has solid dark background', () => {
    render(<AppIcon />);
    const container = screen.getByTestId(TEST_IDS.appIcon);
    expect(container).toHaveStyle({ backgroundColor: '#0a0a0a' });
  });

  it('renders the logo image', () => {
    render(<AppIcon />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toBeInTheDocument();
  });

  it('centers the logo image', () => {
    render(<AppIcon />);
    const container = screen.getByTestId(TEST_IDS.appIcon);
    expect(container).toHaveStyle({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
  });

  it('sizes the logo at 60% of the container', () => {
    render(<AppIcon />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toHaveStyle({ width: '60%', height: '60%' });
  });
});
