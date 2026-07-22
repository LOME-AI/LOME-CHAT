# T16 — Hard-off wire variant + positional normalization — impl report 1

## Objective

Per plan §Task-T16 (both criteria sets): (a) selection `'none'` wires `reasoning: { enabled: false }` end-to-end (explicit, never parameter omission); (b) the canonical ladder grows to `min|low|medium|high|max` with the positional-normalization authority `offeredLevels(model)` that every consumer derives from.

## Files changed

- `packages/shared/src/reasoning-effort.ts` — enum grows to `['min','low','medium','high','max']` (ascending ladder); labels add Min/Max; `none` label changed `'Off'` → `'None'` (founder ruling copy); doc reframed: labels are positions, not upstream words.
- `packages/shared/src/reasoning-effort.test.ts` — updated pins for the 5-label enum, selection order, and the None label.
- `packages/shared/src/estimate/reasoning-plan.ts` — (b) `offeredLevels(model) → ordered OfferedLevel[]` authority (N-ladder via covered `ladderFor()` if-chain, descending-upstream positional zip, `none`-entry exclusion, single-level-mandatory → empty, null → full ladder over upstream words `minimal…max`, budget-native → full 5-tier clamped budget ladder, >5 keeps strongest five); tier table grows to 5 entries (`min:1024=floor, low:4096, medium:12288, high:32768, max:65536`); `planReasoning` rewired to derive wire from `offeredLevels` (native words on the wire, membership = offered ladder); (a) `ReasoningWire` gains third strict variant `{ enabled: z.literal(false) }` and the effort branch widens to `z.string().min(1)` (native words); `planReasoningOff(model, H)` (B=0, maxTokens=H, off wire; new infeasible reason `'reasoning-mandatory'`); `reasoningBudgetForWire(model, wire)` for the server's B re-derivation (off→0, budget verbatim, native word → positional label → clamped tier, unoffered → 0 fail-safe).
- `packages/shared/src/estimate/reasoning-plan.test.ts` — rewritten for positional semantics; new describes for `offeredLevels` (all ruled rules + GPT-5 1:1 pin), `planReasoningOff`, `reasoningBudgetForWire`, wire schema variants; property tests (seeded mulberry32, 500 cases) pin count-match (|offered| == N), ladder order, positional wire mapping, feasibility ⟺ offered-membership, and the pre-existing floor/cap/strict-greater invariants.
- `packages/shared/src/index.ts` — barrel adds `offeredLevels`, `planReasoningOff`, `reasoningBudgetForWire`, type `OfferedLevel`.
- `apps/api/src/slices/models/adapters/mock-provider.ts` — additive: `mockReasoningTextFor()` helper; the mock now emits reasoning only for an ACTIVE wire — absence, malformed, and `{enabled:false}` all produce no deltas and no reasoningTokens.
- `apps/api/src/slices/models/adapters/mock-provider.test.ts` — new hard-off test (no reasoning-delta events, `reasoningTokens` undefined, echo intact).
- `apps/api/src/slices/models/adapters/language-adapter.test.ts` — new: hard-off wire rides `providerOptions` onto the body; `require_parameters: true` fires for the off shape (G4 iff pinned for all three shapes); native word (`xhigh`) passes through verbatim (replaces the obsolete "rejects non-canonical effort" test); `{enabled:true}` still rejected. No adapter source change was needed: it composes `ReasoningWire` from shared, so the third variant flows through `callParametersSchema` → `callSettingsFor` → `providerOptions.openrouter.reasoning`, and `streamFailure`/`languageRoutingOptions({reasoning: parameters.reasoning !== undefined})` already treat the off shape as reasoning-carrying.
- `apps/api/src/slices/chat/domain/turn-reasoning.ts` — `'none'` now resolves to per-model hard-off entries via `planReasoningOff` (`offEntries` replaces `refuseMandatoryNone`): reasoning-capable non-mandatory → `{effort:'none', wire:{enabled:false}, reasoningBudgetTokens:0}`; non-reasoning model → no entry; mandatory → same validation 400 message as before. `TurnReasoningEntry.effort` widens to `CanonicalReasoningEffort | 'none'`. Comment updates for positional membership.
- `apps/api/src/slices/chat/domain/turn-reasoning.test.ts` — hard-off entry pins; `'none'` no-op on non-reasoning model; auto now resolves positionally on a lone-`xhigh` model (High rung); auto → no entry on a single-level mandatory model (nothing offered).
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `nodeReasoningBudgetTokens` handles the off wire (B=0) and re-derives native-word B via shared `reasoningBudgetForWire` (import swap `planReasoning` → `reasoningBudgetForWire`); `turnAnswerSizing` treats an all-B=0 map (the `'none'` case) exactly like a reasoning-free turn (derived ceiling, no payer-budget requirement — trial `'none'` keeps working); `answerNodeParams` writes the off wire with the reasoning-free cap shape (cap present iff derivable — see Deviations D1).
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — hard-off node params (cap = H alone; capless when underivable); refit re-derivation: off wire → B=0, native `xhigh` wire → High-tier B (was 0/broken under exact membership).
- `apps/api/src/slices/chat/domain/turn-definition.integration.test.ts` — new describe: `'none'` build wires `{enabled:false}` with a cap byte-identical to the plain turn's derivation (49_585 pin), and a budget-less (trial-shaped) `'none'` build succeeds uncapped.
- `apps/api/src/slices/chat/routes.ts` — comment truths only (the `'none'`-is-no-op wording predates the hard-off ruling); no behavior lines changed — validation flows through the plan, which is now offered-ladder membership (G3).

## Tests added (name — behavior — criterion)

Shared (`reasoning-effort.test.ts`, `reasoning-plan.test.ts`):
- enum/selection/label pins — 5-label ladder, `auto|min|low|medium|high|max|none`, None/Min/Max labels — criterion (b) enum growth.
- `offeredLevels` describes — every ruled ladder rule: N=0/none-only empty, single-level-mandatory empty, 1→[High], per-count ladders, descending positional zip, GPT-5 1:1 (N=4), none-exclusion, mandatory-with-choice offered, >5 truncation, null full ladder over upstream words, budget-native 5-tier + clamp/floor — criterion (b) authority.
- `offeredLevels` seeded property — |offered| == N, ladder order, positional wires over random vocabularies — criterion (b) property tests.
- `planReasoning` positional describes — native-word wires, unoffered-label refusals (incl. min/max on N=3, empty enumeration, single-level mandatory), null → upstream-word wires, budget-native unchanged, clamp/floor/headroom invariants preserved — criteria (b) + G3/G10.
- `planReasoningOff` describe — not-capable / reasoning-mandatory / no-headroom refusals; B=0, maxTokens=H, `{enabled:false}` wire — criterion (a).
- `reasoningBudgetForWire` describe — off→0, budget verbatim, positional re-derivation, clamp, unoffered→0, agreement with every feasible plan — supports admission/refit consumers.
- `ReasoningWire` describe — third variant parses; mixed shapes and `{enabled:true}` rejected; native words accepted — criterion (a) exclusivity.

API:
- mock-provider: hard-off emits no reasoning deltas / no reasoningTokens — criterion (a) mock behavior.
- language-adapter: off wire on body; `require_parameters` for off shape; native-word passthrough; `{enabled:true}` rejected — criteria (a) adapter passthrough + G4 iff.
- turn-reasoning: `'none'` → off entries / no-op on non-reasoning / mandatory 400 (existing); auto positional on `xhigh`; auto empty on no-choice model — criterion (a) turn path + (b) consumers.
- turn-definition unit: off node params (cap = H, capless mirror), off-wire refit B=0, native-wire refit positional B — criteria (a) B=0/maxTokens=H + (b) re-derivation.
- turn-definition integration: `'none'` cap identical to plain turn (49_585); budget-less `'none'` builds uncapped — criterion (a) "maxTokens = today's H" end-to-end.

TDD: each new behavior was watched red first (enum 4 failures; plan module 35 failures; mock 1; turn-reasoning 1; turn-definition 2 — each failing for the expected missing-behavior reason). Exceptions noted in Deviations D3.

## Self-gate

- `pnpm test:shared` — pass (99 files, 2185+ tests, coverage gate green; `reasoning-plan.ts` 100/98.18/100/100 — sole uncovered branch is the TS `noUncheckedIndexedAccess` zip fallback, documented in code).
- `pnpm test:api` — tests pass, exit 1 from the known foreign coverage gap only. Full-log evidence (run 2026-07-22, serialized, `ps`-checked no concurrent vitest): `Test Files 432 passed | 3 skipped (435)`, `Tests 5981 passed | 4 skipped (5985)` — ZERO test failures; the only threshold errors are `Coverage for branches (94.73%) does not meet ... for src/slices/workflows/nodes/smart-model-execution.ts` (both the global and the `src/slices/**` line, same file). That is verbatim the plan §Known-foreign-failures entry: foreign uncommitted diff, file outside my ownership and import graph, untouched by me (`git status` shows the foreign modification). Attributed, not fixed (T7 inherits per plan). An identical earlier run failed the same single way.
- `npx turbo typecheck --filter=@hushbox/shared --filter=@hushbox/api --force` — pass (2/2).
- `npx turbo typecheck --filter=@hushbox/web --force` — fails ONLY with the known foreign `apps/api/src/middleware/pipeline-bindings.ts` `ExecutionContext` error (plan §Known-foreign-failures — attributed, not touched; no error references my changes).
- `eslint <touched files>` from `packages/shared` and `apps/api` package dirs, run after the final edit — exit 0.
- Scoped integration runs via `pnpm test:watch`: `turn-definition.integration.test.ts` 6/6, `chat/routes.integration.test.ts` 174/174.
- Coverage-run contention: `ps aux | grep vitest` checked clean immediately before launching the full `pnpm test:api` gate.

## Acceptance criteria

(a) hard off:
- Third discriminated variant `{enabled:false}`, exclusivity preserved, TS z.infer'd — MET (`reasoning-plan.ts` ReasoningWire; strict-object mixed-shape rejection tests).
- Adapter passes it (mock test) — MET (language-adapter body test; mock emits nothing under off). Cassette exchange not added — see Deviations D2.
- Turn path emits it for `'none'` on reasoning-capable non-mandatory models — MET (`offEntries` + integration pin; non-reasoning no-op; mandatory 400 unchanged).
- G4 require_parameters fires for the off shape (iff-check verified) — MET (`language-adapter.ts:446` derives `reasoning !== undefined`, covers off; pinned for all three shapes + absent).
- B=0, maxTokens = today's H — MET (plan returns B=0/maxTokens=H; sizing uses derived ceiling; integration pins cap identical to plain turn). Interpretation for the underivable-cap case in Deviations D1.
- Mock: no reasoning deltas, no reasoningTokens under enabled:false — MET (test pins).

(b) normalization:
- Canonical enum min|low|medium|high|max; selection = auto|none|those — MET.
- Tier table 5 entries, exported tunable data — MET (min = 1024 floor per ruling).
- Single exported authority `offeredLevels(model)` implementing N-ladder + budget-native 5-tier + null-full-ladder + no-choice-empty exactly as ruled — MET (N>5 case is unruled; documented choice in Deviations D4).
- `planReasoning` wires positionally (native word / tier budget) — MET.
- Server validation accepts exactly the offered labels (400 otherwise) — MET (validation flows through `planReasoning`'s offered-membership; `requiredReasoningEntryFor` maps refusal to VALIDATION 400; pinned at unit + routes level).
- Property tests: count-match, order, positional mapping, GPT-5 1:1 — MET.
- Existing consumers updated to the authority; no leftover exact-membership checks — MET (grep: the only `supportedEfforts` filter/membership logic left in product code is inside `offeredLevels` itself and the catalog parse (`gateway-metadata.ts`, raw storage); `turn-definition.ts` refit now uses `reasoningBudgetForWire`).

## Deviations (with reasons)

- **D1 — off-wire completion cap mirrors the reasoning-free shape (cap present iff derivable), rather than always-explicit.** "B=0, maxTokens = today's H" collides with a literal reading of G2 ("always send explicit max_tokens on reasoning calls") when today's H is underivable (rich payer whose budget covers the context window, or a budget-less trial turn) — today those turns send NO cap (model default). Forcing an explicit cap there would have regressed rich payers and trial to a 1000-token fallback cap. I read G2 as governing calls with a live reasoning budget (its stated rationale — budget-native cap-must-exceed-B — is vacuous at B=0) and made the off turn byte-identical to a plain turn plus the off wire. Pinned by unit + integration tests.
- **D2 — no new cassette exchange for the off shape.** Criterion says "mock/cassette test"; I chose the mock/unit path (runs everywhere, deterministic). A cassette exchange would create a new record-on-miss entry needing a first CI record run; existing cassette hashes are untouched (no re-record burden). Auditors may ask for the cassette variant as a follow-up.
- **D3 — two pinning tests were green-on-arrival by construction.** The adapter off-wire passthrough and require_parameters-off tests passed immediately because the adapter composes the shared `ReasoningWire` (the red state was the shared schema before my change); the off-wire refit test was accidentally green pre-fix (the old code's undefined-effort path returned 0) but the explicit `'enabled'` branch is required for typecheck and is now pinned. All other tests were watched red first.
- **D4 — N>5 vocabularies keep the strongest five.** The ruling defines ladders only to N=5; upstream's full effort vocabulary has six non-none words, so a 6-word model is possible. Truncating to the strongest five keeps Max the true top; the weakest extras become unreachable (not a downgrade — just unoffered). Documented in code; flagged for founder confirmation.
- **D5 — mock treats a malformed reasoning param as reasoning-free** (previously any defined value triggered deltas). The real adapter rejects malformed configs, so the mock path is unreachable in practice; parsing through the shared wire schema keeps one source of shape truth.

## Concerns and limitations

- Behavior change under `auto` on a single-level model whose lone word is non-canonical (e.g. `['xhigh']`): previously no entry (exact membership); now auto lands on the High rung and wires `xhigh` — intended consequence of positional normalization, pinned by test.
- Behavior change under `auto` on a single-level MANDATORY model: previously (if the word was canonical, e.g. `['high']`) auto wired it with B priced; now nothing is offered → no wire sent → the model reasons at its default and admission prices B=0. Consistent with the ruled "no rail / no choice" and with how an absent selection already behaves on default-reasoning models, but it does shift reserve for that corner; flagged for the auditors.
- `TurnReasoningEntry.effort` widened to include `'none'` — T7 (classifier) will consume this type; the off entry is distinguishable by `effort === 'none'`/wire shape.
- The `NATIVE_EFFORT_BY_LABEL` map for null-vocabulary models (Min→`minimal`, Max→`max`) is my inference from the researched upstream universal vocabulary (research §wire schema, Verified there); a null-vocab model that rejects `minimal`/`max` would surface as the typed no-endpoints/provider error, never silent.
- `REASONING_EFFORT_LABELS.none` changed to "None"; no current UI consumes it (T9 unbuilt), so no visual regression surface.

## Confidence

high — every ruled rule is pinned by a dedicated test, property tests cover the positional mapping space, both scoped integration suites and full shared gate are green, and the only judgment calls (D1, D4) are documented and raised.
