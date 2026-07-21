# E2E media-gen failure cluster — root-cause research

Run: `e2e/report/2026-07-20T05-25-42/` · project `iphone-15` · `pnpm e2e:fast`
Cluster: 31 failures across `e2e/chat/video-generation.spec.ts` (13),
`e2e/chat/image-generation.spec.ts` (11), `e2e/chat/multi-model-media.spec.ts` (6),
`e2e/group/realtime-media.spec.ts` (1).

## Method / evidence sources
- Per-test `error.txt`, `console-errors.txt`, and Playwright `trace/0-trace.network` +
  `trace/resources/*` (decoded request/response bodies).
- App code: `apps/api` chat/media/dev slices, `packages/shared` model-descriptor,
  `apps/web` model store + config panel, `e2e/fixtures.ts`, the specs.
- Confirmed the working catalog exposed to the app via the real `/models` response
  captured in a trace (see RC1/RC3).

## Key non-assumption: the catalog overhaul did NOT hide the media models
The `GET /models` response captured in
`.../e2e-chat-image-generation-...-switches-to-image-modality.../trace/resources/5929fcc9...json`
lists 203 models and DOES expose every E2E media id:
- image: `bytedance-seed/seedream-4.5`
- video: `google/veo-3.1-lite`, `kwaivgi/kling-video-o1`, plus `kwaivgi/kling-v3.0-pro`,
  `kwaivgi/kling-v3.0-std`, `alibaba/wan-2.7`.
So `isRunnableModelShape` gating (`packages/shared/src/model-descriptor.ts:56`) is NOT
excluding the media models at runtime — they resolve and are sendable. The overhaul's
damage is elsewhere (RC3 default-ordering). This rules out the "dual-output image auto-
denied / media hidden" hypothesis for the send failures.

---

## Root Cause A — server-side media generation run fails → `INTERNAL` (15 tests)

Symptom: `expect(locator).toBeVisible()` on `getByRole('log',{name:'Chat messages'})
.locator('img'|'video').first()` times out (element never appears). Every one of these
traces carries the browser console line:
`Stream failed: ChatRunFailedError: INTERNAL`
(source `apps/web/src/hooks/chat/use-authenticated-chat.ts:863`).

Trace evidence (single-image test): the client posts a well-formed run —
`trace/resources/a18c4da7...json`:
`{"model":"bytedance-seed/seedream-4.5","modality":"image","imageConfig":{"aspectRatio":"1:1"},...}`
`POST /chat` fires (network count = 1). The plain-text echo path works elsewhere, so the
turn reached the engine and the **media node** failed.

`ChatRunFailedError` is thrown from `apps/web/src/hooks/chat/use-chat-stream.ts:378-381`
only when the WS run result is `outcome:'failed'` (or `'deadline'`), carrying the run's
`code`. Here the code is `INTERNAL` — the *defect/unexpected* wire code, NOT a typed
inference/domain failure (a real provider outage or an `x-mock-failing-models` hit would
surface a specific code and a model-error tile, `mock-provider.ts:307-311`). So the media
node threw an **unexpected** error that the engine mapped to `INTERNAL`.

Where the defect lives (server-side media execution/persist — app code). Candidate sites,
all on the media-bytes-to-R2 path that only media turns exercise:
- `apps/api/src/slices/models/adapters/media-generate.ts:97-110` — `mediaOutputEvents`
  throws `AdapterDefect` ("generated file received without mapFilePart contract") when the
  per-node `mapFilePart` mapper is absent. The mapper is wired per node via
  `apps/api/src/slices/workflows/engine/interpreter.ts:922` (`this.request.mapFilePartFor?.(nodeId)`);
  if the media node isn't registered with a mapper, every media generation throws
  `AdapterDefect` → `INTERNAL`.
- `apps/api/src/slices/chat/domain/media-persist.ts` + the R2 `storage.put` of the
  encrypted media bytes — a storage/persist throw is also defect-class → `INTERNAL`.

The mock itself (`apps/api/src/slices/models/adapters/mock-provider.ts`) synthesizes a
valid 400×300 PNG / minimal MP4 and looks correct, so the failure is downstream of the
gateway mock, in media event-mapping or media persistence/storage.

Tests in this bucket:
- image: edit-regenerates, cost-badge/nametag, long-prompt, regenerate-replaces,
  retry-same-prompt, switches-to-image-modality, **aspect-ratio-payload** (see note).
- video: edit-regenerates, cost-badge/nametag, regenerate-replaces, playback-controls,
  retry-same-prompt, switches-to-video-modality, **9:16-aspect-payload** (see note).
- multi-model-media: failing-video-model, two-video-models-race-free (`toBeGreaterThan(0)`
  received 0 — zero assistant messages rendered because both video runs failed).
- group/realtime-media: bob-sees-alice-generated-image.

Note on the two aspect-ratio-payload tests (`expect.poll(captured.get).toBeDefined()` →
undefined): these DO fire `POST /chat` (network count = 1) and DO log
`Stream failed: ChatRunFailedError: INTERNAL`. They are RC A, not a config bug — the
payload-capture poll is a downstream symptom of the failed run.

Determinism pillar violated: **Pillar 1 — Proof** (internal media pipeline must run real
prod code; a defect-class `INTERNAL` means prod media generation is broken) and the
debugging doctrine that `e2e/report/<latest>/` is the single source of truth — see the
reporting gap below.

Long-term fix (not a skip/timeout): fix the media node's `mapFilePart`/persist wiring so a
media turn completes; add a media **integration test** (`apps/api`, real local MinIO) that
drives one image + one video turn end-to-end through the engine → `storage.put` →
download round-trip, asserting `outcome:'succeeded'` and a non-empty content_item. That
turns any `INTERNAL` defect red at Rung 3 before it reaches E2E.

Enforcement rung to kill the class: Rung 3 CI contract/integration test on the media node
(engine media-execution + persist). Additionally Rung 1: make `mapFilePartFor` non-optional
for media nodes at the type level so an unwired mapper is a build error rather than a
runtime `AdapterDefect`.

---

## Root Cause B — `/dev/media-conversation` returns 404 `NOT_FOUND` (7 tests)

Symptom: fixture setup throws `image|video conversation creation failed: 404`
(`e2e/fixtures.ts:804-807`, `seedMediaConversation`).

Trace evidence: `POST http://localhost:8788/dev/media-conversation` →
`status:404`, `Content-Type: application/json`, body `{"code":"NOT_FOUND"}`
(`trace/resources/97f53f17...json`). A JSON `NOT_FOUND` (not an unmatched-route HTML 404)
means the handler RAN and returned a domain error.

Path: route `apps/api/src/platform/dev/routes.ts:391-412` → `seedMediaWork` (`:290`) →
`createDevMediaConversation` (`apps/api/src/platform/dev/factories.ts:491`). Any thrown
`DevSeedError` is mapped to `notFoundError` → 404 by `liftDevWork`
(`apps/api/src/platform/dev/routes.ts:98-104`).

Which `DevSeedError`? Discriminated:
- NOT `pickSeedTextModels` "no text models exposed" (`factories.ts:110`): the shared
  `/dev/conversation` seed uses the same `pickSeedTextModels` and works across the suite,
  so text models ARE exposed.
- NOT `requireUser` "User not found" (`factories.ts:74`): the fixture depends on
  `authenticatedPage`, and RC A tests prove alice exists and can send.
- Remaining media-specific steps: the R2 `storage.put` of the encrypted media bytes
  (`factories.ts:542-545`, `unwrapSeed(..., 'media upload')`) or the `runSettlement`
  sequence/insert block (`:548-586`). This is the SAME media-bytes-to-R2 seam as RC A,
  so RC A and RC B are almost certainly one underlying regression (media persistence /
  R2 storage) surfacing on two entry paths (real send vs dev seed).

Where the defect lives: app dev-seed/media-persist path (or the R2 storage adapter /
MinIO harness config). Cannot be split app-vs-infra from the artifacts — see reporting gap.

Tests in this bucket (all use `imageConversation`/`videoConversation` fixtures):
- image: download-link-blob, page-reload, r2-read-failure-placeholder, fits-within-viewport.
- video: download-link-blob, page-reload, fits-within-viewport.

Pillar violated: **Pillar 1 — Proof** (1.5, assert real side effect) and Rung-4 fixture
integrity — a dev-seed fixture that 404s should fail LOUD with the underlying
`DevSeedError` message, not an opaque `NOT_FOUND`.

Long-term fix: same media-persist/storage fix as RC A. Independently, make `liftDevWork`
preserve the `DevSeedError` message in the 404 body (or map storage failures to a distinct
`UNAVAILABLE`/500 code) so a dev-seed failure is diagnosable from the report.

Enforcement rung: Rung 3 integration test on `createDevMediaConversation` against real
MinIO (a `factories.integration.test.ts` case already exists — extend it to assert the
stored object is retrievable). Rung 4: an e2e harness pre-flight fixture that pings
`/dev/media-conversation` once and hard-fails the run with the server error if storage is
down, distinguishing host-flake from app defect (Pillar 2.10).

---

## Root Cause C — default video model changed → media config UI regressions (3 tests)

Symptom (pure UI, NO `POST /chat`, NO `INTERNAL`):
- `resolution buttons render...` and `resolution choice flows...`:
  `getByRole('button',{name:'1080p'})` not visible.
- `cost preview increases 1080p→4k`: duration slider `toHaveValue` expected `"6"`,
  received `"8"`.

Root cause: the config panel derives resolutions/durations from the *selected* video model
(`apps/web/src/components/chat/media/modality-config-panel.tsx:132-165`, intersect of
`pricePerSecondByResolution` keys of `selections.video`). The default selection is picked
positionally: `useResolveDefaultModel` →
`resolveDefault` does `models.find((m) => m.modality === modality && ...)`
(`apps/web/src/hooks/models/use-resolve-default-model.ts:27-32`) — the FIRST video model in
`modelsData.models` order.

The catalog/popularity overhaul re-ordered `/models`. In the captured response the first
video model is now `kwaivgi/kling-v3.0-pro` (resolutions `['720p']` only, and its default
duration is 8s), NOT `google/veo-3.1-lite` (`['720p','1080p']`). Media models all carry
`popularityRank: null`, so ordering falls to whatever secondary order the overhaul
produced — and it put a 720p-only kling model first.

The specs hardcode veo as the default ("Mock Veo 3.1 supports 720p and 1080p",
`e2e/chat/video-generation.spec.ts:74`), so:
- 1080p pill never renders (default model is 720p-only) → both resolution tests fail.
- default duration is 8, not 6 → duration slider test fails.

INTENT CONFLICT: the app selects the first-listed runnable video model (order-dependent,
now kling-v3.0-pro); the tests assume the default is veo-3.1-lite. Neither side is
obviously "wrong" — the app default is legitimately reorderable, and the test's assumption
was silently coupled to catalog order. Flagging rather than picking a side.

Where the defect lives: app (order-dependent default pick is non-deterministic w.r.t.
catalog refresh) AND/OR test (hardcoded veo capabilities). The generation itself is fine
for kling (mock synthesizes for any media id) — only the config Uw derives from the model.

Pillar violated: **Pillar 2 — No flakes / determinism** (2.4 control inputs) — the default
media model must be deterministic and independent of live-catalog ordering.

Long-term fix: make the default media model deterministic and pinned for E2E — e.g., the
app picks a default by an explicit descriptor flag / stable key (not array position), and
E2E pins the default image/video default to `E2E_MODELS.image[0]` / a chosen
`E2E_MODELS.video` id. Then assert config capabilities against THAT pinned model.

Enforcement rung: Rung 3 contract test asserting `resolveDefault(modality)` returns a
deterministic id given the E2E catalog (not "first by array order"); Rung 1 if the default
becomes a typed descriptor field rather than positional `.find`.

---

## Root Cause D — multi-model-media IMAGE: duplicate-id selection (4 tests) — RESOLVED (Task-17)

Resolution: the seed now injects a synthetic second exposed strict-`["image"]`
model (`E2E_SEEDED_IMAGE_MODEL_ID` = `hushbox-e2e/mock-image-2`, via
`scripts/lib/e2e-seeded-image-model.ts` through the models slice's `upsertCatalog`
barrel), and `IMAGE_MODELS` in the spec now selects two DISTINCT ids. There is no
intentional-red marker anymore. The diagnosis below is retained for provenance.

Symptom: `getByTestId('model-item-bytedance-seed/seedream-4.5')` never reaches
`data-selected="true"` (stays `false` through 24 poll attempts; the item IS present and
even pulses/rings, so it is addressable but not *selected*).

Root cause is documented in the spec itself
(`e2e/chat/multi-model-media.spec.ts:7-18`): `IMAGE_MODELS =
['bytedance-seed/seedream-4.5','bytedance-seed/seedream-4.5']` — the SAME id twice, because
the live catalog exposes only ONE strict-image ZDR model. The picker toggles selection per
id, so `selectModelsByIds` clicks the id, selects it, then clicks the *same* id again and
DESELECTS it → `data-selected` ends `false` and the helper's wait times out (the original
duplicate-id `IMAGE_MODELS`).

The catalog exposed only one live ZDR strict-image model (the other is token-priced and
excluded at settlement — a founder-ruled billing guard, not relaxable). Task-17 resolves it
by injecting a deterministic synthetic second strict-image row at seed time (kept OUT of
`E2E_MODELS.image`, which is validated pre-seed against the live catalog), giving a genuine
two-distinct-model fan-out without touching the settlement gate.

Tests: two-image-models-render-distinct, failing-image-model-shows-error-tile,
fork-from-multi-model-image-branch, multi-model-image-responses-survive-reload.

Pillar/rule: Pillar 1 (Proof) — a genuine 2-distinct-image fan-out cannot be proven with
one exposed image id. Enforcement (Rung 3, implemented by Task-17):
`assertSeededImageModelPresent` fails the seed loud unless the synthetic second exposed
strict-image row is present, so the two-distinct catalog is guaranteed at `e2e:prepare`.

---

## Cross-cutting finding — reporting/enforcement gap (blocks RC A/B triage)

The E2E report (`e2e/report/<latest>/`) captures browser console + network + trace, but
NOT the API Worker's server-side logs. RC A (`INTERNAL`) and RC B (`NOT_FOUND`) are both
server-side defects whose actual cause (mapFilePart AdapterDefect vs media-persist vs R2
storage vs MinIO down) is invisible from the artifacts — `grep` over `report.json` yields
only `ChatRunFailedError: INTERNAL` (18×) and `{"code":"NOT_FOUND"}`, never the server
reason. This violates the doctrine (`e2e/CLAUDE.md`) that the report dir is "the single
source of truth when tests fail."

Enforcement fix (Rung 5): capture the api-worker stderr/log stream into
`e2e/report/<latest>/server.log` (or attach the failing run's server error to the failed
test via the auto-fail fixture) so a media `INTERNAL` is root-causable without re-running.

---

## Bucket → test map (31 total)
- RC A (15): img/video not visible + `INTERNAL` — image{edit, cost-badge, long-prompt,
  regenerate, retry, switches, aspect-payload}, video{edit, cost-badge, regenerate,
  playback, retry, switches, 9:16-aspect-payload}, mmm{failing-video, two-video},
  realtime-media{bob-sees-alice}.
- RC B (7): `/dev/media-conversation` 404 — image{download-link, page-reload,
  r2-read-failure, fits-viewport}, video{download-link, page-reload, fits-viewport}.
- RC C (3): default-video-model config UI — video{resolution-buttons, resolution-choice,
  cost-preview-duration}.
- RC D (4, RESOLVED by Task-17): mmm{two-image, failing-image, fork-image, image-reload}.

Confidence: RC C and RC D are pinned to exact code + evidence. RC A/B are pinned to the
symptom, the entry paths, and the media-persist/storage seam, but the exact throwing line
(mapFilePart AdapterDefect vs storage.put vs MinIO) needs the missing server log to finalize;
RC A and RC B are very likely one regression on that seam.
