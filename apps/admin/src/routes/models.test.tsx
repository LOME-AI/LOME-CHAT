import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './models.js';

describe('Models placeholder route', () => {
  it('renders the Models placeholder screen', () => {
    renderRoute(Route);
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
