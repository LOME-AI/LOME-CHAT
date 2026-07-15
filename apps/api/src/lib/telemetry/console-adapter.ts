import { sanitizeErrorName, stackFrameLines } from './error-scrub.js';
import { pickSafeLogFields } from './safe-log-fields.js';
import type { Telemetry } from './port.js';
import type { SafeLogFields } from './safe-log-fields.js';

/**
 * The level-aware emission seam. Defaults to the global console, whose JSON
 * lines Workers Logs ingests natively as structured fields; injectable so
 * tests can record or sabotage emission.
 */
export interface ConsoleSink {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

type LogLevel = keyof ConsoleSink;

/**
 * Console/Workers-Logs adapter for the Telemetry port. Best-effort by
 * contract: every emission is guarded, so a sink or serialization failure is
 * swallowed (one attempt, no fallback channel — there is nowhere safer to
 * report a telemetry failure than not at all).
 *
 * This file is the single allowed `console` caller in backend code (the
 * redaction lint exempts it by filename); everything else logs through the
 * port.
 */
export function createConsoleTelemetry(sink: ConsoleSink = console): Telemetry {
  // Payload construction runs inside the guard via the thunk: field objects
  // and Error properties are caller-controlled and can throw from getters,
  // and the port's error channel is `never` (telemetry must not block or
  // fail the request it observes).
  const emit = (level: LogLevel, buildPayload: () => Record<string, unknown>): void => {
    try {
      sink[level](JSON.stringify({ level, ...buildPayload() }));
      // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: one attempt, no fallback channel.
    } catch {
      // Best-effort port: one attempt, no fallback channel — there is nowhere
      // safer to report a telemetry failure than not at all.
    }
  };

  const logAt =
    (level: LogLevel) =>
    (msg: string, fields?: SafeLogFields): void => {
      emit(level, () => ({ msg, ...pickSafeLogFields(fields ?? {}) }));
    };

  return {
    debug: logAt('debug'),
    info: logAt('info'),
    warn: logAt('warn'),
    error: logAt('error'),
    emitMetric(name: string, value: number, dimensions?: SafeLogFields): void {
      emit('info', () => {
        // Typed as number, but runtime callers arriving through casts can put
        // anything here — non-finite and non-number values are dropped like
        // any other scrub failure (the line still records the occurrence).
        const raw: unknown = value;
        const guarded = typeof raw === 'number' && Number.isFinite(raw) ? { value: raw } : {};
        return { msg: 'metric', metric: name, ...guarded, ...pickSafeLogFields(dimensions ?? {}) };
      });
    },
    captureError(error: Error, errorCode: string): void {
      emit('error', () => ({
        msg: 'error.captured',
        errorCode,
        errorName: sanitizeErrorName(error.name),
        stack: stackFrameLines(error).join('\n'),
      }));
    },
  };
}
