# T2 — fix pass for two validated audit findings (impl-report-2)

## Objective

Address the two [Minor] audit findings on `packages/shared/src/estimate/reasoning-plan.ts`: (1) the descriptor→`ReasoningPlanModel` cap-mapping trap (`limits['contextLength']` silently droppable); (2) `ReasoningWire` being a TS-only union that would force T4 into a sync copy for its Zod consumer.

## Files changed

- `packages/shared/src/estimate/reasoning-plan.ts` —
  - `ReasoningWire` is now a Zod schema (union of two `z.strictObject` branches: `{effort: CanonicalReasoningEffort}` | `{max_tokens: int > 0}`); the TS type is `z.infer` of it, so schema and type cannot drift (One Implementation, Shared). `.strict()` makes the both-keys shape fail parse, preserving the mutual-exclusion guarantee at runtime.
  - `ReasoningPlanModel` doc comment sharpened: it now states explicitly that the server descriptor does NOT satisfy the shape directly (cap lives in `limits['contextLength']`; passing a descriptor compiles but silently drops the cap) and directs server callers to the new helper.
  - New `reasoningPlanModelFrom(descriptor)` (+ its structural input type `ReasoningPlanDescriptorInput: {reasoning?, limits: Record<string, number>}`) performs the `limits['contextLength']` mapping so misuse is structurally harder. 4-line body; no import of the full `ModelDescriptor` type (stays structural, keeps the module pure).
- `packages/shared/src/estimate/reasoning-plan.test.ts` — 8 new tests (below).
- `packages/shared/src/index.ts` — moved `ReasoningWire` from the type-only list to the value list (a value export carries its same-named type); added `reasoningPlanModelFrom` and type `ReasoningPlanDescriptorInput`.

## Tests added (all watched fail first — 8 red for "not exported"/"not a function", then green)

- `ReasoningWire` schema: parses `{effort:'medium'}` (finding-2 criterion: effort variant); parses `{max_tokens: 2048}` (budget variant); rejects the both-keys shape (finding-2 explicit criterion); rejects non-canonical effort words / 0 / fractional `max_tokens` / `{}`; accepts every wire `planReasoning` produces (schema ⟷ plan output coherence).
- `reasoningPlanModelFrom`: maps `limits['contextLength']` → `contextLength` and the result clamps B through `planReasoning` (finding-1 criterion); leaves the cap absent when `limits` has no `contextLength` entry; passes an absent `reasoning` through (still `not-reasoning-capable`).

## Self-gate

- `pnpm test:shared` — pass: 99 files, 2152 tests; `src/estimate` 100/100/100/100 coverage.
- `npx turbo typecheck lint --filter=@hushbox/shared --force` — pass (2/2). First lint run had one prettier error on the new helper signature; fixed via `eslint --fix` from the package dir, then `eslint` on all three touched files exit 0 (run after the last edit, from `packages/shared`), then turbo re-run green.

## Acceptance criteria (the two fix-brief items)

- Finding 1 (comment + mapping helper) — **met**: comment now states the server-side mapping obligation precisely; `reasoningPlanModelFrom` exported and tested (helper well under the ~15-line guidance).
- Finding 2 (Zod wire schema, single source, both-variant parse + both-keys rejection tests) — **met**: schema is the source, type is `z.infer`, tests pin both variants and the both-keys rejection.

## Deviations

- Chose "export the Zod schema with type inferred" over the alternative "require T4's schema be `z.ZodType<ReasoningWire>`" — the finding offered either; the schema-as-source option is the stronger no-drift guarantee. The prior `readonly` modifiers on the wire type are gone (z.infer output); the wire is only ever constructed inside `planReasoning`, so nothing relied on them.
- `max_tokens` schema bound is `int().positive()`, not `≥ 1024`: the 1024 floor is a plan-derivation invariant (already enforced and property-tested in `planReasoning`), not a wire-shape fact; encoding it twice would be a second copy of the floor.

## Concerns / limitations

- `reasoningPlanModelFrom` has no repo consumer yet — T5 is its intended caller per the plan's binding interface note ("T4/T5 interface notes from T2 audits"); if repo-wide knip runs before T5 lands it may flag it (same standing situation as report-1's other new exports).
- `ReasoningWire` moving from type-only to value export in the barrel is additive; T4's brief already says to consume "the Zod schema exported from the T2 module (post-fix)".

## Confidence

High — both findings resolved exactly as directed, every new behavior pinned by a test that failed first, all scoped gates green after the final edit.
