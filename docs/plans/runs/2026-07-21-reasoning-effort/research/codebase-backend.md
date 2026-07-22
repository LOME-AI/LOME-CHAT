# Backend/codebase research: "reasoning effort" feature

Repo root: `/workspace/popper-mobile/.superset/projects/HushBox`. All facts below are
Verified by reading the cited files unless marked Inferred/Assumed.

---

## 1. Classifier / Smart Model system

### Where it lives

- **Composite node builder**: `apps/api/src/slices/workflows/builder/smart-model.ts` —
  `smartModel(options: SmartModelOptions): NodeHandle<TextTag>` (lines 31-49). Ports are
  fixed text→text. Builds one `Node` of `type: 'smartModel'` carrying
  `classifierModelId`, `candidates: readonly SmartModelCandidate[]`, optional `params`
  (answer-call params only) and optional `promptInputTokens`.
- **Node execution**: `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` —
  `createSmartModelExecution(deps): NodeExecution` → `runSmartModel()`. Two generations
  under one node:
  1. `classifierCall()` (lines 129-186): builds classifier messages via
     `buildClassifierMessages` (shared), sends `InferenceRequest` with
     `model: node.classifierModelId`, `parameters: { maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP }`
     (=2048), **no history**, and NEVER emits to the client stream (`ctx.emit` not
     called for classifier tokens). Its cost accrues via `ctx.accrue?.()` toward the
     run's cost circuit before the answer call runs.
  2. `answerCall()` (lines 202-229): resolved candidate model, `node.params` (answer
     params — the classifier call never reads them), FULL run history, `ctx.history`,
     `ctx.customInstructions` — streamed via `ctx.emit` (the normal client-visible
     path), reusing `streamModelCall` from `model-call-execution.ts`.
  - Single-candidate short-circuit: zero classifier charge, straight to `answerCall`.
  - Classifier error → fallback to cheapest candidate, no classifier charge.
  - Unresolvable classifier output → fallback to cheapest candidate, classifier
    charge STILL stands (a generation happened).
  - Classifier charge rides the answer's `NodeRunSuccess.auxiliaryCharges` array
    (keyed `<node>#classifier`), so both settle together in the run's one fenced
    settlement transaction.

### Classifier prompt / matching (all in `packages/shared/src/smart-model/`)

- `prompts.ts`: `CLASSIFIER_SYSTEM_PROMPT_MARKER = '[HUSHBOX_CLASSIFIER]'` (lets the
  mock AI client detect classifier calls without prompt-string coupling).
  `CLASSIFIER_MAX_DESCRIPTION_CHARS = 100`. `buildClassifierMessages(input): ClassifierMessage[]`
  returns `[{role:'system', content: <marker + router prompt + model list>}, {role:'user', content: truncatedContext}]`.
  The system prompt instructs: "Reply with ONLY the model id from the list below... Output
  one model id and nothing else." `computeClassifierPromptOverhead()` renders the actual
  prompt with empty context to get an exact char-overhead count (single source, no
  guessed constant).
- `truncate.ts`: `truncateForClassifier({latestUserMessage, latestAssistantMessage})`
  builds a balanced start/end 4-direction (`[USER START]`, `[USER END]`, `[AI START]`,
  `[AI END]`) round-robin snippet, `MAX_CLASSIFIER_CONTEXT_CHARS = 4000`,
  `CLASSIFIER_CHARS_PER_DIRECTION = 1000`, `CLASSIFIER_CHUNK_SIZE = 250`.
- `eligible-models.ts`: `CLASSIFIER_OUTPUT_TOKEN_CAP = 2048` (comment: reasoning-class
  classifier models like `openai/gpt-5-nano` spend output tokens on hidden reasoning
  before emitting the id, so the cap must cover worst-case reasoning headroom + the id
  — this is the single shared home for the cap, imported by both the estimator and the
  node execution; do not move it).
- `resolve.ts`: `resolveClassifierOutput(raw, eligibleIds): string | null` — exact match
  → case-insensitive → bidirectional substring → Levenshtein (tolerance 0.15 ×
  output length). Returns `null` on no confident match.

### Candidate derivation (models slice)

- `apps/api/src/slices/models/domain/smart-model-candidates.ts`:
  `buildSmartModelCandidates(input): SmartModelCandidates | null` — filters
  `descriptors` to `isEngineTextModel` (text-in/text-out runnable shape), sorts
  ascending by `combinedBasePrice` (input+output per-token base rate); the CHEAPEST
  model doubles as `classifierModelId` and the runtime fallback. The candidate menu
  is **balance-independent** (every priceable text model, never balance-scaled) — a
  deliberate property so the admission reserve stays a bounded constant. Affordability
  is a single binary gate (`some candidate the wallet can afford, including the
  classifier reserve`), not a per-candidate filter.
  `classifierReserveLineItems()` / `classifierWorstCaseBaseNanoUsd()` price the
  classifier's worst-case reserve via the shared `classifierLineItems` core.
- `trial-smart-model-candidates.ts` (not fully read, referenced) provides
  `buildTrialSmartModelCandidates` — the trial-eligible text set whose classifier
  reserve + actual message base cost fits the 1¢-per-message trial ceiling.

### The 3-node / turn wiring

- `apps/api/src/slices/chat/domain/smart-model-turn.ts`:
  - `buildSmartModelTurn(params: SmartModelTurnParams): Result<WorkflowDefinition, DomainError>`
    (lines 131-158) builds the ONE-node `smartModel` workflow (not literally
    "3 nodes" in the graph — it's a single composite node containing two internal
    generations; the doc comment in `ARCHITECTURE.md` calls Smart Model "a three-node
    definition" but the actual implementation is one `smartModel` node type doing
    classify→resolve→answer internally).
  - `buildSmartModelTurnDefinition(deps, args)` (paid path, lines 241-269): reads the
    payer's wallet balance (`readBalance`), lists the catalog (`listDescriptors`),
    derives candidates via `buildSmartModelCandidates`, compiles via
    `compileSmartModelBuild`. Returns `SmartModelTurnBuild = {buildable:true, definition} | {buildable:false}`
    (no affordable candidate ⇒ `buildable:false`, refused pre-admission).
  - `buildTrialSmartModelTurnDefinition(deps, args)` (trial path, lines 285-311): no
    wallet, no balance read; uses `buildTrialSmartModelCandidates` and
    `TRIAL_TURN_HOOKS` (no-persist/no-charge policy).
  - `answerMaxOutputTokens()` (lines 77-128): sizes the answer generation's output-token
    ceiling at the WORST-CASE candidate rates against the TIGHTEST candidate context
    window, after deducting the classifier's worst-case reserve from the budget.

### Routing to Smart Model

- `apps/api/src/slices/chat/routes.ts`: `SMART_MODEL_ID` sentinel (constant
  `'smart-model'`, defined `packages/shared/src/constants.ts:19`) dispatches:
  `if (body.model === SMART_MODEL_ID) { const build = await buildSmartModelTurnDefinition(...) }`
  else `buildTurnDefinition(...)` (single-model) — seen at routes.ts:591-604 and
  again at :642/:668 for a second call site (likely regenerate). Also gated at
  :820/:906/:998 (`body.model === SMART_MODEL_ID && body.models !== undefined` is
  refused — Smart Model forbids fan-out).

### Settlement / charging

- The classifier's charge rides as an `auxiliaryCharges` entry on the answer node's
  `NodeRunSuccess`, keyed `classifier` — both charges settle together in the run's ONE
  fenced settlement transaction (per `ARCHITECTURE.md` §Money & settlement: "nothing
  commits mid-run"). `usage_records` rows are inserted per generation at settlement
  (see §5/§6 below); the classifier's own `usage_records` row is a separate row from
  the answer's row, both sharing the run's `runId` grouping column.

### "Deduplicated code" reusable for an "auto effort" chooser

The user's premise (a reusable classifier system) maps to these concrete, reusable
pieces:
- `resolveClassifierOutput()` (fuzzy free-text → closed-set match) — model-id specific
  today (matches against `eligibleIds: readonly string[]`), but the matching algorithm
  itself is generic string-to-enum resolution and could resolve an effort-level output
  (`'low'|'medium'|'high'`) the same way.
  eligibleIds today is model ids; reuse for effort levels would need the same
  fuzzy-match shape but a different enum.
- `truncateForClassifier()` — generic conversation-truncation, not model-specific.
- `buildClassifierMessages()` / `CLASSIFIER_SYSTEM_PROMPT_MARKER` — model-routing
  specific prompt text (hardcoded "choose the single best AI model" and "Available
  models:" list); would need a parallel prompt-builder for effort selection, not a
  drop-in reuse, unless generalized.
- `CLASSIFIER_OUTPUT_TOKEN_CAP` — generic reasoning-headroom constant, reusable as-is
  for any short-answer classifier call.
- `classifierLineItems()` / `classifierReserveChars()` (estimator) — priced as
  input-tokens + fixed output cap at a stated model's rates; the shape (not the
  content) is reusable for pricing an "auto effort chooser" reserve the same way Smart
  Model's classifier reserve is priced.
- The **node execution pattern** (`smart-model-execution.ts`'s
  `runSmartModel`/`classifierCall`/`answerCall` split, with the classifier's cost
  accruing via `ctx.accrue` before the answer, and the classifier charge riding as an
  `auxiliaryCharge`) is the structural precedent an "auto-choose reasoning effort"
  node would likely follow if implemented as its own composite node type.

---

## 2. Chat turn request path (`POST /chat`)

### Schema — `apps/api/src/slices/chat/routes.ts:85-128` (`startTurnBodySchema`)

```
conversationId: string
model: string
modality: 'text'|'image'|'video' (default 'text')
models?: string[] (min 2, max MAX_SELECTED_MODELS) — fan-out
forkId?: uuid
webSearchEnabled?: boolean
imageConfig? / videoConfig?: imageConfigSchema/videoConfigSchema
userMessage: { id: uuid, content: string }
history?: ChatHistoryMessage[]
customInstructions?: string (max 5000)
```

**No generic per-turn `params` field exists on the client-facing schema today.**
The ONLY per-call knob the client can currently influence indirectly is
`webSearchEnabled` (boolean) and the media config objects (`imageConfig`/
`videoConfig`, which do carry `wire:'providerOptions'` params like `aspectRatio`,
`resolution`, `n`, `duration`, `seed`, `generateAudio` for image/video). There is
**no field today through which the client could request, e.g., `temperature` or a
`reasoningEffort` value** for a text turn.

`regenerateTurnBodySchema` (lines 130-175) mirrors the same shape (no `params` field
either). `trialTurnBodySchema` (lines 208-217) is even narrower (`model`, `prompt`,
`webSearchEnabled`, `history`, `customInstructions`).

### How the server derives per-call `params` today

`apps/api/src/slices/chat/domain/turn-definition.ts`:
- `maxOutputTokensParams(maxOutputTokens): Record<string, unknown>` (lines 377-381) —
  the ONLY param the server itself injects into a `modelCall` node's `params`, an
  affordability-derived output-token ceiling. `buildSingleModelTurn` (line 407) and
  `buildMultiModelTurn` (line 473) both call `params: maxOutputTokensParams(...)`.
  A client-supplied `reasoningEffort` (or any other model param) would need: (a) a new
  field on `startTurnBodySchema`, (b) threading through `buildTurnDefinition` /
  `buildSingleModelTurn` (and the multi-model + Smart Model equivalents) into the
  `modelCall`/`smartModel` node's `params` object, and (c) validation against the
  model's `ParamSpec` (see below) before it reaches the adapter.
- The `smartModel` node's `params` field (from `SmartModelOptions.params`,
  `smart-model.ts:19`) is explicitly documented as answer-call-only — "the classifier
  call sets only its own output cap" — so a per-turn effort param riding through
  Smart Model would apply only to the resolved answer call, never the classifier call
  (consistent with how `customInstructions` is already handled there per
  `smart-model-execution.ts:214-217`).

### ParamSpec system — `packages/shared/src/param-spec.ts`

- `PARAM_TYPES = ['number','integer','string','boolean','enum']`
- `PARAM_WIRES = ['firstClass','providerOptions']` — declares how the param reaches
  the SDK call.
- `ParamSpec = z.strictObject({ type, min?, max?, values?, default?, required?, step?,
  requires?: string[], conflictsWith?: string[], wire? })`.
- `compileParamSpec(specs: Record<string, ParamSpec>): z.ZodType` — compiles a
  descriptor's `parameters` record into a runtime Zod schema: bounds, enum membership,
  required presence, cross-field `requires`/`conflictsWith`. Undeclared params reject
  (`z.strictObject`).
- **Enum params** (`type:'enum'`) are exactly the shape a `reasoningEffort:
  'low'|'medium'|'high'` param would use: `{ type:'enum', values:['low','medium','high'],
  wire:'providerOptions' }` — the image/video adapters already declare enum
  `providerOptions`-wired params this way (`aspectRatio`, `resolution` in
  `normalize.ts:imageParameters`/`videoParameters`).

### `compileWireParams` — defined but NOT wired into the live request path

`apps/api/src/slices/models/domain/wire-params.ts`:
`compileWireParams(descriptor, params): Result<WireParams, DomainError>` validates
caller params via `compileParamSpec(descriptor.parameters)` and splits them into
`{firstClass, providerOptions}` per each spec's `wire` declaration. **Verified: this
function is exported from `models/index.ts` but its only caller in the entire
`apps/api/src` tree is its own unit test** (`wire-params.test.ts`) — `grep` for
`compileWireParams(` outside that test file finds zero production call sites.

Instead, the language adapter (`apps/api/src/slices/models/adapters/language-adapter.ts:53-57`)
uses a **hardcoded closed schema**, independent of the catalog's per-model
`ParamSpec`s:
```ts
const callParametersSchema = z.strictObject({
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
});
```
with the comment: *"The ParamSpec→wire compiler (catalog work) replaces this closed
set; until then an unknown key is rejected at the boundary, never dropped silently."*
This is verbatim-repeated in `video-adapter.ts:148-152` and `image-adapter.ts:41`
(same "not yet wired" comment), confirming this is a known, documented gap across all
three adapters, not just language.

Additionally, `callSettingsFor()` (`language-adapter.ts`, `OptionalCallSettings`
interface) only forwards `abortSignal`, `maxOutputTokens`, `temperature`, `topP`,
`tools`, `stopWhen` to the AI SDK's `streamText()` call — **there is currently no
`providerOptions` passthrough at all in the language adapter's `streamText()` call**.
An OpenRouter `reasoning: { effort: 'low'|'medium'|'high' }` (or `max_tokens`) knob,
which the AI SDK/OpenRouter provider would take via `providerOptions.openrouter.reasoning`,
has no wire today — implementing reasoning effort as a `providerOptions`-wired
`ParamSpec` would require both (a) wiring `compileWireParams` (or extending
`callParametersSchema`) and (b) adding a `providerOptions` spread to the `streamText()`
call, neither of which exists.

---

## 3. Model catalog

### Schema — `packages/db/src/schema/model-catalog.ts`

```
model_catalog: id (uuid7 PK), model_id (text, UNIQUE), descriptor (jsonb, the Zod
  ModelDescriptor contract), admin_disabled_at (timestamp, admin kill switch, survives
  refresh), popularity_rank (integer, nullable, kept OUT of the descriptor jsonb so
  volatile ranking doesn't churn the content hash), created_at
```
One row per model id (siblings across `/models` + `/images/models` + `/videos/models`
merge into a single row — see `normalize.ts`'s `resolveGroup`). No `descriptor` column
schema besides jsonb — full shape is `ModelDescriptor` (below), no separate reasoning
columns.

### `ModelDescriptor` — `packages/shared/src/model-descriptor.ts`

```ts
{
  id, provider, version,
  inputs: Modality[], outputs: Modality[],
  parameters: Record<string, ParamSpec>,
  behaviors: string[], // 'streaming' | 'tools' | 'reasoning' | 'web-search' | …
  limits: Record<string, number>,
  pricing: PricingSchema,
  zdrReachable: boolean,
  name?, description?, releasedAt: number (unix seconds)
}
```
`behaviors` is a free-form string array; `'reasoning'` is a KNOWN behavior tag (comment
says so) but is populated purely from OpenRouter's `supported_parameters` flag — it
does NOT carry any effort-level metadata.

### OpenRouter → catalog mapping — `apps/api/src/slices/models/domain/normalize.ts`

- `SUPPORTED_PARAMETER_SPECS` (lines 64-76): the closed map from OpenRouter
  `supported_parameters` gateway names → canonical descriptor `ParamSpec`s. Only THREE
  entries exist: `temperature`, `top_p`→`topP`, `max_output_tokens`→`maxOutputTokens`,
  all `wire:'firstClass'`. **`reasoning` is NOT in this map** — it cannot become a
  `ParamSpec` via `seedParameters()`.
- `BEHAVIOR_PARAMETERS` (lines 79-82): `{ tools: 'tools', reasoning: 'reasoning' }` —
  gateway parameter names that signal a BEHAVIOR (capability flag), not a call param.
  `languageBehaviors()` (lines 99-106) pushes `'reasoning'` into `descriptor.behaviors`
  whenever OpenRouter's `supported_parameters` for that model includes `"reasoning"`.
  **Verified: reasoning-capable models ARE flagged today (`behaviors` includes
  `'reasoning'`), but there is no way today to CONTROL the reasoning effort level** —
  no ParamSpec is seeded for it.
- `modelsEntrySchema` (`gateway-metadata.ts:31-45`) parses OpenRouter's `/models`
  response: `supported_parameters: z.array(z.string()).nullish()` — a flat string
  array (this is OpenRouter's actual wire shape: bare strings like `"reasoning"`, not a
  structured effort-levels object). There is no additional endpoint metadata parsed
  today describing reasoning effort enum values, max reasoning tokens, or default
  effort — OpenRouter's `/models` response would need to be re-examined (out of scope
  of this codebase-only search) to determine if such structured metadata exists
  upstream (**Assumed gap, not verified against live OpenRouter API**).
- Refresh cadence: per `ARCHITECTURE.md`, hourly, jittered, skip-unchanged (not
  independently re-verified in code this pass, but corroborated by
  `model-catalog.ts`'s content-hash-friendly `popularityRank` exclusion comment).

### How capabilities reach the client — `apps/api/src/slices/models/domain/list-models.ts`

- `buildModelsListResponse()` / `wireCandidate()` (lines ~157-183) projects each
  `ModelDescriptor` into the shared `Model` wire type:
  `supportedParameters: [...descriptor.behaviors, ...Object.keys(descriptor.parameters)]`
  — so the client-visible `Model.supportedParameters` array DOES include `'reasoning'`
  today for reasoning-capable models (via `behaviors`), but there is no client-visible
  ParamSpec (e.g. enum values `low/medium/high`) describing how to configure it.
- `capabilityLists()` (lines 126-141) only derives `supportedAspectRatios` /
  `supportedVideoResolutions` / `supportedVideoDurationsSeconds` for **non-language**
  families (`if (family === 'language') return {}`) — no language-family capability
  lists (e.g. temperature range, reasoning-effort enum) are surfaced to the client at
  all today.
- Wire schema: `packages/shared/src/schemas/api/models.ts:195`:
  `supportedParameters: z.array(z.string()).default([])`.
- **Verified: no frontend code (`apps/web/src`) currently reads `supportedParameters`**
  (`grep` across `apps/web/src` for `supportedParameters` returns zero matches) — the
  field is populated server-side but has no client consumer yet, mirroring the
  reasoning-delta wiring gap in §4/§6 below.

---

## 4. Inference dispatch — ModelProvider port + OpenRouter adapter

### Port — `apps/api/src/slices/models/ports/model-provider.ts` (not fully read this
pass, but referenced): `ModelProvider.infer(request, descriptor, options): AsyncIterable<InferenceEvent>`.

### Language adapter — `apps/api/src/slices/models/adapters/language-adapter.ts`

- `createLanguageAdapter(options): ModelProvider` → `inferLanguage()` (async
  generator) calls AI SDK v6's `streamText()`:
  ```ts
  const result = streamText({
    model: provider.chat(request.model, languageRoutingOptions()), // ZDR pin, single source
    system: buildTurnSystemPrompt({ now, customInstructions? }),
    messages: [...toHistoryMessages(request.history), { role:'user', content }],
    maxRetries: 0,          // retry lives in lib/resilience, not the SDK
    onError: noopOnError,   // errors reach the caller as typed throws off fullStream
    ...callSettingsFor(parameters, options, provider),
  });
  ```
- `callSettingsFor()` (`OptionalCallSettings`): only
  `abortSignal, maxOutputTokens, temperature, topP, tools, stopWhen` are ever set —
  **no `providerOptions` key is ever passed to `streamText()`** in this adapter
  (verified by reading the full function body).
- `languageRoutingOptions()` (`@hushbox/shared`, not opened this pass but referenced
  in `apps/api/CLAUDE.md`: "Never inline `provider`/`extraBody.provider` literals —
  use `languageRoutingOptions()`… which single-sources the ZDR block") is the ONLY
  provider-level option surface wired today, and it's fixed (ZDR pin), not
  per-request-configurable.
- `parseCallParameters(request.parameters)` (line 61) validates against the
  hardcoded `callParametersSchema` (see §2) — **an unknown key throws
  `invalidRequestError`** (not silently dropped), so a client sending an
  unrecognized `reasoningEffort` param today would hard-fail the request at the
  adapter boundary with `invalidRequestError`, UNLESS it were added to this schema
  first.

### Usage / cost extraction

- `extractStepCost(metadata)` reads `providerMetadata.openrouter.usage.cost` (parsed
  via `openrouterUsageMetadataSchema`, a `z.looseObject`) — this is OpenRouter's
  authoritative inline per-generation cost.
- `mapUsage(usage: LanguageModelUsage): Usage` (line 135):
  ```ts
  const reasoningTokens = usage.outputTokenDetails.reasoningTokens;
  const cachedInputTokens = usage.inputTokenDetails.cacheReadTokens;
  return { inputTokens, outputTokens, reasoningTokens?, cachedInputTokens? };
  ```
  **Reasoning token COUNTS are already extracted from the AI SDK's usage object** (the
  SDK itself separates `outputTokenDetails.reasoningTokens` from ordinary output
  tokens) — this flows into the shared `Usage` schema
  (`packages/shared/src/inference.ts:82-89`, `reasoningTokens` optional
  nonnegative int) and ultimately into `llm_completions.reasoningTokens` at
  settlement (see §5).

### Stream event mapping — does it already handle "reasoning parts"?

**Yes — reasoning IS already a first-class stream event, not dropped or crashed on.**
`mapPart()` (the `ts-pattern` `match(part)` dispatcher over the AI SDK's
`TextStreamPart`) handles:
```
'text-delta' → mapTextDelta → { kind:'text-delta', index, content }
'reasoning-delta' → mapReasoningDelta → { kind:'reasoning-delta', index, content }
'tool-call' / 'tool-result' → mapped
'file' → mapFile (multi-output models)
'start-step' / 'finish-step' → mapped, carries per-step cost + generationId
'finish' → terminal ProviderMetadata (usage, finishReason, providerCostUsd)
'error' → throws classifyInferenceFailure(p.error)
'abort' → throws abortedError(p.reason)
[reasoning-start/reasoning-end/text-start/text-end/tool-input-*/source/raw/
 tool-output-denied/tool-approval-request] → mapped to [] (explicitly ignored,
 exhaustively matched, not a fallback)
```
`mapReasoningDelta()` (lines 200-208): `if (part.text.length === 0) return [];` else
`[{ kind:'reasoning-delta', index: indexFor(state.reasoningIds, part.id), content: part.text }]`
— per-stream-id indexing exactly mirrors text deltas (`state.reasoningIds` is a
separate `Map<string, number>` from `state.textIds`).

`InferenceEvent` union (`packages/shared/src/inference.ts:132-180`) declares
`z.object({ kind: z.literal('reasoning-delta'), index: z.number(), content: z.string() })`
as a first-class member — this is a stable, versioned wire contract, not an
ad-hoc addition.

### Node execution → WS stream

`apps/api/src/slices/workflows/nodes/model-call-execution.ts:242-247` (`streamModelCall`):
```ts
ctx.emit?.(streamStartEvent(deps.binding.descriptor, request.model));
for await (const event of deps.provider.infer(request, descriptor, inferOptions)) {
  ...
  ctx.emit?.(event);   // EVERY InferenceEvent, reasoning-delta included, forwarded verbatim
}
```
So reasoning deltas ride the SAME `ctx.emit` seam as text deltas, all the way to the
run's WS stream — no special-casing, no drop path, no crash path.

### Client-side stream dispatch (transport confirmation)

`apps/web/src/lib/chat-run.ts`:`dispatchDelta()` (lines 198-211):
```ts
if (event.kind === 'text-delta') { callbacks.onToken?.(event.content, ...); return true; }
if (event.kind === 'reasoning-delta') { callbacks.onReasoningToken?.(event.content, ...); return true; }
```
`apps/web/src/hooks/chat/use-chat-stream.ts` declares and forwards an
`onReasoningToken?: (token, assistantMessageId) => void` option (lines 155, 357).
**Verified: no component in `apps/web/src` currently supplies an `onReasoningToken`
callback** (`grep -rn "onReasoningToken"` across `apps/web/src` finds only the
type declaration, the pass-through wiring, and its own unit test — zero call sites
that implement rendering/storage logic). Reasoning tokens are therefore fully
plumbed end-to-end at the transport layer but **not yet surfaced in any UI**, and
not persisted anywhere (see §6).

---

## 5. Billing/estimator touchpoints

### Canonical estimator — `packages/shared/src/estimate/`

- No estimator file references "reasoning" as a distinct priced dimension — `grep`
  for "reasoning" across `packages/shared/src/estimate/*.ts` returns zero hits
  outside the classifier's fixed output-token-cap machinery (`CLASSIFIER_OUTPUT_TOKEN_CAP`,
  imported into `classifier-line-item.ts` from `smart-model/eligible-models.ts` — see
  §1). **The estimator prices output tokens uniformly; it has no separate
  reasoning-token line item or reasoning-aware output-token multiplier.** A
  reasoning-effort feature that meaningfully changes expected output-token volume
  (reasoning models can burn many hidden tokens before visible text) is not currently
  reflected in admission/affordability estimates beyond the general output-token
  ceiling math (`turnMaxOutputTokens`, `computeSafeMaxTokens` — referenced in
  `turn-definition.ts`, not opened in full this pass).
- Key estimator files present: `types.ts` (`NanoLineItem`, `Manifest`,
  `ModelRatesNano`, `ClassifierStage`, `BillableRequest`, `EstimateResult`),
  `price-request.ts` (`priceRequest`), `reducers.ts` (`evaluateManifest`,
  `reservationCeiling`, `affordability`), `pre-adapters.ts` (tier-based char/token
  conversion, `MINIMUM_OUTPUT_TOKENS = 1000` from `packages/shared/src/constants.ts:164`),
  `search-reservation.ts` (`webSearchLineItem`), `media-pricing.ts`
  (`buildMediaLineItems`), `format.ts` (display formatting), `classifier-line-item.ts`
  (§1). Per prior session memory (Canonical cost estimator run, 2026-07-20), this is
  the SINGLE nano-USD estimator core shared by client display, server admission, and
  settlement.

### Where the classifier call's charge is recorded

- `usage_records` (schema below, §6) — the classifier's generation gets its own
  `usage_records` row (via `insertLlmCompletionWithinTx` / the standard charge path in
  `billing/domain/charge.ts`), sharing the run's `runId` grouping column with the
  answer's own `usage_records` row. Both rows are written inside the SAME fenced
  settlement transaction (`ARCHITECTURE.md`: "nothing commits mid-run").
- `usage_records.idempotencyKey` is `text().unique()` — each generation's charge row
  is keyed distinctly (the classifier's key suffix `'classifier'` from
  `smart-model-execution.ts:178` `keySuffix: 'classifier'` presumably feeds this,
  though the exact key-construction call site was not opened this pass — Inferred
  from the `NodeGenerationCharge.keySuffix` field name and usage in
  `answerCall`/`classifierCall`).

---

## 6. Message persistence

### `content_items` — `packages/db/src/schema/content-items.ts`

```
content_items: id (uuid7), message_id (FK→messages, cascade), content_type
  (enum: 'text'|'image'|'audio'|'video' — contentItemTypeEnum,
  packages/db/src/schema/enums.ts:71), position,
  encrypted_blob (bytea, TEXT rows only), storage_key/mime_type/size_bytes/
  width/height/duration_ms (MEDIA rows only), model_id (text, no FK),
  provider_name, cost_nano_usd (bigint), is_smart_model (boolean),
  created_at
```
A CHECK constraint (`content_items_type_consistency`) enforces: `text` rows MUST have
`encrypted_blob` set and MUST NOT have `storage_key`/`mime_type`/`size_bytes`; media
rows are the inverse. **There is no `'reasoning'` content type in the closed enum**
(`contentItemTypeEnum = pgEnum('content_item_type', ['text','image','audio','video'])`)
— reasoning text has no persistence slot in this table today. Adding persisted
reasoning traces would require either a new enum member (with a matching CHECK-
constraint branch) or a separate mechanism entirely.

### `messages` — `packages/db/src/schema/messages.ts`

One row per turn-message (`sequenceNumber` unique per conversation), `wrappedContentKey`
(bytea, per-message content key), `epochNumber`, `parentMessageId` (fork tree),
`batchId` (uuid, groups sibling multi-model messages from one settlement). No
reasoning-related columns.

### What's actually persisted per assistant message

Only the FINAL text (or media) content — reasoning tokens are never written to
`content_items` (confirmed by the closed `content_item_type` enum above) and are
never referenced in `messages.ts`. Combined with §4's finding (client wires
`onReasoningToken` but no component consumes it), **reasoning output today is
observable ONLY transiently during the live stream (if a future UI component wires
the callback) and is discarded once the run finishes — it is never stored anywhere,
client or server.** `llm_completions` (schema referenced, not opened in full —
`packages/db/src/schema/llm-completions.ts`) DOES persist `reasoningTokens` as a
per-generation TOKEN COUNT (`billing/domain/charge.ts:192`,
`insertLlmCompletionWithinTx({ ..., reasoningTokens: input.tokens.reasoningTokens, ... })`)
— i.e. how many reasoning tokens were spent is billed/recorded, but the reasoning
TEXT itself is not.

---

## 7. Per-conversation / per-user preference storage

### Server-side (`preferences` table) — `packages/db/src/schema/preferences.ts`

```
preferences: id (uuid7), user_id (FK→users, UNIQUE — one row per user),
  accessibility (jsonb, LWW-synced, Zod-validated, default '{"version":1}'),
  updated_at
```
**This table holds ONLY accessibility settings today** (`apps/api/src/slices/account/domain/preferences.ts`:
`getAccessibilityPreferences`/`saveAccessibilityPreferences`, LWW conflict resolution
keyed on `updatedAt`, `accessibilityPreferencesSchema` from `@hushbox/shared`). There
is no generic per-user chat-preference field (no default-model, no default-effort,
no web-search-default) in this table — `grep` for
`defaultModel|preferredModel|lastUsedModel` across both `apps/web/src` and
`apps/api/src` returns zero matches; no such server-side concept exists today.

### Client-side precedent — `apps/web/src/stores/search.ts`

The existing analog for a per-turn boolean preference (`webSearchEnabled`) is a
**client-only, localStorage-persisted Zustand store**, not a server preference:
```ts
export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({ webSearchEnabled: false, toggleWebSearch: () => set(...) }),
    { name: WEB_SEARCH_STORAGE_KEY }
  )
);
```
Wrapped by `apps/web/src/hooks/chat/use-web-search.ts`'s `useWebSearch()`, which
combines the persisted `preferred` value with an auth-gated `canUse` to compute the
effective `active` value, and is the "single source of truth" the composer/send-path/
budget-check all read. **This is the closest existing precedent for how a persisted
"effort" preference would likely be implemented if it stays client-only** — a new
Zustand `persist()` store plus a `useXxx()` hook wrapper, mirroring `useWebSearch`,
rather than riding the `preferences` table (which today is accessibility-only and
LWW-synced across devices — a genuinely cross-device-synced effort preference would
need the `preferences` table extended, following that LWW pattern).

---

## Open questions / gaps this search could not resolve from the codebase alone

- Whether OpenRouter's `/models` endpoint (live API) exposes structured reasoning
  effort metadata (available levels, default, per-model max) beyond the flat
  `supported_parameters` string array parsed by `gateway-metadata.ts` — this needs a
  live-API check, not a codebase search (flagged as such in §3).
- The exact `NodeGenerationCharge.keySuffix` → `idempotencyKey` construction path for
  the classifier's `usage_records` row was not traced to its exact call site this
  pass (only its consumption in `smart-model-execution.ts` was confirmed).
- `llm_completions` full schema was referenced (path confirmed) but not opened in
  full this pass.
