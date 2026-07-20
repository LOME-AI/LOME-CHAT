import type { FingerprintCode } from './fingerprint-codes.js';
import type { ExactSafeLogFields, SafeLogFields } from './safe-log-fields.js';

/**
 * Compile-time literal constraint for log messages and metric names. A value
 * typed plain `string` (variables, concatenation, function results) infers
 * `Msg = string`, collapses to `never`, and fails to compile.
 *
 * Known gap, closed by lint: template literals with expressions infer
 * template-pattern types (`` `user ${string}` ``), which are NOT `string` and
 * pass this check. The `redaction/logger-msg-literal` ESLint rule rejects
 * any non-literal first argument at logger call sites syntactically, so the
 * two mechanisms together cover both vectors:
 *  - type level: dynamic string VALUES, everywhere the code typechecks;
 *  - lint level: template interpolation and any other non-literal SYNTAX.
 */
export type LiteralMsg<Msg extends string> = string extends Msg ? never : Msg;

/**
 * The Telemetry port's error channel. `never` is uninhabited: a telemetry
 * call cannot produce an error value, and implementations must contain every
 * internal failure (best-effort doctrine: telemetry never blocks or
 * fails a request). An adapter that lets an exception escape violates the
 * port contract.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- the alias IS the contract: an exported public-surface type documenting that the port's error channel is deliberately uninhabited; nothing in the codebase needs it by name
export type TelemetryErrorChannel = never;

/**
 * Best-effort observability port (an infra edge that genuinely varies — the
 * console/Workers Logs and Sentry adapters each carry one channel). All
 * methods return void and never throw; implementations contain every internal
 * failure.
 *
 * `captureError` feeds the error-capture adapters: it takes the Error
 * object (stack/grouping) plus the errorCode used in fingerprints — never
 * content. The code is a `FingerprintCode`, a member of the central
 * `FINGERPRINT_CODES` registry, so an unregistered or misspelled code (and any
 * dynamic string or free text, none of which are registry members) fails to
 * compile. Implementations must scrub before anything leaves the
 * process;
 * they must not serialize `error.message` or cause chains verbatim (driver
 * errors embed query parameters in nested causes).
 */
export interface Telemetry {
  debug<Msg extends string, F extends SafeLogFields>(
    msg: LiteralMsg<Msg>,
    fields?: ExactSafeLogFields<F>
  ): void;
  info<Msg extends string, F extends SafeLogFields>(
    msg: LiteralMsg<Msg>,
    fields?: ExactSafeLogFields<F>
  ): void;
  warn<Msg extends string, F extends SafeLogFields>(
    msg: LiteralMsg<Msg>,
    fields?: ExactSafeLogFields<F>
  ): void;
  error<Msg extends string, F extends SafeLogFields>(
    msg: LiteralMsg<Msg>,
    fields?: ExactSafeLogFields<F>
  ): void;
  /** A numeric observation written as a structured Workers-Log line (the
   * console adapter's metric shape); Sentry ignores it. */
  emitMetric<Name extends string, F extends SafeLogFields>(
    name: LiteralMsg<Name>,
    value: number,
    dimensions?: ExactSafeLogFields<F>
  ): void;
  captureError(error: Error, errorCode: FingerprintCode): void;
}
