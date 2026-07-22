# T17 / R7 — impl report 1

## Objective
Repoint the dev-stack idle heartbeat matcher to the structured JSON request-log the API now
emits (so live traffic ticks the heartbeat and the local stack isn't reaped under an active
developer), and repair the still-used APK log extractor's filter to the new format.

## Files changed
- `scripts/lib/heartbeat-source.ts` — replaced the dead `/^\[req\]\s/` matcher with a
  structured-JSON matcher: parse the stdout line as JSON and match the request-completed
  `msg`. Added exported `REQUEST_LOG_MSG = 'request completed'` (the stable field), used by
  both consumers. Updated the module docstring.
- `scripts/lib/extract-mobile-api-log.ts` — `keepLine` now selects structured request-log
  lines (via the shared `isApiRequestLogLine`) plus the run's START/END markers, dropping
  other noise; imports `isApiRequestLogLine` from `heartbeat-source.js` (One Implementation,
  Shared). Removed the dead `REQ_LINE_PREFIX`/version-match branch. `ExtractSliceOptions.
  mobileVersion` kept for call-site stability but documented as no longer a filter input.
- `scripts/wrangler-dev.ts` — comment-only: two stale `[req]` references updated to
  "structured request-log line". The wiring (`isApiRequestLogLine(line)` call) is unchanged.
- `scripts/lib/heartbeat-source.test.ts` — rewrote the `isApiRequestLogLine` block for the
  JSON format.
- `scripts/lib/extract-mobile-api-log.test.ts` — rewrote fixtures to JSON request-log lines
  and flipped version-filter assertions to the new select-request-log-lines semantics.

## Stable field matched (report-evidence)
The console adapter emits one JSON object per stdout line
(`apps/api/src/lib/telemetry/console-adapter.ts:37` → `console.info(JSON.stringify({level,msg,
...fields}))`); the request-log middleware calls `logger.info('request completed', {...})`
(`apps/api/src/middleware/request-log.ts:38`). So the emitted stdout line is e.g.
`{"level":"info","msg":"request completed","method":"GET","route":"/api/...","statusCode":200,
"latencyMs":12}`. The matcher keys on **`msg === "request completed"`** — a stable literal
unique to the request-log middleware (metrics use `msg:"metric"`, captured errors use
`msg:"error.captured"`).

## NEEDS_CONTEXT trigger checked (does the log reach the stream?)
Cleared. The pipeline `logger` is `createConsoleTelemetry` (default `console` sink) —
`apps/api/src/lib/telemetry/request-telemetry.ts:83`, installed at
`apps/api/src/middleware/pipeline-bindings.ts:38`. `logger.info(...)` → `console.info(JSON)`
→ wrangler-dev stdout → `subprocess.stdout.pipe(lineObserver)` (`scripts/wrangler-dev.ts:180`)
→ `isApiRequestLogLine(line)` (`:166`). The structured line reaches the same stdout stream
heartbeat-source reads; only the match string changed.

## Tests added
- heartbeat: matches a structured request-log line; matches with surrounding whitespace;
  does NOT match other structured lines (metric, error.captured); does NOT match non-JSON
  lines (banner, stack frame, blank, malformed `{`); does NOT match the legacy `[req]` text
  line. (Covers acceptance 1 + 3 — the matcher fires on a real emitted line and not on
  unrelated log lines.)
- extractor: keeps request-log lines in the window; keeps every request-log line (no
  per-version filtering); **drops** non-request, non-marker noise (banners, errors, stack
  traces, metric lines); keeps START/END markers; plus preserved marker/runId/latest-START/
  crash-EOF/empty cases. (Covers acceptance 2 — filter no longer keeps every line.)

## Self-gate
- `vitest run lib/heartbeat-source.test.ts lib/extract-mobile-api-log.test.ts` — pass (18/18).
- RED verified: temporarily reverting both modules to the old logic failed 4 of the new
  tests (matcher rejected JSON / accepted legacy `[req]`; extractor kept banner noise), for
  the expected reasons; restored → green.
- `eslint` on all five owned files — pass (exit 0), run from `scripts/`.
- Per-file coverage (v8) — no threshold ERROR emitted for `heartbeat-source.ts` or
  `extract-mobile-api-log.ts` (both ≥95%). The 0%-file ERRORs in the run are un-imported
  scripts under a 2-file subset run, not my files.
- `tsgo --noEmit` (scripts, whole graph) — FAIL, but **only** on
  `apps/api/src/slices/{identity,models}/routes.ts` (`domainWireCode` undefined /
  `DOMAIN_ERROR_CODE_TO_WIRE_CODE` unused). Those files are `M` in git, not touched by me;
  the symbol is concurrent task T11's (R19 = "route all slice error responders through
  `domainWireCode()`"). Isolated `tsgo` grep shows zero errors in my files. Not mine.

## Acceptance criteria
1. **Met** — `heartbeat-source.ts` matches the structured `msg:"request completed"` field,
   not a re-introduced `[req]` text line (typed-logger doctrine preserved). Test proves the
   matcher fires on a real emitted line and not on unrelated log lines.
2. **Met (with a semantics deviation, below)** — the extractor filter is updated to the
   structured format and stops keeping every line (drops banners/errors/metric noise, keeps
   request-log lines + markers).
3. **Met** — focused unit test proves the heartbeat matcher fires on a real emitted line.

## Deviations & concerns
- **Version-based filtering is gone (unavoidable, upstream).** The old extractor kept only
  request lines whose `v=<APK version>` matched, to drop sibling-session traffic. The new
  structured request-log emits `method/route/statusCode/latencyMs` and **no app-version
  field**, so per-version filtering is no longer expressible. Adding one is out of my file
  bounds (it lives in `apps/api` middleware + would need a `SafeLogFields` slot). I resolved
  criterion 2 by selecting request-log lines + markers (the brief's "select only request-log
  lines in the new format"). Consequence: wrangler banner/error/stack-trace lines are no
  longer in the slice artifact (they remain verbatim in the raw `.wrangler-<port>.log`).
  `ExtractSliceOptions.mobileVersion` is now vestigial (retained for caller stability).
- **Out-of-scope consumer break (RAISED).** My contract change breaks one test in
  `scripts/mobile-test.test.ts:1103-1127` (`writeApiSlice` "extracts the slice…"), which
  still uses old `[req] … v=<version>` fixtures and asserts version filtering. That file is
  **not in T17's file list** so I did not edit it. Fix needed: change its fixture to the JSON
  request-log format and swap the version-filter assertions for request-log-selection
  assertions. R7 research flagged `mobile-test.ts` as a consumer; T17's Files list omitted
  it. Orchestrator should fold `scripts/mobile-test.test.ts` (and the two stale
  `X-App-Version` docstrings in `scripts/mobile-test.ts:419,435`) into scope or sequence a
  follow-up.
- **Concurrent T11 breakage (RAISED).** Scripts `tsgo` fails only on T11's in-flight
  `apps/api` route edits (`domainWireCode`). Not mine; will clear when T11 lands.

## Confidence
High for the two owned modules (behavior tested, RED verified, lint clean, per-file coverage
met). The one real judgment call — dropping banner/error lines from the slice because
per-version filtering can no longer be expressed — is flagged for confirmation.
