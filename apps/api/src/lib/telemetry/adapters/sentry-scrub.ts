import { httpStatusCode, sanitizeErrorName, stackFrameLines } from '../error-scrub.js';
import type { ErrorEvent, EventHint, Exception, StackFrame } from '@sentry/cloudflare';

/**
 * The Sentry `beforeSend` scrub: the last gate before an event leaves the
 * process (structural cause-chain scrubbing lives at the Telemetry port).
 * It rebuilds the event from an allowlist instead of deleting known-bad
 * fields, so anything the SDK or a future integration adds is dropped by
 * default: request bodies, headers, cookies, user, breadcrumbs, extra,
 * contexts, transaction, server_name, and the SDK's own exception parse
 * (whose `value` carries the raw error message) all die here.
 *
 * Exception values are re-derived from `hint.originalException`, walking the
 * `cause` chain, through the single-sourced error-scrub helpers shared with
 * the console adapter: error NAMES pass only when identifier-shaped, MESSAGES
 * are dropped wholesale (driver errors embed query parameters), and stack
 * text keeps only call-site frames after stripping the derived
 * `name: message` header — a stack whose header cannot be derived is dropped
 * wholesale (fail closed).
 */

/** Mirrors the SDK's linked-errors default: the reported error plus at most
 * four causes. */
const MAX_CHAIN_LENGTH = 5;

function parseLocation(
  location: string
): Pick<StackFrame, 'filename' | 'lineno' | 'colno'> | undefined {
  const parsed = /^(.*):(\d+):(\d+)$/.exec(location);
  if (!parsed?.[1] || !parsed[2] || !parsed[3]) {
    return undefined;
  }
  return { filename: parsed[1], lineno: Number(parsed[2]), colno: Number(parsed[3]) };
}

/**
 * One V8 frame line → a structured Sentry frame. Lines that fit no known
 * shape are dropped (fail closed): only runtime-derived code locations may
 * travel.
 */
function parseFrameLine(line: string): StackFrame | undefined {
  const at = /^\s+at\s+(.*)$/.exec(line);
  if (!at?.[1]) {
    return undefined;
  }
  const callSite = /^(.*)\s\((.*)\)$/.exec(at[1]);
  const location = parseLocation(callSite?.[2] ?? at[1]);
  if (location === undefined) {
    return undefined;
  }
  const functionName = callSite?.[1];
  return {
    ...(functionName === undefined ? {} : { function: functionName }),
    ...location,
    in_app: true,
  };
}

function safeException(error: Error): Exception {
  // Sentry's frame order is oldest call first, crash site last — the reverse
  // of V8's stack text.
  const frames = stackFrameLines(error)
    .map((line) => parseFrameLine(line))
    .filter((frame): frame is StackFrame => frame !== undefined)
    .toReversed();
  return {
    type: sanitizeErrorName(error.name),
    ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
  };
}

function errorChain(originalException: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = originalException;
  while (current instanceof Error && chain.length < MAX_CHAIN_LENGTH) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function safeExceptionValues(originalException: unknown): Exception[] {
  // Deepest cause first, reported error last — the SDK's linked-errors order.
  return errorChain(originalException)
    .toReversed()
    .map((error) => safeException(error));
}

/**
 * The HTTP status closest to the reported error — provider failures carry it on
 * the reported `APICallError` or a shallow cause. Only the integer travels
 * (see `httpStatusCode`); message, url, and body stay dropped.
 */
function firstHttpStatusCode(originalException: unknown): number | undefined {
  for (const error of errorChain(originalException)) {
    const status = httpStatusCode(error);
    if (status !== undefined) {
      return status;
    }
  }
  return undefined;
}

/** The opaque envelope fields that survive: SDK- or config-derived, never
 * content-capable. */
function keptEnvelopeFields(event: ErrorEvent): Partial<ErrorEvent> {
  return {
    ...(event.event_id === undefined ? {} : { event_id: event.event_id }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.platform === undefined ? {} : { platform: event.platform }),
    ...(event.level === undefined ? {} : { level: event.level }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(event.release === undefined ? {} : { release: event.release }),
  };
}

export function scrubSentryEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
  try {
    const taggedCode = event.tags?.['errorCode'];
    const errorCode = typeof taggedCode === 'string' ? taggedCode : 'unknown';
    const statusCode = firstHttpStatusCode(hint?.originalException);
    return {
      type: undefined,
      ...keptEnvelopeFields(event),
      exception: { values: safeExceptionValues(hint?.originalException) },
      tags: { errorCode, ...(statusCode === undefined ? {} : { statusCode }) },
      // '{{ default }}' keeps Sentry's stack-based grouping; errorCode splits
      // groups per logical failure (stack-only grouping merges distinct
      // failures that share a call path).
      fingerprint: ['{{ default }}', errorCode],
    };
    // eslint-disable-next-line catch-swallow/no-silent-catch -- fail closed: an event that cannot be scrubbed is dropped (null), never emitted.
  } catch {
    // Fail closed: an event that cannot be scrubbed never leaves the process.
    return null;
  }
}
