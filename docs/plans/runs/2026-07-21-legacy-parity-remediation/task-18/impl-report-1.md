# T18 — R22: restore dev/mock/test fidelity (5 items) — impl report 1

## Objective
Restore five mock/cassette/test-fidelity behaviors: (a) env-gated mock streaming
delays, (b) `recordedFromSha` cassette stamp, (c) grapheme-safe chunk + trailing JSON
fence, (d) aspect-aware mock media + its pinning E2E spec, (e) magic-byte + size-bound
integration assertions. Done as five independent TDD cycles.

## Files changed (path — why)
- `packages/shared/src/mock-directives.ts` — (a) add `textDelayMs`/`mediaDelayMs`
  (positive-int optional) to `mockDirectivesSchema`; doc comment updated.
- `packages/shared/src/mock-directives.test.ts` — (a) parse/reject tests for the two new fields.
- `apps/api/src/slices/models/adapters/mock-provider.ts` — (a) `resolveMockDelays()`
  (isDevServer-gated, `??`-overridable defaults 60/3000/1000); `createMockModelProvider`
  gains `isDevServer=false`; generators (`textDeltas`, `echoStream`, `mediaStream`,
  `classifierStream`) made delay-aware; parse two new `x-mock-*-delay-ms` headers.
  (c) `Intl.Segmenter` 24-grapheme chunking + exported `MOCK_ECHO_JSON_FENCE` appended to
  echo. (d) `mockImageDimensions`/`mockImageBytes` scale the image PNG to `aspectRatio`
  (long side 1024), fixture 400×300 fallback.
- `apps/api/src/slices/models/adapters/mock-provider.test.ts` — updated echo assertions to
  include the fence; new tests for delays (both env branches + media park), grapheme
  safety, fence, aspect-aware image (landscape/square/portrait/malformed/non-positive),
  and the two delay headers.
- `apps/api/src/slices/models/adapters/cassette/recording-fetch.ts` — (b) `recordedFromShaStamp()`
  stamps `GITHUB_SHA` on both write sites (streamed + bodyless), matching the legacy
  direct-`process.env` diagnostic-only exception.
- `apps/api/src/slices/models/adapters/cassette/recording-fetch.test.ts` — (b) stamp/omit tests.
- `apps/api/src/slices/models/adapters/media-assertions.ts` — **NEW** (e) shared
  `assertValidMediaBytes` helper (magic-byte sniff + size bounds), ported verbatim from
  legacy `media-assertions.ts`. One shared copy per CODE-RULES "One Implementation, Shared".
- `apps/api/src/slices/models/adapters/media-assertions.test.ts` — **NEW** (e) unit tests.
- `apps/api/src/slices/models/adapters/image-adapter.integration.test.ts` — (e) replaced
  `byteLength > 0` with `assertValidMediaBytes(bytes, [png/jpeg/webp], {min:32,max:10_000_000})`.
- `apps/api/src/slices/models/adapters/video-adapter.integration.test.ts` — (e) replaced
  `byteLength > 0` with `assertValidMediaBytes(bytes, [mp4/webm], {min:16,max:50_000_000})`.
- `e2e/chat/image-generation.spec.ts` — (d) pinning spec updated 400×300 → 1024×1024
  (default aspect 1:1 → long side 1024).

## Tests added (name — behavior — criterion)
- `resolveMockDelays` — dev defaults 60/3000/1000 only when isDevServer; zeroed otherwise;
  directive override wins either branch — (a) env gate.
- `createMockModelProvider — delay wiring` — paces echo by text delay under isDevServer
  (fake timers, cannot settle until advanced); streams instantly (real timers, no advance)
  when isDevServer=false; media stream parks between start/done by the media delay — (a)
  proves delays OFF in the E2E/vitest branch, ON in dev-server.
- parseMockDirectives reads positive `x-mock-text-delay-ms`/`x-mock-media-delay-ms`;
  ignores non-positive/non-numeric — (a).
- `stamps recordedFromSha from GITHUB_SHA` (streamed + bodyless) / `omits ... when unset` — (b).
- `appends a trailing fenced JSON block` / `never splits a multi-code-unit grapheme` — (c).
- `honors aspectRatio 16:9→1024×576` / `1:1→1024×1024` / `2:3→683×1024` / malformed→400×300 /
  non-positive→400×300 — (d).
- `assertValidMediaBytes` — PNG/JPEG/WebP/MP4/WebM detection, min/max bounds, undetectable,
  disallowed mime, <12-byte floor — (e).

## Self-gate
- `pnpm test:api` (full, coverage) — **OOM-killed (exit 137)** at ~7m20s, mid-identity
  integration tests (expected-defect 500 logging shown, no assertion failure). This is the
  known coverage-over-full-package saturation kill (stack-saturation lesson), NOT a failure
  of my edits (all my edits are in models/adapters + shared). Substituted per-file
  coverage-free runs + scoped coverage below.
- `pnpm test:watch apps/api/src/slices/models/adapters` — pass (16 files, 278 tests, 3 integration skipped).
- `pnpm test:watch packages/shared/src/mock-directives.test.ts` — pass (9).
- scoped coverage (mock-provider.ts, media-assertions.ts, recording-fetch.ts) — pass:
  All files 99.62% stmts / 98.78% branch / 100% funcs / 100% lines; mock-provider 99.08%
  branch (only uncovered branch = pre-existing `parseMockDirectives` safeParse-fail fallback, line 258).
- `pnpm test:watch .../regenerate.integration.test.ts` — **1 FAIL** at line 383 (see Concerns; out of bounds).
- ESLint (from package dirs): api owned files exit 0; shared exit 0; e2e spec exit 0.
- typecheck: `@hushbox/api` exit 0; `@hushbox/shared` exit 0; `@hushbox/e2e` exit 0.

## Acceptance criteria
1. **(a) Mock delays — MET.** Schema fields added; `resolveMockDelays` defaults 60/3000/1000
   only when `isDevServer` (derived from `envUtils`/`createEnvUtilities().isDevServer` by the
   caller — never a raw NODE_ENV/CI/E2E check), per-request `??`-overridable; generators
   honor them. Both branches tested. Legacy env-gate matched:
   `legacy/apps/api/src/legacy/services/ai/index.ts:83-99` (`buildMockConfig(options, isDevServer)`
   with `?? (isDevServer ? LOCAL_DEV_*_DELAY_MS : 0)`) + `:105-114` (`getAIClient` derives
   `isDevServer` from `createEnvUtilities`). **Caveat (RAISED):** the isDevServer auto-default
   is not yet activated at runtime — the composition point that would pass `isDevServer=true`
   (`resolve-model-provider.ts` / `conversation-runtime.ts`) is outside T18's file list.
   Per-request header override works end-to-end today; E2E/vitest/CI/production stay delay-free
   by default (the safety-critical property).
2. **(b) recordedFromSha — MET.** Stamped on both write paths from `process.env['GITHUB_SHA']`
   (legacy `recording-fetch.ts:160` parity, direct-`process.env` diagnostic exception).
   `docs/CI-CASSETTES.md:173` already documents the field as populated — now accurate, no doc change.
3. **(c) grapheme + fence — MET.** `Intl.Segmenter` grapheme chunking (24) restored; trailing
   `MOCK_ECHO_JSON_FENCE` appended. Legacy parity: `legacy/.../mock.ts:285,297-315`.
4. **(d) aspect-aware media — MET (image); documented limitation (video).** Image PNG scales
   to `aspectRatio` (legacy `mockMediaDimensions`, `mock.ts:355-387`); pinning E2E spec updated
   to 1024×1024. Video keeps fixed `ftyp` bytes — the new media contract carries no width/height
   field and the `ftyp` box encodes no dimensions, so aspectRatio has no representable effect on
   video in this architecture (legacy carried width/height on the media-done event; the new tree
   dropped that field). Noted as a deviation.
5. **(e) magic-byte + size bounds — MET.** Shared helper ported verbatim (bounds
   PNG/JPEG/WebP {32,10_000_000}, MP4/WebM {16,50_000_000}; signatures identical to legacy),
   wired into both real-provider integration suites (which skip locally, run CI-vitest).

## Deviations (with reasons)
- **Two new files** (`media-assertions.ts` + test) not literally in the plan Files list.
  Justification: CODE-RULES "One Implementation, Shared" forbids two inline copies; the DELTA
  (research R22.e) says port it "as a shared helper". Placed in the adapters tree, imported by
  both named integration tests. RAISED.
- **(d) video not aspect-scaled** — no representable dimension in the new media
  contract/`ftyp` bytes (see criterion 4).

## Concerns and limitations
- **(c) breaks an out-of-bounds test:** `apps/api/src/slices/chat/domain/regenerate.integration.test.ts:383`
  asserts `toBe('Echo:\nfirst prompt')` — the mandated fence makes this the full content
  `Echo:\nfirst prompt` + `\n\n\`\`\`json…\`\`\``. Confirmed failing in isolation. That file is
  not in T18's list; required one-line follow-up (→ `toContain('Echo:\nfirst prompt')` or the
  full echo). `test:api` fails on this until updated. RAISED.
- **Full-package coverage OOMs (exit 137)** in this sandbox — a resource kill, not a test
  failure; validated via per-file + scoped coverage.
- **Phase-4 E2E:** every text echo now carries the JSON fence. Surveyed e2e consumers use
  substring/`/^Echo:/` matches (safe); only exact-content assertions would break (none found in
  e2e; the one exact-match is the out-of-bounds api integration test above). The other e2e image
  dimension check (`e2e/group/realtime-media.spec.ts`) asserts `naturalWidth > 0`, unaffected by 1024×1024.

## Confidence
High for (b),(c),(e) and the image half of (d); medium for (a) — the feature is built, tested
both branches, and safe-by-default, but its dev-server auto-default needs one out-of-bounds
composition edit to activate, and (c)'s fence requires the out-of-bounds regenerate test fix.
