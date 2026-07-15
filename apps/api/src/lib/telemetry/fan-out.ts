import type { Telemetry } from './port.js';
import type { SafeLogFields } from './safe-log-fields.js';

/**
 * The widened call surface the fan-out addresses sinks through. `Telemetry`'s
 * compile-time-literal constraints protect CALLERS of the port; inside the
 * fan-out every value has already passed them, and re-stating the generic
 * constraints would make forwarding uncompilable. Methods check bivariantly,
 * so `Telemetry` is assignable to this shape.
 */
interface WidenedTelemetry {
  debug(msg: string, fields?: SafeLogFields): void;
  info(msg: string, fields?: SafeLogFields): void;
  warn(msg: string, fields?: SafeLogFields): void;
  error(msg: string, fields?: SafeLogFields): void;
  emitMetric(name: string, value: number, dimensions?: SafeLogFields): void;
  captureError(error: Error, errorCode: string): void;
}

/**
 * Composes Telemetry sinks into one port implementation: every call fans out
 * to every sink in order. Each sink call is individually guarded — the port's
 * error channel is `never`, and a sink that violates its own containment must
 * not silence the remaining sinks or fail the request being observed.
 */
export function createTelemetryFanOut(sinks: readonly Telemetry[]): Telemetry {
  const targets: readonly WidenedTelemetry[] = sinks;
  const fanOut = (call: (sink: WidenedTelemetry) => void): void => {
    for (const target of targets) {
      try {
        call(target);
        // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: isolate each sink; a violating sink must not fail the request.
      } catch {
        // Best-effort port: one attempt per sink, no fallback channel — there
        // is nowhere safer to report a telemetry failure than not at all.
      }
    }
  };

  const logAt =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (msg: string, fields?: SafeLogFields): void => {
      fanOut((sink) => {
        sink[level](msg, fields);
      });
    };

  return {
    debug: logAt('debug'),
    info: logAt('info'),
    warn: logAt('warn'),
    error: logAt('error'),
    emitMetric(name: string, value: number, dimensions?: SafeLogFields): void {
      fanOut((sink) => {
        // eslint-disable-next-line redaction/logger-msg-literal -- port-internal forwarding: the metric name was literal-checked at the originating call site; the fan-out never originates names
        sink.emitMetric(name, value, dimensions);
      });
    },
    captureError(error: Error, errorCode: string): void {
      fanOut((sink) => {
        sink.captureError(error, errorCode);
      });
    },
  };
}
