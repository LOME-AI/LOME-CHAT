import { describe, it, expect } from 'vitest';
import { extractRelevantSlice, MARKER_PREFIX } from './extract-mobile-api-log.js';

const RUN_ID = 'abc12345';
const OTHER_RUN_ID = 'def67890';

function startMarker(runId: string, iso = '2026-05-26T03:18:00.000Z'): string {
  return `${MARKER_PREFIX} ${runId} START ${iso} =====`;
}

function endMarker(runId: string, iso = '2026-05-26T03:21:43.000Z'): string {
  return `${MARKER_PREFIX} ${runId} END ${iso} =====`;
}

// The structured request-log line the API middleware emits through the console
// adapter (one JSON object per stdout line). `route` is the discriminator the
// assertions key on, standing in for the old text line's path token.
function reqLine(route = '/api/auth/login/init', status = 200): string {
  return JSON.stringify({
    level: 'info',
    msg: 'request completed',
    method: 'POST',
    route,
    statusCode: status,
    latencyMs: 117,
  });
}

describe('extractRelevantSlice', () => {
  it('returns empty string when no START marker for runId is present', () => {
    const raw = [reqLine(), '[wrangler:info] Ready'].join('\n');
    expect(extractRelevantSlice({ rawLog: raw, runId: RUN_ID })).toBe('');
  });

  it('slices from START to END for the matching runId', () => {
    const raw = [
      '[wrangler:info] Ready',
      reqLine('/before'),
      startMarker(RUN_ID),
      reqLine('/during'),
      endMarker(RUN_ID),
      reqLine('/after'),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain('/during');
    expect(slice).not.toContain('/before');
    expect(slice).not.toContain('/after');
    expect(slice).toContain(startMarker(RUN_ID));
    expect(slice).toContain(endMarker(RUN_ID));
  });

  it('slices from START to EOF when END marker is missing (crash mid-run)', () => {
    const raw = [
      startMarker(RUN_ID),
      reqLine('/during'),
      '[wrangler:error] something blew up',
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain('/during');
    // The window still extends to EOF; the request-log line inside it survives.
    expect(slice).toContain(startMarker(RUN_ID));
  });

  it('keeps every request-log line in the window (no per-version filtering)', () => {
    const raw = [
      startMarker(RUN_ID),
      reqLine('/mine'),
      reqLine('/also-mine'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain('/mine');
    expect(slice).toContain('/also-mine');
  });

  it('drops non-request, non-marker noise (wrangler banners, errors, stack traces)', () => {
    const raw = [
      startMarker(RUN_ID),
      '[wrangler:info] Ready on http://localhost:8915',
      '[wrangler:error] TypeError: cannot read property of undefined',
      '    at someFunction (file.ts:42:10)',
      JSON.stringify({ level: 'info', msg: 'metric', metric: 'x', value: 1 }),
      reqLine('/mine'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain('/mine');
    expect(slice).not.toContain('[wrangler:info]');
    expect(slice).not.toContain('[wrangler:error]');
    expect(slice).not.toContain('at someFunction');
    expect(slice).not.toContain('"msg":"metric"');
  });

  it('keeps the run START/END markers in the output', () => {
    const raw = [startMarker(RUN_ID), reqLine('/mine'), endMarker(RUN_ID)].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain(startMarker(RUN_ID));
    expect(slice).toContain(endMarker(RUN_ID));
  });

  it('ignores markers belonging to a different runId', () => {
    const raw = [
      startMarker(OTHER_RUN_ID),
      reqLine('/not-mine'),
      endMarker(OTHER_RUN_ID),
      startMarker(RUN_ID),
      reqLine('/mine'),
      endMarker(RUN_ID),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain('/mine');
    expect(slice).not.toContain('/not-mine');
    expect(slice).not.toContain(startMarker(OTHER_RUN_ID));
  });

  it('uses the latest START when the same runId appears multiple times', () => {
    const raw = [
      startMarker(RUN_ID, '2026-05-26T01:00:00.000Z'),
      reqLine('/earlier'),
      endMarker(RUN_ID, '2026-05-26T01:05:00.000Z'),
      startMarker(RUN_ID, '2026-05-26T03:00:00.000Z'),
      reqLine('/later'),
      endMarker(RUN_ID, '2026-05-26T03:05:00.000Z'),
    ].join('\n');

    const slice = extractRelevantSlice({
      rawLog: raw,
      runId: RUN_ID,
    });

    expect(slice).toContain('/later');
    expect(slice).not.toContain('/earlier');
  });

  it('handles empty rawLog', () => {
    expect(extractRelevantSlice({ rawLog: '', runId: RUN_ID })).toBe('');
  });
});
