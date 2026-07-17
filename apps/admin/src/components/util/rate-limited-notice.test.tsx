import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { RateLimitedNotice } from './rate-limited-notice.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimitedNotice', () => {
  it('shows the countdown, never a blank page', () => {
    render(<RateLimitedNotice retryAfterSeconds={12} resetKey={1} onRetry={() => {}} />);

    const notice = screen.getByTestId(TEST_IDS.adminRateLimited);
    expect(notice).toHaveTextContent('Rate limited');
    expect(notice).toHaveTextContent('12s');
  });

  it('counts down each second and retries at zero, once', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<RateLimitedNotice retryAfterSeconds={2} resetKey={1} onRetry={onRetry} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId(TEST_IDS.adminRateLimited)).toHaveTextContent('1s');
    expect(onRetry).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retries immediately from the manual button', () => {
    const onRetry = vi.fn();
    render(<RateLimitedNotice retryAfterSeconds={30} resetKey={1} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('restarts the countdown when the server hint changes', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <RateLimitedNotice retryAfterSeconds={5} resetKey={1} onRetry={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId(TEST_IDS.adminRateLimited)).toHaveTextContent('4s');

    rerender(<RateLimitedNotice retryAfterSeconds={9} resetKey={1} onRetry={() => {}} />);

    expect(screen.getByTestId(TEST_IDS.adminRateLimited)).toHaveTextContent('9s');
  });

  it('restarts the countdown when a retry fails with the same retry-after value', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const { rerender } = render(
      <RateLimitedNotice retryAfterSeconds={1} resetKey={1} onRetry={onRetry} />
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The auto-retry 429s again with an identical hint: only the error
    // identity distinguishes it; the countdown must not stall at 0s.
    rerender(<RateLimitedNotice retryAfterSeconds={1} resetKey={2} onRetry={onRetry} />);
    expect(screen.getByTestId(TEST_IDS.adminRateLimited)).toHaveTextContent('1s');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
