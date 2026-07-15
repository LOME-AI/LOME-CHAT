/**
 * Content-safe derivations from Error objects, shared by every adapter that
 * reports errors off-process (the console adapter's stack field and the
 * Sentry scrub's rebuilt exception chain). The discipline is single-sourced
 * here so the channels cannot drift: error MESSAGES are dropped wholesale
 * (driver errors embed query parameters), NAMES pass only when
 * identifier-shaped, stack text keeps only call-site frames, and only a
 * finite numeric HTTP status escapes off an error's status field.
 */

/** Error names pass through only when identifier-shaped; anything else falls
 * back to 'Error' — a name is caller-controlled and can carry content. */
export function sanitizeErrorName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : 'Error';
}

/**
 * Frame-only stack lines. Drops the V8 header (`<name>: <message>`) by exact
 * derived length BEFORE frame filtering: a multi-line message can itself
 * contain frame-shaped lines, so pattern-matching a string that still
 * contains the message would leak it. A stack that does not start with the
 * derived header is dropped wholesale (fail closed) — there is no safe way
 * to locate the message inside it.
 */
export function stackFrameLines(error: Error): string[] {
  const stack = error.stack ?? '';
  const header = error.message === '' ? error.name : `${error.name}: ${error.message}`;
  if (!stack.startsWith(header)) {
    return [];
  }
  return stack
    .slice(header.length)
    .split('\n')
    .filter((line) => /^\s+at /.test(line));
}

/**
 * The numeric HTTP status an error carries (provider-failure diagnosis: a
 * charge that fell over on a 429 vs a 500 is a different operational story).
 * Only a finite number from a `statusCode` or `status` property travels —
 * never the surrounding message, url, or body. A non-numeric value on those
 * keys is a content vector and is dropped, so nothing but the integer status
 * can escape here.
 */
export function httpStatusCode(error: Error): number | undefined {
  const candidate = error as unknown as Record<string, unknown>;
  for (const key of ['statusCode', 'status'] as const) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}
