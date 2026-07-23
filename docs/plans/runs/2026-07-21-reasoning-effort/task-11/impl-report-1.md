# T11 — Estimate display + E2E — impl-report-1

## Objective

(a) The composer's live estimate rises with the selected reasoning-effort level — `use-prompt-budget` consumes `reasoningEffort` through the shared plan (G5) and the premature doc comment is corrected. (b) Extend `e2e/chat/chat.spec.ts` with the reasoning journey (select effort → send → glazed preview → expand → answer → reload → persisted thoughts; rail hidden on non-reasoning models; per-message disclosure). Plus the §Follow-ups T8 flag: verify/wire trial reasoning-delta streaming.

## Files changed

- `apps/web/src/hooks/billing/use-budget-calculation.ts` — `UseBudgetCalculationInput` gains optional `reasoningBudgetTokens`; `computeBudget` adds `B × effectivePerOutputTokenRateNano(manifest)` to `estimatedMinimumCost`. The rate is re-derived from the manifest via shared `evaluateManifest` deltas + `applyMarkup` (exactly the rate `affordability` prices with), mirroring the server's minimum gate (`turn-definition.ts` `answerHeadroomTokens`: `fixed + (B + MINIMUM_OUTPUT_TOKENS) × rate`).
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — new `reasoningBudgetInput()` derives B THROUGH `planReasoning` (shared plan, G5): largest feasible per-model budget across the selection, matching the server's `maxReasoningBudget` min-gate composition; wired into the `useBudgetCalculation` call. The premature comment at the `reasoningEffort` input field (old lines 40–44) rewritten to describe actual behavior, including that `auto`'s placeholder reserve is deliberately NOT display-mirrored.
- `apps/web/src/stores/trial-chat.ts` — `appendToMessage` gains an optional `StreamTokenChannel`; delegates to the shared generic `appendTokenToMessage` (same accumulation as the authenticated optimistic path; answer channel byte-identical to before).
- `apps/web/src/components/chat/page/trial-chat-page.tsx` — `onReasoningToken` wired to reasoning-channel append (T8 flag: trial DOES stream reasoning — the trial route accepts `reasoningEffort`, trial+auto resolves placeholder entries server-side, and the mock emits deltas on any active wire; the handler was simply absent, thoughts were dropped).
- Tests for each of the above (`use-budget-calculation.test.ts`, `use-prompt-budget.test.ts`, `trial-chat.test.ts`, `trial-chat-page.test.tsx` — the page test's local `StreamOptions` mirror gained `onReasoningToken`).
- `e2e/pages/chat.page.ts` — `reasoningRail()`, `selectReasoningEffort(level)` (asserts `aria-checked` took), `thinkingDisclosureFor(assistantMessage)` (per-message, nametag pattern), `switchToTextMode()`.
- `e2e/chat/chat.spec.ts` — the 'AI Response Streaming' test became the reasoning journey (details below); imports `E2E_MODELS` from `scripts/lib/e2e-model-ids.js` (precedent: admin helpers).

## Tests added

Unit (all watched RED for the right reason first, then GREEN):
- budget calc: high-budget > low-budget estimate; any budget > reasoning-free; zero ≡ absent; exact `B × rate` surcharge value — pins estimate(high) > estimate(low) > estimate(none/absent) with plan-tier budgets.
- prompt budget: 'high' feeds `REASONING_BUDGET_TOKENS_BY_EFFORT.high` into the calc; 'low' smaller; 'none'/'auto'/absent omit the field; multi-model takes the largest per-model B; unoffered level contributes nothing.
- trial store: reasoning-channel folds into canonical inline form (parse round-trip); answer stays separate.
- trial page: `onReasoningToken` appends with the 'reasoning' channel.

E2E (extended, no new spec file): `displays streaming AI response with reasoning effort after sending message` — image modality → rail hidden → back to text → select `anthropic/claude-sonnet-4.6` (verified live catalog: `supported_efforts ["max","high","medium","low"]`, non-mandatory) → select High (positional wire = native `max`) → send under the `x-mock-hold-primary-stream` knob (mock parks after reasoning deltas + first answer chunk → deterministic in-flight assertion, zero wall-clock) → disclosure visible per-message + glazed preview contains mock thought text → expand → full thoughts → release → `Echo:` + cost → reload → disclosure + thoughts persist (parsed from the persisted field). Signal-based waits only (`waitForStreamingActive`, `waitForConversationLoaded`, existing helpers).

## Self-gate

- `pnpm test:watch <4 touched web test files> --run --sequence.concurrent=false` — pass (153 tests). Consumers: `prompt-input.test.tsx` + `reasoning-effort-rail.test.tsx` — pass (147). Sequential override used per §Known-foreign-failures (foreign vitest concurrency diff); judged by full-file runs.
- `eslint` on all 8 touched web files (from `apps/web/`) and both e2e files (from `e2e/`), after final edits — pass, 0 warnings.
- `tsc --noEmit` (apps/web) — pass except the two §Known-foreign-failures entries (`pipeline-bindings.ts` ExecutionContext; `model-list-body.test.tsx`), reproduced on files I never touched. `tsc -p e2e/tsconfig.json` — pass.
- Scoped per-file coverage (touched files only): use-budget-calculation 100 · trial-chat.ts 100 · use-prompt-budget 98.97/98.61 · trial-chat-page 96.99/96.82 — all ≥95.
- `pnpm e2e:chat` (chromium): first run — my test failed (my bug: `waitForAppStable` gates on `data-app-stable`, which only the new-chat route emits; I had started from `testConversation`). Fixed by starting the journey from the new-chat page (as the media specs do). Verification rerun: my intended `-g`-scoped rerun (`pnpm e2e -- …`) did not forward args and ran the FULL matrix — accidental but decisive evidence: **my test passed on all 6 projects, first attempt (not in the flaky list), under a fully saturated 21-minute run**.

## Acceptance criteria

- estimate rises with level via shared plan — **met** (unit-pinned high > low > none/absent; B from `planReasoning`; comment corrected).
- E2E extends `chat.spec.ts` within the send journey, all ruled beats incl. reload persistence and rail-hidden — **met** (passed 6/6 projects; signal waits only; per-message disclosure via nametag pattern; TEST_IDS registry ids only).
- Trial low-levels: **unit-level only** — no existing trial spec covers the effort composer surface deterministically (trial specs send on the catalog-default model whose reasoning capability is not pinned; a rail assertion there would flake). Trial reasoning-delta wiring is unit-pinned instead (store + page).

## Deviations

1. **Ownership stretch (directed by plan §Follow-ups / brief):** T11's Files list names only the budget hook + e2e, but the T8 flag work required `stores/trial-chat.ts` + `components/chat/page/trial-chat-page.tsx` (+ their tests). Additive, minimal, precedented (T7's recorded stretch).
2. **`auto` is not display-priced.** Mirroring the server's placeholder reserve client-side would require duplicating `AUTO_REASONING_EFFORT_ORDER` (lives in `apps/api/src/slices/chat/domain/turn-reasoning.ts`) — banned mirrored constant. Estimate shows the reasoning-free floor under Auto; documented in the hook comment and pinned by a test. Fix path: hoist the order to `packages/shared` (out of my ownership).
3. **Per-token rate derivation** (`effectivePerOutputTokenRateNano`) re-derives `affordability`'s internal rate via exported shared functions rather than a re-typed formula — judged compliant with One Implementation, Shared (it computes through the shared fold), but an auditor may prefer exporting the rate from `packages/shared/estimate/reducers.ts` instead (out of my ownership).

## Concerns and limitations

- **Foreign E2E failures (attributed, not fixed):** ALL image/video-generation specs fail suite-wide (server-side run failure → client shows UNAVAILABLE, "not billed" tile) and all link-guest sharing specs fail ("Hello from Alice" history never renders — fetch/decrypt path). Reproduced identically in both my runs (chromium chat suite: 31 failed; accidental full matrix: 143 failed = 131 media + 12 link-guest, everything else green). None of my files are in either import graph (media send/render + guest history = server media path + `use-decrypted-messages`/read path — T13's recorded ownership). Prime suspect is the landed-but-uncommitted reasoning-run server/web work (e.g. T13 read-path or T5/T16 wire changes on media nodes); needs orchestrator attribution — I did not touch it.
- The chromium-only run also showed one-off failures (trial rate-limit, smart-model insufficient-balance text, multi-model wallet-debit N=2) that did NOT reproduce in the full-matrix run — saturation flakes, not investigated further.
- Trial+auto on a reasoning model server-side reserves a placeholder B that the trial ceiling may not fund — whether trial admission then refuses the send is a server-behavior question outside my ownership; my client wiring is correct either way.
- Retries=0 evidence not strictly obtained (the `--retries=0` arg was swallowed by pnpm arg-forwarding); however the test is absent from the flaky list in both green runs, i.e. it passed on first attempt.

## Confidence

**high** — every criterion pinned by a test that was watched fail first; the E2E journey passed on all six projects under full-suite saturation; all remaining check failures reproduce on files outside my diff and match §Known-foreign-failures or the foreign media/link-guest cluster.
