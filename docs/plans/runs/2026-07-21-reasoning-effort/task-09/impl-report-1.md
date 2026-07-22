# T9 — Effort rail UI — impl-report-1

## Objective

Vertical reasoning-effort rail docked right of the prompt input (R1): renders offeredLevels' labels + Auto (top) + None (non-mandatory only); one-touch change desktop and mobile; disabled-with-reason per the pinned 2026-07-22 criteria; trial hides non-fitting levels (G9); full radiogroup keyboard semantics; persisted preference store (D4); selection rides the startTurn request.

## Files changed

New (in-ownership):

- `apps/web/src/stores/reasoning-effort.ts` — persisted Zustand store mirroring `stores/search.ts`; `preferredReasoningEffort` default `'auto'`. Key is a store-local literal per `packages/shared/src/storage-keys.ts`'s own doctrine ("store-local keys with no cross-package consumer may stay literals"); promote when T11's e2e needs to seed it.
- `apps/web/src/components/chat/input/reasoning-effort-rail.tsx` — the rail component + `railPillStates` feasibility classifier (through shared `planReasoning`/`planReasoningOff` — G5) + `RAIL_DISABLED_REASONS` copy.
- `apps/web/src/hooks/chat/use-reasoning-effort.ts` — the `useWebSearch`-mirror hook: pure derivations (`railOfferedLabels` intersection over shared `offeredLevels`, `railOffersNone`, `effectiveReasoningSelection` model-clamp) + the hook every consumer reads (rail, budget input, send paths).

Edited (some outside T9's plan-listed Files — see Deviations):

- `apps/web/src/components/chat/input/prompt-input.tsx` — docks the rail in a flex row right of the composer box (`min-w-0 flex-1` box + rail); feeds the effective selection into `usePromptBudget`'s `reasoningEffort` input (T2/T16 landed field).
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — `PromptBudgetResult` additionally exposes `maxOutputTokens` + `estimatedInputTokens` (already computed by `useBudgetCalculation`; the rail's live disabled-state recompute reads them).
- `apps/web/src/hooks/chat/use-chat-stream.ts` — `reasoningEffort?` on `AuthenticatedStreamRequest`, `TrialStreamRequest`, `TurnWireBody`; spread into the `/chat` and `/chat/trial` bodies (absent = omitted, matching webSearchEnabled's pattern). Regenerate deliberately untouched (T13 owns `regenerateTurnBodySchema`).
- `apps/web/src/hooks/chat/use-authenticated-chat.ts` — reads `useReasoningEffort().effective`; spreads it into both startStream sites (existing conversation + create-mode); dep arrays updated.
- `apps/web/src/components/chat/page/trial-chat-page.tsx` — same wiring for the trial send.

Test-only edits:

- `apps/web/src/components/chat/input/prompt-input.test.tsx` — 4 rail tests + `defaultBudget` gains the two new fields (type-required).
- `apps/web/src/hooks/billing/use-prompt-budget.test.ts` — 2 exposure tests.
- `apps/web/src/hooks/chat/use-chat-stream.test.ts` — 3 body tests (auth include/omit, trial include).
- `apps/web/src/hooks/chat/use-authenticated-chat.test.ts` — hook mock + 2 request tests.
- `apps/web/src/components/chat/page/trial-chat-page.test.tsx` — hook mock + 1 request test.
- `apps/web/src/components/chat/page/chat-welcome.test.tsx` — budget fixture gains the two new fields (type-required, no behavior change).
- `apps/web/src/components/chat/page/authenticated-chat-page.test.tsx` — mocks `use-reasoning-effort` (its file-level react-query mock lacks `useQuery`, which my hook's `useModels()` now reaches; 99 tests failed until mocked — my breakage, fixed).

## Tests added (name — behavior — criterion)

- store: default auto / setReasoningEffort updates / persist key — D4 persisted store, default auto.
- `railOfferedLabels`: positional ladder for enumerated vocab; full ladder budget-native; empty on any non-reasoning model; canonical-order intersection for multi-model — "renders exactly offeredLevels" via the shared authority, never re-derived.
- `railOffersNone`: offered iff no mandatory model — 'None' hidden on mandatory (founder ruling).
- `effectiveReasoningSelection`: level passes when offered; unoffered clamps to auto; auto passes; none kept / clamped on mandatory; undefined on non-text, Smart Model, non-reasoning, unresolved — "effective value clamps per model".
- `useReasoningEffort`: catalog-resolved effective; undefined pre-catalog; setSelection persists; empty selection undefined.
- `railPillStates`: all-enabled happy path; balance-infeasible level; output-limit-infeasible level; None omitted on mandatory; None disabled at zero headroom; None output-limit on exhausted context — disabled-with-reason, cause-specific, via shared plan (G5).
- Rail component: hidden for non-reasoning / Smart Model / non-text; full-word accessible names with Auto top and None last; checked = effective; auto-checked when preferred unoffered; one-click select; disabled pill aria-disabled + aria-describedby resolving to balance copy; output-limit copy; disabled click ignored; trial hides infeasible (G9); trial preference resets to auto when hidden; arrow-key roving focus; Home/End; unrelated key no-op; ArrowUp at top no-op; 44px mobile targets; keyboard select — pinned disabled-state behavior, keyboard/radiogroup semantics, one-touch.
- PromptInput: rail docked when model offers levels; absent otherwise; forwards `reasoningEffort` into `usePromptBudget`; omits when disengaged.
- usePromptBudget: exposes `maxOutputTokens` / `estimatedInputTokens`.
- useChatStream: `/chat` body carries/omits `reasoningEffort`; trial body carries it — "selection rides the startTurn request".
- useAuthenticatedChat + TrialChatPage: request objects carry the effective selection; omitted when disengaged.

All tests were watched RED for the expected reason before implementation (module-missing or field-missing failures), then GREEN.

## Self-gate

- `pnpm test:web` (full, coverage gate) — tests: **363 files / 5962 tests, all passing** (two consecutive full runs). First run had failed with 99 fails in `authenticated-chat-page.test.tsx` (my hook reaching that file's incomplete react-query mock — my breakage, fixed by mocking `use-reasoning-effort` there).
- Coverage gate: every file I touched or created meets the 95% per-file gate (e.g. `stores/reasoning-effort.ts` 100/100/100/100). The run exits 1 solely on `src/hooks/models/use-resolve-default-model.ts` branches 87.09% — **foreign, with evidence**: the file and its test are committed-unmodified (last commit 92785bc4, clean `git status`), I never touched them, and running that test file in complete isolation reproduces the identical 87.09% — so the shortfall is intrinsic to the current tree, not an interaction with my changes. Deterministic (identical figure across two full runs + isolation), so NOT the plan's flaky-coverage-merge watch item; likely exposed by the foreign-modified `apps/web/vitest.config.ts` (test-speed workstream). Raised for the orchestrator to route.
- `npx turbo typecheck --filter=@hushbox/web --force` — apps/web sources clean; remaining error is foreign: `../api/src/middleware/pipeline-bindings.ts(59): TS2304 ExecutionContext` — file is committed-unmodified and untouched by me; earlier in the session the same run also showed transient unused-import errors in `apps/api/src/slices/chat/domain/smart-model-turn.ts` that disappeared between runs — consistent with T7's concurrent apps/api work per the coordination note.
- `npx eslint <every touched file>` from `apps/web/` after the final edit — exit 0.
- `node .claude/skills/frontend-design/scripts/detect.mjs --json` on the rail + prompt-input — `[]` (clean).

## Acceptance criteria

- Renders only when the model supports reasoning, derived from T1 metadata — MET. Gating keys on the structured `reasoning` object through shared `offeredLevels` (the T1 interface ruling's single authority; `behaviors` never consulted). Note: the plan names "the ModelFeatureId pattern"; `ModelFeatureId` gates on `supportedParameters`, which would violate the T1 ruling, so the rail follows the same *shape* (derive a UI flag from catalog data in shared code) but keys on `reasoning` — deviation recorded below.
- Levels shown = offeredLevels ∩ canonical + Auto top + None (non-mandatory) — MET (`railOfferedLabels` renders labels straight from `offeredLevels`; never re-derives the ladder; display order Auto / strongest→weakest / None).
- Trial shows only ceiling-fitting levels (G9, via shared plan) — MET client-side: unauthenticated flows price through the shared core at the trial tier (`getEffectiveBalanceNano` → `TRIAL_FIXED_BALANCE_NANO_USD`), feasibility via `planReasoning`; infeasible pills hidden, and a hidden preferred level resets to auto. Server truth stays `trialReasoningSelection` (Verified: `apps/api/.../turn-definition.ts:1027`).
- Pinned disabled-state: greyed never hidden outside trial; tooltip on hover/focus AND aria-describedby; cause-specific copy ("Doesn't fit your current balance" vs "Exceeds the model's output limit"); live recompute through the shared plan from the prompt-budget numbers (150 ms debounced budget → props → `railPillStates`) — MET.
- One touch/click desktop AND mobile — MET: every pill is a direct target (collapsed two-glyph abbreviations A/MX/HI/MD/LO/MN/OFF resolve the Max/Med/Min collision); tap/click selects immediately; 44px (`min-h-11 min-w-11`) targets on mobile, 28px pointer targets on desktop.
- Accessible names always full words — MET (aria-label full word; abbreviation spans aria-hidden); hover/focus expansion is a discrete class swap (no animation), trivially honoring reduced-motion (G12); the only transition is `transition-colors` with `motion-reduce:transition-none`.
- Active level One Red Rule — MET (`bg-primary text-primary-foreground` selection signal only).
- Full keyboard operation — MET: radiogroup + roving tabindex (checked pill tab-stop), Arrow/Home/End move focus (disabled pills stay focusable so SR users hear the reason), Enter/Space select.
- No overlap with composer content/panels — MET by construction: rail is in-flow in the composer row (`min-w-0 flex-1` box), no absolute positioning; hover expansion widens the rail and narrows the composer rather than overlapping.
- Persisted D4 store, default auto, effective clamps per model — MET (`useReasoningEffortStore` + `effectiveReasoningSelection`).
- Selection rides the startTurn request — MET for `/chat` (both send sites) and `/chat/trial`; regenerate excluded (T13's criterion).
- Built through `frontend-design` skill — MET (skill loaded, dials declared, detector clean). Design-review agent pass — NOT RUN here (cannot spawn agents); documented manual pass below.

## Manual design pass (in lieu of the design-review agent)

Checked against DESIGN.md + skill floors: flat (no shadows), warm surfaces (transparent on bg-background, hover `bg-secondary`), One Red only on the checked pill, tokens only (no stray hex), semantic `<button>`s, `data-chrome` on the rail, copy direct and precise, no banned patterns, zero JS animation, reduced-motion covered. Two items flagged for the live design-review: (1) checked-pill label is 12px white-on-brand-red (~3.9:1) — matches the committed `button-primary` identity but is below AA for small text; mitigated with `font-semibold`; a review may prefer a higher-contrast checked treatment. (2) hover expansion narrows the composer (founder's approved concept behaves the same); confirm feel in the running app at 1440/768/375.

## Deviations (all raised in the return message)

1. Files outside T9's plan-listed ownership edited: `hooks/chat/use-reasoning-effort.ts` (new), `hooks/chat/use-chat-stream.ts`, `hooks/chat/use-authenticated-chat.ts`, `hooks/billing/use-prompt-budget.ts`, `components/chat/page/trial-chat-page.tsx` (+ their tests, `chat-welcome.test.tsx`, `authenticated-chat-page.test.tsx`). Each is forced by a T9 criterion (D4 hook mirror, "selection rides the startTurn request", "recompute through PromptBudgetInput") and none conflicts with T7 (apps/api only). T11 (later, depends on T9) owns `hooks/**` — its brief should know `PromptBudgetResult` grew two fields and `PromptBudgetInput.reasoningEffort` is now fed by the composer.
2. Capability gating keys on the `reasoning` object, not `ModelFeatureId`/`supportedParameters` (T1 interface ruling wins over the criterion's "ModelFeatureId pattern" wording).
3. Smart Model: rail hidden and nothing sent — the server 400s engaged effort × SMART_MODEL_ID until T7 relaxes smart+auto (Verified: `apps/api/src/slices/chat/routes.ts` engagedReasoningRefusal). When T7 lands, the `models.some(id === SMART_MODEL_ID) → undefined` line in `effectiveReasoningSelection` is the single place to relax client-side.
4. Display order is Auto / Max→Min / None (strongest under Auto, off at the bottom) — the ruling's "Auto | None | Low | Medium | High" enumeration read as set membership, not order; the proposal's approved demo also runs strongest-first.

## Concerns and limitations

- An authenticated, already-selected level that *becomes* balance-infeasible (typing grows the prompt) stays selected: the pill greys but the selection is honored (G3 — no silent downgrade); the server's admission gate is the refusal authority. Once T11 prices effort into the estimate, the composer's blocking-error path will also engage client-side.
- Auto is never disabled client-side; on a reasoning model where no level fits, the server's auto resolution yields no reasoning (placeholder order finds nothing) — honest no-op.
- No TEST_IDS entries added (T11's criterion owns the e2e disclosure ids); unit tests use roles/names.
- `pnpm test:ui` not run — `packages/ui` untouched.
- Multi-model fan-out: labels are the intersection and a level must be feasible for every selected model (mirrors `levelEntries`' every-model refusal); None hidden if any model is mandatory.

## Confidence

High for behavior (every criterion pinned by a watched-red test; server contracts read from source). Medium for visual polish — the live design-review pass (orchestrator-dispatched) has not run; two flagged items above.
