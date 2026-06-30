import { createEnvUtilities } from '@hushbox/shared';
import { SAFE_LOG_FIELD_KEYS } from '../safe-log-fields.js';
import type { EnvContext } from '@hushbox/shared';

/** The console surface the patch covers: the output methods dependencies
 * actually call and Workers Logs ingests. Exotic methods (table, dir, group)
 * are deliberately left alone — no dependency in this tree uses them, and
 * each addition widens the surface this module must keep content-safe. */
export interface PatchableConsole {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

const PATCHED_METHODS = ['debug', 'info', 'log', 'warn', 'error', 'trace'] as const;

/**
 * The closed key set a console line may carry to pass through: the console
 * adapter's emission envelope (level, msg, metric, value, errorName, stack)
 * plus the SafeLogFields allowlist. Anything else is, by definition, not a
 * line the Telemetry port produced.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'level',
  'msg',
  'metric',
  'value',
  'errorName',
  'stack',
  ...SAFE_LOG_FIELD_KEYS,
]);

const SUPPRESSED_LINE = JSON.stringify({ level: 'warn', msg: 'console.suppressed' });

/** Targets already patched; keyed by object identity so tests with injected
 * fakes never interfere with each other or with the real global. */
const patchedTargets = new WeakSet<PatchableConsole>();

/**
 * A call passes through only as a single string that parses to a flat JSON
 * object whose keys all sit in the envelope and whose values are primitives —
 * the exact shape the telemetry console adapter emits. Everything else is
 * stray output and gets suppressed. A dependency could in principle forge the
 * envelope shape; this module defends against accidental leaks, not against
 * hostile in-process code (which could simply call fetch).
 */
function isEnvelopeObject(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  return Object.entries(parsed).every(
    ([key, value]) =>
      ENVELOPE_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number')
  );
}

function conformantTelemetryLine(args: readonly unknown[]): string | undefined {
  if (args.length !== 1 || typeof args[0] !== 'string') {
    return undefined;
  }
  try {
    return isEnvelopeObject(JSON.parse(args[0])) ? args[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entry-point console patch: in production, stray console output from
 * dependencies would reach Workers Logs around both the Telemetry port and
 * the redaction lint. The patch closes that path — lines the console adapter
 * emitted pass through untouched; everything else is replaced by a fixed
 * marker line on the warn channel, so the occurrence stays observable with
 * zero content.
 *
 * Best-effort by the port's doctrine: installation and every patched call are
 * guarded, so a failure here can never block or fail a request. Outside
 * production the patch is inert — local dev and tests keep the raw console.
 */
export function installProductionConsolePatch(
  env: EnvContext,
  target: PatchableConsole = globalThis.console
): void {
  try {
    if (!createEnvUtilities(env).isProduction || patchedTargets.has(target)) {
      return;
    }
    // Captured before replacement: the suppression marker and pass-through
    // lines must reach the ORIGINAL emitters, not loop through the patch.
    const suppress = target.warn.bind(target);
    for (const method of PATCHED_METHODS) {
      const forward = target[method].bind(target);
      target[method] = (...args: unknown[]): void => {
        try {
          const line = conformantTelemetryLine(args);
          if (line === undefined) {
            suppress(SUPPRESSED_LINE);
          } else {
            forward(line);
          }
        } catch {
          // Best-effort: there is nowhere safer to report a telemetry
          // failure than not at all.
        }
      };
    }
    patchedTargets.add(target);
  } catch {
    // Best-effort: a target that refuses patching (frozen, exotic host
    // object) degrades telemetry hygiene, never the request path.
  }
}
