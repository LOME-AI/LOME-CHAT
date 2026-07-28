# D1 — Persist the resolved effort — implementation report 1

## Objective

Record, against each generation's own completion row, the reasoning level that generation
actually ran at, so what the classifier decided is stored beside the reasoning tokens it
produced (`docs/BILLING.md` §Reasoning Effort 9).

## The one design decision this task had to make, and why

**The resolved level is carried, never re-derived from the reasoning wire.** The obvious
cheap implementation — read the level back off `request.parameters.reasoning` at the node —
is wrong, and provably so:

- `offeredLevels` mints a budget-native model's rungs as `{ max_tokens: clampBudget(tier) }`.
  `clampBudget` is `max(min(tier, contextLength, maxOutputTokens), 1024)`, so **any model
  whose output ceiling sits below two tier budgets mints the same wire for both rungs**. A
  model with an 8k output cap collapses Mid, High and Max onto `{ max_tokens: 8192 }`.
  Reading the level back would name Mid on a turn the user set to Max — a false downgrade
  badge, in exactly the surface §Effort 4 introduced the record for.
- Pinned rungs are not deduplicated out of the menu (`turnEffortOptions` unions labels, not
  budgets), so the collision is reachable from the product, not theoretical.
- Independently of the collision: a wire→label reverse map would be a **second authority**
  for a fact the resolver already decided.

Pinned in `effort-dimension.test.ts`: two rungs that yield `toEqual`-identical wires and
distinct levels.

So the level travels on two channels, each the authority for its own arm:

| arm | who decides the level | how it reaches the charge |
| --- | --- | --- |
| pinned (user fixed the effort) | the turn build, via `TurnReasoningEntry.effort` | new **node field** `modelCall.reasoningEffort` |
| classified (auto) | `pickClassifiedEffortPlan`'s downward walk | new `ReasoningPlan.level`, read at the node |
| `smartModel` slot, built hard-off wire | the build's one stamped wire shape | derived from the surviving off wire (`{enabled:false}` ⟺ `off`, a bijection) |

The node field follows the **exact precedent already in the same schema**: `promptInputTokens`
is server-derived definition data that lives on the node, never inside `params`, and is never
forwarded to the provider. `params` was not an option — it is closed by `z.strictObject` at the
language adapter, and a display fact is not a call parameter.

## Files changed

### Storage

- `packages/shared/src/affordability/reasoning-effort.ts` — new `RESOLVED_REASONING_EFFORTS` /
  `ResolvedReasoningEffort`: the ladder plus the off rung, `auto` excluded. Composed from the
  two existing sources (`CANONICAL_REASONING_EFFORTS`, `REASONING_OFF`), not re-typed.
- `packages/db/src/schema/enums.ts` — `reasoningEffortEnum` derived from that const.
- `packages/db/src/schema/llm-completions.ts` — nullable `reasoning_effort` column beside
  `reasoning_tokens`.
- `packages/db/src/schema/index.ts` — enum on the schema barrel (the shape test reads it there).
- `packages/db/drizzle/0061_nifty_pepper_potts.sql` (+ `meta/0061_snapshot.json`,
  `meta/_journal.json`) — the generated migration, shipping with the schema change.

### The producing end

- `packages/shared/src/affordability/estimate/reasoning-plan.ts` — `ReasoningPlan.level`: the
  rung a plan wired, the one fact its wire cannot be read back for.
- `packages/shared/src/workflow.ts` — `modelCall.reasoningEffort`, registered so the DO's
  re-parse at ingest does not strip it.
- `apps/api/src/slices/workflows/builder/model-call.ts` — the builder option that stamps it.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `resolvedEffortField`, applied at both
  sibling-building sites (`buildSingleModelTurn`, `siblingOptions`), so the pinned and the
  pinned-inside-auto shapes both stamp.
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts` — `paramsApplyingDecision`
  becomes `callAtDecidedEffort`, returning the parameters **and** the rung they were minted at;
  `ModelCallStreamContext.resolvedEffort` carries it into `billingMetadataOf`. `streamContextOf`
  extracted (complexity gate).
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — `answerParamsWithEffort`
  returns the same pair; `builtLevel` names the built hard-off rung; `carriesOffWire` extracted
  so the off-wire predicate exists once. Also took the one-line reach closure the orchestrator
  flagged: `planReasoningOff` now comes off the `@hushbox/shared` barrel (B9 published it)
  instead of the walled `affordability/estimate/reasoning-plan` subpath.

### The carrying chain

- `apps/api/src/slices/workflows/engine/execution-registry.ts` — `NodeBillingMetadata.reasoningEffort`.
- `apps/api/src/slices/workflows/engine/interpreter.ts` — lifted onto the settlement charge.
- `packages/shared/src/flow-executor.ts` — `SettlementCharge.reasoningEffort`.
- `apps/api/src/slices/workflows/engine/settlement.ts` — forwarded into `ChargeInput`.
- `apps/api/src/slices/billing/domain/charge.ts` — `ChargeInput.reasoningEffort`; the completion
  row now writes for **every** text generation (`observedTokens` zeroes an unreported usage)
  rather than skipping when no usage was observed.
- `apps/api/src/slices/billing/ports/stores.ts` — `LlmCompletionInput.reasoningEffort`.
- `apps/api/src/slices/billing/adapters/stores.ts` — the column write.
- `apps/api/src/slices/billing/index.ts` — `LlmCompletionInput` published (the engine's own
  settlement test types its fake store against it).

## Tests added

| test | behavior | criterion |
| --- | --- | --- |
| `reasoning-effort.test.ts` — `RESOLVED_REASONING_EFFORTS` (4) | the persisted domain is the ladder + off, never `auto` | new pgEnum |
| `shape-enums.test.ts` — derivation + nullability (2) | the pgEnum derives from the one shared source; the column is nullable | new pgEnum, shape registry |
| `effort-dimension.test.ts` — "the level the plan resolved to" (4) | the classified plan reports the rung it wired, including after a step-down and after resolution to off; **two rungs with identical wires report different levels** | threading, and the design's premise |
| `reasoning-plan.test.ts` (2 amended) | the plan's full shape now includes its level | — |
| `model-call-execution.test.ts` (3) | records the level stepped down to (not the one classified); records the pinned level a decision may not rewrite; records **no** level on a reasoning-capable call nobody asked to reason | threading; null-vs-`off` |
| `smart-model-execution.test.ts` (3) | the slot records its classified level; `off` for the candidate that kept the off wire; nothing for the candidate it was stripped from | threading |
| `turn-definition.test.ts` (4) | the build stamps the resolved level, stamps `off` on a hard-off turn, stamps nothing on a reasoning-free turn, and stamps each sibling its own | pinned arm |
| `build-workflow.test.ts` (1) | the builder passes the level to the node and never into `params` | node field |
| `settlement.test.ts` (4) | the charge→`ChargeInput` mapping forwards the level and leaves it absent; a text record with no usage still writes its completion row; a modality with neither shape writes none | threading; totality |
| `live-run.test.ts` (3) | **on a real engine run over real nodes**: the classified turn records High while the request was `auto` and the fallback is `off`; the classifier generation itself records nothing; a pinned turn records the user's level though the decision says otherwise | the pinned/classified evidence |
| `charge.integration.test.ts` (4) | the level, `off`, and null all round-trip through the real DB; a text generation with no usage still gets a row | persistence; null-vs-`off`; totality |
| `settlement.integration.test.ts` (2) | a settled multi-model turn records each sibling's own level against its own persisted answer; every persisted assistant text item has a completion row to read | persistence on a settled turn; totality |

One behavior-change amendment, not a weakening: `settlement.test.ts`'s "writes no dimension
row when the record carries neither tokens nor media" asserted the skip this task deliberately
removes. It is replaced by two tests — the text record now writes a zeroed row, and a modality
with neither shape (embedding) still writes none — which is strictly more discriminating.

## Self-gate

| command | result |
| --- | --- |
| `pnpm db:generate` | pass — wrote `0061_nifty_pepper_potts.sql` |
| `pnpm db:migrate` | pass — "migrations applied successfully" |
| `pnpm db:generate` (drift re-check, twice) | pass — "No schema changes, nothing to migrate"; the only working-tree delta is the new migration itself |
| `pnpm test:db` | pass — 532 + 2, twice |
| `pnpm test:shared` | pass — 3201 then 3200 (see below) |
| `pnpm test:api` (run 1) | fail — 10 tests / 3 suites, all attributed outward (below) |
| `pnpm test:api` (run 2, after the last edit) | fail — **only** the 7 documented `template-html` snapshots; 6535 passed |
| `npx turbo typecheck --force --continue` | pass — 16/16 |
| `pnpm arch:check` | pass — 13 rules over 2046 files, twice; the run **includes** the new `money-internals-owners-only` rule (13 files under `arch/rules/`, and the runner loads every `*.rule.ts`) |
| `npx eslint <owned files>` from `apps/api` | pass — exit 0 (after fixes) |
| `npx eslint <owned files>` from `packages/shared` | pass — exit 0 (after fix) |
| `npx eslint <owned files>` from `packages/db` | pass — exit 0 |

### Scoped per-file coverage (one `--coverage.include` per run, driving suites named)

| file | suites | stmts / branch / funcs / lines |
| --- | --- | --- |
| `billing/domain/charge.ts` | `src/slices/billing` (610 tests) | 100 / 96.87 / 100 / 100 |
| `workflows/nodes/model-call-execution.ts` | `src/slices/workflows` (493) | 100 / 98.78 / 100 / 100 |
| `workflows/nodes/smart-model-execution.ts` | `src/slices/workflows` (493) | 100 / 100 / 100 / 100 |
| `workflows/engine/settlement.ts` | `src/slices/workflows` (493) | 100 / 100 / 100 / 100 |
| `workflows/engine/interpreter.ts` | `src/slices/workflows` (493) | 98.37 / 95.63 / 97.61 / 99.47 |
| `chat/domain/turn-definition.ts` | `src/slices/chat` (794) | 99.6 / 97.66 / 100 / 100 |
| `workflows/builder/model-call.ts` | `src/slices/workflows` + `src/slices/chat` (1288) | 100 / 100 / 100 / 100 |

`builder/model-call.ts` read **80% branch** under a workflows-only run. Read out of the v8
JSON, the two uncovered branches were `tools` and `promptInputTokens` — **not** mine (my
branch was covered by the builder test added for it); the file's driving suites are in the
chat slice, which is the §Known-Breakage narrow-suite trap. Widened to both slices: 100%.

### Lint findings fixed, not silenced

Two complexity errors (`writeGenerationDimension` 18, `runModelCall` 11) were resolved by
extracting `observedTokens` and `streamContextOf`, never by raising the threshold. A nested
ternary in the live-run harness became a lookup table; the rest were prettier.

### Red-first evidence

Every production change was driven by a watched failure: the shared const (4 red, symbols
undefined), the pgEnum + column (2 red), the DB round-trip (4 red — `undefined`/empty rows),
the charge→input mapping (1 red), `ReasoningPlan.level` (4 red), the node-level records (2
red), the smart-model records (2 red), the build stamp (3 red).

The two end-to-end layers were written after their machinery existed, so both were
**inverted** to prove they are not vacuous:

- removing the interpreter's lift ⇒ 2 of the 3 `live-run` tests go red; restored from a
  byte-exact backup, `diff` clean.
- restoring `if (input.tokens === undefined) return;` in `charge.ts` ⇒ the totality assertion
  in `settlement.integration.test.ts` goes red; restored byte-exact, `diff` clean.

No background suite was in flight during either inversion.

## Acceptance criteria

1. **New nullable pgEnum column; migration generated and committed with the schema change; db
   shape-test registry updated** — met. `reasoning_effort` enum + nullable column;
   `0061_nifty_pepper_potts.sql` applies cleanly and re-generating finds no drift;
   `reasoningEffortEnum` is in `ALL_ENUMS` and its values are asserted equal to the shared
   source, with the column's nullability asserted beside it.
2. **Threaded end to end: resolved effort → node billing metadata → settlement charge input →
   row, with an integration test on a real turn asserting the persisted value** — met. The
   chain is `callAtDecidedEffort`/`answerParamsWithEffort` → `NodeBillingMetadata` →
   `SettlementCharge` → `ChargeInput` → `LlmCompletionInput` → column. Pinned at two levels:
   `live-run.test.ts` runs the real interpreter over the real node executions and asserts the
   charge; `settlement.integration.test.ts` settles a multi-model turn into the real DB and
   reads the level back off each sibling's own content item.
3. **Null versus `off` distinguished and pinned** — met. `charge.integration.test.ts` pins all
   three DB states (`'high'`, `'off'`, `null`);
   `model-call-execution.test.ts` pins the discriminating case at the node: a
   reasoning-**capable** model on a call nobody pinned or classified records nothing, so the
   axis's declared fallback can never be mistaken for a level that ran.
4. **Totality, scoped to text** — met, and it required a behavior change:
   `writeGenerationDimension` skipped the completion row when a text generation reported no
   usage (an aborted partial), which would have persisted an answer the badge could never
   describe. Every `text` generation now writes its row, counts falling to zero. Asserted over
   a settled turn; the media scope is vacuous as the criterion allows (media items take
   `media_generations`, never a completion row).

## Deviations

- **The Files list was stale and the work is wider than it names.** It predates C3 relocating
  the classified path into `model-call-execution.ts`, and it omits the middle links of the very
  chain its own criterion describes. Beyond the listed files I edited: `packages/shared/`
  `{flow-executor,workflow,affordability/reasoning-effort,affordability/estimate/reasoning-plan}.ts`,
  `workflows/{engine/interpreter,nodes/model-call-execution,builder/model-call}.ts`,
  `billing/{ports/stores,adapters/stores,index}.ts`, `chat/domain/turn-definition.ts`. None is
  owned by a concurrent task (B9 is `models/**`, E1 is `apps/web/**`).
- **A new declared node field.** The plan assumed the value was "computed and consumed
  immediately"; it is, on the classified arm, but the pinned arm decides at build time and the
  wire cannot carry the level back. Justified above; it is a derived server-side datum on the
  node, matching `promptInputTokens`, not a declared behavioural flag.
- **`turn-reasoning.ts` left untouched.** Its three `TurnReasoningEntry` constructions now have
  a second source for `effort` (`plan.level`). I judged this not to be the banned mirrored
  shape — the plan's level is *derived from* the argument those sites already hold, one
  implementation with an echo, not two implementations that must agree — and collapsing it
  would widen the diff into a file no criterion needs.

## Concerns and limitations

- **A `smartModel` slot carrying a pinned NON-off wire records no level.** The turn builder
  only ever stamps the shared hard-off wire there (`smart-model-turn.ts`), and a defensive
  pass-through test covers the other shape, so this is unreachable from the product today. The
  failure direction is deliberate: a missing badge, never a wrong rung.
- **`platform/dev/seed-billing-history.ts` still skips the completion row for a text charge
  with no tokens**, so seeded dev history diverges slightly from the production rule it says it
  mirrors. Dev-only, outside this task's ownership, and its specs always supply tokens for text.
- **`turn-definition.ts` carries pre-existing plan-task identifiers in comments** (`G2`, `G3`)
  — Global Constraint 8. Not mine, not touched.
- **Two `effort: 'off'` string literals in `turn-reasoning.ts`** re-type the rung that
  `REASONING_OFF` exists to hold once, against that constant's own stated rule. Pre-existing.
- The classifier's charge is anchored to the run's first persisted content item, so that item
  carries **two** completion rows — the answer's (with its level) and the classifier's (level
  null). This is pre-existing anchoring behaviour, but it constrains D2: reading the level per
  content item must take the non-null row, not fold over the rows the way the reasoning-token
  read sums them.

## Known-breakage attribution

- **7 `template-html` snapshot failures** — the documented foreign family. Reproduced in
  isolation; `git status` shows the template source and `.snap` unmodified.
- Run 1 additionally showed 3 chat/model-catalog tests (`POST /chat` 201→400 ×2,
  `refreshCatalog`) and 3 suite-level failures (two `deps_ssr` collection errors, one
  `beforeAll` hook timeout on the shared catalog lock). All six are named families; **all pass
  in isolation**, and run 2 — the gating run, taken after the last edit — showed none of them.
  My diff adds no catalog fixture. Per the moving-set rule I am not citing either single run as
  proof of health; I am citing both, and the isolation results.
- One transient `apps/web` typecheck error (`effortOptionsFrom` arity) appeared in my first
  repo-wide run and was gone in the next two. `apps/web` is E1's, mid-edit.
- `pnpm test:shared` reported 3201 then 3200 tests. `packages/shared/src/affordability/index.test.ts`
  was modified by another agent between the runs (its counts come from `it.each` over export
  lists), which accounts for it exactly. Both runs exit 0.
- I ran `pnpm ensure-stack` at task start, which regenerates `.env.development` / `.env.scripts`
  — the documented voider of another agent's in-flight suite.

## Coordinator items, dispositioned

1. **`planReasoningOff` onto the barrel** — taken. One-line import move in
   `smart-model-execution.ts`; lint, typecheck and the workflows suite re-run clean after it.
   Its two other walled reaches (`pickClassifiedEffortPlan`,
   `resolveClassifierOutput`) stay: neither producer is published on the barrel yet, and both
   files sit on the new rule's `PENDING_CONSUMER_CLOSURES` list.
2. **The `TS2322` on `smart-model-execution.ts` around reasoning-wire `level` optionality** —
   mine, and already resolved before the message arrived. It came from returning
   `{ parameters, level?: 'off' }` against a return type declaring `level` as a required
   `… | undefined`, which `exactOptionalPropertyTypes` rejects. Fixed by naming the pair as a
   `DecidedCall` interface with a genuinely optional `level`. `npx turbo typecheck --force
--continue` is 16/16 with the import move in place.
3. **`money-internals-owners-only`** — green over my files. It already allowlists
   `model-call-execution.ts`, `smart-model-execution.ts`, `smart-model-execution.test.ts` and
   `live-run.test.ts` as pending consumer closures, which covers the walled import I added to
   `live-run.test.ts` (`cheapestClassifierEffort`, used to show the recorded level differs from
   the axis's declared fallback). None of my files is a price owner, so none belongs on the
   owner allowlist.

## Confidence

**High** on the storage, the threading and the gates: every layer was driven by a watched
failure, the two after-the-fact layers were proven non-vacuous by inversion, the migration
applies with a clean drift re-check, and repo typecheck is 16/16.

**Medium** on the shape of the pinned carrier — the node field is the right call on the
evidence (the wire is provably lossy, and the alternative is a second authority), but it is a
design decision the plan did not make, it widens the definition schema, and it deserves the
auditor's judgement rather than mine.
