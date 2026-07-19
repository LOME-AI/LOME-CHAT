import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorFallback, RouteErrorComponent, NotFoundFallback } from './error-fallback.js';

describe('ErrorFallback', () => {
  it('renders the title and detail inside an alert region', () => {
    render(<ErrorFallback title="Something went wrong" detail="boom" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('boom');
  });

  it('omits the retry button when no handler is given', () => {
    render(<ErrorFallback title="Something went wrong" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('invokes onRetry when the retry button is pressed', async () => {
    const onRetry = vi.fn();
    render(<ErrorFallback title="Something went wrong" onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('RouteErrorComponent', () => {
  it('degrades a route render throw to a readable message with the error detail', () => {
    const reset = vi.fn();
    render(<RouteErrorComponent error={new Error('kaboom')} reset={reset} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('kaboom');
  });

  it('wires the router reset to the retry button', async () => {
    const reset = vi.fn();
    render(<RouteErrorComponent error={new Error('kaboom')} reset={reset} />);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('NotFoundFallback', () => {
  it('renders a readable not-found message', () => {
    render(<NotFoundFallback />);

    expect(screen.getByRole('alert')).toHaveTextContent(/not found/i);
  });
});
