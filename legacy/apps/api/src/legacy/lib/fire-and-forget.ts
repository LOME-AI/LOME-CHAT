/**
 * Fire-and-forget utility for non-blocking async operations.
 * Logs errors with context without blocking the main execution flow.
 *
 * Use for side effects that shouldn't block the response:
 * - WebSocket broadcast events
 * - Push notifications
 * - Background cleanup tasks
 *
 * When `executionCtx` is provided, registers the promise with `waitUntil()`
 * so the Cloudflare Worker isolate stays alive until the operation completes.
 * This does not block processing — it only prevents premature isolate termination.
 *
 * @param promise - The promise to execute without awaiting
 * @param errorContext - Description of the operation for error logging
 * @param executionCtx - Optional Cloudflare Workers execution context for keep-alive
 */
export function fireAndForget<T>(
  promise: Promise<T>,
  errorContext: string,
  executionCtx?: { waitUntil(p: Promise<unknown>): void }
): void {
  const handled = (async (): Promise<void> => {
    try {
      await promise;
    } catch (error: unknown) {
      console.error(`[fire-and-forget] ${errorContext}:`, error);
    }
  })();

  if (executionCtx) {
    try {
      executionCtx.waitUntil(handled);
    } catch {
      // executionCtx unavailable outside Cloudflare Workers runtime
    }
  }

  void handled;
}
