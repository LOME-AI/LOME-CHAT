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
 * Compile-time constraint for `captureError`'s errorCode: a literal in code
 * shape, never free text. Two rejections compose:
 *  - dynamic `string`-typed values collapse to `never` (the `LiteralMsg`
 *    mechanism — runtime strings are the content-leak vector);
 *  - literals containing whitespace or a colon collapse to `never` (prose
 *    and `Error: message` header echoes are not codes; codes group Sentry
 *    fingerprints and must stay stable, finite identifiers).
 *
 * Shares `LiteralMsg`'s known gap: a mixed template (`` `code_${x}` ``)
 * infers a template-pattern type and passes the type check. The division of
 * labor: this type rejects dynamic `string`-typed values (variables,
 * concatenation, whole-string interpolations) at compile time; the
 * `redaction/logger-msg-literal` rule rejects interpolated-template syntax
 * at `captureError`'s errorCode argument, closing the mixed-template form.
 */
export type LiteralErrorCode<Code extends string> = string extends Code
  ? never
  : Code extends `${string}${' ' | '\t' | '\n' | ':'}${string}`
    ? never
    : Code;

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
 * console/Workers Logs, Sentry, and Workers Analytics Engine adapters each
 * carry one channel). All methods return void and never throw;
 * implementations contain every internal failure.
 *
 * `captureError` feeds the error-capture adapters: it takes the Error
 * object (stack/grouping) plus the errorCode used in fingerprints — never
 * content (`LiteralErrorCode` rejects dynamic strings and free text at
 * compile time). Implementations must scrub before anything leaves the
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
  /** Every metric names its watcher — auditor, dashboard, or alert — or
   * doesn't ship. */
  emitMetric<Name extends string, F extends SafeLogFields>(
    name: LiteralMsg<Name>,
    value: number,
    dimensions?: ExactSafeLogFields<F>
  ): void;
  captureError<Code extends string>(error: Error, errorCode: LiteralErrorCode<Code>): void;
}
