import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorState } from './states';

describe('ErrorState', () => {
  it('renders the engine error envelope code and message', () => {
    render(<ErrorState code="analyze_failed" message="Failed to analyze the requested URL." />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('analyze_failed');
    expect(alert).toHaveTextContent('Failed to analyze the requested URL.');
  });
});
