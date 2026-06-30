/**
 * Telemetry port adapters: Sentry (unexpected errors), Workers Analytics
 * Engine (metrics), and the production console patch. The console adapter —
 * the logs channel — lives one level up as the port's reference
 * implementation.
 *
 * OTel tracing disposition (verified 2026-06-11 against the Cloudflare
 * Workers observability docs): Workers automatic tracing is still open beta —
 * span and attribute names are not finalized, and the export pipeline has no
 * attribute redaction or filtering before OTLP export. The telemetry doctrine
 * makes a redaction processor (allowlist, allow_all_keys: false) mandatory
 * for tracing, because auto-instrumented spans can embed URLs and SQL.
 * Tracing wiring is therefore deliberately absent; Sentry tracing is the
 * documented fallback if tracing is needed before the platform pipeline
 * matures. Re-verify before wiring — beta facts age.
 */
export { createSentryTelemetry, sentryClientOptions } from './sentry-adapter.js';
export { createWaeTelemetry } from './wae-adapter.js';
export { installProductionConsolePatch } from './console-patch.js';
export { scrubSentryEvent } from './sentry-scrub.js';
export type {
  SentryClientOptions,
  SentryTelemetryOptions,
  SentryTransportFactory,
} from './sentry-adapter.js';
export type { PatchableConsole } from './console-patch.js';
