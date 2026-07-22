# T2 — Canonical effort enum + reasoning token plan (impl-report-1)

## Objective

Single shared effort vocabulary + pure `(model, canonicalEffort) → plan | infeasible` function in `packages/shared/src/estimate/`, per plan §Task-T2, D1, G1–G3/G5/G10, and the T1 interface ruling (supportedEfforts tristate; structured `reasoning` object is the single authority).

## Files changed

- `packages/shared/src/reasoning-effort.ts` (new) — canonical enum `['low','medium','high']` + Zod `CanonicalReasoningEffort`, the D4 selection enum `['auto',…,'none']` + Zod `ReasoningEffortSelection`, and `REASONING_EFFORT_LABELS` (G5: levels + Zod + display labels, once).
- `packages/shared/src/reasoning-effort.test.ts` (new) — enum/labels tests.
- `packages/shared/src/estimate/reasoning-plan.ts` (new) — `planReasoning`, `REASONING_BUDGET_TOKENS_BY_EFFORT` (exported tunable data: 4096/12 288/32 768), `REASONING_BUDGET_FLOOR_TOKENS` (=1024, the ONLY protocol constant), types `ReasoningWire` / `ReasoningPlan` / `ReasoningPlanResult` / `ReasoningInfeasibleReason` / `ReasoningPlanModel`.
- `packages/shared/src/estimate/reasoning-plan.test.ts` (new) — unit + seeded property tests.
- `packages/shared/src/estimate/index.ts` — one barrel line (`export * from './reasoning-plan.js'`).
- `packages/shared/src/index.ts` — named exports for the plan module in the existing explicit estimate lists + `export * from './reasoning-effort.js'`.
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — `PromptBudgetInput` gains optional `reasoningEffort?: ReasoningEffortSelection` (type-only; consumers land in T5/T9) + the type import.

## Design notes (auditor-relevant)

- **Wire choice** is exactly the T1 tristate: array ⇒ `{effort}` gated on exact string membership (no nearest-mapping — G3); `null` ⇒ `{effort}` for every canonical level; absent ⇒ `{max_tokens: B}` (budget-native). `ReasoningWire` is a discriminated union — both keys unrepresentable together (G1).
- **B formula**: `max(min(tier, floor(cap)), 1024)` — mirrors the research §Round-2 derivation shape where the floor is applied last (floor wins over cap). Cap is catalog-driven: `contextLength` (the only token cap the catalog carries — descriptor `limits.contextLength` / wire `Model.contextLength`); non-finite/non-positive caps ignored. No 128k anywhere (G10).
- **Strictly-greater rule**: `maxTokens = B + H` with H required to be an integer ≥ 1, so `maxTokens > B` always holds on feasible plans; H < 1 (or non-integer/non-finite) ⇒ typed `no-answer-headroom`. H is a pure input — affordability untouched, nothing of `fitAnswerCapToCeiling` re-implemented.
- **Input shape** `ReasoningPlanModel` (`{reasoning?, contextLength?}`) is satisfied structurally by both the server descriptor (adapt `limits['contextLength']` at call site) and the client wire `Model` (direct `Pick`) — one shared function for both sides (G5). The legacy `behaviors: ['reasoning']` flag is never consulted (T1 ruling).
- **Tier values**: brief's "low 4k / medium 12k / high 32k" encoded as 4096/12 288/32 768 (token-conventional binary k). Exported as data for founder tuning.
- **Check order** pinned by tests: capability → vocabulary → headroom (an uncapable model reports `not-reasoning-capable` even with bad H).
- `mandatory` is deliberately not consulted for canonical levels (it only forbids `'none'`, which is outside the plan's domain — T5 owns the 400, T9 hides the Off pill). Pinned by a test.

## Tests added (all in the two new test files)

- Enum: exact member sets/order; Zod accepts members, rejects `xhigh`/`minimal`/`max`/case-variants; labels total and non-empty; `none` → "Off". (criterion: canonical enum + Zod + labels)
- Capability: absent `reasoning` ⇒ `not-reasoning-capable`; precedence over headroom. (typed infeasible reasons)
- Tristate: array-hit wires `{effort}`; array-miss ⇒ `effort-not-supported`; raw `xhigh` never satisfies nor disturbs; empty array ⇒ all levels infeasible; `null` ⇒ all three levels `{effort}`; absent ⇒ `{max_tokens} === B`; `mandatory` indifferent. (discriminated wire output per tristate)
- Clamps: tier table values; cap-below-tier clamps to cap; cap 512 ⇒ floor 1024 wins; fractional cap floored; non-finite/non-positive cap ignored. (clamp floor 1024 / catalog cap)
- Headroom: 0 / −3 / 2.5 / NaN / ∞ ⇒ `no-answer-headroom`; H=1 feasible with `maxTokens = B+1`; vocabulary checked before headroom. (strictly-greater)
- Properties (mulberry32-seeded, 500 cases × 3, dependency-free per the package precedent in `reasoning-format.test.ts`): feasible ⇒ B integer ≥ 1024 and equals the closed-form clamp; `maxTokens = B + H > B`; wire has exactly one key and its discriminant matches the tristate; on enumerated vocabularies feasibility ⇔ membership.

## Self-gate

- `pnpm test` (packages/shared, full suite + coverage gate) — pass: 99 files, 2144 tests; new files at 100% lines/branches/functions (only sub-100 file listed is pre-existing `smart-model/resolve.ts` at ≥95, untouched).
- `npx turbo typecheck lint --filter=@hushbox/shared --force` — pass (2/2 tasks). First run failed on prettier formatting + one sonarjs nested-ternary in the new test; fixed (`eslint --fix` from the package dir + helper extraction), re-run green. Final `eslint` on all six owned shared files + the web file: exit 0, run from the package dirs after the last edit.
- `apps/web` `npx tsgo --noEmit` — fails ONLY with the plan-listed foreign failure (`../api/src/middleware/pipeline-bindings.ts(59,29) TS2304 ExecutionContext`, §Known foreign failures; reproduces on code I never touched, present in the pre-task `git status` snapshot of concurrent work). No new web type errors from my edit; `eslint` on `use-prompt-budget.ts` exit 0.

## Acceptance criteria

- Canonical enum + Zod + labels in packages/shared — **met** (`reasoning-effort.ts`; barrel-exported).
- `reasoning-plan.ts` beside the estimator implements D1 exactly — **met** (B tier table exported data; clamp floor 1024 / catalog cap; H an input, affordability untouched; `maxTokens = B+H`; discriminated `{effort}|{max_tokens}` chosen by `supportedEfforts` presence; typed infeasible reasons).
- Pure function, no IO — **met** (no imports beyond types; deterministic; tested as data-in/data-out).
- Property tests for clamps/floors/infeasibility — **met** (seeded, reproducible; see Tests).
- `PromptBudgetInput` field added — **met** (optional `reasoningEffort`, typed by the shared selection enum; consumption is T5/T9 per plan).
- G1/G2 support — **met at this layer** (wire only constructible via the plan's union; `maxTokens` always computed for both branches so callers can always send explicit completion max_tokens).
- G3 — **met** (infeasible reported, never downgraded/substituted; no nearest-mapping).
- G10 — **met** (1024 the only protocol constant; cap from catalog `contextLength`; no 128k).

## Deviations

- Tier constants use binary-k values (4096/12 288/32 768) for the approved "4k/12k/32k" placeholders — data, founder-tunable; flagged for the auditor rather than assuming decimal 4000/12000/32000.
- "Catalog-driven cap" implemented as `contextLength` — the only token limit the catalog exposes (descriptor `limits` carries only `contextLength`; verified in `normalize.ts:177`). If a max-output-tokens catalog field ever lands, the clamp input is one line to retarget.
- The selection enum (`auto|…|none`) is defined here alongside the canonical enum rather than left to T5: D4 names it, G5 wants effort vocabulary in one module, and the `PromptBudgetInput` field needs its type now.

## Concerns / limitations

- `planReasoning` deliberately excludes `'none'`/`'auto'` from its domain (D1 maps canonical levels only); `'none'`-on-mandatory rejection is T5's criterion, off-pill hiding is T9's (keyed on `reasoning.mandatory` directly).
- The new shared exports have no repo consumers yet (T4/T5/T9 consume); repo-wide knip was not run (not in my scoped checks) — if it flags them, that resolves when the dependent tasks land.
- `packages/shared/src/index.ts` is contended across this run's concurrent tasks; my additions are the named-list lines and one `export *` line only.

## Confidence

High — every criterion has a pinning test, the formula matches the research math verbatim, and all scoped gates ran clean after the final edit.
