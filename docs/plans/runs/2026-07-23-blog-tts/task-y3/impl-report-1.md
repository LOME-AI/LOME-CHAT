# Y3 — One source for the TTS voice ids (impl report 1)

## Objective

Give the five TTS voice ids exactly one declaration. They were declared independently as a
hand-written TypeScript union in the engine and as a Zod enum in the shared preferences
schema; drift between them would let a persisted preference and the speech engine disagree.

## Files changed

- `packages/shared/src/schemas/accessibility-preferences.ts` — added the single declaration
  `TTS_VOICE_IDS` (readonly tuple) plus the derived `TtsVoice` type; the `ttsVoice` field now
  builds its enum from that tuple instead of restating the ids.
- `packages/shared/src/schemas/accessibility-preferences.test.ts` — new test pinning that the
  exported list is exactly what the `ttsVoice` preference accepts.
- `packages/ui/src/components/accessibility/lib/tts-engine.ts` — the engine's `TtsVoice` union
  is now a re-export of the shared type; `TTS_VOICES` is derived from `TTS_VOICE_IDS` mapped
  over a `Record<TtsVoice, …>` of presentation metadata, replacing the hand-written array.

## Old vs new declarations

Before — two independent declarations:

```ts
// packages/ui/.../tts-engine.ts:24
export type TtsVoice = 'af_heart' | 'am_michael' | 'bf_emma' | 'bm_george' | 'af_nicole';

// packages/shared/.../accessibility-preferences.ts:29-31
ttsVoice: z.enum(['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'])
  .default('af_heart'),
```

After — one declaration in shared, everything else derived:

```ts
// packages/shared/.../accessibility-preferences.ts
export const TTS_VOICE_IDS = ['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'] as const;
export type TtsVoice = (typeof TTS_VOICE_IDS)[number];
...
  ttsVoice: z.enum(TTS_VOICE_IDS).default('af_heart'),

// packages/ui/.../tts-engine.ts
import { TTS_VOICE_IDS } from '@hushbox/shared';
import type { TtsVoice } from '@hushbox/shared';
export type { TtsVoice } from '@hushbox/shared';
const VOICE_PRESENTATION: Record<TtsVoice, Omit<TtsVoiceMeta, 'id'>> = { … };
export const TTS_VOICES: readonly TtsVoiceMeta[] = TTS_VOICE_IDS.map((id) => ({
  id, ...VOICE_PRESENTATION[id],
}));
```

The engine keeps exporting the name `TtsVoice`, so no consumer import changed. The shared type
is named `TtsVoice` (not `TtsVoiceId`) deliberately: the plan's §Interfaces note records that
`TtsVoiceId` "does not exist — use `TtsVoice`", and one concept should keep one name.

## Proof there is now exactly one declaration

Repo-wide grep for the five id strings across production source (`--include=*.ts,*.tsx,*.astro`
over `packages apps e2e scripts`, excluding `node_modules`, `*.test.*`, `/legacy/`, and build
`dist/` output):

```
packages/shared/src/schemas/accessibility-preferences.ts:9-13   ← the one declaration
packages/shared/src/schemas/accessibility-preferences.ts:44     ← .default('af_heart') (a value, not a list)
packages/ui/.../tts-engine.ts:44-48                             ← VOICE_PRESENTATION keys
```

`dist/` hits (`packages/shared/dist/**`, `apps/api/dist/**`) are stale build artifacts generated
from this same schema, not declarations.

The remaining `tts-engine.ts` occurrence is the **keys of a total mapping**, not a second list:
`Record<TtsVoice, …>` is exhaustive and exact, so it cannot drift from the shared declaration in
either direction. Proven by temporarily editing the file and running `tsgo --noEmit` (both edits
reverted immediately; `git diff` confirms the file is back to the shipped version):

- Removing `bf_emma`:
  `error TS2741: Property 'bf_emma' is missing in type '{…}' but required in type
  'Record<"af_heart" | "af_nicole" | "am_michael" | "bf_emma" | "bm_george", Omit<TtsVoiceMeta, "id">>'.`
- Adding an unknown `af_sky`:
  `error TS2353: Object literal may only specify known properties, and 'af_sky' does not exist in
  type 'Record<…>'.`

Deliberate limit: `displayName`/`accent`/`gender` stay in `packages/ui` — presentation metadata
does not belong in the shared persistence schema, and hoisting it would ripple into API contract
types for no correctness gain.

## Evidence of no behaviour change

- Runtime voice list is byte-identical to the pre-change literal. `TTS_VOICES` was serialized
  after the change and compared with the exact pre-change array:
  `IDENTICAL TO PRE-CHANGE LITERAL: true`, value
  `[{"id":"af_heart","displayName":"Heart","accent":"American","gender":"female"},{"id":"am_michael",…,"Michael",…},{"id":"bf_emma",…,"Emma",…},{"id":"bm_george",…,"George",…},{"id":"af_nicole",…,"Nicole",…}]`
  — same five entries, same order, same fields.
- The pre-existing engine test `TTS_VOICES > contains five expected voice ids in documented order`
  still asserts the hard-coded id list and still passes; it was deliberately left hard-coded so it
  keeps catching an unintended change in shared, rather than becoming tautological.
- Default voice unchanged: the pre-existing shared test
  `expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.ttsVoice).toBe('af_heart')` passes, as does
  `rejects invalid ttsVoice value` (`cf_unknown`).
- The schema's public shape is unchanged — same field, same five enum members in the same order,
  same `.default('af_heart')`. `apps/api/src/slices/account/domain/preferences.ts:2` imports
  `accessibilityPreferencesSchema`/`reconcileAccessibilityPreferences` rather than restating them,
  so no API contract or persisted-preference validation ripple exists.
- 1893 `@hushbox/ui` tests and all `packages/shared/src/schemas` tests pass unchanged.

## Consumers of the old union, and why each is unaffected

All import `TtsVoice` from the engine (or a package subpath to it); the name and the set of
members are unchanged, so all are pure no-ops at the type level:

- `packages/ui/.../lib/tts-worker-protocol.ts` (worker message types)
- `packages/ui/.../lib/tts-stream-feeder.ts`
- `packages/ui/.../lib/document-reader.ts`
- `packages/ui/.../sections/audio.tsx` (also consumes `TTS_VOICES` to render the voice select —
  same array, same order, so the option list and its ordering are unchanged)
- `packages/ui/.../blog-reader/blog-read-aloud.tsx`
- `apps/web/src/lib/tts-dom-observer.ts` (via `@hushbox/ui/accessibility/lib/tts-engine`)
- Tests that mock the engine module with a partial `TTS_VOICES`
  (`accessibility-panel.test.tsx`, `sections.test.tsx`, `tts-dom-observer.test.ts`) are unaffected
  — they replace the export rather than derive from it.

New dependency edge: `tts-engine.ts` gains a **value** import from `@hushbox/shared`. No new
package dependency (`@hushbox/ui` already depends on `@hushbox/shared`) and no new bundle edge in
the blog path — sibling modules `lib/tts.worker.ts`, `lib/profiles.ts`, `sections/audio.tsx`, and
`blog-reader/blog-read-aloud.tsx` already import the same barrel. Import direction is unchanged:
`shared` gained nothing from `ui`.

## Tests added

- `TTS_VOICE_IDS > lists exactly the voices the ttsVoice preference accepts`
  (`packages/shared/src/schemas/accessibility-preferences.test.ts`) — every exported id parses
  through `accessibilityPreferencesSchema` as itself, and the list is length 5. This is the pin
  that the enum is built from the exported declaration.
  - RED verified before implementation: `TypeError: TTS_VOICE_IDS is not iterable` at
    `accessibility-preferences.test.ts:12` (1 failed | 75 passed).
  - GREEN after: 76 passed.

## Self-gate

Run from the repo root via `npx tsx scripts/with-env.ts turbo … --force` (`--force` to defeat
warm-cache masking), plus per-package `eslint`/`tsgo` after the final edit.

| Command | Result |
| --- | --- |
| `turbo test typecheck lint --filter=@hushbox/ui --force` | test PASS (94 files, 1893 tests, coverage gate enabled and green), typecheck PASS, lint PASS — `Tasks: 3 successful` for `@hushbox/ui`, all cache-bypassed |
| `turbo test typecheck lint --filter=@hushbox/shared --force` | test FAIL (1 file of 131), typecheck FAIL, lint FAIL (83 problems) — **all failures foreign** (see attribution) |
| `cd packages/ui && npx eslint .` (after last edit) | exit 0 |
| `cd packages/ui && npx tsgo --noEmit` | exit 0 |
| `cd packages/shared && npx eslint src/schemas/accessibility-preferences.ts src/schemas/accessibility-preferences.test.ts` (after last edit) | exit 0 |
| `pnpm test:watch packages/shared/src/schemas/accessibility-preferences.test.ts` | 76/76 pass |
| `pnpm test:watch packages/ui/src/components/accessibility/lib/tts-engine.test.ts` | 63/63 pass (63/63 before the change too — same tests, same count) |

One lint error was raised by my own first cut and fixed before final gate:
`tts-engine.ts:34 error unicorn/prefer-export-from — Use \`export…from\` to re-export \`TtsVoice\``.
Resolved by `export type { TtsVoice } from '@hushbox/shared';`; `eslint .` then exits 0.

### Attribution of the red `@hushbox/shared` gate (foreign, not fixed)

Every failure is in `packages/shared/src/affordability/**`, which the concurrent
affordability-remediation workstream is mid-flight on (`git diff --stat` shows large uncommitted
changes across `src/affordability/**` that I did not make). Nothing under `src/schemas/**` fails.

- typecheck: ~50 errors, all `src/affordability/**`, dominated by
  `Type 'string' is not assignable to type 'string & $brand<"ModelId">'` (in-flight ModelId
  branding). `npx tsgo --noEmit | grep -c "schemas/"` → `0`.
- test: 6 failed of 3082, in `src/affordability/premium.test.ts`,
  `src/affordability/priceable-model.test.ts`, `src/affordability/turn-options.purity.test.ts`.
  `src/schemas/accessibility-preferences.test.ts` is among the 127 passing files.
- lint: 6 problems in `src/affordability/dimensions/re-partition.test.ts`,
  `turn-arithmetic.test.ts`, `turn-core.ts`, `turn-options.ts`.

The failure set **moved between two runs ~20 minutes apart**, which is itself evidence the
directory is being actively edited by another agent: the final gate run showed a different
picture — 1 failing test file (`src/affordability/classifier-choice.test.ts`, failing at module
load with `Cannot find module './classifier-choice.js'`, i.e. a test committed ahead of its
source), and lint grown from 6 problems to 83, still entirely under `src/affordability/**`.
Re-checked after that run: `eslint src/schemas/accessibility-preferences{,.test}.ts` exits 0 and
`tsgo --noEmit` reports 0 errors under `src/schemas/`.

## Acceptance criteria

1. **Five voice ids have exactly one declaration** — met. Single `TTS_VOICE_IDS` tuple in shared;
   the Zod enum, the engine type, and the engine's runtime voice list all derive from it. The only
   other occurrence of the strings in production source is an exhaustive `Record` key set, proven
   above to be a compile error in both drift directions.
2. **Union derived from the enum, not restated** — met. `TtsVoice` is a re-export of the shared
   type derived from the tuple the enum is built from.
3. **Runtime array derived from the same source** — met. `TTS_VOICES` is `TTS_VOICE_IDS.map(...)`.
4. **No behaviour change** — met. Voice list byte-identical (order included), default still
   `af_heart`, schema public shape unchanged, every consumer compiles and its tests pass.
5. **Import direction preserved** — met. `packages/shared` imports nothing from `packages/ui`;
   the new edge is `ui → shared`, which already existed as a package dependency.
6. **No new dependency** — met.

## Deviations, with reasons

- **The engine side was executed as a refactor, not red-green.** The task's own constraint is "no
  behaviour change", so no ui-side test could legitimately be made to fail first — a new test would
  have passed against the old hand-written union by construction. Instead the existing engine suite
  was run green before the edit (63 passed), the edit made, and the suite re-run (63 passed), with
  the byte-identical `TTS_VOICES` dump as extra evidence. The genuinely new surface (the shared
  `TTS_VOICE_IDS` export) was driven red-green, with the RED failure recorded above. This matches
  AGENT-RULES' refactoring path (tests exist and pass before and after; behaviour unchanged).
- **The existing engine test keeps its hard-coded id list** rather than being rewritten to compare
  against `TTS_VOICE_IDS`. Comparing derived against source would be tautological; the hard-coded
  expectation is a real assertion about the shipped product and now guards changes in shared.
- **Presentation metadata stayed in `packages/ui`** rather than moving to shared (see the
  deliberate-limit note above).

## Concerns and limitations

- `@hushbox/shared`'s package gate cannot be green while the affordability workstream is mid-flight;
  the auditor should judge `src/schemas/**` and the scoped eslint/tsgo runs, not the package gate.
- `packages/shared/dist/**` and `apps/api/dist/**` carry stale pre-change `.d.ts` snapshots of the
  voice union. They are build output, regenerated by the next build; the enum they encode is
  unchanged, so the regenerated declarations will be identical.
- I did not run `apps/web` / `apps/marketing` builds — outside this task's ownership and gates. The
  risk is nil-to-negligible: the added runtime import is five strings from a barrel those bundles
  already import.

## Confidence

**High.** The change is three files, the derived runtime value is proven byte-identical to the one
it replaces, both drift directions on the remaining `Record` keys are proven compile errors, the
`@hushbox/ui` gate (test + coverage + typecheck + lint) is fully green, and every red item in the
`@hushbox/shared` gate is attributed to a concurrently-edited directory I did not touch.
