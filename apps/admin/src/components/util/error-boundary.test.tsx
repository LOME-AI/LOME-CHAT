import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminErrorBoundary } from './error-boundary.js';

function Boom(): React.JSX.Element {
  throw new Error('shell exploded');
}

describe('AdminErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error; silence the expected noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(
      <AdminErrorBoundary>
        <div>healthy shell</div>
      </AdminErrorBoundary>
    );

    expect(screen.getByText('healthy shell')).toBeInTheDocument();
  });

  it('catches a render throw and shows a readable fallback instead of a blank page', () => {
    render(
      <AdminErrorBoundary>
        <Boom />
      </AdminErrorBoundary>
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('shell exploded');
  });

  it('recovers to children after the underlying fault is healed and retry is pressed', async () => {
    function Flaky({ shouldThrow }: { readonly shouldThrow: boolean }): React.JSX.Element {
      if (shouldThrow) {
        throw new Error('shell exploded');
      }
      return <div>recovered shell</div>;
    }

    function Harness(): React.JSX.Element {
      const [shouldThrow, setShouldThrow] = React.useState(true);
      return (
        <>
          {/* The heal control lives outside the boundary so it survives the
              fallback swap; retry then re-attempts the now-healthy children. */}
          <button
            type="button"
            onClick={() => {
              setShouldThrow(false);
            }}
          >
            heal
          </button>
          <AdminErrorBoundary>
            <Flaky shouldThrow={shouldThrow} />
          </AdminErrorBoundary>
        </>
      );
    }

    render(<Harness />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /heal/i }));
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('recovered shell')).toBeInTheDocument();
  });
});
