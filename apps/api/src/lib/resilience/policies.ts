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

type Cockatiel = typeof import('cockatiel');

// Lazy import: cockatiel constructs AbortControllers at module scope, which
// workerd forbids at global eval — a static import breaks `wrangler dev` boot.
// Loaded on first policy execution (inside a request context) and memoized.
let cockatiel: Cockatiel | undefined;

async function loadCockatiel(): Promise<Cockatiel> {
  cockatiel ??= await import('cockatiel');
  return cockatiel;
}

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
  // `cockatiel` is set before any policy can produce a TaskCancelledError;
  // it is only undefined here when the lazy load itself failed.
  if (cockatiel !== undefined && cause instanceof cockatiel.TaskCancelledError) {
    return timeoutError('operation timed out', cause);
  }
  return unavailableError('operation failed', cause);
}

function runnerFor(build: (cockatielModule: Cockatiel) => IPolicy): PolicyRunner {
  let policy: Promise<IPolicy> | undefined;
  const buildPolicy = async (): Promise<IPolicy> => build(await loadCockatiel());
  return {
    run: <T>(task: (signal: AbortSignal) => Promise<T>): ResultAsync<T, DomainError> => {
      policy ??= buildPolicy();
      const pending = policy;
      return ResultAsync.fromPromise(
        (async (): Promise<T> => {
          const builtPolicy = await pending;
          return await builtPolicy.execute(({ signal }) => task(signal));
        })(),
        toDomainError
      );
    },
  };
}

function buildRetry(cockatielModule: Cockatiel, options: RetryOptions): RetryPolicy {
  return cockatielModule.retry(cockatielModule.handleAll, {
    maxAttempts: options.maxRetries,
    backoff: new cockatielModule.ExponentialBackoff({
      initialDelay: options.initialDelayMs,
      maxDelay: options.maxDelayMs,
    }),
  });
}

function buildTimeout(cockatielModule: Cockatiel, options: TimeoutOptions): TimeoutPolicy {
  // Aggressive: the run settles at the deadline even if the task never does;
  // the task's signal is aborted for cooperative cancellation.
  return cockatielModule.timeout(options.timeoutMs, cockatielModule.TimeoutStrategy.Aggressive);
}

export function retryPolicy(options: RetryOptions): PolicyRunner {
  return runnerFor((cockatielModule) => buildRetry(cockatielModule, options));
}

export function timeoutPolicy(options: TimeoutOptions): PolicyRunner {
  return runnerFor((cockatielModule) => buildTimeout(cockatielModule, options));
}

/** Retry with a per-attempt timeout (timeout inside, retry outside). */
export function retryWithTimeoutPolicy(options: RetryOptions & TimeoutOptions): PolicyRunner {
  return runnerFor((cockatielModule) =>
    cockatielModule.wrap(
      buildRetry(cockatielModule, options),
      buildTimeout(cockatielModule, options)
    )
  );
}
