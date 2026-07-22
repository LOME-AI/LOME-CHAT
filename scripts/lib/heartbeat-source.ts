/**
 * Heartbeat tick sources, gathered behind one bucketed helper. Used by:
 *
 *   - scripts/wrangler-dev.ts: pipes the API process's stdout through
 *     `createLineObserver` and ticks for each request-log line emitted by
 *     apps/api/src/middleware/request-log.ts. Wrangler running with no
 *     observed requests does NOT tick — only real API activity does.
 *   - scripts/lib/vitest-setup.ts: ticks once per Vitest worker process,
 *     so long test runs keep the stack from being reaped mid-run.
 *   - e2e/global-setup.ts: ticks once per Playwright run start, same reason.
 *
 * The bucket means even a flood of requests turns into at most one fs.utimes
 * call per HEARTBEAT_TICK_BUCKET_MS — cheap regardless of traffic shape.
 */

export const HEARTBEAT_TICK_BUCKET_MS = 5000;

/**
 * The `msg` value the request-log middleware stamps on every per-request line
 * (apps/api/src/middleware/request-log.ts). The middleware logs through the
 * typed SafeLogFields logger, whose console adapter emits one JSON object per
 * line (`{"level":...,"msg":...,...fields}` — see
 * apps/api/src/lib/telemetry/console-adapter.ts), so the stable signal for
 * "a request completed" is this exact `msg`, not a legacy `[req]` text prefix.
 *
 * This is a PRODUCER→CONSUMER parse contract, not two implementations of the
 * same logic that must agree: the middleware is the sole producer of the log
 * line, and this dev-stack tooling is a consumer that parses that stdout and
 * keys on its `msg`. The value is duplicated here — not imported from a shared
 * constant — because the producer's `msg` is intentionally an inline literal at
 * its call site (the `redaction/logger-msg-literal` rule requires a syntactic
 * literal so redaction can statically prove no content leaks), so the emitter
 * cannot reference a shared constant. If the producer ever changes this literal
 * it must update this consumer too, or the idle heartbeat and the mobile-test
 * log slice silently stop recognizing traffic.
 */
export const REQUEST_LOG_MSG = 'request completed';

/**
 * True when `line` is one structured request-log line from the API's
 * request-log middleware. Parses the line as JSON (the console adapter's wire
 * shape) and matches the request-completed `msg`; any non-JSON stdout line
 * (wrangler banners, stack traces) or JSON line with a different `msg`
 * (metrics, captured errors) is not a request-log line.
 */
export function isApiRequestLogLine(line: string): boolean {
  const trimmed = line.trim();
  // A JSON object is the only shape the console adapter emits and the only one
  // whose text starts with `{`, so this guard means a successful parse below is
  // always a non-null object — no further shape check is reachable.
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { msg?: unknown };
    return parsed.msg === REQUEST_LOG_MSG;
  } catch {
    // Not JSON — not a request-log line.
    return false;
  }
}

export interface HeartbeatTickerOptions {
  heartbeatPath: string;
  touch: (path: string) => Promise<void>;
  now?: () => number;
}

/**
 * Build a ticker function that the caller invokes on every activity event.
 * Internally bucketed so the underlying `touch` runs at most once per
 * HEARTBEAT_TICK_BUCKET_MS. Errors from `touch` are swallowed — a missing
 * heartbeat tick is not worth crashing the consumer (the next tick recovers).
 */
export function createHeartbeatTicker(options: HeartbeatTickerOptions): () => Promise<void> {
  const now = options.now ?? (() => Date.now());
  let lastTickAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const current = now();
    if (current - lastTickAt < HEARTBEAT_TICK_BUCKET_MS) return;
    lastTickAt = current;
    try {
      await options.touch(options.heartbeatPath);
    } catch {
      // Best-effort — see module docstring.
    }
  };
}
