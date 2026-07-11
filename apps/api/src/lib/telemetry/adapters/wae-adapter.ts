import { SAFE_LOG_FIELD_KEYS, pickSafeLogFields } from '../safe-log-fields.js';
import type { Telemetry } from '../port.js';
import type { SafeLogFields } from '../safe-log-fields.js';
import type { WaeDataset } from '../../context/app-env.js';

/** Logs and errors are other adapters' channels; see `createWaeTelemetry`. */
function noop(): void {
  // Deliberately inert.
}

/**
 * Workers Analytics Engine adapter for the Telemetry port: the metrics
 * channel. Logs ride the console adapter (Workers Logs) and errors ride the
 * Sentry adapter, so every method except `emitMetric` is deliberately inert.
 *
 * Data-point mapping (load-bearing for every saved WAE SQL query):
 * - `index1`  = the metric name (the compile-time-literal `name` argument;
 *   also WAE's sampling key).
 * - `double1` = the metric value. Non-finite or non-number values arriving
 *   through casts are dropped — the point is still written so the occurrence
 *   stays countable (the console adapter's posture).
 * - `blobN`   = the dimension at position N-1 of `SAFE_LOG_FIELD_KEYS`,
 *   stringified, or null when absent. Blob positions follow that array's
 *   order, so WAE SQL addresses dimensions positionally (blob1 = requestId,
 *   …); inserting or reordering keys (rather than appending) breaks saved
 *   queries.
 *
 * Doctrine: every metric names its watcher — a read-only cron auditor
 * polling the WAE SQL API, or the admin dashboard — or it doesn't ship. The
 * watcher is the emitting feature's concern, not this adapter's.
 */
export function createWaeTelemetry(dataset: WaeDataset): Telemetry {
  // Best-effort port (error channel `never`): scrub and write both run inside
  // the guard — dimension objects are caller-controlled and can throw from
  // getters, and the binding itself can fail.
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    emitMetric(name: string, value: number, dimensions?: SafeLogFields): void {
      try {
        const raw: unknown = value;
        const doubles = typeof raw === 'number' && Number.isFinite(raw) ? [raw] : [];
        const picked = pickSafeLogFields(dimensions ?? {});
        const blobs = SAFE_LOG_FIELD_KEYS.map((key) =>
          picked[key] === undefined ? null : String(picked[key])
        );
        dataset.writeDataPoint({ indexes: [name], doubles, blobs });
      } catch {
        // Best-effort port: one attempt, no fallback channel — there is
        // nowhere safer to report a telemetry failure than not at all.
      }
    },
    captureError: noop,
  };
}
