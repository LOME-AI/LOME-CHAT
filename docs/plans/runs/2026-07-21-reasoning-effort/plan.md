# Reasoning Effort — Plan

Run: `docs/plans/runs/2026-07-21-reasoning-effort/` · Tier 2 · Status: **APPROVED 2026-07-22** (immutable; deviations via recorded amendments) · Implementation: not started (paused at founder request)

Research authorities (briefs cite these over local guessing):

- `research/openrouter-reasoning.md` — OpenRouter reasoning API (rounds 1+2; 498 lines)
- `research/codebase-backend.md` — classifier/Smart Model, chat path, catalog, adapter, billing
- `research/codebase-frontend.md` — chat layout, streaming render, ui primitives, state, a11y

## Founder rulings (2026-07-21, this run)

- R1 — Selector UI: **vertical rail docked to the right of the prompt-input component** (not the chat edge). One-touch change is the hard requirement. Original one-letter-collapsed / expand-on-interaction sketch is the starting point; exact interaction solved in implementation under the acceptance criteria below.
- R2 — **Storage doctrine (record in docs):** *We always store the text return of the models exactly as returned. All presentation to the user is computed/parsed on-demand.* Reasoning text goes in the SAME field as all other assistant text, exactly as received; the client parses it to decide display. No separate content-item type, no separate column.
- R3 — Trial turns: **low effort levels only** — offer exactly the levels whose token plan fits the trial ceiling; hide the rest.
- (Implicit via R2) Reasoning storage is billed like any other text — it IS the text field; no special case.

## Design decisions (from analyst material, orchestrator-endorsed)

- D1 — **Effort-aware token plan** (option A): shared function in `packages/shared/src/estimate/reasoning-plan.ts` maps `(modelDescriptor, canonicalEffort) → { reasoningBudget B, answerHeadroom H, maxTokens: B+H } | { infeasible }`. B = per-level constants table (data, founder-tunable), clamped to catalog-driven caps (never hardcode 128k) and the 1024 floor. H remains the existing affordability-derived answer cap (`fitAnswerCapToCeiling` sizes H only; B is a constant input). Budget-native models (no `supported_efforts`) wire `reasoning: { max_tokens: B }`; effort-native models wire `reasoning: { effort }`; both always send completion `max_tokens = B+H`. Infeasible levels are reported and disabled in the UI — never silently downgraded or clamped away. Never send `reasoning.effort` and `reasoning.max_tokens` together (treat as invalid per research; discriminated union).
- D2 — **`require_parameters: true` on every call that carries `reasoning`; never otherwise.** Implemented as a variant in `routing-options.ts` (single source). "No endpoints found" surfaces as a typed domain error → new error code the UI renders.
- D3 — **One generalized classifier stage, dimension-composed.** The classifier call takes dimensions (`model?`, `effort?`); one call per turn ever, including Smart Model + Auto together. Effort is classified on the canonical scale `low|medium|high` (model-agnostic); the D1 plan maps canonical→model-native (nearest supported level / budget tier). Charged as the existing `auxiliaryCharges` classifier entry in the same settlement; admission's classifier reserve condition extends from "Smart Model" to "Smart Model ∨ effort=Auto". Non-reasoning model + Auto ⇒ no classifier call, no charge. Unresolvable classifier output ⇒ fallback `medium`, charge stands (existing precedent).
- D4 — **Request schema:** one narrow optional enum `reasoningEffort` on `startTurnBodySchema` (`'auto' | canonical levels | 'none'`); server derives all wire mechanics via the D1 plan. 400 VALIDATION for unsupported level / non-reasoning model. **No ParamSpec revival**: the adapter's `callParametersSchema` gains a typed `reasoning` discriminated union and `callSettingsFor` gains the (currently absent) `providerOptions.openrouter.reasoning` passthrough. **Catalog:** parse OpenRouter's top-level `reasoning` object (`supported_efforts`, `mandatory`, `default_effort`, `default_enabled`) into an optional structured field on `ModelDescriptor` + wire `Model` schema (backward-compatible optional Zod field, rides the existing hourly snapshot). `supported_efforts` stored as raw strings; intersected with the canonical enum at use (unknown upstream levels are not offered — excluded, never crash). **Client persistence:** small persisted Zustand store + hook mirroring `useSearchStore`/`useWebSearch` (preferred value, default `'auto'`; effective = `supported ? preferred : 'auto'`).
- D5 — superseded by founder ruling R2 (same-field storage; see Global Constraints G6–G8).
- D6 — **No new pricing dimension.** Admission/estimate become effort-aware only through the existing output-token input: the priced output count is `B+H` (plus reasoning chars flowing through existing storage line items naturally, per R2). Settled cost display unchanged (inline `usage.cost` already includes reasoning).
- D-UI — **Thinking display** (analyst O1 with substitutions): per-assistant-message default-closed disclosure; while reasoning streams, a fixed-height (~3 line) bottom-anchored `overflow-hidden` preview shows the newest lines in muted ink with a mask-gradient "glazed" treatment (**no `backdrop-filter`/`filter: blur` on live text**); auto-scroll is emergent from content flow (new lines push old up) — **zero JS animation**; click expands (real `<button aria-expanded aria-controls>`); expanded-while-streaming is height-bounded (`max-h` + internal scroll). Preview box is `aria-hidden`; the sole live announcement surface remains the existing `role="status"` ThinkingIndicator. Honest states: (a) streaming with deltas → live preview; (b) reasoning billed but no visible text (o-series) → no disclosure; quiet metadata line "Reasoned privately (N tokens)"; (c) summarized reasoning (Anthropic) → expanded view labeled as a summary; (d) message with no reasoning → nothing rendered.

## Global Constraints

- G1 — Effort is NEVER sent without the D1 plan. No code path may set `reasoning` on a provider call except via `reasoning-plan.ts` output; no independent `maxOutputTokens` injection on reasoning calls. `reasoning.effort` and `reasoning.max_tokens` are mutually exclusive by type (discriminated union).
- G2 — Always send an explicit completion `max_tokens` on reasoning calls (unset behavior is undocumented upstream).
- G3 — Infeasible (model, effort) combinations are reported and disabled — never silently downgraded, clamped, or substituted server-side.
- G4 — `require_parameters: true` iff the request body carries `reasoning`; built only through `routing-options.ts`.
- G5 — Canonical effort enum lives once in `packages/shared` (levels + Zod + display labels); every layer (catalog intersection, request schema, classifier output, plan, UI) imports it. Per **One Implementation, Shared**, client and server compute affordability/feasibility through the same plan function.
- G6 — **Storage doctrine (R2):** the assistant message's text field stores the model's text return exactly as received. Reasoning text is embedded in that same field in the canonical inline format (G7); nothing is rewritten, summarized, or trimmed at persist time. All display parsing is on-demand.
- G7 — Canonical inline format: reasoning precedes answer text, delimited as `<think>…</think>` (the de-facto convention models themselves emit; final delimiter confirmed at approval). One shared parser/serializer in `packages/shared` is the ONLY code that reads or writes the delimiter — client display, optimistic-message assembly, and server history-replay stripping all import it.
- G8 — History replay to models strips embedded reasoning via the G7 shared parser before building provider messages (feeding thoughts back changes behavior and cost). Server-side at the existing history-build seam.
- G9 — Trial turns offer exactly the effort levels whose D1 plan fits the trial ceiling (computed, not hardcoded); other pills hidden.
- G10 — Never hardcode provider caps/floors (128k cap, 1024 floor is the protocol floor constant; caps come from catalog data).
- G11 — Reasoning deltas are never logged; reasoning text is message content under the telemetry rules (no content in logs, ever).
- G12 — All UI honors reduced-motion (the thinking preview has no JS animation by construction), WCAG touch/keyboard rules; the rail is fully keyboard-operable and screen-reader navigable.
- G13 — TDD per AGENT-RULES; scoped checks per task table; 95% per-file coverage.

## Open items folded into tasks

- The rail's one-letter label collision (Max/Med/Min) and the mobile one-touch interaction (candidate: press-drag-release gesture; hover-reveal + single click on desktop) are design-freedom WITHIN acceptance criteria of T9, resolved with the `frontend-design` skill + design-review loop.
- `compileWireParams` dead code: NOT revived here; disposition escalated to founder at close (Phase 4 doc/debt proposals).
- Six OpenRouter live probes (~$0.05) listed in `research/openrouter-reasoning.md` §C for a founder-run key; none block the design (nothing rests on the unprobed behaviors).

## Tasks

Dependency graph:

```
T12 (integration-test harness rework) ──────────────────────┐
T1 (catalog metadata) ──┬─→ T2 (canonical enum + plan fn) ──┼─→ T4 (adapter wiring)
                        │                                   ├─→ T5 (turn integration + admission)
                        │                                   └─→ T9 (rail UI)
T3 (inline format parser) ──┬─→ T6 (persist + history strip)
                            └─→ T8 (client streaming accumulation) ──→ T10 (thinking display)
T2 ─→ T7 (classifier effort dimension)   T5,T7 → T11 (E2E)   T9,T10 → T11
```

### T1 — Catalog: capture per-model reasoning metadata

- **Objective:** the model snapshot and wire `Model` schema carry OpenRouter's per-model `reasoning` object.
- **Criteria:** `normalize.ts` parses top-level `reasoning` (`supported_efforts` as raw string array, `mandatory`, `default_effort`, `default_enabled`) into an optional structured `reasoning?` field on `ModelDescriptor`; wire `Model` schema exposes it; absent object ⇒ field absent (131/342 models); unknown effort strings preserved raw; existing stored jsonb rows still parse (optional field, backward-compatible); refresh path unchanged otherwise.
- **Files:** `apps/api/src/slices/models/**` (normalize/gateway-metadata), `packages/shared/src/schemas/api/models.ts`, `packages/shared` descriptor types.
- **Checks:** `pnpm test:api`, `pnpm test:shared`, turbo typecheck/lint both filters.
- **Sensitive:** no.

### Interface ruling from T1 (2026-07-22) — binding on T2/T9

- The descriptor's `reasoning.supportedEfforts` is a **tristate** preserved from upstream: an array = the enumerated levels; `null` = effort-supporting with all canonical levels accepted (upstream enumerates none); **absent** = budget-native (no effort vocabulary — wire `reasoning.max_tokens` per D1). T2 consumes this shape exactly; collapsing null/absent would mis-branch the effort/budget wire choice.
- **Single authority for all effort logic:** the structured `reasoning` object on the descriptor. The older `behaviors: ['reasoning']` flag (from `supported_parameters`, can disagree per model) is NOT consulted for effort UI, the plan function, or wire decisions — it remains only for its pre-existing generic uses. T9's capability gating keys on the `reasoning` object's presence.

### T2 — Canonical effort enum + reasoning token plan (shared)

- **Objective:** the single shared effort vocabulary and the `(model, effort) → plan | infeasible` function.
- **Criteria:** canonical enum + Zod + labels in `packages/shared`; `reasoning-plan.ts` beside the estimator implements D1 exactly (B tier table as exported data; clamp floor 1024 / catalog cap; H untouched affordability path; `maxTokens = B+H`; discriminated wire output `{effort}|{max_tokens}` chosen by presence of `supported_efforts`; infeasible reasons typed); pure function, no IO; property tests for clamps/floors/infeasibility; feeds `PromptBudgetInput` type (field added, consumed in T5/T9).
- **Depends:** T1 (descriptor field shape).
- **Files:** `packages/shared/src/estimate/**`, `packages/shared/src/**` (enum module).
- **Checks:** `pnpm test:shared`, turbo shared filter.
- **Sensitive:** yes (money-adjacent: sizing feeds holds) → 2 auditors.

### T3 — Inline reasoning format: shared parser/serializer

- **Objective:** the G7 canonical format, implemented once.
- **Criteria:** `packages/shared` module exporting serialize(reasoning, answer) and parse(text) → `{reasoning?, answer}`; round-trip property tests; tolerant parse of text containing no delimiter (all = answer) and of models that natively emit the delimiter (no double-wrapping; leading-delimiter detection); handles streaming-partial text (unclosed delimiter ⇒ everything after open tag is reasoning-so-far); zero dependencies.
- **Files:** `packages/shared/src/**` (new module).
- **Checks:** `pnpm test:shared`.
- **Sensitive:** no.

### T4 — Adapter + routing: reasoning passthrough

- **Objective:** the language adapter can send a validated reasoning config; routing guards it.
- **Criteria:** `callParametersSchema` gains the `reasoning` discriminated union (from T2's wire type); `callSettingsFor` passes `providerOptions.openrouter.reasoning` to `streamText` (currently absent — first red test: providerOptions never set today); `routing-options.ts` variant sets `require_parameters: true` iff reasoning present (G4); typed domain error + new error code (shared error-codes + `friendlyErrorMessage` entry) for the no-endpoints refusal; no other call shape changes. **Cassette integration tests** (in `language-adapter.integration.test.ts`, via `setupRealProvider()` — the suite self-gates with `describe.skipIf(!SHOULD_RUN)`, running in CI and skipping locally without a real key): one exchange with `reasoning: { effort }` on an effort-native model and one with `reasoning: { max_tokens }` on a budget-native model (cheap models, prompts kept stable for hash stability), asserting reasoning deltas stream through the adapter and `finish` usage carries `reasoningTokens > 0` + inline cost. New body fields hash to new cassettes; record-on-miss populates them on the first CI run — no manual recording step, no version bump. **Also in this task (same file ownership):** `mock-provider.ts` gains deterministic reasoning emission — when a language request carries reasoning config, the mock emits a few `reasoning-delta` events before the echo text and sets `usage.reasoningTokens > 0` — so the reasoning cassette-test assertions stay provider-agnostic under the local mock run (T12 harness), and E2E (T11) gets its deterministic thoughts for free.
- **Depends:** T2, T12 (harness rework lands first; same adapter files).
- **Files:** `apps/api/src/slices/models/**`, `packages/shared/src/models/routing-options.ts`, `packages/shared/src/error-*.ts`.
- **Checks:** `pnpm test:api`, `pnpm test:shared`.
- **Sensitive:** no (single auditor; correctness pinned by cassettes).

### Interface notes from T2 audits (2026-07-22) — binding on T4/T5/T7

- T5 MUST map the descriptor's `limits['contextLength']` into `ReasoningPlanModel.contextLength` when calling the plan (the field is optional; omitting it silently un-caps B — fail-safe direction but not the intended clamp).
- T5 additionally owns the one-line wire mapping for T4's new `no_reasoning_endpoints` InferenceError in `apps/api/src/slices/workflows/nodes/model-call-execution.ts` (→ `ERROR_CODES.NO_REASONING_ENDPOINTS`; without it the routing refusal renders as generic UNAVAILABLE). File added to T5 ownership — no conflict with T7, which owns `smart-model-execution.ts` in the same directory.
- T4 cassette model ids (`openai/gpt-oss-20b` effort-native, `google/gemini-2.5-flash` budget-native) are Assumed until the first CI record run; a wrong id fails loudly there and is a one-line swap in `REASONING_MODEL_IDS`.
- T4 consumes the reasoning wire shape via the Zod schema exported from the T2 module (post-fix) — never a re-typed copy.
- The plan function does exact-membership, never nearest-mapping (G3). T7: when Auto's classified canonical level is infeasible for the resolved model, T7 picks a feasible level itself via the plan function (documented choice), never expects plan-level substitution.

### T5 — Turn definition + admission integration

- **Objective:** `POST /chat` accepts `reasoningEffort`; the turn prices and wires it via the plan.
- **Criteria:** `startTurnBodySchema` gains optional `reasoningEffort` (canonical enum + `'auto'|'none'`); 400 VALIDATION on unsupported level/non-reasoning model (G3 — no silent downgrade); `turn-definition.ts` composes the D1 plan with `fitAnswerCapToCeiling` (B constant, H sized; documented coupling preserved); admission estimate prices output as `B+H`; explicit `max_tokens` always sent on reasoning calls (G2); `'none'` on `mandatory` models is 400 (research: upstream rejects); trial path offers/accepts only ceiling-fitting levels (G9); settlement untouched (inline cost already includes reasoning).
- **Depends:** T2, T4.
- **Files:** `apps/api/src/slices/chat/**` (routes, turn-definition), NOT billing/settlement files.
- **Checks:** `pnpm test:api`.
- **Sensitive:** yes (admission/money) → 2 auditors.

### T6 — Persistence doctrine: same-field storage + history strip

- **Objective:** reasoning text persists inside the assistant text content exactly as received (R2/G6-G8).
- **Criteria:** at persist, the final assistant text = T3-serialized (reasoning, answer) when reasoning text arrived, else answer verbatim; no schema migration; history replay strips reasoning via the T3 parser at the existing history-build seam — **covering BOTH history sources: server-loaded rows AND client-supplied history arrays** (T14 flag, 2026-07-22: `use-chat-stream` toHistory / regeneration / trial send raw assistant content on the wire under E2EE — the server seam must strip whatever it is handed; test both paths: a prior turn with embedded reasoning produces provider messages without it); settlement char-counts operate on the stored field as-is (no special casing — R2); o-series (tokens>0, no text) persists answer only.
- **Depends:** T3; coordinate with T5 (same slice — sequenced after T5, same-file ownership).
- **Files:** `apps/api/src/slices/chat/**` (persist + history build).
- **Checks:** `pnpm test:api`.
- **Sensitive:** yes (user data/content) → 3-lens panel.

### T7 addendum (from T6, 2026-07-22, binding)

`streamModelCall` is shared with the smartModel classifier leg; after T6, a classifier model that streams reasoning yields a canonical-inline-prefixed value — T7's `resolveClassifierOutput` input must be the parsed `.answer` (one line via the shared parser), test-pinned with a reasoning-streaming classifier fixture. Also from T16: `TurnReasoningEntry.effort` now includes `'none'` — T7 must handle the off entry explicitly.

**G2 clarification (orchestrator-ratified 2026-07-22, from T16):** G2's always-explicit `max_tokens` applies to calls carrying a reasoning BUDGET (effort or max_tokens wire). A hard-off call (`{enabled:false}`) is a plain turn: cap present iff derivable, byte-consistent with reasoning-free calls — a literal G2 reading would regress rich-payer/trial 'none' turns to a 1000-token cap. Auditors confirm the shape; founder may override.
**Unruled edge (founder, low stakes):** N>5 effort vocabularies — T16 keeps the strongest five (Max stays the true top). Confirm or re-rule.

### T7 — Generalized classifier stage: effort dimension

- **Objective:** one classifier call can classify model and/or effort; Auto works for pinned models.
- **Criteria:** classifier stage is dimension-composed (D3): prompt composed from requested dimensions; output parsed per-dimension via `resolveClassifierOutput` against closed sets; canonical scale `low|medium|high` for effort; exactly one generation per turn in every combination (pinned+Auto, SmartModel alone, SmartModel+Auto — pinned via single-candidate short-circuit); unresolvable effort ⇒ `medium`, charge stands; non-reasoning model + Auto ⇒ no call, no charge, no reserve; admission classifier-reserve condition extended to `SmartModel ∨ effort=auto`; charge remains one `auxiliaryCharges` classifier entry in the same settlement.
- **Depends:** T2, T5 (request field exists).
- **Files (corrected 2026-07-22):** `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` (+ its test — NOTE: carries the foreign diff; T7 legitimately edits it and therefore INHERITS closing the 94.73% branch-coverage gap per §Known-foreign-failures), classifier modules, `packages/shared/src/smart-model/**`, `packages/shared/src/estimate/classifier-line-item.ts`, and the models-slice `estimate-run.ts` reserve-condition line (extend classifier reserve to `SmartModel ∨ effort=auto` — T5 could not reach it). T5's landed seams T7 builds on: `resolveTurnReasoning` (returns empty map, never undefined), auto currently reserved at a feasible placeholder level (medium→high→low) — T7 replaces the placeholder with classifier resolution; T5's 400 on engaged effort × SMART_MODEL_ID is the seam T7 relaxes for smartModel+auto.
- **Checks:** `pnpm test:api`, `pnpm test:shared` (superseded by §Gate-policy-amendment: scoped file checks; full gates at close).
- **Sensitive:** yes (billing) → 2 auditors.
- **T7 shipped deviations on record (2026-07-22, auditors judge):** (i) multi-model+auto keeps T5's placeholder reserve — no classifier call (fan-out siblings cannot host one call per turn); same for pinned+auto+webSearch (composite node has no tool loop) and trial pinned+auto; (ii) single-candidate model-only SmartModel nodes no longer hold the classifier reserve (short-circuit never bills one — strictly reserve-reducing); (iii) **pointed audit question:** SmartModel+auto does NOT add a B term — classified-effort thinking spends inside the existing answer cap (hold ≥ billable preserved since the cap is unchanged, but high classified effort can eat answer headroom — the truncation class B+H exists to prevent), while pinned+auto reserves placeholder B on top. Judge money-soundness AND whether the asymmetry warrants a fix or a founder note; (iv) additive ownership stretch: shared workflow.ts + mock-directives.ts + mock-provider.ts `x-mock-classifier-effort` knob (available to T11's E2E).

### T8 — Client streaming: reasoning accumulation

- **Objective:** reasoning deltas reach client message state (they are dropped today).
- **Criteria:** `use-authenticated-chat.ts` supplies `onReasoningToken`; optimistic assistant message accumulates reasoning in the same text field via the T3 streaming-partial convention (open delimiter on first reasoning token, close on first answer token) so live and persisted messages parse identically; `appendTokenToMessage` generalized, not copied; first red test: a `reasoning-delta` frame for a bound tile reaches the accumulator (fails today — no callback supplied); no rendering changes in this task. **Amendment (T3 clean, 2026-07-22):** T3's module landed at `packages/shared/src/reasoning-format.ts` WITHOUT a barrel export (index.ts was contended with T1's concurrent work) — this task adds `export * from './reasoning-format.js';` to `packages/shared/src/index.ts` and consumes the module through the barrel. The delimiter constants stay module-private (G7: only the shared module touches the delimiter — build the open/close accumulation through its exported API, never by writing literal `<think>` strings).
- **Depends:** T3.
- **Files:** `apps/web/src/hooks/chat/**`, `apps/web/src/lib/chat-messages.ts`, `packages/shared/src/index.ts` (barrel line only), and — only if the existing parse/serialize API cannot express the unclosed mid-stream state — a minimal streaming-assembly export added to `packages/shared/src/reasoning-format.ts` + tests (keeps delimiters module-private per G7; never write literal tags outside the module).
- **Checks:** `pnpm test:web`.
- **Sensitive:** no.

### T9 — Effort rail UI

- **Objective:** the vertical effort rail docked to the right of the prompt input (R1).
- **Criteria:** renders only when the selected model supports reasoning (capability derived from T1 metadata via the ModelFeatureId pattern); levels shown = model's supported set ∩ canonical enum, plus Auto on top; trial shows only ceiling-fitting levels (G9, via the shared plan — G5); infeasible levels disabled with reason — **pinned 2026-07-22 (founder):** greyed (disabled) pill, never hidden (except trial's G9 hiding), with an accessible reason via tooltip on hover/focus AND `aria-describedby` (distinguish "doesn't fit balance" from "exceeds model output limit"); disabled state recomputes live with the prompt-budget estimate through the shared plan (G5); changing effort = ONE touch/click on desktop AND mobile (interaction design free within: collapsed state may abbreviate but the accessible name is always the full word; visual label ambiguity (Max/Med/Min) must be resolved by the chosen design; hover/focus expansion honors reduced-motion); active level uses the One Red Rule; full keyboard operation (roving tabindex or radiogroup semantics) + SR labels; 44px effective touch targets; does not overlap composer content or panels at any breakpoint; selection persists via the D4 store (default auto, effective value clamps per model); built through the `frontend-design` skill, then design-review agent pass.
- **Depends:** T1, T2 (plan for feasibility), T5 (request field).
- **Files:** `apps/web/src/components/chat/input/**`, `apps/web/src/stores/**`, `packages/ui` (only if a primitive is genuinely shared).
- **Checks:** `pnpm test:web` (+ `pnpm test:ui` if packages/ui touched).
- **Sensitive:** no.

### T10 — Thinking display

- **Objective:** the glazed live-thoughts disclosure per D-UI.
- **Criteria:** all D-UI mechanics and honest states implemented; parses reasoning from message text via the T3 parser (live and persisted paths identical — works after reload by construction); fixed-height preview while streaming; row height changes only on user toggle (Virtuoso constraint); zero JS animation; mask-gradient glaze, no blur filters; `aria-hidden` preview, real disclosure button; "Reasoned privately (N tokens)" uses persisted reasoning token count; duration labels per the approved rule — live client-measured elapsed time may show only while streaming; settled and post-reload labels derive from the persisted reasoning token count (no duration is stored); reduced-motion identical behavior; built through `frontend-design` + design-review.
- **Depends:** T8 (accumulation), T3.
- **Files:** `apps/web/src/components/chat/message/**`, `apps/web/src/components/chat/indicators/thinking-indicator.tsx`.
- **Checks:** `pnpm test:web`.
- **Sensitive:** no.

### T11 interface note (from T9, 2026-07-22)

T9 fed `reasoningEffort` into `PromptBudgetInput` and grew `PromptBudgetResult` (exposes `maxOutputTokens`/`estimatedInputTokens`) — but the T9 audit confirmed the field is **accepted, not yet consumed**: the estimate does not rise with level, and `use-prompt-budget.ts:40-44`'s doc comment prematurely claims otherwise. T11 wires the consumption (its "estimate rises with level" criterion) AND corrects that comment. T9's display order shipped as Auto / High→Low / None (ruling read as membership; founder may override to the enumeration order). T11's remaining estimate work is verification/display polish, not first wiring. T9's manual design pass flagged for the live design-review: checked-pill 12px white-on-red ≈3.9:1 (matches committed button identity, sub-AA), hover expansion narrowing the composer (approved concept, verify feel). Client keeps a balance-infeasible selection selected-but-greyed; server admission is the refusal authority.

### T11 — Estimate display + E2E

- **Objective:** the composer's live estimate reflects effort; E2E covers the flow by extending existing specs (founder ruling: no new standalone spec).
- **Criteria:** `use-prompt-budget.ts` feeds effort into `PromptBudgetInput` (estimate rises with level, via the shared plan — G5). E2E: **extend `e2e/chat/chat.spec.ts`** (one-journey-per-test doctrine, `e2e/CLAUDE.md` rule 4.1) — within the existing send flow: select effort on a reasoning model → send → thoughts stream into the glazed preview → expand → answer arrives → reload → thoughts still render (persisted path); rail hidden on non-reasoning models. Per-message disclosure follows the `model-nametag.spec.ts` pattern (`TEST_IDS` entry + `ChatPage` helper; check `e2e/contracts/` for the signal/test-id registry contract first). The mock provider's deterministic reasoning-delta emission ships in T4 (file ownership); this task only consumes it. Trial low-levels coverage goes in the trial's existing spec if one covers the composer, else unit-level only. Specs import from `e2e/fixtures.js`, signal-based waits only, no new spec files.
- **Depends:** T5, T7, T9, T10.
- **Files:** `apps/web/src/hooks/**` (budget hook), `e2e/**`.
- **Checks:** `pnpm test:web`, targeted `pnpm e2e:<suite>`.
- **Sensitive:** no.

### T12 — Integration-test local/CI rework + evidence confinement

- **Objective:** cassette integration tests run everywhere — mock locally, real+cassettes in CI — and service-evidence writes are CI-only.
- **Criteria (finalized from the 2026-07-21 gating investigation):** the three adapter integration suites (language/image/video) drop `describe.skipIf(!SHOULD_RUN)`; the harness (`integration-setup.ts`) replaces module-scope raw `process.env['CI']`/`['E2E']` sniffing with one `createEnvUtilities()` derivation (the `VITEST` field exists for this) and resolves the provider as `useMock: !envUtils.isCI` — locally the SAME test bodies run against the deterministic mock (investigation verified every existing assertion in all three suites is provider-agnostic in shape and passes under the mock unmodified — no env-conditional assertions), in CI `useMock:false` runs real calls with record-on-miss cassettes. Evidence confinement: `resolveModelProvider`'s mock-first early return (already pinned by `resolve-model-provider.test.ts` "mock path records no evidence") is the structural enforcement point; add the harness-side pin — a test asserting the env→`useMock` derivation yields the mock outside CI (today's gap: `setupRealProvider` hardcodes `useMock:false` and only a skip stands between a CI-shaped local shell and a real evidence-writing call). `docs/CI-CASSETTES.md` gains the doctrine note: *there is no and will never be a local cassette system; locally these suites run the mock; evidence rows are CI-only behind the real-call path* (doc edit founder-directed this run).
- **Depends:** none upstream; **T4 depends on T12** (same files; T4's new reasoning cassette tests are written against the reworked harness).
- **Out of scope, escalate at close:** sibling harnesses share the raw-env `SHOULD_RUN` pattern (`gateway-metadata.integration.test.ts`, `linear-real`, `realtime-room-bindings`, `smoke/harness.ts`) — same CODE-RULES violation, separate workstream.
- **Files:** `apps/api/src/slices/models/adapters/**` (integration-setup, integration tests, resolve-model-provider), `docs/CI-CASSETTES.md`.
- **Checks:** `pnpm test:api`.
- **Sensitive:** no.

## Related E2E (declared per CODE-RULES)

- New/extended spec per T11 (messaging/streaming critical path — E2E mandated).
- Existing chat/streaming suites touched by composer changes: run the chat suite(s) at close, not the full run.

## Known foreign failures (attribute, never fix — other agents work in this repo)

- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` fails the per-file branch-coverage gate (94.73% < 95%) under another workstream's uncommitted diff (file + test, +47/−9 and +106 lines). Not caused by this run; no run task has it in its import graph. Agents running `pnpm test:api` must attribute this failure to that foreign diff and not touch the file. (If a later task in THIS run legitimately edits it — T7 likely will — that task inherits closing the gap.)
- `apps/web/src/hooks/models/use-resolve-default-model.ts` branch coverage 87.09% < 95% — pre-existing on committed, unmodified code (reproduces in isolation; independently flagged by the 2026-07-21 test-speed investigation). Makes `pnpm test:web` exit non-zero repo-wide; web tasks attribute and report tests-pass-except-this.
- `apps/api/src/middleware/pipeline-bindings.ts` `ExecutionContext` type error breaks `apps/web` typecheck (committed/unmodified or concurrent api workstream; not this run's). Attribute, don't fix.
- `apps/web/src/components/models/model-list-body.test.tsx:41` typecheck error on committed, unmodified code. Attribute, don't fix.
- Watch item: `markdown-renderer.tsx` intermittently reports 78.57% branch coverage in full-suite runs, 100% in isolation (foreign jsdom-pragma modification; likely flaky coverage merge). Rerun before attributing.
- Foreign vitest workstream (founder-flagged 2026-07-22, handle lazily): `packages/config/vitest.config.ts` concurrency change makes 3 pre-existing trial tests in chat `routes.integration.test.ts` flaky under `-t` subset filters (403 vs 402 quota contention); FULL-FILE runs pass — always judge by full-file runs.
- **E2E regression verdicts (investigator, 2026-07-23 — closes the run's Related-E2E attribution):** the suite-wide media UNAVAILABLE failures (131) and link-guest history failures (12) BOTH PREDATE this run — identical signatures in the retained `e2e/report/2026-07-20T19-19-25/` artifacts, before any reasoning code existed; the failing media spec passes in isolation on the current tree (report `2026-07-23T00-34-29`, 44/0). Attribution: media = environment/stack saturation under the full 12-worker matrix (fix direction: make the RunFailure kind observable in e2e artifacts — wrangler `--log-level error` suppresses it — then harden the saturating seam, likely storage; NEVER lower worker count per standing doctrine); link-guest = pre-existing share-route reload-on-exit loop (fix direction: trace the immediate post-mount route exit — prime suspect the fork-URL mirror navigating share-mounted pages to `/chat/$id` — and guard it for guests). Side finding, foreign: video cost-preview duration slider renders inverted min/max (unsorted catalog durations, `modality-config-panel.tsx:291`). All three are product bugs OUTSIDE this run's scope — founder-notes items 24–26.
- T13 deviation on record: the message-fetch read path lives in the CONVERSATIONS slice (the plan's "chat slice's published read path" was wrong); T13's ownership extends to `apps/api/src/slices/conversations/{adapters,ports,domain}`, `packages/shared/src/schemas/api/conversations.ts`, `apps/web/src/hooks/crypto/use-decrypted-messages.ts`, `apps/web/src/lib/chat-run.ts` — no table writers added.

### T13 — Reasoning token count exposure (added 2026-07-22; closes T10's data gap)

- **Objective:** the client message shape carries `reasoningTokens` (persisted and live) so T10's "Reasoned privately (N tokens)" and settled duration labels render truthfully.
- **Criteria:** message fetch responses include the persisted reasoning token count (from `llm_completions.reasoningTokens` via the chat slice's published read path — no new table writers); the live count reaches the optimistic message during streaming (finish/usage frame → the T8 accumulation path); `Message.reasoningTokens` (added by T10, unpopulated) is populated in both paths; a message with zero reasoning tokens carries 0/absent and renders no private-reasoning line; tests pin fetch shape, live update, and reload parity.
- **Additional criterion (2026-07-22, from T5):** extend `regenerateTurnBodySchema` with the same `reasoningEffort` field (+ idempotency body-hash coverage) — T5's criteria named only `startTurnBodySchema`; the shared execution path is already reasoning-capable, so this is schema+hash lines with validation parity tests.
- **Depends:** T5 (chat-slice file ownership), T10 (field + component exist). Files: `apps/api/src/slices/chat/**` (read path + regenerate schema), `apps/web/src/hooks/chat/**`, `apps/web/src/lib/api.ts`.
- **Checks:** `pnpm test:api` (serialized per gating rule), `pnpm test:web`. Sensitive: no.

### T14 — Raw-text consumers strip reasoning (added 2026-07-22; same-field doctrine consequence)

- **Objective:** no user-facing surface ever shows literal think-delimiters: every consumer of raw message text parses via the shared module.
- **Criteria:** the public share view (`routes/share.m.$shareId.tsx` render path) and copy-to-clipboard emit `parse(text).answer` (or answer + visible reasoning formatting where deliberately designed — default: answer only); grep-level sweep of apps/web for other raw `content` consumers (export, search preview, notifications preview, anything rendering message text outside the T10 component) with each either parsed or justified in the report; no literal delimiters outside the shared module (G7); tests pin share render and copy output for a reasoning-bearing message.
- **Depends:** T3, T8 (clean). Files: `apps/web/src/routes/**` (share), copy/clipboard util + their tests. No api changes; if the share API returns raw text server-side that is correct (ciphertext/plaintext contract unchanged) — stripping is presentation, done client-side per the doctrine.
- **Checks:** `pnpm test:web`. Sensitive: no (presentation), single auditor.

### T15 — Welcome-page feature entry (founder-added 2026-07-22)

- **Objective:** the marketing site's /welcome page lists reasoning effort as a feature alongside the existing ones.
- **Criteria:** one new feature entry in `apps/marketing/src/pages/welcome.astro` (or the component it delegates its feature list to), following the page's existing entry pattern exactly (structure, icon usage, length); copy matches brand voice per `docs/PRODUCT.md` and describes the feature truthfully (per-message thinking-effort control incl. Auto + visible thoughts); no layout or styling changes beyond the added entry; existing marketing tests/build stay green (`pnpm --filter marketing build` or the repo's marketing check).
- **Depends:** none (content describes the feature; ships with the run). Files: `apps/marketing/src/pages/welcome.astro` + its feature-list component only.
- **Checks:** marketing build/test; eslint on touched files. Sensitive: no.

### Founder ruling 2026-07-22 — 'None' is a hard off (+T16)

The UI offers a no-reasoning option labeled **None** (rail: Auto | None | Low | Medium | High; None hidden on `mandatory` models — T5's 400 stands). 'None' wires `reasoning: { enabled: false }` explicitly — never parameter-omission — so `default_enabled` models truly stop reasoning; G4 then applies (`require_parameters: true` rides any body carrying `reasoning`, including the off shape). There is no 'minimal' canonical tier; no copy replacement needed beyond using "None".

### Founder ruling 2026-07-22 — positional level normalization (supersedes exact-membership DISPLAY; wire mapping becomes positional)

The rail shows the SAME NUMBER of levels the model offers, normalized onto the canonical label ladder **Min < Low < Medium < High < Max**:

- Count N = the model's enumerated non-none effort levels (descending upstream order). Label assignment by N: 1 → [High]; 2 → [Low, High]; 3 → [Low, Medium, High]; 4 → [Min, Low, Medium, High]; 5 → [Min, Low, Medium, High, Max]. Each label maps positionally to the model's native effort string (High = top, Low = bottom of the shown non-Min/Max range, etc. — GPT-5's minimal/low/medium/high maps 1:1 under N=4).
- N=0-with-effort-vocabulary or a single-option no-choice model (one level, no off available) → **no rail**. Reasoning-unsupported models → no rail (unchanged).
- `null` supported_efforts (all accepted) → full 5-label ladder.
- **Budget-native models (no effort vocabulary): full 5-tier ladder** Min…Max as budget tiers — tier table grows to 5 entries (placeholders e.g. 1024/4096/12288/32768/65536 nano-registry data; Min respects the 1024 floor).
- None: shown for non-mandatory reasoning models (hard off via T16's `{enabled:false}`); Auto unchanged. Classifier canonical scale stays low|medium|high (D3); T7 maps positionally to the model's offered set.
- G3 preserved: every displayed label maps deterministically to a real native level or tier — nothing shown that can't be honored; validation accepts exactly the labels offered for that model.

### T16 — Hard-off wire variant + positional normalization (founder-ruled 2026-07-22, combined — same files)

- **Objective:** (a) selection 'none' sends `reasoning: { enabled: false }` end-to-end; (b) the shared plan module implements the positional ladder above and every consumer derives the offered-label set from it.
- **Criteria (a — hard off):** the shared wire schema gains the third discriminated variant `{ enabled: false }` (exclusivity preserved; TS type z.infer'd); T4's adapter passes it (mock/cassette test); the turn path emits it for 'none' on reasoning-capable non-mandatory models; G4 require_parameters fires for the off shape (verify the iff-check); B=0, maxTokens = today's H; mock emits no reasoning deltas and no reasoningTokens under enabled:false.
- **Criteria (b — normalization):** canonical enum grows to min|low|medium|high|max (selection = auto|none|those); tier table 5 entries (exported tunable data); a single exported authority `offeredLevels(model) → ordered [{label, wire}]` implements the N-ladder + budget-native 5-tier + null-full-ladder + no-choice-empty rules exactly as ruled; `planReasoning` wires positionally (label → native effort string for enumerated models; label → tier budget for budget-native); server validation (chat slice) accepts exactly the offered labels for the model (400 otherwise — G3); property tests over random vocabularies pin count-match (|offered| == N), order, positional wire mapping, and 1:1 GPT-5-shape mapping; existing consumers (T5 validation, admission pricing) updated to the authority fn — grep for any leftover exact-membership check.
- **Depends:** T5 clean (chat-slice files). Files: `packages/shared/src/reasoning-effort.ts`, `packages/shared/src/estimate/reasoning-plan.ts` (+tests), `apps/api/src/slices/models/adapters/**` (passthrough + mock + tests), `apps/api/src/slices/chat/**` (wiring + validation), `routing-options.ts` iff-check only if needed.
- **Checks:** `pnpm test:shared`, `pnpm test:api` (serialized). Sensitive: **yes** (repricing/validation surface) → 2 auditors.
- T9 consumes `offeredLevels` for rendering (labels incl. None/Auto placement); T7 maps classifier low|medium|high onto the model's offered set positionally (nearest offered position, documented).

### Amendment — T10 honest state (c), 2026-07-22 (provisional, founder may override)

No client-detectable signal distinguishes summarized from verbatim reasoning on the wire; true summary detection would require a new protocol field. Amended: the expanded view uses neutral copy ("Reasoning" — never "Full reasoning" or completeness claims), satisfying the analyst's underlying goal (users must not reconcile visible thought length against billed cost). State (c) as literally written is dropped. Design-review of T10+T9 is dispatched by the orchestrator as a dedicated agent once T9 and T4 (mock reasoning emission) make a live reasoning message reachable.

## Follow-ups recorded mid-run (sequence at close or as micro-tasks)

- `smart-model.integration.test.ts` (workflows slice) still imports `SHOULD_RUN`/`setupRealProvider` and keeps CI-only skip semantics; migrating it to the no-skip local-mock doctrine is a follow-up outside T12's ownership.
- `apps/api/vitest.config.ts` comment now slightly stale ("CI-gated" wording); the coverage exclusion itself remains correct. Code-comment fix at close.
- T8 flag: the trial-chat path is not wired for reasoning deltas. T11 must check whether trial can stream reasoning (trial offers low levels per G9) and wire/assert accordingly.
- Future-definitions note (T6 correctness audit): a graph whose transform/fanIn nodes consume a modelCall's value will see the serialized inline reasoning form — today no live definition does; any future definition authoring must parse `.answer` at the consuming node or strip at emit. Keep visible when the workflow library grows.
- T8 deviation on record (auditor judges merits): reasoning accumulates in always-closed canonical form (serialize on each delta) rather than the criteria's literal open-tag/close-on-first-answer convention; claimed parse-identical to persisted at every intermediate state, avoids the optional streaming-assembly export and native-tag mis-closing.

## UI pivot (founder-confirmed 2026-07-23 — supersedes the rail)

The rail (R1) is replaced by a self-labeling dropdown chip `Effort · <current>` in the composer controls row left of send: upward menu (Auto/High/Mid/Low/Min/None — 4-char full words; Medium's display word is "Mid"), built on the composer's existing menu primitives; slide in/out on model/modality switch (reduced-motion gated); textarea starts at 2 lines, grows to 7, then scrolls. Supersessions: the one-touch requirement is relaxed to open+pick (founder's own change); the founder-ratified radiogroup/focus-then-confirm keyboard model is superseded by standard menu semantics (Radix menu). Surviving unchanged: greyed-never-hidden + cause-specific tooltip/aria-describedby reasons, trial hiding, persistence + per-model clamp, offeredLevels-only rendering (G5), capability gating, ordering Auto/High→Low/None. Rail code deleted.

## Gate policy amendment (founder-directed 2026-07-22)

Full-package suite runs kept stalling agents (repeated dormancy waiting on long coverage runs). Effective immediately: **implementer and auditor self-gates run SPECIFIC-FILE checks only** (`pnpm test:watch <files> --run` / scoped vitest on the touched files + their consumers, plus eslint/typecheck as before). The full-package coverage gates run ONCE, serialized, in Phase 4 close — attributing recorded foreign failures there. A task's clean no longer requires a full-package run by its own agents.

## Approval record

- 2026-07-22 — founder approved the plan (everything except doc edits, which are held). Delimiter `<think>`, placeholder B tiers, and the task structure stand as presented.
- Founder ruling: **no doc file is edited during implementation.** All doc changes accumulate in this section as they arise and are presented as one batch at the end of the entire implementation for per-file rulings. This supersedes T12's in-task `docs/CI-CASSETTES.md` edit — T12 implements the code rework only; its doc note is recorded below.
- Thinking-duration label rule (T10): while streaming, the panel may show live client-measured elapsed time; settled and post-reload labels derive from the persisted reasoning token count only ("Reasoned · N tokens"). No duration is stored.

## Founder-notes batch (assembled at close per the completeness critic — every item gets a ruling or an explicit "carried")

1. SmartModel+auto no-B-term asymmetry (accepted as money-sound by both T7 auditors; classified thinking spends inside the answer cap — fix would be a B term in the multi-candidate reserve).
2. N>5 effort vocabularies: T16 keeps the strongest five (Max = true top) — confirm or re-rule.
3. G2 hard-off clarification (off-wire cap mirrors reasoning-free turns) — orchestrator-ratified; confirm.
4. T10 state-(c) neutral copy ("Reasoning", no completeness claims; no summary detection without a protocol field) — provisional; confirm or request the protocol field.
5. T9 rail order Auto/High→Low/None — already founder-confirmed 2026-07-22 ("your ordering is good"): RATIFIED, listed for completeness.
6. Auto-on-mandatory-single-level: offers nothing, reasons at provider default within H (product-quality corner).
7. Trial+auto: placeholder reserve vs 1¢ ceiling may refuse — unverified server corner; rule whether to care.
8. T16 off-shape cassette exchange (mock-only shipped; optional live-recording follow-up).
9. Share-payload `role` field — eventual clean fix for user-authored think-tags on the public share route.
10. `compileWireParams` dead code — wire it for flat params in the catalog workstream or delete.
11. Six founder-key OpenRouter probes (research §C, ~$0.05) — founder-owned; includes max_tokens-unset basis.
12. First post-commit CI run needs a named watcher: reasoning cassettes record on miss; T4's two model ids are Assumed and a wrong id is a one-line swap.
13. AUTO_REASONING_EFFORT_ORDER hoist to shared if Auto should ever be display-priced (client currently shows Auto as reasoning-free floor, honestly documented).
14. Sibling raw-env test harnesses (gateway-metadata, linear-real, realtime-room-bindings, smoke) share the CODE-RULES env violation; `smart-model.integration.test.ts` still on CI-only-skip semantics — separate workstream or explicit deferral.
15. `use-resolve-default-model.ts` deterministic coverage gap (87.09%, committed foreign) reddens `pnpm test:web` repo-wide — route to its owner.
16. `reasoning-effort-proposal.html` at repo root — delete or move into the run dir (doc-lifecycle: it is none of loaded/on-demand/history).
17. Phase-4 full-package gates: HELD on the vitest workstream — re-trigger = "when that workstream settles, before commit"; orchestrator-owned. (T6's runtime.ts full-coverage confirmation rides this run.)
18. Optional: a standing arch/lint rule enforcing G1/G7 against future code (none required by the plan; note only).

From the design review (2026-07-22, score 31/40; screenshots in `.playwright-mcp/`):
19. Checked-pill contrast (white on Signal Red at 12.75px ≈3.75:1, sub-AA small-text) — this IS the committed `button-primary` identity; joins the already-pending brand-red contrast ruling from the mailing-list workstream. Adjudicate there.
20. Rail keyboard model: arrows move focus, Enter/Space selects — deviates from the ARIA radio pattern (arrows-select) but is a defensible cost-safety choice; either bless focus-then-confirm (and consider whether role=radio is the right contract) or switch to arrows-select.
21. Disclosure copy shipped as "Thoughts"/"Thoughts (N tokens)" vs the amendment's literal "Reasoning" — no completeness claim is made, but the token-count-in-label invites visible-vs-billed reconciliation on summarizing providers. Pick the word.
22. Mobile rail grammar: two-glyph codes are the only visible labels on touch, tooltips unreachable, and the reveal tap IS the select tap (your one-touch requirement) — a first-time mobile user can change a cost-affecting setting before reading it. Tension between one-touch and read-before-select needs your call (e.g., always-full-words on mobile at the cost of width?).
24. Pre-existing media e2e UNAVAILABLE under load: instrument RunFailure kind visibility in e2e artifacts, then harden the saturating seam (storage suspected). Never lower worker count.
25. Pre-existing link-guest reload loop: trace + guard the post-mount route exit for guests (fork-URL mirror suspected).
26. Foreign: video duration slider inverted min/max from unsorted catalog durations (`modality-config-panel.tsx:291`).
23. Nit pair, accept or polish: the 7-level rail floats ~42px above the resting composer's top (reads unanchored until the composer grows); the settled short-reasoning preview keeps ~2 lines of dead space (the fixed height is the recorded Virtuoso constraint — post-settle shrink-to-content would be a single discrete transition if you want it).

## Doc changes (accumulating — presented at END of implementation, founder rules per file)

- R2 doctrine recorded: founder judged CODE-RULES a poor fit; proposed home = `apps/api/CLAUDE.md` (loaded for all backend work; the doctrine binds persist + history-replay) with a mirror line in `apps/web/CLAUDE.md` (parse-on-demand display) and one line in ARCHITECTURE.md §Data model essentials.
- `docs/CI-CASSETTES.md` (from T12): note that there is no and will never be a local cassette system; locally the adapter integration suites run the deterministic mock with no skips; evidence rows are CI-only behind the real-call path.
- `docs/BILLING.md` (completeness critic): one line each — the admission output term is now effort-aware (B+H on reasoning turns), and the classifier reserve condition is `SmartModel ∨ effort=auto`.
- Workflows slice loaded doc (completeness critic): one line — node values from a reasoning modelCall carry the serialized inline reasoning form; future transform/fanIn consumers must parse `.answer` (the run-dir note is not citable as current).
- ARCHITECTURE.md (already listed) + apps/api/apps/web CLAUDE.md R2 doctrine placement (already listed).
- ARCHITECTURE.md: one line in Models & capabilities (reasoning metadata in catalog) + Data model essentials (reasoning embedded in message text).
- `compileWireParams` dead-code disposition (escalated, not decided here).
