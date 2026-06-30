import {
  ExponentialBackoff,
  TaskCancelledError,
  TimeoutStrategy,
  handleAll,
  retry,
  timeout,
  wrap,
} from 'cockatiel';
import { ResultAsync } from '../result/index.js';
import { isDomainError, timeoutError, unavailableError } from '../errors/index.js';
import type { IPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel';
import type { DomainError } from '../errors/index.js';

/**
 * The policy factory is the single seam to cockatiel: nothing else may import
 * it (enforced by lint). Retry and timeout only — circuit breakers are banned
 * because breaker state in ephemeral isolate memory never accumulates
 * meaningful failure counts (a deliberate limit recorded in ARCHITECTURE.md).
 */

export interface RetryOptions {
  /** Retry attempts after the initial one; the task runs at most maxRetries + 1 times. */
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  /** Upper bound on every backoff delay, jitter included. */
  readonly maxDelayMs: number;
}

export interface TimeoutOptions {
  readonly timeoutMs: number;
}

export interface PolicyRunner {
  run<T>(task: (signal: AbortSignal) => Promise<T>): ResultAsync<T, DomainError>;
}

function toDomainError(cause: unknown): DomainError {
  if (isDomainError(cause)) return cause;
  if (cause instanceof TaskCancelledError) return timeoutError('operation timed out', cause);
  return unavailableError('operation failed', cause);
}

function runnerFor(policy: IPolicy): PolicyRunner {
  return {
    run: <T>(task: (signal: AbortSignal) => Promise<T>): ResultAsync<T, DomainError> =>
      ResultAsync.fromPromise(
        policy.execute(({ signal }) => task(signal)),
        toDomainError
      ),
  };
}

function buildRetry(options: RetryOptions): RetryPolicy {
  return retry(handleAll, {
    maxAttempts: options.maxRetries,
    backoff: new ExponentialBackoff({
      initialDelay: options.initialDelayMs,
      maxDelay: options.maxDelayMs,
    }),
  });
}

function buildTimeout(options: TimeoutOptions): TimeoutPolicy {
  // Aggressive: the run settles at the deadline even if the task never does;
  // the task's signal is aborted for cooperative cancellation.
  return timeout(options.timeoutMs, TimeoutStrategy.Aggressive);
}

export function retryPolicy(options: RetryOptions): PolicyRunner {
  return runnerFor(buildRetry(options));
}

export function timeoutPolicy(options: TimeoutOptions): PolicyRunner {
  return runnerFor(buildTimeout(options));
}

/** Retry with a per-attempt timeout (timeout inside, retry outside). */
export function retryWithTimeoutPolicy(options: RetryOptions & TimeoutOptions): PolicyRunner {
  return runnerFor(wrap(buildRetry(options), buildTimeout(options)));
}
