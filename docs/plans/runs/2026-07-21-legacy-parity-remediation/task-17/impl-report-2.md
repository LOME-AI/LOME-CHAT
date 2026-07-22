# T17 / R7 — impl report 2 (scope expansion: close the consumer break)

Continues impl-report-1. Scope expanded to include `scripts/mobile-test.ts` and
`scripts/mobile-test.test.ts` (plan §"T17 scope expansion"). This report covers only the
newly-in-bounds work; the heartbeat/extractor changes and their evidence are in report-1.

## Objective
Close the consumer break caused by report-1's `extractRelevantSlice` contract change:
green the `writeApiSlice` test, correct the stale `X-App-Version` docstrings, and resolve
the now-vestigial `mobileVersion` parameter.

## Files changed
- `scripts/lib/extract-mobile-api-log.ts` — removed the dead `mobileVersion: string` field
  from `ExtractSliceOptions` (durable naming: it was no longer a filter input).
- `scripts/mobile-test.ts` — dropped `mobileVersion: APK_APP_VERSION` from the
  `extractRelevantSlice(...)` call in `writeApiSlice`; corrected the two stale docstrings
  (`withMobileTestRun` and `writeApiSlice`) that claimed X-App-Version filtering.
- `scripts/mobile-test.test.ts` — rewrote the `writeApiSlice` fixture/assertions from the old
  `[req] … v=<version>` text format to structured JSON request-log lines; assertions now key
  on request `route` (no version discrimination) and still assert surrounding wrangler noise
  is dropped.
- `scripts/lib/extract-mobile-api-log.test.ts` — removed the `MOBILE_VERSION` const and every
  `mobileVersion:` argument from the `extractRelevantSlice` calls (interface field is gone);
  prettier-collapsed the calls that now fit one line.

## mobileVersion decision — REMOVED (not kept)
Version-based filtering is unexpressible: the structured request-log emits
`method/route/statusCode/latencyMs` and no app-version field (report-1). The param was
therefore genuinely dead — passed by exactly one caller (`writeApiSlice`) into a filter that
no longer reads it. Removed from `ExtractSliceOptions` and from every call site
(`mobile-test.ts` + both test files). `APK_APP_VERSION` itself stays live (APK build,
version-override reset — `mobile-test.ts` + `mobile-test.test.ts:1169`); only its use as an
`extractRelevantSlice` argument was removed. No `[req]` text line reintroduced and no
app-version log field added (both out of scope).

## RED → GREEN (mobile-test.test.ts:writeApiSlice)
- RED (pre-fix, against report-1's new extractor): the test failed at the
  `expect(sliceContent).toContain(`v=${APK_APP_VERSION}`)` assertion — the old `[req]` lines
  are not structured request-log lines, so the extractor dropped them and the slice held only
  the markers. (Reproduced earlier this session: "1 failed | 159 passed".)
- Fix: fixture now emits `{"level":"info","msg":"request completed","method":"POST",
  "route":"…",…}` lines; assertions check the routes are present and `before`/`after`
  wrangler banners are absent.
- GREEN: passes as part of the suite run below.

## Docstring fixes (mobile-test.ts)
- `withMobileTestRun` — removed "(combined with the X-App-Version filter)"; now states the
  START/END window is the only per-run isolation and sibling-session traffic in the same
  window can no longer be filtered by APK build.
- `writeApiSlice` — removed "(filtered to APK traffic only via X-App-Version)"; now states
  the slice keeps request-log lines + run markers in the window and wrangler banner/error
  lines stay in the unfiltered raw log.

## Self-gate (green)
- `vitest run lib/heartbeat-source.test.ts lib/extract-mobile-api-log.test.ts
  mobile-test.test.ts` (coverage-free) — pass, 148/148 (3 files).
- `vitest run lib/extract-mobile-api-log.test.ts` after the prettier auto-fix — pass, 9/9.
- `eslint` on all owned + newly-owned files (`lib/heartbeat-source.ts`,
  `lib/heartbeat-source.test.ts`, `lib/extract-mobile-api-log.ts`,
  `lib/extract-mobile-api-log.test.ts`, `wrangler-dev.ts`, `mobile-test.ts`,
  `mobile-test.test.ts`), run from `scripts/` after the last edit — pass (exit 0).
- `tsgo --noEmit` (scripts, whole graph) — fails ONLY on
  `apps/api/src/slices/{identity,models}/routes.ts` (`domainWireCode` undefined /
  `DOMAIN_ERROR_CODE_TO_WIRE_CODE` unused), concurrent task T11's in-flight work in files I
  never touched. Grep confirms zero errors in any owned file. Not mine.

## Acceptance (report-1 criteria, now with no open consumer break)
1–3 remain Met (report-1). The report-1 "out-of-scope consumer break" concern is now
resolved: `mobile-test.test.ts` is green and the `mobileVersion` vestige is removed.

## Concerns
- **Behavioral note (already flagged in report-1):** sibling-session API traffic occurring
  inside a run's START/END window can no longer be filtered out of the slice, because the
  structured request-log has no app-version field. In practice the mobile-test spawns its own
  dedicated wrangler-dev API, so foreign traffic is not expected; the raw wrangler log retains
  everything regardless. Restoring per-session filtering would require adding an app-version
  field to the request-log (apps/api + SafeLogFields) — out of R7 scope.
- **Concurrent T11** `apps/api/.../routes.ts` typecheck failure is unrelated and will clear
  when T11 lands.

## Confidence
High — all owned + newly-owned files tested (RED→GREEN shown for the consumer test), lint
clean, no typecheck errors in owned files; the only remaining behavioral tradeoff is the
documented, unavoidable loss of per-version slice filtering.
