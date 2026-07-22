# T4 — Adapter + routing: reasoning passthrough — impl report 1

## Objective

The language adapter sends a validated reasoning config and routing guards it: `callParametersSchema` gains the reasoning union (composing the shared `ReasoningWire` Zod schema), `callSettingsFor` passes `providerOptions.openrouter.reasoning` to `streamText`, `routing-options.ts` sets `require_parameters: true` iff reasoning is present (G4), a typed error + new shared error code covers the no-endpoints refusal, cassette integration tests cover both wire shapes, and `mock-provider.ts` gains deterministic reasoning emission.

## Files changed

- `packages/shared/src/models/routing-options.ts` — `LanguageRoutingVariant` + optional `require_parameters?: true` on `OpenRouterProviderRouting`; `languageRoutingOptions(variant?)` emits it iff `variant.reasoning === true` (single source, G4). Media path untouched.
- `packages/shared/src/models/routing-options.test.ts` — pins presence with `{reasoning: true}` and absence with no variant / `{reasoning: false}`.
- `packages/shared/src/error-codes.ts` — `NO_REASONING_ENDPOINTS` code + `ERROR_MESSAGES` entry (messages live here per current convention; `error-messages.ts` holds only the branded type and was not touched).
- `packages/shared/src/error-codes.test.ts` — pins the code + its own copy (distinct from `UNAVAILABLE`).
- `apps/api/src/slices/models/adapters/language-adapter.ts` — `reasoning: ReasoningWire.optional()` composed into `callParametersSchema` (never re-typed — binding interface note honored); `callSettingsFor` conditional `providerOptions.openrouter.reasoning` spread; `provider.chat(model, languageRoutingOptions({ reasoning: … }))`; stream-loop failures now dispose through extracted `streamFailure()`, which re-types a `no_providers_available` classification on a reasoning-carrying call as `no_reasoning_endpoints` (extraction also keeps the function under the complexity lint cap).
- `apps/api/src/slices/models/adapters/inference-error.ts` — new `no_reasoning_endpoints` code in `INFERENCE_ERROR_CODES` + `noReasoningEndpointsError(cause)` factory (non-retryable, cause-chained).
- `apps/api/src/slices/models/adapters/language-adapter.test.ts` — six new tests (see below).
- `apps/api/src/slices/models/adapters/mock-provider.ts` — ADDITIVE: `MOCK_REASONING_TEXT` constant, `reasoningDeltas()` generator (grapheme-chunked, mirrors `textDeltas`), `echoStream` yields reasoning deltas ahead of the echo when `request.parameters['reasoning']` is present, `finishEvent` gains an optional `reasoningText` param that adds `usage.reasoningTokens`. Reasoning-free requests are byte-for-byte unchanged; the foreign uncommitted diff (delays, grapheme chunking, JSON fence, aspect-ratio images, holdPrimaryStream) was not restructured — the hold path works unchanged with reasoning (deltas precede the held first text delta).
- `apps/api/src/slices/models/adapters/mock-provider.test.ts` — three new tests incl. a full-content pin against `MOCK_REASONING_TEXT`.
- `apps/api/src/slices/models/adapters/integration-setup.ts` — `REASONING_MODEL_IDS` (`openai/gpt-oss-20b` effort-native, `google/gemini-2.5-flash` budget-native), reasoning descriptors/requests. The reasoning parameters are built via `planReasoning(reasoningPlanModelFrom(descriptor), 'low', 512)` — G1 honored even in test fixtures (deterministic, hash-stable), and G2 (`maxOutputTokens = B+H`) rides along.
- `apps/api/src/slices/models/adapters/language-adapter.integration.test.ts` — two cassette tests (effort wire / budget wire) asserting reasoning deltas stream, answer text arrives, `usage.reasoningTokens > 0`, and inline cost (`providerCostUsd > 0`). Provider-agnostic bodies; run against the mock locally via the T12 harness, self-record in CI.

## Tests added (name — behavior — criterion)

- routing-options: `sets require_parameters on the provider block when the call carries reasoning` / `omits require_parameters entirely when the call carries no reasoning` — G4 both directions.
- error-codes: `names the reasoning no-endpoints refusal code with its own copy` — new error code + friendly message.
- language-adapter: `wires an effort reasoning config onto the request body via providerOptions` — **first red test** (recorded wire body carries `reasoning: {effort}`; failed pre-impl because the strict schema rejected the key — providerOptions never set today); `wires a token-budget reasoning config …` — `{max_tokens}` wire shape; `sets provider.require_parameters iff the request carries reasoning` — G4 at the recorded-body level; `rejects a reasoning config carrying both effort and max_tokens` — union exclusivity (G1); `rejects a reasoning effort outside the canonical enum`; `types the no-endpoints refusal distinctly when the request carries reasoning` — `no_reasoning_endpoints` from the 404 fixture (the reasoning-free variant staying `no_providers_available` is pinned by the pre-existing fixture test).
- mock-provider: `emits reasoning deltas before the echo text when the request carries reasoning config` (ordering + exact content = `MOCK_REASONING_TEXT`); `carries reasoningTokens > 0 on the finish usage when reasoning config is present` (+ cost); `emits no reasoning events and no reasoningTokens without reasoning config` (baseline unchanged).
- language-adapter.integration: `streams reasoning deltas and bills reasoning tokens for an effort-native reasoning config` / `… budget-native reasoning config` — deltas + `reasoningTokens > 0` + inline cost, both wire shapes.

TDD notes: routing variant, error code, adapter wiring, no-endpoints remap, and mock emission were each watched red for the right reason before implementation. The two adapter rejection tests (both-keys, non-canonical effort) passed pre-impl because the schema rejected any `reasoning` key wholesale; they now pin the union's boundary post-impl. The two integration tests were red only via missing harness imports (their behavior was TDD'd at the mock-provider unit level first).

## Self-gate

- `pnpm test:shared` — pass (full coverage table clean).
- `pnpm test:api` — all tests pass; overall exit 1 SOLELY on the per-file coverage gate for `src/slices/workflows/nodes/smart-model-execution.ts` (branches 94.73% < 95%) — byte-identical to the failure pre-recorded in plan §Known-foreign-failures (foreign uncommitted workstream; not in this task's import graph, file untouched by this diff). Attributed foreign, not fixed. Every file this task touched meets the gate (adapters dir shows no threshold errors).
- `turbo typecheck --filter=@hushbox/shared --filter=@hushbox/api --force` — pass (2/2).
- `eslint <all edited files>` from each package dir, after the final edit — exit 0. (Interim failures fixed: `sonarjs/cognitive-complexity` on `inferLanguage` → extracted `streamFailure()`; `no-secrets` false-positive on the literal `require_parameters` inside apps/api comments → comments reworded to "require-parameters routing guard", no eslint-disable added; one prettier reflow via `--fix`.)
- Focused suites: adapters dir 20 files / 298 tests pass; integration suite 3/3 under the local mock.

## Acceptance criteria

- callParametersSchema reasoning union from the shared schema — **met** (`ReasoningWire.optional()` composed; both-keys unparseable; language-adapter.test.ts pins).
- callSettingsFor passes `providerOptions.openrouter.reasoning` — **met** (recorded body carries `reasoning`; first red test as specified).
- `require_parameters: true` iff reasoning, single-sourced in routing-options.ts — **met** (variant + shared tests + recorded-body iff test).
- Typed domain error + new error code for the no-endpoints refusal — **met in-slice** (`no_reasoning_endpoints` InferenceError + `NO_REASONING_ENDPOINTS` shared code + message). **Deviation/raise:** the InferenceError→wire-code mapping seam (`inferenceNodeError` in `apps/api/src/slices/workflows/nodes/model-call-execution.ts`) is outside T4 file ownership; without a one-line entry there the refusal surfaces as generic `UNAVAILABLE`. Reported as an out-of-scope need — not edited.
- Cassette integration tests, both wire shapes, cheap models, stable prompts, deltas + reasoningTokens + inline cost — **met** (self-record in CI; see concerns on model-id assumptions).
- Mock deterministic reasoning emission — **met** (deltas before echo, `usage.reasoningTokens > 0`, reasoning-free path unchanged).
- No other call-shape changes — **met** (image/video adapters and mediaRoutingOptions untouched).

## Deviations

- The wire-code mapping for the new error is not wired (out of ownership; above).
- The mock detects reasoning by key presence (`parameters['reasoning'] !== undefined`) rather than re-validating via the schema — validation is the real adapter's job; the mock mirrors legacy knob-style leniency.

## Concerns and limitations

- **Model-id assumptions (Assumed, verifiable only on the CI record run):** `openai/gpt-oss-20b` (effort-native, returns visible reasoning text) and `google/gemini-2.5-flash` (budget-native, streams thought summaries) chosen because the o-series returns *no* reasoning text (research §7) and Anthropic is not cheap. ZDR-reachability of both is unverified locally; a wrong pick fails loudly on the CI record run per the harness's documented contract (`provider.zdr: true` fail-closed) and is a one-line id swap in `REASONING_MODEL_IDS`.
- `packages/shared/src/error-codes.ts` carries a pre-existing FOREIGN uncommitted diff (a reworded client-code comment block + a changed `PRIVILEGE_INSUFFICIENT` message) — verified present before my edits; my hunks are only the two `NO_REASONING_ENDPOINTS` additions. Same for the foreign diffs in `mock-provider.ts` (noted in the brief) — untouched.
- The `no-secrets` lint rule false-positives on the literal `require_parameters` in apps/api (but not in packages/shared, which carries the literal in code and comments) — worked around by rewording comments; the config asymmetry may be worth a look by whoever owns lint config.

## Confidence

**high** for everything exercised locally (wire bodies pinned byte-level via recorded cassettes against scripted SSE; mock emission pinned exactly). **medium** for the two CI-record-run properties: real-model reasoning-delta visibility and ZDR-reachability of the two new model ids (Assumed, self-verifying on first CI run).
