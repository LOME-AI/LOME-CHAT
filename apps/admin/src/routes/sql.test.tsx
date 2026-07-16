import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './sql.js';

describe('SQL panel placeholder route', () => {
  it('renders the SQL panel placeholder screen', () => {
    renderRoute(Route);
    expect(screen.getByRole('heading', { name: 'SQL panel' })).toBeInTheDocument();
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
