import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { RateLimitedNotice } from './rate-limited-notice.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimitedNotice', () => {
  it('shows the countdown, never a blank page', () => {
    render(<RateLimitedNotice retryAfterSeconds={12} onRetry={() => {}} />);

    const notice = screen.getByTestId(TEST_IDS.adminRateLimited);
    expect(notice).toHaveTextContent('Rate limited');
    expect(notice).toHaveTextContent('12s');
  });

  it('counts down each second and retries at zero, once', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<RateLimitedNotice retryAfterSeconds={2} onRetry={onRetry} />);

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
    render(<RateLimitedNotice retryAfterSeconds={30} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('restarts the countdown when the server hint changes', () => {
    vi.useFakeTimers();
    const { rerender } = render(<RateLimitedNotice retryAfterSeconds={5} onRetry={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId(TEST_IDS.adminRateLimited)).toHaveTextContent('4s');

    rerender(<RateLimitedNotice retryAfterSeconds={9} onRetry={() => {}} />);

    expect(screen.getByTestId(TEST_IDS.adminRateLimited)).toHaveTextContent('9s');
  });
});
