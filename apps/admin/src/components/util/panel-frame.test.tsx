import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { PanelFrame } from './panel-frame.js';

describe('PanelFrame', () => {
  it('renders the title and content', () => {
    render(
      <PanelFrame title="Money">
        <p>content here</p>
      </PanelFrame>
    );

    expect(screen.getByRole('heading', { name: 'Money' })).toBeInTheDocument();
    expect(screen.getByText('content here')).toBeInTheDocument();
  });

  it('renders a skeleton while loading, not the content', () => {
    render(
      <PanelFrame title="Money" loading>
        <p>content here</p>
      </PanelFrame>
    );

    expect(screen.queryByText('content here')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Money' })).toBeInTheDocument();
  });

  it('renders an inline panel error instead of the content', () => {
    render(
      <PanelFrame title="Usage" error="unavailable">
        <p>content here</p>
      </PanelFrame>
    );

    const error = screen.getByTestId(TEST_IDS.adminPanelError);
    expect(error).toHaveTextContent('Failed to load');
    expect(error).toHaveTextContent('unavailable');
    expect(screen.queryByText('content here')).not.toBeInTheDocument();
  });
});
