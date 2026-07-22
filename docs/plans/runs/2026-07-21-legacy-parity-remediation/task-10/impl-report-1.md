# T10 (R18) — impl report 1

## Objective
Restore legacy Smart Model chip semantics: badge the answer "Smart Model" whenever the
Smart pipeline RAN (stagesRun-equivalent), even when the classifier failed and fell back;
and graceful-degrade a thrown/unclassified classifier error instead of Sentry-failing the
whole node.

## Legacy anchor (opened and confirmed)
`legacy/apps/api/src/legacy/lib/pre-inference/smart-model-stage.ts:115-131` — the classifier
call is wrapped in a **blanket** `try { … } catch (error) { … return resolveOk({ … billing:
null, fallbackOccurred: true }) }`, i.e. ANY throw becomes an `ok: true` stage outcome.
`stream-pipeline.ts:1389-1400` (`derivedIsSmartModel`): the docstring pins the rule —
*"Driven by the list of stages that actually ran, NOT by billings: a classifier failure that
falls back … produces no billing entry yet the smart-model stage did run, so the chip still
belongs on the response."* `executor.ts:45-71` pushes `'smart-model'` onto `stagesRun` on the
`ok` outcome, so a classifier throw still lands in `stagesRun`. Report lines L1528/L1543/L1678/
L2103 as cited in the plan.

## Design decisions I own (as required)

**(a) Where the stagesRun-equivalent signal lives.** A new optional `smartModelRan?: boolean`
threaded from the smartModel node's *primary answer* generation, NOT inferred from the
classifier charge:
- Set in `smart-model-execution.ts` on the answer `NodeRunSuccess` whenever the multi-candidate
  routing path ran (the classifier was attempted), regardless of classifier outcome. The
  single-candidate short-circuit does NOT set it (no routing happened — matches "no
  classification").
- `NodeRunSuccess.smartModelRan` (execution-registry.ts) → interpreter `pushCharge` copies it
  onto the **primary** `SettlementCharge` only (never the classifier's auxiliary charge) →
  `SettlementCharge.smartModelRan` (packages/shared/flow-executor.ts) → chat settlement's
  `aggregateDisplayCostByKey` reads `charge.smartModelRan === true` instead of the old
  `charge.key.endsWith('#classifier')` proxy. The charge-anchored proxy (`isClassifier` +
  the `CLASSIFIER_CHARGE_KEY_SUFFIX` constant) is removed — the chip now reads "ran", never
  "billed". Display-only: no ledger leg, debit, or `saved⟺billed` path is touched (the
  NEEDS_CONTEXT trigger did not fire).

**(b) How narrowly the thrown-classifier catch was widened.** Scoped to the classifier's
`streamModelCall` invocation ALONE in `smart-model-execution.ts` (`classifierCall`). The
`try` wraps only the `await streamModelCall(...)` for the classifier; on any throw it returns
`{}` (the same graceful-degrade the typed-`Result` failure already produced). Everything after
the provider call — `ctx.accrue`, `resolveClassifierOutput`, charge construction — stays
OUTSIDE the `try`, so a genuine routing defect still propagates. The **answer** call
(`answerCall` → `streamModelCall`) is untouched, so an unclassified answer-call throw still
hits the interpreter's node-defect path (`FAILED_DEFECT` + Sentry `workflowNodeDefect`). This
is the smallest-blast-radius analog of legacy's stage-scoped catch; `model-call-execution.ts`
and the interpreter `executeNode`/`settle()` catches were NOT modified.

## Files changed
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — set `smartModelRan` on the
  multi-candidate answer success; wrap ONLY the classifier `streamModelCall` in a
  legacy-parity degrade catch (justified `eslint-disable` on the deliberate swallow).
- `apps/api/src/slices/workflows/engine/interpreter.ts` — `collectCharge`/`pushCharge` lift
  `success.smartModelRan` onto the primary charge only; `pushCharge` refactored to a 3-param
  `(key, billing, facts)` shape to stay under `max-params` with no object-default.
- `apps/api/src/slices/workflows/engine/execution-registry.ts` — add optional
  `NodeRunSuccess.smartModelRan` (+ doc). **Not in plan §T10 file list — see deviations.**
- `packages/shared/src/flow-executor.ts` — add optional `SettlementCharge.smartModelRan`
  (+ doc). **Not in plan §T10 file list — see deviations.**
- `apps/api/src/slices/chat/domain/settlement.ts` — `aggregateDisplayCostByKey` reads
  `smartModelRan`; removed dead `CLASSIFIER_CHARGE_KEY_SUFFIX` + `isClassifier`; docstring
  updated. (Confined to the chip region; T09's conflict machinery left intact — 10 markers
  verified present.)
- Tests: `smart-model-execution.test.ts`, `interpreter.test.ts`, `settlement.integration.test.ts`,
  `live-run.test.ts` (charge-shape pin updated).

## Tests added / updated (RED→GREEN)
- `smart-model-execution.test.ts`:
  - UPDATED "falls back to the cheapest candidate on a classifier error" (typed
    `InferenceError`) — now also asserts `smartModelRan === true` (the no-charge assertion
    kept). — criterion 1/3.
  - NEW "badges the fallback answer and degrades gracefully on a THROWN unclassified
    classifier error" — plain `Error` from the classifier stream: cheap answer, no charge,
    `smartModelRan === true`, no throw. RED = promise rejected `classifier exploded`. —
    criterion 1/2.
  - NEW "badges the answer with smartModelRan on the happy classify→answer path". RED =
    `undefined`. — criterion 1.
  - NEW "does NOT badge the single-candidate short-circuit". Guards no over-badging. —
    criterion 1.
  - NEW "still fails the node … on a thrown unclassified error from the ANSWER call" —
    `rejects` — proves the widened catch is classifier-scoped, not over-widened. — criterion 2.
  - NEW "still propagates a defect thrown AFTER the classifier stream (routing logic)" —
    `ctx.accrue` throws → `rejects` — proves the catch wraps only the provider call. —
    criterion 2.
- `interpreter.test.ts` NEW "lifts smartModelRan onto the primary charge only, never the
  auxiliary classifier charge" — primary charge `smartModelRan: true`, auxiliary lacks the
  property. — criterion 1.
- `settlement.integration.test.ts`: UPDATED the charge-anchored smartModel case to stamp
  `smartModelRan: true` on the answer charge; NEW "badges a smartModel answer whose classifier
  failed — smartModelRan, no classifier charge" asserts persisted `isSmartModel === true` with
  a single usage record. — criterion 3 / settlement-level proof.
- `live-run.test.ts`: charge-shape `toEqual` pin updated to include `smartModelRan: true` on
  the primary answer charge (correct consequence of the interpreter change).

## Self-gate
- `pnpm typecheck` (api + shared, isolated `--force`) — **pass**. Repo-wide `pnpm typecheck`
  reports one failure `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name
  'ExecutionContext'` surfaced only by `@hushbox/admin#typecheck`; that file is unmodified
  (clean `git status`) and outside my diff — pre-existing, not attributable to this task.
- `npx eslint <all owned files>` (from `apps/api`) and `npx eslint src/flow-executor.ts`
  (from `packages/shared`), after the last edit — **exit 0**.
- `pnpm test:api` (full suite + coverage gate) — **pass** (1 successful). Touched files at
  coverage: `interpreter.ts` 98.35/95.88, engine `settlement.ts` 100, nodes
  `smart-model-execution.ts` 100/97.36; chat `settlement.ts` exercised via integration.
- `pnpm test:shared` — **pass**.

## Acceptance criteria
1. Chip anchored to the "Smart pipeline ran" signal, not the classifier charge — **met**.
   `smartModelRan` replaces the `#classifier` charge proxy end-to-end; classifier failure
   (typed AND thrown) still badges the fallback answer (unit + integration proofs).
2. Thrown unclassified classifier error degrades gracefully (fallback persists, badged, no
   Sentry defect, node does not fail); a genuine non-classifier defect in that path still
   fails+Sentry — **met**. Catch scoped to the classifier `streamModelCall`; answer-call and
   post-classifier-routing defects both proven to still propagate.
3. Charge-anchored chip test updated; classifier-throw-badged + graceful-degrade tests added
   — **met** (see tests above).

## Deviations (raise)
- Edited two files beyond plan §T10's file list: `execution-registry.ts` (NodeRunSuccess) and
  `packages/shared/src/flow-executor.ts` (SettlementCharge), each gaining ONE additive optional
  `smartModelRan?: boolean`. The research (`research/legacy-chat.md` §R18 NOTES 1) explicitly
  prescribes threading a new boolean "through the node's success output into
  SettlementRequest/SettlementCharge", so these edits are inherent to the specified design;
  the plan's file list appears to have omitted them (its directory prefixes for
  `smart-model-execution.ts`/`model-call-execution.ts` were also inaccurate — both live under
  `workflows/nodes/`, not the listed paths). No public API removed; purely additive.
- Updated `live-run.test.ts` (engine) — an existing charge-shape `toEqual` pin my change
  correctly alters. Not named in §T10 but a required test-consequence.

## Concerns and limitations
- `packages/shared/src/flow-executor.ts` is a shared-package edit — additive optional field,
  no runtime/zod validation over `SettlementCharge` (charges are constructed in-code, never
  parsed), so no wire-schema impact. Flagged for cross-task awareness.
- `model-call-execution.ts` deliberately left untouched (T15 owns it next; the narrow catch
  did not require it).

## Confidence
high — legacy anchor confirmed directly; RED→GREEN at unit, interpreter, and settlement-
integration levels; full `test:api` + coverage green; T09 regions verified intact.
