import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryProvider, queryClient } from './query-provider.js';

describe('QueryProvider', () => {
  it('renders its children', () => {
    render(
      <QueryProvider>
        <div>child content</div>
      </QueryProvider>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('never refetches on window focus (ops tool, not a live feed)', () => {
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
