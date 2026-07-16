import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { legacyFriendlyErrorMessage } from '@hushbox/shared';
import { ErrorBoundary } from './error-boundary';

function ThrowingComponent({ shouldThrow }: Readonly<{ shouldThrow: boolean }>): React.JSX.Element {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div data-testid="child">Child content</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders fallback UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });

  it('displays error message in fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('falls back to the INTERNAL message when a child throws a non-Error value', () => {
    function ThrowsNonError(): React.JSX.Element {
      // React forwards non-Error throws to the boundary, so `state.error` is
      // undefined here: `error?.message` short-circuits and the `?? 'INTERNAL'`
      // fallback drives the friendly message.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately testing the boundary's handling of a non-Error throw
      throw undefined;
    }

    render(
      <ErrorBoundary>
        <ThrowsNonError />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByText(legacyFriendlyErrorMessage('INTERNAL'))).toBeInTheDocument();
  });

  it('provides retry button that resets error state', () => {
    let shouldThrow = true;

    function ConditionalThrower(): React.JSX.Element {
      if (shouldThrow) {
        throw new Error('Recoverable error');
      }
      return <div data-testid="recovered">Recovered!</div>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <ConditionalThrower />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();

    shouldThrow = false;

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    rerender(
      <ErrorBoundary>
        <ConditionalThrower />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
  });

  it('uses custom fallback when provided', () => {
    const customFallback = <div data-testid="custom-fallback">Custom error message</div>;

    render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.getByText('Custom error message')).toBeInTheDocument();
  });

  it('calls onError callback when error occurs', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Test error' }),
      expect.any(Object)
    );
  });

  it('resets the error state when resetKey changes', () => {
    let shouldThrow = true;
    function ResetKeyThrower(): React.JSX.Element {
      if (shouldThrow) {
        throw new Error('Chunk load failed');
      }
      return <div data-testid="reset-recovered">Reset recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <ResetKeyThrower />
      </ErrorBoundary>
    );
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <ErrorBoundary resetKey="b">
        <ResetKeyThrower />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('reset-recovered')).toBeInTheDocument();
  });

  it('stays in the error state when resetKey is unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="same">
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();

    // Re-render with the same resetKey: componentDidUpdate must not reset.
    rerender(
      <ErrorBoundary resetKey="same">
        <ThrowingComponent shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });
});
