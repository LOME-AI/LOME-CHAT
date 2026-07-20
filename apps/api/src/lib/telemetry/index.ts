export { createConsoleTelemetry } from './console-adapter.js';
export { FINGERPRINT_CODES } from './fingerprint-codes.js';
export { createTelemetryFanOut } from './fan-out.js';
export { createRequestTelemetry } from './request-telemetry.js';
export { domainErrorFields } from './domain-error-fields.js';
export { sanitizeErrorName, stackFrameLines } from './error-scrub.js';
export { SAFE_LOG_FIELD_KEYS, pickSafeLogFields } from './safe-log-fields.js';
export {
  createSentryTelemetry,
  installProductionConsolePatch,
  scrubSentryEvent,
  sentryClientOptions,
} from './adapters/index.js';
export type { ConsoleSink } from './console-adapter.js';
export type { RequestTelemetryOptions, TelemetryEnv } from './request-telemetry.js';
export type { FingerprintCode } from './fingerprint-codes.js';
export type { LiteralMsg, Telemetry, TelemetryErrorChannel } from './port.js';
export type { ExactSafeLogFields, SafeLogFieldKey, SafeLogFields } from './safe-log-fields.js';
export type {
  PatchableConsole,
  SentryClientOptions,
  SentryTelemetryOptions,
  SentryTransportFactory,
} from './adapters/index.js';
