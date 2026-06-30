import { timeoutError } from '../errors/index.js';

export interface DisposableSignal {
  readonly signal: AbortSignal;
  /** Detaches timers/listeners. Call when the signal is no longer needed to avoid leaks. */
  dispose: () => void;
}

/**
 * A signal that aborts after `timeoutMs` with a `timeout` DomainError as its
 * reason, so consumers rejecting on abort already carry a taxonomy error.
 */
export function timeoutSignal(timeoutMs: number): DisposableSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(timeoutError(`timed out after ${String(timeoutMs)}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: (): void => {
      clearTimeout(timer);
    },
  };
}

/**
 * Links signals: aborts when the first source aborts, propagating its reason.
 * Hand-rolled instead of AbortSignal.any so listeners on long-lived source
 * signals are removable (dispose) — .any leaks listeners until the source
 * itself is garbage-collected.
 */
export function anySignal(signals: readonly AbortSignal[]): DisposableSignal {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  const dispose = (): void => {
    while (cleanups.length > 0) cleanups.pop()?.();
  };
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      dispose();
      break;
    }
    const onAbort = (): void => {
      controller.abort(source.reason);
      dispose();
    };
    source.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => {
      source.removeEventListener('abort', onAbort);
    });
  }
  return { signal: controller.signal, dispose };
}
