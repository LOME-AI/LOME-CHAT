# T8 impl-report-2 — STATUS: DONE_WITH_CONCERNS (criterion 1 closed via STAMP-TIER-INTO-DEFINITION; media-turn hold storage flagged out-of-scope)

## Objective (restated)
Close criterion 1: a persisting chat turn's admission hold must include tier-exact storage. Founder-ruled
route — stamp `{ inputChars, tier }` into the CHAT definition; the run estimator reads it per-run FROM the
definition (replacing T7's per-DO factory `storageContext` param, which the DO could never fill because the
payer tier never reaches it). Re-confirm criteria 2–5 intact.

## Decision: where `{ inputChars, tier }` is stamped (typed field, not params) — with rationale
Added a minimal OPTIONAL typed field `storage` to `WorkflowDefinition` in `packages/shared/src/workflow.ts`
(schema `StorageStamp = { inputChars: int≥0, tier: enum(trial|guest|free|paid) }`). I took the founder's
explicit escape hatch ("only if clearly cleaner") over the params bag, on two decisive facts:

1. **It is TURN-level, not node-level.** `inputChars` (once per prompt) and `tier` (the payer) are one value
   for the whole turn; `params` is per-node. Input storage must be added exactly once — smearing a turn-level
   value across N sibling param bags and reconstituting it is strictly worse.
2. **It is admission-only and must NOT reach the provider.** `model-call-execution.ts:163` forwards
   `node.params` verbatim as the adapter `parameters` (`language-adapter.ts:54` reads `parameters.maxOutputTokens`).
   That is exactly why `promptInputTokens` already lives on the node OUTSIDE `params` (workflow.ts:52-57 comment).
   A storage stamp in `params` would be shipped to OpenRouter as a bogus call param. The same rule applies.

The field transports route→DO for FREE with no protocol change (the founder's stated intent): `RunStartBody.definition`
is validated by the `WorkflowDefinition` schema at the DO boundary (`protocol.ts:61`), so a new optional field is
preserved through parse and rides `body.definition` (`room-core.ts:541`) to `interpreter.run()` →
`estimateRun(request.definition)`. It is server-derived (does not perturb the client-request bodyHash) and carries
a count + a tier (no user content), preserving the "definition stays safe to log" invariant.

## How estimate-run sources storageContext per-run
`createEstimateRun(resolveModel)` — the 2nd `storageContext?` param is GONE. Inside the returned closure:
`const storageContext: StorageContext | undefined = definition.storage;`. Everything T7 built is preserved
unchanged (storage math, `tokenNodeStorage`/`mediaNodeStorage`/classifier reserve, DAG enclosure walker, media
size gate, subWorkflow fail-closed refuse, the safe-integer enclosure guard). `StorageStamp` (shared schema type)
is structurally identical to the estimator's internal `StorageContext`, so `definition.storage` flows in with no
cast. A general/non-chat/no-persist definition has no `storage` → `storageContext` undefined → zero storage
(unchanged for every pre-existing caller).

## How the stamp is produced (turn-definition + smart-model)
New exported pure helper `withStorageStamp(definition, budget, hooks)` (turn-definition.ts):
- Returns the definition UNCHANGED when `budget` is undefined OR `hooks.settlement !== CHAT_TURN_HOOKS.settlement`.
- Otherwise sets `storage: { inputChars: budget.promptCharacterCount, tier: tierForFunding(budget.funding) }`.

The **hooks gate is load-bearing**: a TRIAL send passes a `budget` with `funding.kind: 'free'` (routes.ts:638-640),
so tier alone cannot distinguish it; a trial turn persists NOTHING and must hold no storage. The gate on the
persisting chat settlement hook excludes it exactly.

Applied at the three persisting outer builders:
- `buildTurnDefinition` → `.map(def => withStorageStamp(def, options.budget, options.hooks ?? CHAT_TURN_HOOKS))`.
- `buildMultiModelTurnDefinition` → `.map(def => withStorageStamp(def, options.budget, CHAT_TURN_HOOKS))` (paid-only).
- `compileSmartModelBuild` (smart-model-turn.ts, paid + trial) → `withStorageStamp(built.value, budget, hooks ?? CHAT_TURN_HOOKS)`
  (paid stamps; trial passes TRIAL_TURN_HOOKS → unstamped).

`runtime.ts` required NO edit: it already called `createEstimateRun(common.pricingResolver)` with one arg
(runtime.ts:326) — that was T7's blocker; now that storage rides the definition, the existing call is correct.

## The tier-exact hold test (paid = 2 chars/token, free = 4) — with nano numbers
`turn-definition.test.ts` › `withStorageStamp` › "sizes the admission hold storage at the tier ratio":
build one single-model turn (context 1000, base rates input 2n/output 3n, no output cap → output leg = full
1000-token window), stamp it paid vs free (both inputChars=100), feed `createEstimateRun(resolver)`:
- `outputCharsPerTokenForTier('paid')` === 2, `('free')` === 4 (asserted).
- `paidHold − noStorageHold` === `100·CHAR_RATE + 1000·2·CHAR_RATE` (input-once + output at paid ratio).
- `freeHold − noStorageHold` === `100·CHAR_RATE + 1000·4·CHAR_RATE`.
- `freeHold > paidHold` (free reserves strictly more storage). CHAR_RATE = STORAGE_COST_PER_CHARACTER_NANO (300).

The estimate-run suite's migrated "persisting-turn storage" tests independently pin the same at the estimator:
output storage per text node (free=4 → 1_200_000n; paid=2 → 600_000n), input storage once, classifier +
candidate storage on smartModel, media byte-storage (image 144_000_000n, video 360_000_000n), all PASS-THROUGH
(never marked up), and zero storage when the definition carries no stamp.

## Criteria 2–5 re-confirmed intact after the edits
- **2 (stamps feed estimator):** promptInputTokens/maxOutputTokens stamping unchanged; storage stamp added on top.
- **3 (settlement media byte-storage charged once):** `settlement.ts` UNCHANGED — `withStorageFees` (line 1119)
  still folds `mediaBytesOf(output) × MEDIA_STORAGE_COST_PER_BYTE_NANO` once into `storageFeeNanoUsd`. No edit.
- **4 (admission.ts estimateNanoUsd unchanged):** `admission.ts` UNCHANGED — storage rides INSIDE the estimate
  via the stamped definition; no second balance gate.
- **5 (fail-closed):** `createEstimateRun` still returns `Result`; only the storage-input source changed. All
  fail-closed estimate-run tests (unknown model, no pricing, no context limit, subWorkflow, oversize media,
  over-range enclosure) still pass.

## Files changed
- `packages/shared/src/workflow.ts` — `StorageStamp` schema + optional `WorkflowDefinition.storage` field (durable
  comment: why it rides the definition, is admission-only, never provider-forwarded, safe to log).
- `packages/shared/src/index.ts` — barrel-export `StorageStamp` (matches the `SettlementHookName`/`AdmissionHookName`
  precedent; barrel is the knip entry, so unused-consumer is not flagged).
- `packages/shared/src/workflow.test.ts` — StorageStamp parse/reject tests + optional-storage on definition.
- `apps/api/src/slices/models/domain/estimate-run.ts` — `createEstimateRun` drops the 2nd param, reads
  `definition.storage`; doc updated.
- `apps/api/src/slices/models/domain/estimate-run.test.ts` — migrated the persisting-storage suite from the
  factory-param form to the definition-stamp form (`workflow(nodes, storage)`), added explicit `charsPerToken`
  assertions.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `withStorageStamp` helper; applied in the two text
  outer builders.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — `withStorageStamp` derivation tests (paid/free/
  trial-hooks/no-budget) + tier-exact hold money test.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — applied `withStorageStamp` in `compileSmartModelBuild`.

## grep proof — no pricing/storage formula duplicated
`grep STORAGE_COST_PER_CHARACTER_NANO|MEDIA_STORAGE_COST_PER_BYTE_NANO|outputCharsPerToken|applyMarkup` over
`smart-model-turn.ts` and `workflow.ts` → EMPTY (no formula in either). `withStorageStamp` threads only
`{ inputChars, tier }` — no arithmetic. `estimate-run.ts` reads `definition.storage` — all storage arithmetic
stays in T7's existing helpers using the single-sourced shared rate. No mirrored constant, drift guard, or
keep-in-sync introduced. (`turn-definition.ts`'s pre-existing `turnMaxOutputTokens` storage-rate use is the
affordability derivation — untouched, known-interim, owned by T11.)

## TDD evidence
- workflow.ts: added StorageStamp tests, ran shared suite GREEN (28 passed incl. 6 new).
- estimate-run: migrated storage suite → ran RED (5 fail, delta 0n = estimator ignored definition.storage) →
  implemented `definition.storage` read → GREEN (63 passed).
- turn-definition: added withStorageStamp + hold tests → ran RED (`withStorageStamp is not a function`) →
  implemented helper + wiring → GREEN (59 passed). smart-model-turn GREEN (19).

## Self-gate
- `pnpm test:watch` estimate-run.test.ts — pass (63); turn-definition.test.ts — pass (59); smart-model-turn.test.ts
  — pass (19); executor-construction.test.ts — pass (1); runtime.test.ts — pass (45); interpreter.test.ts — pass
  (87). (Focused runs; full `test:api` not run — DB/Redis integration is infra-gated per brief. The required
  storage-in-hold + estimate-run unit suites all pass.)
- `pnpm test:shared` — pass (EXIT=0, per-file coverage gate green).
- `turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/shared` — typecheck PASS both; lint auto-fixed
  (prettier + one `prevent-abbreviations` rename), re-run of `eslint` on all owned api+shared files EXIT=0.
- `jscpd --threshold 2` on the 4 changed source files — 0.79% duplicated (< 2% → pass); the one clone is the
  structural twin of the two text outer builders' `.andThen(...).map(withStorageStamp...)` chains (they call
  different build fns; extracting would over-abstract two 3-line sites).
- `arch:check` — OK, 11 rules over 1834 files, EXIT=0.

## Deviations
- Chose the typed `WorkflowDefinition.storage` field over the founder-preferred params bag. Justified above
  (turn-level + admission-only-must-not-reach-provider); the founder explicitly permitted this when "clearly
  cleaner." Kept the field optional so general definitions are unaffected.

## Concerns / auditor-scrutiny points
- **MEDIA-TURN HOLD carries no storage (out of scope, not a regression).** `buildMediaTurnDefinition`
  (routes.ts:580) receives no `TurnBudget`, so media turns are unstamped → their admission hold excludes BOTH
  media-byte storage and input-prompt storage. This is UNCHANGED from before T8 (holds never included any
  storage). Settlement still charges media byte-storage (criterion 3 intact). Closing it needs a budget threaded
  to `buildMediaTurnDefinition`, which requires editing `chat/routes.ts` — OUT of T8 bounds. Flagged for
  orchestrator sequencing.
- **compileSmartModelBuild + the two outer text builders' stamp lines are integration-covered only** (they call
  `createModelPricingResolver`/`listDescriptors`/`readBalance` with DB). The `withStorageStamp` helper itself is
  fully unit-covered; its application in the DB-dependent builders rides `*.integration.test.ts` (infra-gated,
  not run here). Per-file coverage of those builders was already integration-only before this change.
- The estimator's internal `StorageContext` and shared `StorageStamp` are two structurally-identical types
  (schema vs. estimator-input views). Not a formula duplication; documented as such. Could be unified later if
  the team prefers a single name.

## Confidence
High. The seam is fully traced (definition rides route→DO and is re-validated; estimator reads it per-run); the
tier-exact money is pinned with exact nano numbers at both the turn-definition and estimator levels; criteria 2–5
verified untouched; all named gates pass. The one open item (media-turn hold storage) is a bounded, pre-existing
gap that cannot be closed inside T8's file ownership.
