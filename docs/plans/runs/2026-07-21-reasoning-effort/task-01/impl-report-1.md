# T1 — Catalog: capture per-model reasoning metadata — impl report 1

## Objective

Parse OpenRouter's top-level per-model `reasoning` object (`supported_efforts`, `mandatory`, `default_effort`, `default_enabled`) through the gateway seam into an optional structured `reasoning?` field on `ModelDescriptor`, and expose it on the wire `Model` schema; absent upstream ⇒ field absent; unknown effort strings preserved raw; stored jsonb rows remain parseable; refresh path otherwise unchanged.

## Files changed

- `packages/shared/src/model-descriptor.ts` — new `ModelReasoning` Zod schema + type (the single shared shape); optional `reasoning` field on `ModelDescriptor`.
- `packages/shared/src/index.ts` — barrel export of `ModelReasoning`.
- `packages/shared/src/schemas/api/models.ts` — wire `modelSchema` gains optional `reasoning: ModelReasoning.optional()` (imports the one shared shape — no re-typed mirror).
- `apps/api/src/slices/models/domain/gateway-metadata.ts` — `modelsEntrySchema` parses the top-level `reasoning` looseObject; `LanguageMetadata.reasoning?`; `reasoningOf()` maps snake_case → the shared camelCase shape (null scalar sub-fields collapse to absent; null `supported_efforts` preserved — see Deviations).
- `apps/api/src/slices/models/domain/normalize.ts` — `normalizeLanguage` carries `reasoning` into `DescriptorContent` via an optional spread (absence stays absence); `mergeContent` folds it with base precedence.
- `apps/api/src/slices/models/domain/list-models.ts` — `wireCandidate` projects `descriptor.reasoning` onto the wire model (omitted when absent).

Test files: `packages/shared/src/model-descriptor.test.ts`, `packages/shared/src/schemas/api/models.test.ts`, `apps/api/src/slices/models/domain/gateway-metadata.test.ts`, `apps/api/src/slices/models/domain/normalize.test.ts`, `apps/api/src/slices/models/domain/list-models.test.ts`.

## Tests added (name — behavior — criterion)

model-descriptor.test.ts:

- "parses the optional structured reasoning field" — all four sub-fields round-trip — structured `reasoning?` on `ModelDescriptor`.
- "preserves unknown effort strings raw (no enum narrowing at parse)" — `['ultra-think','max']` kept — unknown-strings-raw criterion.
- "preserves a null supportedEfforts (upstream: every effort accepted) distinct from absent" — tristate kept — lossless parse (see Deviations).
- "parses a reasoning object with every sub-field absent (presence alone is signal)" — `{}` valid.
- "leaves reasoning absent when the source carries none (backward-compatible rows)" — old jsonb rows parse — backward-compat criterion.
- "rejects non-string entries in supportedEfforts" — schema is typed, not `unknown`.

schemas/api/models.test.ts:

- "preserves the optional structured reasoning object" — wire `Model` exposes it — wire-schema criterion.
- "leaves reasoning absent when not declared (backward-compatible wire rows)".

gateway-metadata.test.ts:

- "captures the top-level reasoning object as camelCased metadata" — snake→camel mapping.
- "leaves reasoning undefined when the entry carries no reasoning object" — absent ⇒ absent (131/342 case).
- "preserves a null supported_efforts (all-accepted) distinct from an absent one".
- "omits reasoning sub-fields the entry leaves null or absent" — null scalars collapse.

normalize.test.ts:

- "carries the gateway reasoning metadata into descriptor content" — normalize criterion.
- "leaves the reasoning field absent when the gateway carries no reasoning object" — `'reasoning' in content === false`.
- "round-trips a reasoning-carrying descriptor through the persisted jsonb schema" — content parses under `ModelDescriptor`.
- "carries reasoning through a same-id fold regardless of which sibling declares it" — `mergeContent` determinism (both orders).

list-models.test.ts:

- "projects the descriptor reasoning metadata onto the wire model" — wire exposure end-to-end.
- "omits reasoning from the wire model when the descriptor carries none".

TDD: each new production behavior was watched RED first (5 failed in model-descriptor.test.ts; 1 in models.test.ts; 3 in gateway-metadata.test.ts; 3 in normalize.test.ts; 1 in list-models.test.ts — each failing because the field was stripped/absent), then GREEN after the minimal change. The pure absence-pins passed pre-implementation by construction (they pin existing behavior against regression).

## Self-gate

- `pnpm test:shared` — pass (full package, coverage gate green; model-descriptor.ts and schemas/api/models.ts at existing thresholds).
- `pnpm test:api` — tests all pass; gate exits 1 on ONE per-file coverage threshold **outside my ownership**: `src/slices/workflows/nodes/smart-model-execution.ts` branches 94.73% < 95% (uncovered lines 252-255). Attribution: file untouched by this task (my diff is confined to `slices/models/domain` + `packages/shared`); the plan records this as a known foreign failure (coordinator-confirmed). All models-domain files under test pass; the six targeted test files for my seams ran green in isolation (38 + 79 + 23 api-side; 49 + 41 shared-side).
  - First full run additionally crashed in coverage collection ("Something removed the coverage directory .tmp" / ENOENT `coverage-432.json`) — vitest's own diagnostic names concurrent same-reportsDirectory runs; T12 works in `apps/api` concurrently. Infrastructure, not a test failure; did not reproduce on the re-run.
- `npx turbo typecheck --filter=@hushbox/shared --filter=@hushbox/api --force` — pass (2/2).
- `npx turbo lint --filter=@hushbox/shared --filter=@hushbox/api --force` — pass (2/2). Per-file `eslint` from each package dir on all owned files after the final edit — exit 0 (one prettier violation found and `--fix`ed, tests re-run green after).

## Acceptance criteria

- `normalize.ts` parses top-level `reasoning` into optional structured `reasoning?` on `ModelDescriptor` — **met** (gateway-metadata parses; normalize carries; tests above).
- `supported_efforts` as raw string array — **met** (raw strings, no enum narrowing; unknown levels preserved — pinned by test).
- `mandatory`, `default_effort`, `default_enabled` captured — **met** (camelCased, optional each).
- Wire `Model` schema exposes it — **met** (`modelSchema.reasoning` optional; `wireCandidate` projects it; `safeParse` no longer strips it — pinned).
- Absent object ⇒ field absent — **met** (`'reasoning' in content === false` pinned at normalize; wire omission pinned at list-models).
- Existing stored jsonb rows still parse — **met** (optional additive field on `z.object`; pre-existing descriptor fixtures without `reasoning` parse unchanged — pinned; round-trip test covers new rows).
- Refresh path unchanged otherwise — **met** (no changes to refresh.ts/catalog-store.ts; `DescriptorContent` gains only the optional field, so skip-unchanged content-compare will rewrite a row exactly when a model first gains reasoning metadata — the intended behavior).

## Deviations

- **`supportedEfforts` is `z.array(z.string()).nullable().optional()`, not plain optional array.** Research (`research/openrouter-reasoning.md` §3) documents an upstream tristate: `null` = all efforts accepted, omitted = no effort selection (budget-or-nothing). The T1 criteria say only "raw string array" and don't rule on `null`. Collapsing `null` → absent would silently flip an all-efforts model into budget-native under D1's "presence of `supported_efforts`" branch, so I preserved the tristate losslessly and documented it on the schema. T2 decides the semantics; nothing is interpreted here.

## Concerns and limitations

- Descriptor rows persisted before this change carry no `reasoning`; they gain it on the next hourly refresh (one-time content-hash churn across ~211 language models — expected, no action needed).
- The `behaviors: ['reasoning']` flag (from `supported_parameters`) and the structured `reasoning` object come from different upstream fields (210 vs 211 of 342 per research); they can disagree for a model. T1 carries both verbatim; any reconciliation belongs to T2/T9's capability derivation.
- `packages/shared/src/schemas/api/models.ts` now imports from `src/model-descriptor.ts` (first cross-import between those modules; no cycle — model-descriptor imports nothing from schemas/).

- The shared barrel (`packages/shared/src/index.ts`) gained a concurrent T3 export (`reasoning-format.js`) mid-task from the sibling workstream; I did not touch or depend on it — my only barrel change is the `ModelReasoning` export.

## Confidence

High — pure additive data plumbing, every seam pinned by a red-first test; typecheck + lint green in both packages; the single red gate line is a pre-recorded foreign coverage gap in a file this task never touched.
