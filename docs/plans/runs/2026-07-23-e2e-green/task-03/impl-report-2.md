# Task-03 impl-report-2 — Money-panel follow-ups (Finding 1 fixed; Finding 2 blocked)

## Objective
Two validated money-panel findings on the Smart Model pool:
1. Fix the broken `{@link estimateTokensForTier}` JSDoc in `smart-model-candidates.ts`.
2. Close the residual client/server pool-membership drift by routing BOTH sides through
   ONE shared text-eligibility predicate.

## Outcome summary
- **Finding 1 — DONE** (comment-only, in-bounds).
- **Finding 2 — BLOCKED / NEEDS_CONTEXT.** The prescribed fix ("have the client call the
  server's `isEngineTextModel` semantics") cannot be implemented within Task-03's file
  ownership + the "catalog code" bound, because the wire `Model` contract does not carry
  the information the predicate consumes. Evidence and options below. No client/server
  code was changed for Finding 2.

## Files changed (path — why)
- `apps/api/src/slices/models/domain/smart-model-candidates.ts` — Finding 1: reworded the
  `CLASSIFIER_CHARS_PER_TOKEN` re-export's JSDoc, dropping the broken `{@link
  estimateTokensForTier}` (that symbol is not imported/declared in this file — current
  imports are `affordableSmartModelCandidates`, `classifierReserveLineItems`,
  `outputCharsPerTokenForTier`, `priceSmartModelPool`) and re-pointing it to "the shared
  `estimateTokensForTier` helper" (its owner is `@hushbox/shared`'s `estimate/pre-adapters.ts`).
  Comment-only; zero behavior change.

## Self-gate (command — result)
- `pnpm exec turbo typecheck lint --filter=@hushbox/api` — pass (typecheck + lint, 2/2
  tasks successful). Confirms the Finding 1 comment edit introduces no typecheck/lint error.
- No test run needed for Finding 1 (a JSDoc edit changes no behavior; TDD does not apply to
  a comment). No `test:shared`/`test:web`/web-typecheck run for Finding 2 because no
  Finding 2 code change was made.

## Finding 1 — acceptance evidence
- Broken link removed. Verified the referenced symbol is absent from this module's imports
  and declarations; the JSDoc now names the shared helper in plain code font, per the brief
  ("drop the broken link or re-point it to the shared module that now owns the symbol").

## Finding 2 — why it is blocked (evidence)

The brief's fix is: "make BOTH sides select pool membership through ONE shared
text-eligibility predicate (extract/reuse the server's `isEngineTextModel` semantics into
`packages/shared` … and have the client call it) — so the client pool exactly equals the
server pool."

`isEngineTextModel(descriptor)` = `isTextModel(descriptor)` =
`isRunnableModelShape(descriptor) && descriptor.outputs[0] === 'text'`
(`trial-eligibility.ts:75`, `smart-model-candidates.ts:102`), where
`isRunnableModelShape` (`packages/shared/src/model-descriptor.ts:56`) reads `inputs` +
`outputs`. The predicate's discriminators are therefore: text is an accepted **input**,
and the model has exactly **one output**, which is text.

1. **The wire `Model` the client consumes does not carry those discriminators.**
   `packages/shared/src/schemas/api/models.ts` — grepped: zero `inputs`/`outputs` fields,
   and no `isEngineText`/`engineText` flag anywhere in shared/web/list-models. The wire row
   carries only `modality` (the single OUTPUT modality) + `pricing` + `isSmartModel`. A
   multi-output text+image descriptor projects (`list-models.ts:146,159` →
   `MODALITY_BY_FAMILY.language = 'text'`) to `modality:'text'` with token pricing —
   **byte-indistinguishable on the wire from a pure single-text-output model.** `inputs` is
   dropped entirely. So no predicate over the wire `Model` can reproduce
   `isRunnableModelShape`; the client literally cannot exclude the model the brief's example
   ("both rates but non-text/multi-output — server excludes, client includes") describes.
   Closing the drift requires the wire to carry the signal — i.e. editing
   `apps/api/src/slices/models/domain/list-models.ts` (project `inputs`/`outputs` or a
   computed `isEngineText` boolean) **and** `packages/shared/src/schemas/api/models.ts` (add
   the field). Both are **outside Task-03's File ownership** (neither is listed) and the
   `list-models` projection is plausibly the "catalog code" the bound forbids.

2. **The specific multi-output / non-text-input drift the brief cites is UNREACHABLE in
   production.** `list-descriptors.ts:35` (`isExposed`) contains
   `if (!isRunnableModelShape(descriptor)) return false;`. Every descriptor that reaches the
   server's `buildSmartModelCandidates` (via `listDescriptors`) AND every descriptor that
   becomes a wire catalog row is already guaranteed `isRunnableModelShape` (text input,
   single routable output). So a multi-output or non-text-input model is dropped before it
   can enter either pool; the two predicates cannot disagree on it on real data. The brief's
   example is only constructible by bypassing `isExposed` at the unit seam.

3. **The reachable residual difference is a DIFFERENT axis: the both-rates check.** On the
   exposed set, server `isEngineTextModel` reduces to `outputs === ['text']` and includes a
   text descriptor even when it is **missing one flat per-token rate**; the client's
   `smartModelPoolFromCatalog` (`use-prompt-budget.ts:302-320`) additionally requires BOTH
   `inputPerToken` and `outputPerToken`. A rate-less exposed text model therefore: server
   includes it → it sorts cheapest → `priceSmartModelPool` returns `null` (unpriceable
   classifier, `smart-model-affordability.ts:173-174`) → server BLOCKS; client drops it →
   prices the rest → may ADMIT. That is a genuine reachable client/server drift — but its
   fix is to make the server pool ALSO require both rates (aligning `buildSmartModelCandidates`
   with `list-models.ts:175` `isPriceableTextDescriptor`, which already gates on
   `isTextModel && both rates`). That is a **complementary-predicate** resolution (server
   check on descriptor `Pricing` bigints, client check on wire string pricing — different
   types), which the brief EXPLICITLY BANS ("Do NOT add a note pinning the assumption … that
   is the banned sync-contract; the resolution is one shared predicate").

**Net:** the money-safe, truly-single-predicate fix the brief mandates requires carrying the
engine-text signal onto the wire (out-of-bounds catalog change); the only in-bounds move
that closes the reachable drift is the complementary-predicate pattern the brief forbids.
The two constraints conflict, so I stopped rather than guess.

## Options for the orchestrator / money panel
- **(A) Expand ownership to the wire.** Add ownership of
  `apps/api/src/slices/models/domain/list-models.ts` + `packages/shared/src/schemas/api/models.ts`.
  Then: add `inputs`/`outputs` (or a computed `isEngineText: boolean`) to the wire `Model`,
  project it from the descriptor in `list-models`, define the shared predicate over that
  shape in `packages/shared`, and have BOTH `buildSmartModelCandidates` and
  `smartModelPoolFromCatalog` call it. This is the only way to make the client pool exactly
  equal the server pool per the brief.
- **(B) Reframe the finding.** Accept that the multi-output/non-text-input drift is
  unreachable (guarded by `isExposed`) and re-scope Finding 2 to the reachable rate-less
  axis, resolved in-bounds by requiring both rates on the server pool — acknowledging this
  is complementary rather than one shared predicate.
- **(C) Confirm no-op.** If the money panel judges the residual drift acceptable (unreachable
  on exposed data; client is a UX preflight, server re-validates authoritatively), close
  Finding 2 with Finding 1 as the only change.

I recommend (A) if the drift must be closed per the acceptance criterion, since it is the
only faithful reading of "one shared predicate the client calls."

## Deviations / notes
- No out-of-ownership file was edited. Finding 2 needs one and is raised, not made.

## Concerns / limitations
- Finding 1 is a pure comment fix and is low-risk.
- Finding 2 remains open pending the scoping decision above.

## Confidence
- Finding 1: high — comment-only, typecheck + lint green.
- Finding 2 blocker: high — the wire schema demonstrably lacks `inputs`/`outputs` (grep:
  zero hits), and `list-descriptors.ts:35` demonstrably guards `isRunnableModelShape`; both
  are verified reads this session.
