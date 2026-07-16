import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './audit.js';

describe('Audit trail placeholder route', () => {
  it('renders the Audit trail placeholder screen', () => {
    renderRoute(Route);
    expect(screen.getByRole('heading', { name: 'Audit trail' })).toBeInTheDocument();
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});
