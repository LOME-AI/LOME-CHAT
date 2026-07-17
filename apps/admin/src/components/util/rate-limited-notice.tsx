import * as React from 'react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

interface RateLimitedNoticeProps {
  /** The server's 429 hint (`details.retryAfterSeconds`). */
  readonly retryAfterSeconds: number;
  /**
   * Identity of the failure this notice renders — a query's
   * `errorUpdatedAt` or the error instance itself. Consecutive 429s often
   * carry the same seconds hint, so the countdown reset must key on WHICH
   * failure, not its value, or an auto-retry loop stalls at 0s.
   */
  readonly resetKey: unknown;
  readonly onRetry: () => void;
}

/**
 * The visible 429 state for the rate-limited admin reads: a countdown that
 * auto-retries at zero, plus a manual retry. Never a blank page.
 */
export function RateLimitedNotice({
  retryAfterSeconds,
  resetKey,
  onRetry,
}: RateLimitedNoticeProps): React.JSX.Element {
  const [remaining, setRemaining] = React.useState(retryAfterSeconds);
  const retryRef = React.useRef(onRetry);

  React.useEffect(() => {
    retryRef.current = onRetry;
  }, [onRetry]);

  // A fresh 429 restarts the countdown, keyed on the failure's identity.
  React.useEffect(() => {
    setRemaining(retryAfterSeconds);
  }, [resetKey, retryAfterSeconds]);

  React.useEffect(() => {
    if (remaining <= 0) {
      retryRef.current();
      return;
    }
    const timer = setTimeout(() => {
      setRemaining((current) => current - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [remaining]);

  return (
    <div
      data-testid={TEST_IDS.adminRateLimited}
      role="status"
      className="border-border bg-card flex items-center gap-3 rounded-md border p-3 text-sm"
    >
      <span>
        Rate limited. Retrying in{' '}
        <span className="font-mono tabular-nums">{Math.max(remaining, 0)}s</span>
      </span>
      <Button
        data-testid={TEST_IDS.adminRateLimitedRetry}
        size="sm"
        variant="outline"
        onClick={onRetry}
      >
        Retry now
      </Button>
    </div>
  );
}
