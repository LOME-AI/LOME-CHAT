# Legacy→New parity research: R5, R7, R22, R23 (dev/seed/mock fidelity)

Grounding for `docs/history/2026-07-21-legacy-parity-audit.md` findings R5, R7, R22
(a–e), R23 (a–b). All citations are file:line opened this session. No source file was
edited to produce this research.

---

### R5 — server-seeded conversations always get an empty title

**LEGACY** — `legacy/scripts/legacy_seed.ts`: real, varied titles at every seed site.
- `:595` — `title: encryptTextForEpoch(epochPublicKey, \`Seed Conversation ${String(convIndex + 1)}\`)` (the flat `SEED_CONFIG` generator loop).
- `:832` — `${personaName} Project ${String(projectIndex + 1)}` (project name, not conversation, but same pattern).
- `:850` — `` `${personaName} Conversation ${String(convIndex + 1)}` `` — default per-persona sample conversation title.
- `:849` — `'Quantum Computing Research'` — special title when `convIndex === 2` (the search-conversation carve-out; see R23.a).
- Screenshot conversations: legacy titles follow `Screenshot: ${name}` pattern per `legacy/LEGACY-BEHAVIOR-REPORT.md:4667-4680` (solo) and `:4645` (group chat), matching the current fixture's `seedKey` naming (`screenshot-conv-*`) but never wired to a title string.
- `legacy/apps/api/src/legacy/services/dev/dev.ts:775` — `createDevGroupChat` itself passes `encryptTextForEpoch(epochResult.epochPublicKey, '')` (empty) — i.e. the *shell helper* was always empty in legacy too; real titles come from the *seed script* passing a title through, not from the shell primitive. This matters: the regression is not in the shell's default, it's that no caller in the new seed script has a title parameter to override the default with.

**CURRENT** — `apps/api/src/platform/dev/factories.ts:176` — `seedConversationShell` hardcodes:
```ts
title: encryptTextForEpoch(epoch.epochPublicKey, ''),
```
No caller can override it — none of the four param interfaces expose a `title` field:
- `CreateDevConversationParams` (`:321-327`)
- `CreateDevMultiModelConversationParams` (`:360-366`)
- `CreateDevGroupChatParams` (`:409-421`)
- `CreateDevMediaConversationParams` (`:493-501`)

Callers, none passing a title:
- `apps/api/src/platform/dev/mint-admin-targets.ts:146` (`createDevConversation`)
- `apps/api/src/platform/dev/routes.ts:279,290,304,321` (dev-only HTTP routes calling all four factories)
- `scripts/seed.ts:320-349` (`seedScreenshotConversations`, per `SCREENSHOT_CONVERSATIONS` spec — `scripts/lib/seed-fixtures.ts:22-31` `ScreenshotConversationSpec` has no `title` field either)
- `scripts/seed.ts:449` (charlie's conversation in `seedDevData`)

Frontend has no "Untitled" fallback, so an empty title renders as literal blank UI, not a placeholder:
- `apps/web/src/components/sidebar/chat-item.tsx:44-62` — `ChatItemTitle` renders `title` verbatim; only special-cases the `DECRYPTING_TITLE` sentinel.
- `apps/web/src/components/shared/page-header.tsx:80` — `{title && (...)}` omits the entire title `<span>` block when falsy (real path; the audit's `page-header.tsx` shorthand omits the `components/shared/` segment).

**DELTA** — Thread a `title: string` parameter through `seedConversationShell` and all four `CreateDev*Params` interfaces (or leave the shell's own default empty, matching legacy's `dev.ts:775` behavior, and instead have every *seed-script* caller pass an explicit title — this mirrors legacy's actual split between "shell defaults empty" and "seed script always supplies a title"). Then update every caller in `mint-admin-targets.ts`, `platform/dev/routes.ts`, and `scripts/seed.ts` to pass a real title, and add a `title` field to `ScreenshotConversationSpec` / `SCREENSHOT_CONVERSATIONS` for the screenshot flow.

**NOTES** — The legacy value corpus to reuse: `Seed Conversation ${n}`, `${personaName} Conversation ${n}` (with the `convIndex===2` → `'Quantum Computing Research'` carve-out for the search-tool demo conversation), `Screenshot: ${name}`. `apps/api/src/platform/dev/routes.ts` dev-only routes are used interactively by developers hitting the API directly, so those call sites need a sensible default title too, not just the batch seed script.

---

### R7 — `[req]` request-log line removal breaks the dev-stack idle heartbeat

**LEGACY** — `legacy/apps/api/src/legacy/middleware/request-log.ts` (full file, 42 lines): plain-text emission gated only on `!isProduction`:
```ts
console.log(
  `[req] ${new Date(startedAt).toISOString()} ${method} ${path} ${String(status)} ${String(durationMs)}ms v=${version}`
);
```
Line format begins with the literal `[req] ` prefix consumed downstream (`legacy/LEGACY-BEHAVIOR-REPORT.md:182-193`).

**CURRENT** — `apps/api/src/middleware/request-log.ts` (full file, 46 lines): structured JSON via the typed logger, no `[req]` text anywhere:
```ts
logger.info('request completed', {
  method: c.req.method,
  route: routeTemplate(matchedRoutes(c)),
  statusCode: c.res.status,
  latencyMs: Date.now() - startedAt,
});
```
Confirmed emitted shape via `apps/api/src/lib/telemetry/console-adapter.ts:37` (full file read) — `console.log(JSON.stringify({ level, msg, ...pickSafeLogFields(fields) }))`, so the actual stdout line is:
```json
{"level":"info","msg":"request completed","method":"GET","route":"/api/...","statusCode":200,"latencyMs":12}
```
Stranded consumers:
- `scripts/lib/heartbeat-source.ts` (full file, 49 lines): `API_REQUEST_LOG_PREFIX = /^\[req\]\s/`; `isApiRequestLogLine(line)` never matches any current stdout line — the heartbeat never ticks from live traffic.
- `scripts/wrangler-dev.ts:100-170` — pipes wrangler stdout through `createLineObserver`, calls `isApiRequestLogLine(line)` around `:163-166` to touch the heartbeat; comment there still says "Each [req] line from the API request-log middleware... counts as user activity."
- `scripts/ensure-stack-cli.ts:41` (real path — **not** under `scripts/lib/`, contra the audit doc's shorthand) — `DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000`; the stack self-reaps after 60 idle minutes measured off this heartbeat, so a live dev session generating real API traffic gets silently reaped anyway.
- `scripts/lib/extract-mobile-api-log.ts` (~66 lines): `REQ_LINE_PREFIX = '[req] '`; `keepLine(line, mobileVersion)` returns `true` for any line that does **not** start with `[req] `, else filters by `v=${mobileVersion}` substring. Since no line ever starts with `[req] ` any more, `keepLine` now returns `true` unconditionally — every line is kept, silently defeating the intended filtering. **Not orphaned**: confirmed live caller `scripts/mobile-test.ts:16` — `import { MARKER_PREFIX, extractRelevantSlice } from './lib/extract-mobile-api-log.js'`.

**DELTA** — Repoint `heartbeat-source.ts`'s matcher to the structured JSON the new logger actually emits (e.g. parse each line as JSON and check `msg === 'request completed'`, or a stable substring match on that literal), not by resurrecting a legacy `[req]` text line (would violate the typed-`SafeLogFields`-logger doctrine in CODE-RULES.md). Update `wrangler-dev.ts`'s stale comment. Separately repair (not delete) `extract-mobile-api-log.ts`'s `REQ_LINE_PREFIX`/`keepLine` logic to match the new structured-JSON request-log shape, since `mobile-test.ts` still calls it.

**NOTES** — `heartbeat-source.ts` and `extract-mobile-api-log.ts` need the *same* new match condition (both currently keyed on `[req] `), so the fix is naturally one shared constant/helper for "is this stdout line a request-completed log line", consistent with CODE-RULES's "One Implementation, Shared" rule, rather than two independent re-implementations of the JSON-shape check.

---

### R22.a — mock streaming delays (60/3000/1000 ms) lost their env gate entirely

**LEGACY** — `legacy/apps/api/src/legacy/services/ai/index.ts` (full file, 123 lines) — **the exact env-gate**:
```ts
export const LOCAL_DEV_MEDIA_DELAY_MS = 3000;
const LOCAL_DEV_TEXT_DELAY_MS = 60;
const LOCAL_DEV_CLASSIFIER_DELAY_MS = 1000;

export function buildMockConfig(
  options: AIClientOptions,
  isDevServer: boolean
): MockAIClientConfig {
  return {
    ...options.mockConfig,
    textDelayMs: options.mockConfig?.textDelayMs ?? (isDevServer ? LOCAL_DEV_TEXT_DELAY_MS : 0),
    mediaDelayMs: options.mockConfig?.mediaDelayMs ?? (isDevServer ? LOCAL_DEV_MEDIA_DELAY_MS : 0),
    classifierDelayMs:
      options.mockConfig?.classifierDelayMs ?? (isDevServer ? LOCAL_DEV_CLASSIFIER_DELAY_MS : 0),
  };
}

export function getAIClient(env: AIClientEnv, options: AIClientOptions = {}): AIClient {
  const { isLocalDev, isE2E, isDevServer } = createEnvUtilities(env);
  if (isLocalDev || isE2E) {
    return createMockAIClient(buildMockConfig(options, isDevServer), {
      useFixtureCatalog: isE2E,
    });
  }
  return createRealAIClient({ ... });
}
```
**ENV-GATE**: `isDevServer` — a strict subset of `isLocalDev` that excludes `isE2E` and `isVitest`. The outer gate (`isLocalDev || isE2E`) decides mock-vs-real; the inner `isDevServer` decides whether the *human-facing timing defaults* apply. Per-request `options.mockConfig.*DelayMs` values always win via `??`, so E2E/vitest runs never get artificial delay unless a test explicitly asks for one; only an interactive human dev server does by default.

**CURRENT** — `apps/api/src/slices/models/adapters/mock-provider.ts` (444 lines): no text/media delay concept survives.
- `MOCK_CHUNK_CHARS = 8` (`:60`) — chunking constant only, no delay constants at all.
- `textDeltas` (`:416-421`) is a pure synchronous generator — no delay of any kind:
```ts
function* textDeltas(content: string): Generator<InferenceEvent> {
  for (let index = 0; index < content.length; index += MOCK_CHUNK_CHARS) {
    yield { kind: 'text-delta', index: 0, content: content.slice(index, index + MOCK_CHUNK_CHARS) };
  }
}
```
- `mediaStream` is likewise synchronous, no delay.
- `firstEventDelay(ms)` (`:440-443`) exists but is only used by `classifierStream`, and `classifierDelayMs` has no default anywhere — it's `undefined` unless a caller sets the `x-mock-classifier-delay-ms` header, so it no-ops even on a real interactive dev server.
- `mockProviderEnabled(env)` (`:217-221`) mirrors legacy's *outer* gate only:
```ts
export function mockProviderEnabled(
  env: Pick<EnvUtilities, 'isLocalDev' | 'isE2E' | 'isProduction'>
): boolean {
  return (env.isLocalDev || env.isE2E) && !env.isProduction;
}
```
There is no equivalent of legacy's `buildMockConfig` — no inner `isDevServer`-gated default injection exists anywhere in the call chain.
- `packages/shared/src/mock-directives.ts` (full file, 38 lines) — `mockDirectivesSchema` fields: `classifierResolution`, `classifierFailure`, `failingModels`, `classifierDelayMs`, `holdPrimaryStream`. **`textDelayMs`/`mediaDelayMs` do not exist in the schema at all** — this is a schema gap, not just a wiring gap.
- `packages/shared/src/env.ts` (full file, 91 lines) — `isDevServer` **already exists** in the current shared package:
```ts
isDevServer: isLocalDev && !isE2E && !isVitest,
```
with doc comment "Use this (not `isLocalDev`) to gate human-facing dev affordances like visible mock-stream timing." Confirmed via grep: in current `apps/api/src`, `isDevServer` is used nowhere. Its only current consumers repo-wide are unrelated: `apps/web/src/lib/crawler-view.ts` and `apps/web/src/components/dev/crawler-eye.tsx` (a dev-mode UI badge, not the mock provider).
- Composition point confirmed: `apps/api/src/slices/chat/routes.ts:235-239` (`mockDirectivesBody`) is entirely header-driven with zero env-default injection — this is the code location analogous to legacy's `getAIClient`, but missing the `buildMockConfig`-equivalent step. `apps/api/src/slices/models/adapters/resolve-model-provider.ts:102-104` composes `createMockModelProvider(input.mockDirectives, ...)` with no env defaults either. `apps/api/src/slices/chat/conversation-runtime.ts:57,63` also calls `mockProviderEnabled(envUtilities)` only for the mock-vs-real switch.

**DELTA** — Three-part fix, per the founder directive (branch the same way legacy branched, via `envUtils`, never `NODE_ENV`/`CI`/`E2E` directly):
1. Add `textDelayMs`/`mediaDelayMs` fields to `mockDirectivesSchema` in `packages/shared/src/mock-directives.ts` (classifier already has one).
2. At the composition point that already reads `c.var.envUtils` (`apps/api/src/slices/chat/routes.ts` and/or `resolve-model-provider.ts`), inject `isDevServer`-gated defaults for `textDelayMs`/`mediaDelayMs`/`classifierDelayMs` the same way legacy's `buildMockConfig` does — per-request header value wins, otherwise `isDevServer ? LOCAL_DEV_*_DELAY_MS : 0`.
3. Wire the resolved delay values into `mock-provider.ts`'s `textDeltas`/`mediaStream` generators (currently synchronous, need to become delay-aware the way `classifierStream`/`firstEventDelay` already is).

**NOTES** — `isDevServer` is not a new concept to introduce — it is a purpose-built, already-defined, already-documented `envUtils` field that is simply unused in `apps/api` today, so this fix is additive wiring, not new architecture.

---

### R22.b — `recordedFromSha` never stamped on newly-recorded cassettes

**LEGACY** — `legacy/apps/api/src/legacy/services/ai/cassette/recording-fetch.ts:95-163`, stamped only in the `drainAndStore` write path (`:160`):
```ts
store.write(hash, {
  version: 1,
  exchanges: [{ status, statusText, headers, chunks }],
  recordedAt: new Date().toISOString(),
  ...(process.env['GITHUB_SHA'] !== undefined && { recordedFromSha: process.env['GITHUB_SHA'] }),
});
```
Comment at that site: "`GITHUB_SHA` is a GitHub Actions runtime detail, not part of `envConfig` — it doesn't have a slot in `envUtils`. Reading `process.env` directly is the pragmatic choice for cassette diagnostics; production code never runs through this path." The bodyless-response branch does not stamp it either (symmetric with current code).

**CURRENT** — `apps/api/src/slices/models/adapters/cassette/recording-fetch.ts:120-203` — both write sites set `recordedAt` but never `recordedFromSha`. `apps/api/src/slices/models/adapters/cassette/cassette-store.ts:66` — `recordedFromSha: z.string().optional()` is declared in the Zod schema but never populated by any writer. `docs/CI-CASSETTES.md:173` documents the field as if populated: "Correlate recordings to tests by `recordedAt` and `recordedFromSha`."

**DELTA** — At the same write site(s) in `recording-fetch.ts`, add `...(process.env['GITHUB_SHA'] !== undefined && { recordedFromSha: process.env['GITHUB_SHA'] })`, matching legacy's direct-`process.env` exception (this is a diagnostic-only field outside the `envConfig` registry, same rationale legacy documented).

**NOTES** — This is a pure omission — the schema slot, the doc, and the legacy precedent all already agree; only the write call is missing.

---

### R22.c — mock echo lost grapheme-safe chunking and the trailing JSON fence

**LEGACY** — `legacy/apps/api/src/legacy/services/ai/mock.ts` (~680 lines, partial tool-display compression on this large file): `STREAM_CHUNK_CHARS = 24`; chunking implemented via `Intl.Segmenter` over grapheme clusters (so a chunk boundary never splits a multi-code-point emoji/grapheme); echo content includes a trailing fence, approximately:
```
```json
{
  "ok": true
}
```
```
(source line ~298 in `mock.ts`).

**CURRENT** — `apps/api/src/slices/models/adapters/mock-provider.ts`:
- `MOCK_CHUNK_CHARS = 8` (`:60`).
- `const content = \`${MOCK_ECHO_PREFIX}\n${prompt}\`;` (`:385`) — no trailing JSON fence.
- `textDeltas` (`:416-421`) uses plain `.slice(index, index + MOCK_CHUNK_CHARS)` on the raw string — no grapheme awareness, so a chunk boundary can split a multi-code-point character.

**DELTA** — Reinstate `Intl.Segmenter`-based grapheme chunking in `textDeltas` (or an equivalent grapheme-safe slicer) and append the trailing JSON-fence content to the echo string, matching legacy's `mock.ts` output shape.

**NOTES** — The chunk-size constant itself (24 vs 8) is a separate, non-functional difference (only affects how many `text-delta` events are emitted) — the correctness-relevant part of this finding is grapheme safety, not the specific chunk size.

---

### R22.d — mock media ignores `aspectRatio`, always emits fixed 400×300 PNG / fixed MP4

**LEGACY** — `legacy/apps/api/src/legacy/services/ai/mock.ts` — `mockMediaDimensions(aspectRatio, fallback)` (~lines 366-387) honors the request's `aspectRatio`, scaling to `MOCK_MEDIA_LONG_SIDE = 1024` on the long side; used by both `createImageStream` and `createVideoStream`.

**CURRENT** — `apps/api/src/slices/models/adapters/mock-provider.ts:72-74` — `MOCK_IMAGE_WIDTH = 400`, `MOCK_IMAGE_HEIGHT = 300`; `:156-162` — fixed `MOCK_IMAGE_BYTES`/`MOCK_VIDEO_BYTES` are emitted regardless of `request.aspectRatio`.

**DELTA** — Reinstate `aspectRatio`-aware dimension computation for both image and video mock generation, matching legacy's `mockMediaDimensions`.

**NOTES — E2E spec that pins the current fixed dimensions and must be updated alongside this fix:**
`e2e/chat/image-generation.spec.ts:1-55` — test `'switches to image modality, generates, and renders inline'` asserts:
```ts
expect(naturalWidth).toBe(400);   // :49
expect(naturalHeight).toBe(300);  // :54
```
with comment: "The canned JPEG must actually decode in the browser — naturalWidth / naturalHeight match the 400×300 dimensions emitted by mock.ts." This spec must be updated (e.g. to assert an aspect-ratio-consistent size, or drive the test's request with the aspect ratio the assertion expects) the same change that restores aspect-ratio honoring, or it starts failing immediately.

---

### R22.e — media integration tests assert only `byteLength > 0`, lost magic-byte + size-bound checks

**LEGACY** — `legacy/apps/api/src/legacy/services/ai/media-assertions.ts` (full file, 67 lines) defines the shared checker used by both legacy real-inference integration suites:
```ts
export function assertValidMediaBytes(
  bytes: Uint8Array,
  allowedMimeTypes: readonly string[],
  sizeBoundsBytes: { min: number; max: number }
): { detectedMime: string }
```
It throws if `bytes.byteLength` is outside `[min, max]`, or if `detectMimeFromBytes` (hand-rolled magic-byte sniffing) doesn't match one of `allowedMimeTypes`. Signature constants: `PNG_SIGNATURE = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]`, `JPEG_SIGNATURE = [0xff,0xd8,0xff]`, `RIFF_SIGNATURE`+`WEBP_SIGNATURE` (offset 8), `FTYP_SIGNATURE = [0x66,0x74,0x79,0x70]` (offset 4, → `video/mp4`), `EBML_SIGNATURE = [0x1a,0x45,0xdf,0xa3]` (→ `video/webm`).

Call sites:
- `legacy/apps/api/src/legacy/services/ai/image-generation.integration.test.ts:48-51`:
```ts
const detection = assertValidMediaBytes(
  generated.mediaBytes!,
  ['image/png', 'image/jpeg', 'image/webp'],
  { min: 32, max: 10_000_000 }
);
```
- `legacy/apps/api/src/legacy/services/ai/video-generation.integration.test.ts:54-57`:
```ts
assertValidMediaBytes(generated.mediaBytes!, ['video/mp4', 'video/webm'], {
  min: 16,
  max: 50_000_000,
});
```
Both are the real-OpenRouter-inference integration suites — the direct legacy analog of the current `image-adapter.integration.test.ts` / `video-adapter.integration.test.ts` (both `SHOULD_RUN`-gated real-provider tests).

**CURRENT** — `apps/api/src/slices/models/adapters/image-adapter.integration.test.ts:53` and `video-adapter.integration.test.ts:55` — identical, minimal assertion in both files:
```ts
expect(capture.captured[0]?.byteLength ?? 0).toBeGreaterThan(0);
```
No mime/magic-byte sniffing, no upper/lower size bound.

Real magic-byte signatures the *mock* provider itself produces (for reference when writing mock-path tests, distinct from the real-provider integration tests above):
- PNG: `apps/api/src/slices/models/adapters/mock-provider.ts:75` — `PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10]` (decimal form of `0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a` — matches legacy's `PNG_SIGNATURE` exactly).
- MP4: `apps/api/src/slices/models/adapters/mock-provider.ts:159-162` — `MOCK_VIDEO_BYTES` is an `ftyp` box; bytes at offset 4-7 spell `ftyp` (`'f'=102,'t'=116,'y'=121,'p'=112`), matching legacy's `FTYP_SIGNATURE` offset-4 convention.

**DELTA** — Port `media-assertions.ts` (or an equivalent shared helper, per CODE-RULES "One Implementation, Shared" — this logic has no reason to differ between old and new) into the current adapters test tree, and replace the bare `byteLength > 0` checks in both `image-adapter.integration.test.ts:53` and `video-adapter.integration.test.ts:55` with `assertValidMediaBytes(bytes, ['image/png','image/jpeg','image/webp'], {min: 32, max: 10_000_000})` / `assertValidMediaBytes(bytes, ['video/mp4','video/webm'], {min: 16, max: 50_000_000})` respectively (bounds copied verbatim from legacy).

**NOTES** — Current `image-adapter.integration.test.ts`/`video-adapter.integration.test.ts` are real-OpenRouter, CI-only (`describe.skipIf(!SHOULD_RUN)`), exactly mirroring legacy's `image-generation.integration.test.ts`/`video-generation.integration.test.ts` structure (`setupRealProvider`/`setupIntegrationClient`, real inference, `beforeAll`-hoisted single generation). This is a direct structural match, so the legacy bounds/mime-lists can be ported as-is without re-deriving them.

---

### R23.a — bulk per-persona sample data generator is gone; `hasSampleData` is a dead field

**LEGACY** — `legacy/scripts/legacy_seed.ts`:
- `DEV_PERSONAS` (`:162-187`): alice `hasSampleData: true, conversationCount: 150`; bob/charlie `hasSampleData: false, conversationCount: 3`.
- `createPersonaSampleData(personaName, userId, userPublicKey, { now, conversationCount = 3 })` (`:802-886`): builds 2 projects (titled `${personaName} Project ${n}`) and `conversationCount` conversations (titled `${personaName} Conversation ${n}`, except `convIndex === 2` → the special `'Quantum Computing Research'` search-tool demo conversation via `createSearchConversationMessages`; all other indices use `createGenericConversationMessages` with `messageCount = 3 + (convIndex % 3)`), returning the full set of projects/conversations/messages/contentItems/epochs/epochMembers/conversationMembers as plain arrays for batch insert.
- Gated call site `:1456-1483`: inside the per-persona loop, `if (persona.hasSampleData) { const sampleData = createPersonaSampleData(persona.name, user.id, publicKey, { now, conversationCount: persona.conversationCount }); ...push everything...; }` then also creates payments (`createPersonaPayments`) and usage/billing history (`createPersonaUsageData`) scoped to `sampleData.conversations.map(c => c.id)`, all inside the same `hasSampleData` branch.
- Separately, `:1730-1735` — wallet balance also branches on `hasSampleData` (`'10000.00000000'` vs `'0.00000000'`), independent of the conversation generator.

**CURRENT** — `scripts/lib/seed-personas.ts:41-71` — `DevPersona` interface still carries `hasSampleData: boolean`; `DEV_PERSONAS` still sets alice `true`, bob/charlie `false` (values preserved), but confirmed via grep that `hasSampleData` (lines 46,56,63,70,109,139,149,161,169,180,188,196 in `seed-personas.ts`, line 106 in `seed.ts`) is **declared everywhere, read nowhere** — no `if (persona.hasSampleData)` branch exists in the new codebase.

`scripts/seed.ts` orchestration structure (confirmed):
- `seedDevData(db, redis, masterSecret)` (`:440-485`) is the dev-roster entry point, called from the script's `main`-equivalent at `:556` (immediately after `seedTestPersonas(...)` at `:555`).
- Inside `seedDevData`: `devRoster = [...DEV_PERSONAS, ADMIN_TARGET_PERSONA]` (`:442`) → `mintAll(deps, personas)` creates the persona users/wallets (`:446`) → `seedScreenshotConversations(db)` (`:448`) → one fixed `createDevConversation` call for charlie (`:449-454`) → `seedAliceBillingHistory` scoped to the single screenshot conversation (`:462`) → `seedAdminOpTargets` (`:468`) → final authoritative wallet balances loop over `devRoster` (`:475-481`).
- **Insertion point for a restored bulk generator**: inside `seedDevData`, after `mintAll` (so persona users/public keys exist) and before or alongside `seedScreenshotConversations` — e.g. `for (const persona of devRoster.filter(p => p.hasSampleData)) { await createPersonaSampleData(db, persona, ...) }`, analogous to legacy's `if (persona.hasSampleData)` branch inside its per-persona loop. `createDevConversation`/the four factories in `apps/api/src/platform/dev/factories.ts` are the natural insertion primitives to build each generated conversation through (see R5 — they will also need the restored `title` parameter to reproduce legacy's `${personaName} Conversation ${n}` / `'Quantum Computing Research'` titles).

**DELTA** — Restore a bulk per-persona sample-data generator (conversations + messages, optionally projects/payments/usage history to the extent those exist in the new schema) gated on `persona.hasSampleData`, wired into `seedDevData` after `mintAll`, using the restored title-passing from R5 to reproduce legacy's title corpus (including the `convIndex===2` → `'Quantum Computing Research'` special case).

**NOTES** — `conversationCount` is not currently a field on the new `DevPersona` interface (`scripts/lib/seed-personas.ts:41-47`, read this session, has no such field) — a restored generator needs either that field re-added or a new equivalent constant threaded through.

---

### R23.b — `DELETE /dev/usage-rate-limits` omits `share:create:user:ratelimit:*`

**LEGACY** — n/a (this is a new-codebase-only rate-limit key; not cross-checked against a legacy equivalent file — the finding is purely a current-code omission scoped by the audit).

**CURRENT** — `apps/api/src/platform/dev/redis-resets.ts:85-93` — `resetUsageRateLimits`:
```ts
export async function resetUsageRateLimits(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, [
    'chat:stream:user:ratelimit:*',
    'media:download:user:ratelimit:*',
    'media:share:presign:ip:ratelimit:*',
    'media:share:presign:remint:ratelimit:*',
    'conversations:share:read:ip:ratelimit:*',
  ]);
}
```
Missing key template, defined at `apps/api/src/slices/conversations/adapters/rate-limit.ts:1-37`:
```ts
export const shareCreateRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 60,
  buildKey: (callerId: string) => `share:create:user:ratelimit:${callerId}`,
  rateLimitConfig: { maxAttempts: 20, windowSeconds: 60 },
});
```
(comment there: "the window mirrors the legacy `shareCreateUserRateLimit`" — `:29`).

`e2e/helpers/auth.ts:165-190` — `clearUsageRateLimits` doc comment (`:176-179`) claims: "Clears authenticated-user usage rate limits (chat stream, media download, share creation) so consecutive E2E tests sharing a user don't saturate the per-minute buckets" — this claim is currently false for share creation.

**DELTA** — One-line addition to the prefix array in `redis-resets.ts:85-93`: `'share:create:user:ratelimit:*'`.

**NOTES** — The exact prefix to add is `share:create:user:ratelimit:*` (wildcard-suffixed to match the `deleteRedisKeysByPrefixes` pattern already used for every other entry, since `buildKey` is per-caller-id).
