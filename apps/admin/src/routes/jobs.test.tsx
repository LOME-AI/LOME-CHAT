import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './jobs.js';

describe('Jobs placeholder route', () => {
  it('renders the Jobs placeholder screen', () => {
    renderRoute(Route);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
