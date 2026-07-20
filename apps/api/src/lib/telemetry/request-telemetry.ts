import { createSentryTelemetry } from './adapters/sentry-adapter.js';
import { createConsoleTelemetry } from './console-adapter.js';
import { createTelemetryFanOut } from './fan-out.js';
import type { Bindings } from '../context/index.js';
import type { SentryTransportFactory } from './adapters/sentry-adapter.js';
import type { ConsoleSink } from './console-adapter.js';
import type { Telemetry } from './port.js';

const SINK_NAMES = ['console', 'sentry'] as const;
type SinkName = (typeof SINK_NAMES)[number];

/**
 * The slice of the canonical Worker `Bindings` the telemetry composition
 * reads — derived, never redeclared (`lib/context/app-env.ts` owns the
 * declarations). Which sinks compose is a per-mode env-registry value, never
 * a code branch on the runtime mode — dev/test modes declare `console`,
 * production declares every bound sink.
 */
export type TelemetryEnv = Pick<Bindings, 'TELEMETRY_SINKS' | 'SENTRY_DSN'>;

export interface RequestTelemetryOptions {
  /** Forwarded to the Sentry adapter; the pipeline passes `ctx.waitUntil`. */
  scheduleFlush?: ((task: Promise<unknown>) => void) | undefined;
  /** Console sink override for tests; production uses the global console. */
  consoleSink?: ConsoleSink | undefined;
  /** Transport override for tests; production uses the fetch transport. */
  sentryTransport?: SentryTransportFactory | undefined;
}

function isSinkName(token: string): token is SinkName {
  return (SINK_NAMES as readonly string[]).includes(token);
}

function parseSinkList(raw: string | undefined): SinkName[] {
  if (raw === undefined || raw === '') {
    throw new Error(
      'TELEMETRY_SINKS is missing: every mode declares its sink list in the env registry — ' +
        'there is no default. Set it in wrangler config / .dev.vars.'
    );
  }
  const parsed: SinkName[] = [];
  for (const token of raw.split(',').map((entry) => entry.trim())) {
    if (!isSinkName(token)) {
      throw new Error(
        `TELEMETRY_SINKS contains an unknown sink '${token}' (known: ${SINK_NAMES.join(', ')}).`
      );
    }
    if (parsed.includes(token)) {
      throw new Error(`TELEMETRY_SINKS lists '${token}' more than once.`);
    }
    parsed.push(token);
  }
  return parsed;
}

function createSentrySink(env: TelemetryEnv, options: RequestTelemetryOptions): Telemetry {
  if (env.SENTRY_DSN === undefined || env.SENTRY_DSN === '') {
    throw new Error(
      'TELEMETRY_SINKS requests the sentry sink but SENTRY_DSN is missing or empty. ' +
        'Set the SENTRY_DSN secret, or remove the sink from the mode in the env registry.'
    );
  }
  return createSentryTelemetry({
    dsn: env.SENTRY_DSN,
    transport: options.sentryTransport,
    scheduleFlush: options.scheduleFlush,
  });
}

/**
 * Builds the per-request Telemetry implementation from the TELEMETRY_SINKS
 * registry value: a fan-out over the listed adapters in list order. Sink
 * misconfiguration fails fast (missing list, unknown token, sentry without a
 * DSN).
 */
export function createRequestTelemetry(
  env: TelemetryEnv,
  options: RequestTelemetryOptions = {}
): Telemetry {
  const sinks: Telemetry[] = [];
  for (const name of parseSinkList(env.TELEMETRY_SINKS)) {
    if (name === 'console') {
      sinks.push(createConsoleTelemetry(options.consoleSink));
    } else {
      sinks.push(createSentrySink(env, options));
    }
  }
  return createTelemetryFanOut(sinks);
}
