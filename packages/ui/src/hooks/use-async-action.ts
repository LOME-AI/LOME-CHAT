import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { legacyFriendlyErrorMessage, type LegacyErrorCode } from '@hushbox/shared';
import { useAsyncActivityStore } from '../stores/async-activity-store';

export interface UseAsyncActionOptions {
  /**
   * Where the friendly error message goes when the wrapped action throws.
   * - `'throw'` (default): set local `error` state. Use when there is a UI
   *   surface attached to the hook instance (e.g. an `ActionModal` that
   *   renders the inline error region from `error` + `errorKey`).
   * - `'toast'`: call `toast.error(friendly)` and leave local `error` null.
   *   Use when there is no modal/inline surface to attach to (e.g. a
   *   select-on-change action that lives in a sidebar).
   */
  fallback?: 'throw' | 'toast';
}

/** Discriminated result of `run()`. Lets the caller distinguish success-with-
 *  undefined-return from caught failure (a check on `T | undefined` cannot). */
export type AsyncActionResult<T> = { ok: true; value: T } | { ok: false };

export interface UseAsyncActionReturn {
  /** True while a `run()` call is awaiting its action. */
  isPending: boolean;
  /** Friendly error message after the most recent failure, or null. */
  error: string | null;
  /**
   * Bumped on every new error so consumers can re-key animations. Without the
   * bump, two consecutive identical errors would not retrigger CSS keyframe
   * animations attached to the error element.
   */
  errorKey: number;
  /**
   * Run an async action with managed loading + error state. Resolves with a
   * discriminated result — never rejects. Use `result.ok` to branch. On
   * `ok: true`, `value` is the action's return value (may itself be undefined
   * if the action returned undefined).
   */
  run: <T>(action: () => Promise<T>) => Promise<AsyncActionResult<T>>;
  /** Clear the inline error (called by ActionModal on user input). */
  clearError: () => void;
  /**
   * Force the error state without executing an action. Drives the dev
   * failure-simulator buttons — exercises the exact same surface path as a
   * real server-returned failure.
   */
  simulateFailure: (code: LegacyErrorCode | (string & {})) => void;
  /**
   * Set the inline error directly with a pre-localized, user-facing string,
   * bypassing `legacyFriendlyErrorMessage`. Use only when bridging legacy callbacks
   * that already return a finished user-facing message (e.g. the old
   * `{ success: false, error: 'Current password is incorrect' }` shape).
   * New code should throw an `LegacyErrorCode` and let the hook translate.
   */
  setError: (message: string) => void;
}

/**
 * Throw this from a `run()` action when you already have a user-facing
 * message (e.g. bridging a legacy `{ success: false, error: 'Current
 * password is incorrect' }` callback). The hook uses `message` directly
 * without routing through `legacyFriendlyErrorMessage` — that path is for raw
 * LegacyErrorCode strings only.
 */
export class UserMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserMessageError';
  }
}

// Extract a code-like string from an arbitrary thrown error. `ApiError` (from
// apps/web/src/lib/api.ts) stores the API error code in `.message`, so this
// covers the load-bearing case. Unknown shapes fall through to 'INTERNAL'
// which `legacyFriendlyErrorMessage` already routes to the generic fallback.
function extractErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const m = error.message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return 'INTERNAL';
}

export function useAsyncAction(options?: UseAsyncActionOptions): UseAsyncActionReturn {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const fallback = options?.fallback ?? 'throw';

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const surfaceError = useCallback(
    (message: string): void => {
      if (fallback === 'toast') {
        toast.error(message);
        setError(null);
      } else {
        setError(message);
      }
      setErrorKey((k) => k + 1);
    },
    [fallback]
  );

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<AsyncActionResult<T>> => {
      setIsPending(true);
      setError(null);
      useAsyncActivityStore.getState().begin();
      try {
        const value = await action();
        return { ok: true, value };
      } catch (error_: unknown) {
        // UserMessageError carries a pre-localized message; use it verbatim.
        // Anything else goes through legacyFriendlyErrorMessage as an LegacyErrorCode.
        if (error_ instanceof UserMessageError) {
          surfaceError(error_.message);
        } else {
          const code = extractErrorCode(error_);
          surfaceError(legacyFriendlyErrorMessage(code));
        }
        return { ok: false };
      } finally {
        useAsyncActivityStore.getState().end();
        setIsPending(false);
      }
    },
    [surfaceError]
  );

  const simulateFailure = useCallback(
    (code: LegacyErrorCode | (string & {})): void => {
      surfaceError(legacyFriendlyErrorMessage(code));
    },
    [surfaceError]
  );

  const setErrorDirect = useCallback(
    (message: string): void => {
      surfaceError(message);
    },
    [surfaceError]
  );

  return {
    isPending,
    error,
    errorKey,
    run,
    clearError,
    simulateFailure,
    setError: setErrorDirect,
  };
}
