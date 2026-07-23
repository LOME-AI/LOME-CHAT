# OpenRouter max-output-tokens data: what ingestion receives vs. discards

Factual code survey. No recommendations. All citations verified against the current
worktree (2026-07-23).

---

## 1. Raw schema and normalization — `normalize.ts` + `gateway-metadata.ts`

**Files:**
- `apps/api/src/slices/models/domain/gateway-metadata.ts` (522 lines) — raw Zod schemas for
  the four OpenRouter endpoints, and the mapping into the typed `GatewayCatalog` seam.
- `apps/api/src/slices/models/domain/normalize.ts` (745 lines) — maps `GatewayCatalog` →
  `ModelDescriptor` content.
- Caller: `apps/api/src/slices/models/domain/refresh.ts:5,207` —
  `import { EXCLUDE_REASONS, normalizeCatalog } from './normalize.js'` /
  `const entries = normalizeCatalog(catalog.models, catalog.zdrModelIds);`. This is the only
  non-test caller of `normalizeCatalog` in the repo.

### 1a. Does the raw Zod schema include a max-completion/output-tokens field?

**No.** `top_provider` and `max_completion_tokens` do not appear anywhere in
`gateway-metadata.ts`, nor anywhere else under `apps/api/src/slices/models/` source. A
repo-wide grep for `top_provider|max_completion_tokens` across `apps/api` and `docs` returns
zero hits in source; the only two repo hits are prose in a historical research doc (§5).

The `/models` entry schema — `modelsEntrySchema`, `gateway-metadata.ts:32-61` — is a
`z.looseObject`:

```ts
const modelsEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  context_length: z.number().nullish(),
  architecture: z.looseObject({
    input_modalities: z.array(z.string()).nullish(),
    output_modalities: z.array(z.string()).nullish(),
  }).nullish(),
  pricing: modelsPricingSchema.nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  reasoning: z.looseObject({
    mandatory: z.boolean().nullish(),
    supported_efforts: z.array(z.string()).nullish(),
    default_effort: z.string().nullish(),
    default_enabled: z.boolean().nullish(),
  }).nullish(),
  expiration_date: z.string().nullish(),
});
```
(`gateway-metadata.ts:32-61`)

Because it is `looseObject`, any unlisted upstream field — including a hypothetical
`top_provider.max_completion_tokens` — survives Zod parsing as an untyped passthrough
property on the parsed object, but nothing reads it: `languageMetadata()`
(`gateway-metadata.ts:332-352`) only destructures the fields explicitly named in
`modelsEntrySchema`.

Numeric/token-limit-relevant fields that **are** parsed:
- `context_length: z.number().nullish()` — `gateway-metadata.ts:39`
- `supported_parameters: z.array(z.string()).nullish()` — `gateway-metadata.ts:47` (a flat
  array of capability-name strings; `"max_output_tokens"` is one possible entry — see §1c —
  but it is a string flag, not a numeric ceiling)

**No per-endpoint schema is fetched for language models at all.** The four fetched endpoints
are documented at `gateway-metadata.ts:7-22`: `/models` (language), `/endpoints/zdr`,
`/images/models` (+ N+1 `/images/models/{id}/endpoints`), `/videos/models`. There is no call
to OpenRouter's per-model endpoint-listing route (`/models/{author}/{slug}/endpoints`) for
language models anywhere in this file — confirmed by reading `fetchGatewayCatalog`
(`gateway-metadata.ts:509-521`), which combines exactly `fetchLanguageModels`,
`fetchImageModels`, `fetchVideoModels`, `fetchZdrModelIds`. Per OpenRouter's documented shape,
`top_provider.max_completion_tokens` lives on the per-endpoint listing — a response this
codebase never requests for language models, so the field is out of scope of any schema here,
not merely dropped after being seen.

### 1b. Exactly which fields are parsed vs. dropped

`languageMetadata()` (`gateway-metadata.ts:332-352`) reads every field declared in
`modelsEntrySchema` — nothing declared in the schema is left unconsumed for language models.
Then `normalizeLanguage()` (`normalize.ts:151-185`) consumes the typed `LanguageMetadata`
object:

| Field | normalize.ts line |
|---|---|
| `model.deprecated` | 152 |
| `model.outputModalities` | 155 |
| `model.releasedAt` | 159, 167 |
| `model.id` | 163 |
| `model.provider` | 164 |
| `model.inputModalities` | 165 |
| `model.supportedParameters` | 168, 175 |
| `model.contextLength` | 177 — **the only numeric limit field consumed** |
| `model.pricing` | 178 |
| `model.name` / `model.description` / `model.reasoning` | 180–182 |

Fields **absent from the schema entirely** (never parsed, let alone normalized):
`top_provider` and any sub-field (`max_completion_tokens`, per-endpoint `context_length`),
and any endpoint-level max-output-token data — because the endpoint-listing response is never
fetched for language models (§1a).

Image entries (`imagesEntrySchema`, `gateway-metadata.ts:111-124`) and video entries
(`videosEntrySchema`, `gateway-metadata.ts:146-160`) likewise carry no token/output-limit
field in their schemas — confirmed by direct inspection; images carry no context/token field
at all, video carries none either (video's numeric fields are `supported_durations` and
`pricing_skus`, unrelated to token limits).

### 1c. `parameters.maxOutputTokens` capability flag — verbatim, `normalize.ts:64-76`

```ts
const SUPPORTED_PARAMETER_SPECS: Readonly<
  Record<string, { readonly name: string; readonly spec: ParameterSpec }>
> = {
  temperature: {
    name: 'temperature',
    spec: { type: 'number', min: 0, max: 2, wire: 'firstClass' },
  },
  top_p: { name: 'topP', spec: { type: 'number', min: 0, max: 1, wire: 'firstClass' } },
  max_output_tokens: {
    name: 'maxOutputTokens',
    spec: { type: 'integer', min: 1, wire: 'firstClass' },
  },
};
```

Verified verbatim at `apps/api/src/slices/models/domain/normalize.ts:64-76`.

**Confirmed: this carries no numeric ceiling from OpenRouter.** It is a `ParamSpec`
capability flag, `{ type: 'integer', min: 1, wire: 'firstClass' }` — populated into a
model's `descriptor.parameters.maxOutputTokens` only when the literal string
`"max_output_tokens"` is present in OpenRouter's `supported_parameters` array, via
`seedParameters()` (`normalize.ts:90-97`, called from `normalizeLanguage` at
`normalize.ts:168`). It declares only that the model *accepts* a request-side
`maxOutputTokens` call parameter, with a floor of `min: 1` and **no `max`**. There is no
upstream numeric ceiling anywhere in this structure.

### Consumers of `maxOutputTokens` across the repo

All non-test occurrences of `maxOutputTokens` are the **request-side / caller-declared**
value — how many output tokens the caller wants generated — never a value read out of
OpenRouter catalog metadata:

- `apps/api/src/slices/models/adapters/language-adapter.ts:55,371,387,389` — request-param
  Zod schema (`z.number().int().positive().optional()`) and mapping into the AI SDK call.
- `apps/api/src/slices/models/domain/estimate-run.ts:397-407` — `declaredOutputCeiling()`:
  uses the caller-declared `params['maxOutputTokens']` (bounded by `contextLength`, never by
  any OpenRouter max-output field) as the admission-estimate output-leg ceiling; falls back
  to the full `contextLength` when absent or invalid (see §3 for full excerpt).
- `apps/api/src/slices/models/domain/smart-model-candidates.ts:83,90` —
  `SmartModelCandidateEntry.maxOutputTokens`: an affordability-computed ceiling (balance /
  rate / `contextLength`), not sourced from OpenRouter metadata.
- `apps/api/src/slices/workflows/builder/smart-model.ts:12`,
  `apps/api/src/slices/workflows/nodes/smart-model-execution.ts:206,342,360,362,366,389` —
  Smart Model node execution wiring the computed cap into `modelCall` params.
- `apps/api/src/slices/chat/domain/turn-definition.ts:354,376,493-520,543,566,599,639,932,1012`
  — `maxOutputTokensParams()` / `answerNodeParams()`, deriving the request param from
  `answerTokens` + reasoning budget.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts:180,269` — reads a candidate's
  computed `maxOutputTokens` into the executed node's params.
- `apps/web/src/components/chat/input/prompt-input.tsx:799`,
  `reasoning-effort-menu.tsx:45,70,93,106,303,312` — UI: budget-derived `maxOutputTokens`
  bounding reasoning-effort option availability.
- `apps/web/src/hooks/billing/use-budget-calculation.ts:54,66,154`,
  `use-prompt-budget.ts:77,512,519,549` — client-side affordability computation of
  `maxOutputTokens` from wallet balance and pricing.
- `packages/shared/src/estimate/reducers.ts:107,120,136,142,143` — canonical estimator:
  `maxOutputTokens = floor((balance − fixed)/rate)`.
- `packages/shared/src/estimate/smart-model-affordability.ts:204,210,305` — per-candidate
  `cap` in the shared affordability core.
- `packages/shared/src/budget.ts:20,142,153,189,225` — low-balance warning threshold logic.
- `packages/shared/src/workflow.ts:115` — workflow node-param Zod schema
  (`z.number().int().positive().optional()`).

None of these read a numeric max-output ceiling out of OpenRouter's catalog data — every one
computes it from balance/pricing/`contextLength`, or takes it as user- or system-declared
input.

---

## 2. Fixtures and cassettes

**Live cassettes:** none present in this checkout. `.ai-cassettes/` is git-ignored
(`.gitignore:41-43`) and is restored only inside CI via `actions/cache`
(`docs/CI-CASSETTES.md:136-152`); `find` for `.ai-cassettes` returns nothing in this worktree.
A cassette-backed integration test exists —
`apps/api/src/slices/models/domain/gateway-metadata.integration.test.ts:34-77` — calling
`fetchGatewayCatalog` through `createCassetteFetch`, but it asserts only loose structural
invariants (`catalog.models.length > 0`, source ∈ `{language,image,video}`,
`gateway-metadata.integration.test.ts:63-72`), never inspecting individual field values. So
there is no in-repo record of real OpenRouter payload contents to inspect.

**Synthetic fixtures** — `apps/api/src/slices/models/domain/gateway-fixtures.ts`, explicitly
documented as hand-authored, never recorded from the live gateway
(`gateway-fixtures.ts:1-9`: "SYNTHETIC OpenRouter catalog fixtures … authored from
OpenRouter's documented metadata format … never recorded from the live gateway").

1. Language / `/models` entry — `gateway-fixtures.ts:21-36`:
   ```ts
   export function modelEntryFixture(
     overrides: Record<string, unknown> = {}
   ): Record<string, unknown> {
     return {
       id: 'openai/gpt-test',
       name: 'GPT Test',
       description: 'A test model',
       created: 1_700_000_000,
       context_length: 128_000,
       architecture: { input_modalities: ['text'], output_modalities: ['text'] },
       pricing: { prompt: '0.0000025', completion: '0.00001' },
       supported_parameters: ['temperature', 'top_p', 'max_output_tokens'],
       expiration_date: null,
       ...overrides,
     };
   }
   ```
   `context_length: 128_000` is the only numeric limit field present. No `top_provider` or
   `max_completion_tokens` key appears. `"max_output_tokens"` is present only as a string
   inside `supported_parameters` (the capability-flag list, §1c) — not a numeric field.
   This fixture (without a `context_length` override) is reused in
   `refresh.integration.test.ts:119,210,236,267` and
   `pricing-resolver.integration.test.ts:83,102`; none of these add a `top_provider` or
   `max_completion_tokens` key.

2. Image / `/images/models` entry — `gateway-fixtures.ts:39-55`: no context-length or
   max-output field of any kind.

3. Video / `/videos/models` entry — `gateway-fixtures.ts:66-84`: carries `pricing_skus` (a
   duration-keyed rate dict) but no token/output-limit field.

**Gap:** no fixture, cassette, or test anywhere in the repo contains a `top_provider` object
or a `max_completion_tokens` key — the synthetic fixtures don't include it because the schema
never asks for it, and no live cassette exists locally to check the real payload shape
against.

---

## 3. `descriptor.limits` population and consumers

### Population — confirmed `contextLength`-only

- Language: `normalize.ts:177` —
  `limits: model.contextLength === undefined ? {} : { contextLength: model.contextLength }`
- Image: `normalize.ts:294` — `limits: {}` (always empty; verified in context at
  `normalize.ts:286-299`)
- Video: `normalize.ts:538` — `limits: {}` (always empty)
- Catalog-entry merge/fold: `normalize.ts:664` — `limits: { ...next.limits, ...base.limits }`
  (shallow merge; still only ever carries the single `contextLength` key produced above)
- Shared schema: `packages/shared/src/model-descriptor.ts:100` —
  `limits: z.record(z.string(), z.number())` — an open string→number map at the type level,
  populated everywhere in the codebase with only the one key `contextLength`.

### Consumers of `descriptor.limits` / `limits['contextLength']`

Backend (`apps/api`):
- `apps/api/src/slices/models/domain/list-models.ts:154` —
  `const contextLength = family === 'language' ? (descriptor.limits['contextLength'] ?? 0) : 0;`
  — sets the per-model wire `contextLength` field served to the frontend catalog
  (spread into the wire candidate at `list-models.ts:160`).
- `apps/api/src/slices/models/domain/list-models.ts:193` —
  `const contexts = pool.map((entry) => entry.limits['contextLength'] ?? 0);` inside
  `smartModelCandidate()`, feeding `contextLength: Math.max(...contexts)` at
  `list-models.ts:201` for the synthetic "Smart Model" wire entry.
- `apps/api/src/slices/models/domain/smart-model-candidates.ts:200` — `toPoolCandidate()`
  copies `contextLength` into the shared affordability-pool candidate shape.
- `apps/api/src/slices/models/domain/estimate-run.ts:365-370` — reads
  `descriptor.limits[CONTEXT_LENGTH_LIMIT]` (`CONTEXT_LENGTH_LIMIT = 'contextLength'`,
  `estimate-run.ts:96`); a model with no context limit fails the estimate with a
  `validationError` rather than proceeding:
  ```ts
  const contextLength = descriptor.limits[CONTEXT_LENGTH_LIMIT];
  if (contextLength === undefined) {
    return err(
      validationError(`Model '${modelId}' declares no context-token limit to bound the estimate`)
    );
  }
  ```
  (`estimate-run.ts:365-370`)
- `apps/api/src/slices/models/domain/estimate-run.ts:390-393` — `inputTokenCeiling()`: bounds
  the input-leg admission estimate by `contextLength`.
- `apps/api/src/slices/models/domain/estimate-run.ts:402-407` — `declaredOutputCeiling()`:
  bounds the output-leg admission estimate by `contextLength` when the caller declared no
  `maxOutputTokens` (or an invalid one) — i.e. `contextLength` is the current stand-in proxy
  for an output-token ceiling in the absence of any parsed OpenRouter max-output field:
  ```ts
  function declaredOutputCeiling(params: Record<string, unknown>, contextLength: number): number {
    const declared = params['maxOutputTokens'];
    if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
      return Math.min(contextLength, declared);
    }
    return contextLength;
  }
  ```
  (`estimate-run.ts:402-407`)
- `apps/api/src/slices/chat/domain/turn-definition.ts:475-483` — `turnModelPricings()`:
  requires `contextLength` to be defined per model or the whole pricing lookup returns
  `undefined`.
- `packages/shared/src/estimate/reasoning-plan.ts:136-140` — `reasoningPlanModelFrom()`: maps
  `descriptor.limits['contextLength']` into `ReasoningPlanModel.contextLength`, consumed by
  the shared reasoning-effort-ladder planner.

Frontend (`apps/web/src`) — downstream consumers of the wire-level `contextLength` field the
API already derived from `.limits` (not the `.limits` object itself), grep-matched on
`contextLength` in non-test files:
- `components/chat/input/reasoning-effort-menu.tsx`
- `components/chat/model-selector/model-info-panel.tsx`
- `components/chat/model-selector/model-selector-helpers.ts`
- `hooks/billing/use-budget-calculation.ts`
- `hooks/billing/use-prompt-budget.ts`
- `hooks/chat/use-reasoning-effort.ts`

Breadth note: this is the main location set (backend domain layer + shared estimator +
frontend hook/component names touching `contextLength`), not an exhaustive line-by-line
audit of every frontend usage site.

---

## 4. `parameters.maxOutputTokens` — summary confirmation

Restated for clarity against the task's framing: the ParamSpec at `normalize.ts:72-75`
(`{ type: 'integer', min: 1, wire: 'firstClass' }`, keyed under
`descriptor.parameters.maxOutputTokens`) is a boolean-style capability flag (present/absent
per model, driven by membership of `"max_output_tokens"` in OpenRouter's
`supported_parameters` list) with a hardcoded floor of `1` and no ceiling. It carries no
model-specific numeric maximum. All numeric ceilings applied to `maxOutputTokens` requests
elsewhere in the codebase are computed from `descriptor.limits['contextLength']` or from
balance/pricing affordability math (§1c, §3) — never from an OpenRouter-supplied per-model
max-output value, because no such value is ever fetched or parsed (§1a).

---

## 5. Related prior research (context only, not current documentation)

`docs/plans/runs/2026-07-21-reasoning-effort/research/openrouter-reasoning.md:112,401` is the
only other place in the repo mentioning `max_completion_tokens` or `top_provider` — a
historical research doc (a `docs/plans/runs/` run record per repo convention, not current
documentation). It states (that doc's own methodology labels this "Inferred," not "Verified")
that OpenRouter's effort→budget math falls back to "the endpoint's `max_completion_tokens`
(the model's max output)" when `max_tokens` is unset, and separately notes
(`openrouter-reasoning.md:171-174`) that "the catalog slice already snapshots `/models`
hourly; these fields ride the same response, so discovery is a snapshot-schema addition, not
a new fetch … Inferred that the current snapshot drops these fields — confirm in `apps/api`
catalog code during planning." Per the code inspected in §1 above, that gap was never closed:
the current schema and fetch set do not include `top_provider` or `max_completion_tokens` in
any form, for any of the three model families.
