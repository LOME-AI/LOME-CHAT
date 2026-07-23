# impl-report-9 — Close item enforcement: G1 branded wire + G7 lint rule

## Objective

Both halves of the orchestrator-ruled enforcement item:

1. **G1 branded wire** — brand the `ReasoningWire` Zod schema so the schema/plan functions are the only mint; hand-written wire object literals fail to compile at every consumer; the `satisfies ReasoningWire` off-wire literal in `smart-model-turn.ts` routes through the mint; type-level `@ts-expect-error` pin.
2. **G7 lint rule** — vendored ESLint rule banning the literal `<think>` / `</think>` strings everywhere except `packages/shared/src/reasoning-format.ts` and its test, with its own test suite per the eslint-extensions README convention.

## Files changed

- `packages/shared/src/estimate/reasoning-plan.ts` — `.brand<'ReasoningWire'>()` on the union schema; new exported `REASONING_OFF_WIRE` (the one minted hard-off value, reused by `planReasoningOff`); the three internal wire-construction sites in `offeredLevels` now mint through `ReasoningWire.parse(...)`.
- `packages/shared/src/estimate/reasoning-plan.test.ts` — new `ReasoningWire brand (G1)` describe (off-wire constant identity, `@ts-expect-error` raw-literal pin, plan/ladder outputs assign to the branded type); the six `reasoningBudgetForWire` call sites that passed raw literals now mint via `ReasoningWire.parse`.
- `packages/shared/src/index.ts` — barrel line for `REASONING_OFF_WIRE`.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — the `{ enabled: false } satisfies ReasoningWire` literal replaced with `REASONING_OFF_WIRE`; now-unused `ReasoningWire` type import removed.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — the raw `wire: {...}` literals inside `TurnReasoningEntry`-typed positions (10 sites) now mint via `ReasoningWire.parse`; `ReasoningWire` added to the shared import. (Type-position-only change forced by the brand; see deviations.)
- `packages/config/eslint-extensions/rules/no-think-tag-literal.mjs` — the vendored rule (string Literals + TemplateElements; exemption by absolute-filename suffix for the parser module + its test; comments deliberately not flagged).
- `packages/config/eslint-extensions/reasoning-format.config.mjs` — topic config file registering the rule repo-wide (`**/*.ts`, `**/*.tsx`) as `reasoning-format/no-think-tag-literal: error`.
- `packages/config/eslint-extensions/rules/no-think-tag-literal.test.mjs` — 8-case programmatic ESLint suite (same lintText pattern as `no-legacy-imports.test.mjs`).

## Tests added

- `reasoning-plan.test.ts › ReasoningWire brand (G1)` (3 tests) — off-wire mint identity with `planReasoningOff`; `@ts-expect-error` pin that a raw literal assignment fails to compile (removing the brand makes the directive itself error under tsc, so the red is watched structurally); every plan/ladder wire assigns to the branded type and re-parses. Criterion: G1 branded wire.
- `no-think-tag-literal.test.mjs` (8 tests) — fires on open/close delimiters in string literals and template literals at arbitrary repo paths; once per offending literal; silent on `packages/shared/src/reasoning-format.ts` + `.test.ts`; look-alike filenames elsewhere NOT exempt; `<thinking>`/`think` near-misses allowed; comments ignored. Criterion: G7 lint rule + rule test per README convention.

## Self-gate

- `tsc --noEmit` (packages/shared) — pass.
- `tsc --noEmit` (apps/api) — pass.
- `vitest run reasoning-plan.test.ts effort-dimension.test.ts` (shared) — pass (82).
- `vitest run turn-definition.test.ts turn-reasoning.test.ts smart-model-turn.test.ts` (api) — pass (144).
- `vitest run eslint-extensions/rules/no-think-tag-literal.test.mjs` (config) — pass (8).
- `eslint` (run from each package dir, after final edits) on all touched files — exit 0 (two prettier findings surfaced and `--fix`ed, then re-linted clean).
- Live-config verification: `eslint src/reasoning-format.ts src/reasoning-format.test.ts` (shared) — exit 0 silent; a transient fixture `apps/web/src/lib/think-tag-probe.ts` containing the literal fired `reasoning-format/no-think-tag-literal` through the real repo config (then deleted); `smart-model-execution.test.ts` (comment-only occurrence) — 0 hits.
- **Attributed failures (not mine, evidence below):**
  - `packages/config/eslint-extensions/load-extensions.test.mjs` — 5/10 fail with `Cannot find module file:///tmp/.../example.config.mjs` (vite-node cannot dynamically import freshly written temp-dir modules in this sandbox). Reproduced identically with my three new files moved out of the tree, so pre-existing/environmental, not caused by this task. Untracked-only git state in that dir confirms no foreign diff either.
  - `apps/web` tsc (extra sanity, outside scoped checks): 2 errors in `../api/src/middleware/pipeline-bindings.ts` (`ExecutionContext` global) and `model-list-body.test.tsx` (mock signature) — both files unmodified in git; neither is in my change's import graph for those error shapes; the concurrent rail agent owns apps/web (foreign-modified `apps/web/package.json`).

## Acceptance criteria

1. **Branded wire, schema/plan-only mint** — met. Watched red first: before branding, tsc reported the `@ts-expect-error` directive unused (raw literal compiled) + missing `REASONING_OFF_WIRE` export; after branding, raw literals errored at 1 api source site + 10 api test sites + 6 shared test sites (the enforcement firing), all then routed through the mint; tsc green.
2. **`satisfies ReasoningWire` literal routed through mint** — met. `smart-model-turn.ts:162` now stamps `REASONING_OFF_WIRE`; its behavior test (`stamps the explicit hard-off reasoning wire...`) passes.
3. **Type-level test pinning the red** — met. `@ts-expect-error` pin in `reasoning-plan.test.ts`; un-branding the schema turns the directive into a tsc error.
4. **G7 rule per vendored conventions, with test** — met. Topic config file + rule in `rules/` + colocated `.test.mjs`, loader-picked-up automatically; verified firing on a fixture through the real repo config and silent on the parser module.

## Deviations

- `apps/api/src/slices/chat/domain/turn-definition.test.ts` was not in the named BOUNDS list, but the brand makes its raw `TurnReasoningEntry.wire` literals uncompilable; the edits are mint-wrapping only (type positions, zero behavioral change). The file also carries a foreign diff (vitest workstream); my edits are disjoint from it (wire literals only).
- One vitest-cache incident during verification: apps/api's stale vite transform cache served the pre-brand shared barrel, making `REASONING_OFF_WIRE` momentarily `undefined` at runtime; `rm -rf apps/api/node_modules/.vite/vitest` resolved it. No code implication, but a close-phase gate hitting a similar stale cache should clear before attributing.

## Concerns and limitations

- The rule checks string literals and template quasis only — comments and JSX text are not flagged (a `<think>` in JSX parses as an element, not text; comments are prose). This is deliberate: the one in-repo comment occurrence (`smart-model-execution.test.ts:717`, foreign-diffed file) stays legal.
- `offeredLevels` now runs up to 5 small `ReasoningWire.parse` calls per invocation — negligible, but it is runtime work added for mint integrity.
- The brand is compile-time only; `safeParse`/`parse` at consumers (mock-provider, smart-model-execution params round-trip) re-mint legitimately, as ruled.

## Confidence

High — both enforcement mechanisms were watched firing (tsc red at every raw-literal site; lint red on a live fixture through the repo config) and all scoped checks are green with foreign failures attributed by reproduction.
