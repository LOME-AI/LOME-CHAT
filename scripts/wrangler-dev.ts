import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { touchHeartbeat } from './lib/idle-killer.js';
import { createHeartbeatTicker, isApiRequestLogLine } from './lib/heartbeat-source.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

export function wranglerLogPath(port: string): string {
  return path.join(REPO_ROOT, 'apps', 'api', `.wrangler-${port}.log`);
}

function teeStreamErrorHandler(label: string): (error: Error) => void {
  /* v8 ignore next 3 -- fires only on a rare tee-stream 'error' event; the wiring is covered, the handler is a defensive logger */
  return (error) => {
    console.warn(`wrangler-dev tee ${label} error: ${error.message}`);
  };
}

/**
 * workerd emits these on the API process's stderr whenever a client drops a
 * connection mid-response — routine under E2E, where Playwright closes pages
 * while chat SSE streams are still in flight. They originate in workerd's C++
 * I/O layer, below the JS `await` point, so the app's own disconnect guards
 * (the SSE writer's connection check, fire-and-forget's catch, the billing
 * `waitUntil(...).catch`) can't intercept them. They are not failures.
 *
 * Matched lines are dropped from the *terminal* only. The raw stderr is still
 * teed verbatim to apps/api/.wrangler-<port>.log, so nothing is hidden — this
 * de-noises the interactive view without losing the record. Patterns are
 * deliberately narrow so a genuine error is never swallowed.
 */
const SUPPRESSED_STDERR_PATTERNS: readonly RegExp[] = [
  // kj socket write to an already-closed peer: "disconnected: ::write(...): Broken pipe".
  /disconnected:.*Broken pipe/,
  // Companion frame of the broken-pipe report: a "stack:" line of raw workerd
  // address frames (each token ends in @<hex>). A real JS stack is "  at ...",
  // never this shape, so it stays visible.
  /^\s*stack:\s+\S+@[0-9a-f]+(?:\s+\S+@[0-9a-f]+)*\s*$/,
  // A pending subrequest canceled when the request context tears down after the
  // client disconnects; surfaced by workerd as an uncaught rejection, no JS stack.
  /Uncaught (?:\(in promise\) )?Error: Network connection lost/,
  // Workerd brackets error blocks with blank lines. With the error message
  // itself suppressed above, those bare blanks would still pass through and
  // surface in Playwright's webServer output as `[API]` prefix with nothing
  // after it (the prefix is added per stderr line regardless of content). A
  // blank stderr line carries no information; the log file retains everything
  // verbatim, so dropping them from the terminal is purely cosmetic de-noising.
  /^\s*$/,
];

export function isSuppressedStderrLine(line: string): boolean {
  return SUPPRESSED_STDERR_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Line-buffering Transform that fires `onLine` for each complete line passing
 * through. Pass-through stream — every chunk reaches downstream unchanged.
 * Used to peek at API stdout for `[req]` request-log lines (each one ticks
 * the heartbeat without blocking the original pipe).
 */
export function createLineObserver(onLine: (line: string) => void): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk: unknown, _encoding, callback): void {
      /* v8 ignore next -- stream is not objectMode, so chunk is always a Buffer */
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      this.push(chunk);
      buffer += text;
      const lines = buffer.split('\n');
      /* v8 ignore next -- split always yields at least one element, so pop never returns undefined */
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
      callback();
    },
    flush(callback): void {
      if (buffer.length > 0) onLine(buffer);
      callback();
    },
  });
}

/**
 * Line-buffering Transform that drops {@link isSuppressedStderrLine} matches.
 * Buffers across chunk boundaries so a line split between two writes is matched
 * as a whole; the trailing partial line (no newline yet) is held until flush.
 */
export function createStderrFilter(): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk: unknown, _encoding, callback): void {
      /* v8 ignore next -- stream is not objectMode, so chunk is always a Buffer */
      buffer += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const lines = buffer.split('\n');
      /* v8 ignore next -- split always yields at least one element, so pop never returns undefined */
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!isSuppressedStderrLine(line)) {
          this.push(`${line}\n`);
        }
      }
      callback();
    },
    flush(callback): void {
      if (buffer.length > 0 && !isSuppressedStderrLine(buffer)) {
        this.push(buffer);
      }
      callback();
    },
  });
}

/**
 * Spawn wrangler dev with stdout/stderr teed to apps/api/.wrangler-<port>.log.
 *
 * Single source of truth for how wrangler dev runs in this repo: port, stdio,
 * log file, and log level all decided here. Callers (apps/api package script,
 * playwright.config.ts, mobile-test, ad-hoc `pnpm dev`) pass no wrangler flags
 * — if anything needs to vary, change it here, not at the callsite.
 *
 * The log file is truncated on every restart — that's the only bound. A
 * long-lived `pnpm dev` session can grow the file without limit; the
 * deliverable to maestro-results is the bounded slice produced by
 * scripts/lib/extract-mobile-api-log.ts, so unbounded raw-log growth is
 * acceptable for a .gitignore'd local artifact.
 *
 * `--log-level error` silences wrangler's per-request INFO lines (which lack
 * headers and would duplicate the per-request log emitted by the request-log
 * middleware in apps/api/src/middleware/request-log.ts).
 */
function heartbeatPathFromEnv(): string | null {
  const slotRaw = process.env['HB_STACK_SLOT'];
  if (slotRaw === undefined) return null;
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptsDir, '..');
  return path.join(repoRoot, 'scripts', '.cache', 'local', slotRaw, 'heartbeat');
}

export async function runWranglerDev(extraArgs: string[]): Promise<number> {
  const port = process.env['HB_API_PORT'];
  if (!port) {
    throw new Error('HB_API_PORT is not set — run pnpm generate:env first');
  }

  const logStream = createWriteStream(wranglerLogPath(port), { flags: 'w' });

  const subprocess = execa(
    'wrangler',
    ['dev', '--port', port, '--log-level', 'error', ...extraArgs],
    { stdio: ['inherit', 'pipe', 'pipe'], reject: false }
  );

  // Heartbeat ticker. Each [req] line from the API request-log middleware
  // (apps/api/src/middleware/request-log.ts) counts as user activity →
  // the slot's heartbeat file gets utimes-touched (bucketed to 1/5s).
  // wrangler being alive but unused does NOT tick — only observed requests do.
  const heartbeatPath = heartbeatPathFromEnv();
  const tickHeartbeat =
    heartbeatPath === null ? null : createHeartbeatTicker({ heartbeatPath, touch: touchHeartbeat });
  const lineObserver = createLineObserver((line) => {
    if (tickHeartbeat && isApiRequestLogLine(line)) {
      void tickHeartbeat();
    }
  });

  // Tee both pipes to the terminal (preserving the interactive UX) and to
  // the log file (preserving content for post-hoc debugging). `end: false`
  // keeps the destination open across both stdout and stderr ends; we close
  // the log stream explicitly in the finally block.
  //
  // stderr reaches the terminal through a filter that drops benign workerd
  // disconnect noise (see SUPPRESSED_STDERR_PATTERNS); the log file still
  // receives the unfiltered stderr, so the record is complete.
  const stderrFilter = createStderrFilter();
  subprocess.stdout.pipe(lineObserver);
  lineObserver.pipe(process.stdout, { end: false });
  lineObserver.pipe(logStream, { end: false });
  stderrFilter.pipe(process.stderr, { end: false });
  subprocess.stderr.pipe(stderrFilter);
  subprocess.stderr.pipe(logStream, { end: false });

  // Defensive: surface stream errors (disk full, EACCES on apps/api/) as a
  // single warn line instead of an unhandled 'error' event that would crash
  // the dev process. The terminal stream stays usable either way.
  logStream.on('error', teeStreamErrorHandler('log'));
  stderrFilter.on('error', teeStreamErrorHandler('stderr-filter'));
  subprocess.stdout.on('error', teeStreamErrorHandler('stdout'));
  subprocess.stderr.on('error', teeStreamErrorHandler('stderr'));

  try {
    const result = await subprocess;
    return typeof result.exitCode === 'number' ? result.exitCode : 1;
  } finally {
    logStream.end();
  }
}

/* v8 ignore start -- CLI entry point exercised via apps/api dev script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runWranglerDev(process.argv.slice(2)));
}
/* v8 ignore stop */
