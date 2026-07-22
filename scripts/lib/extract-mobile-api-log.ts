/**
 * Extracts the slice of a wrangler-dev log that belongs to a specific mobile-test
 * run: the API request activity bracketed by the run's START/END markers.
 *
 * Inputs are the raw log content (already read from disk by the caller) and the
 * runId written into the START/END markers by mobile-test. The result is
 * suitable for writing directly into the maestro-results report.
 *
 * The API request-log middleware now emits one structured JSON line per request
 * (apps/api/src/middleware/request-log.ts) with no app-version field, so the
 * slice can no longer be narrowed to a single APK build the way the old `[req]
 * ... v=<version>` text line allowed. The temporal START/END window is the only
 * per-run isolation; within it the slice keeps the request-log lines (the API
 * activity) plus the run's own markers, dropping wrangler's own banner/error
 * noise, which stays available verbatim in the raw wrangler log.
 */
import { isApiRequestLogLine } from './heartbeat-source.js';

export const MARKER_PREFIX = '===== MOBILE-TEST';

export interface ExtractSliceOptions {
  rawLog: string;
  runId: string;
}

function isStartMarker(line: string, runId: string): boolean {
  return line.startsWith(`${MARKER_PREFIX} ${runId} START `);
}

function isEndMarker(line: string, runId: string): boolean {
  return line.startsWith(`${MARKER_PREFIX} ${runId} END `);
}

/**
 * Selects the lines worth keeping inside the run window: structured request-log
 * lines (the API activity) and the mobile-test START/END markers that delimit
 * the run. Everything else in the window — wrangler banners, errors, stack
 * traces — is dropped from the slice (it remains in the unfiltered raw log).
 */
function keepLine(line: string): boolean {
  return isApiRequestLogLine(line) || line.startsWith(MARKER_PREFIX);
}

export function extractRelevantSlice(options: ExtractSliceOptions): string {
  const lines = options.rawLog.split('\n');

  // Latest START wins — defensive against the unlikely case of runId reuse,
  // and aligns with the "most recent run" mental model when reading by hand.
  let startIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && isStartMarker(line, options.runId)) {
      startIndex = index;
      break;
    }
  }
  if (startIndex === -1) return '';

  let endIndex = lines.length - 1;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line !== undefined && isEndMarker(line, options.runId)) {
      endIndex = index;
      break;
    }
  }

  const slice = lines.slice(startIndex, endIndex + 1);
  return slice.filter((line) => keepLine(line)).join('\n');
}
