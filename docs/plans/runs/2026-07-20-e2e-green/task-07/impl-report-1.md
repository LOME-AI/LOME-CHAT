# Task-07 — regenerate path resolves Smart Model like the send path

## Objective

Every regenerate of a Smart-Model (default) turn 400s: `regenerateTurnDefinitionOrRefusal`
(chat routes.ts) passed the `smart-model` sentinel straight to `buildTurnDefinition`,
missing the sentinel branch the send path has. This broke fork-regeneration, smart-model
regenerate, and group retry-own (3 e2e tests). Fix: single-source model resolution so
send and regenerate share one resolver.

## Files changed

- `apps/api/src/slices/chat/routes.ts` — deleted the duplicate
  `regenerateTurnDefinitionOrRefusal` helper (the branch that lacked the sentinel handling);
  pointed the regenerate terminal handler at the shared `turnDefinitionOrRefusal(c, deps, body, { userId, budget })` — the same resolver the two send handlers already use. Added the
  single-model-sentinel guard (`model === SMART_MODEL_ID && models !== undefined → 400 VALIDATION`)
  to the regenerate handler, matching the send and guest routes. Generalized the
  `turnDefinitionOrRefusal` doc comment to name all three paid entrypoints.
- `apps/api/src/slices/chat/routes.integration.test.ts` — replaced the stale test that
  asserted a smart-model regenerate 400s (`refuses a regenerate naming 'smart-model'…`)
  with the correct-behavior tests below.
- `apps/api/src/slices/chat/domain/regenerate.integration.test.ts` — updated the stale
  mock-echo assertion `'Echo: first prompt'` → `'Echo:\nfirst prompt'` (and its two doc
  comments) to match Task-09's newline-separated mock echo format (`Echo:\n<prompt>`).
  Not a Task-07 behavior change — a cross-task assertion fix the orchestrator directed.

## Tests added

- `builds the one-node smartModel definition for a smart-model regenerate (201)` — a
  smart-model regenerate resolves the sentinel to a one-node `smartModel` definition whose
  candidates are the catalog models (not the sentinel). Covers AC-2 (regenerate no longer 400s).
- `resolves the smart-model sentinel on a $action regenerate (fork: $onFork) with 201`
  (it.each: retry/edit × linear/fork) — the contract matrix: every regenerate entry resolves
  the sentinel without a VALIDATION refusal. Covers AC-2 enforcement rung (turn entrypoint ×
  sentinel matrix). Note: send-path sentinel resolution is already pinned by the existing
  `builds the one-node smartModel definition for a smart-model send (201)` test; this adds the
  regenerate axis, closing the matrix across entrypoints.
- `refuses a smart-model regenerate combined with a multi-model list with 400` — the
  single-model-sentinel rule now holds on regenerate too (parity with send/guest). Covers AC-1
  (behavior single-sourced, no copied branch that could drift).

## Self-gate

- `pnpm test:watch run apps/api/src/slices/chat/routes.integration.test.ts` — pass — 154/154
  (was 152; +2 net after replacing 1 stale test with 6 new cases).
- `pnpm test:watch run …/chat/domain/regenerate.integration.test.ts` — pass — 2/2 (after Echo fix).
- `turbo typecheck lint --filter=@hushbox/api --force` — pass — 2/2 tasks successful, 0 cached.
  (The earlier `regenerateTurnDefinitionOrRefusal` TS6133 unused-symbol error is resolved:
  the symbol is deleted and its call site rewired to the shared resolver.)
- `eslint src/slices/chat/routes.ts routes.integration.test.ts domain/regenerate.integration.test.ts`
  (from apps/api) — pass, exit 0, run after the last edit.
- `jscpd` on both changed source paths — pass, no clones.
- E2E proof `pnpm e2e e2e/chat/fork-regeneration.spec.ts` — DEFERRED TO ORCHESTRATOR
  CONSOLIDATED RUN. The per-task e2e lock had a ~28-min backlog bottlenecking the run;
  the orchestrator elected to run the consolidated suite centrally. The regression proof
  for this task is the api integration RED→GREEN plus the entrypoint contract matrix above.

## Acceptance criteria

1. **Model resolution single-sourced** — MET. Send handlers and the regenerate handler now
   call the identical `turnDefinitionOrRefusal`. The copied `regenerateTurnDefinitionOrRefusal`
   branch is deleted, so the media/smart/multi-model resolution cannot drift between paths.
2. **TDD failing api integration test first; enforcement matrix** — MET. Wrote the failing tests
   first and watched them fail for the right reason (regenerate smart-model returned 400, matrix
   returned 400) before the fix; green after. The it.each matrix (retry/edit × linear/fork)
   plus the existing send test form the entrypoint × sentinel contract matrix.

## Deviations

- The regenerate body carries no `webSearchEnabled` field, so through the shared resolver
  `webSearchEnabled` resolves to `false` — preserving the prior "regenerate never enables web
  search" behavior exactly. No behavior change on the text non-smart path.

## Concerns and limitations

- The mock-provider echo-format change (Task-09, `Echo:\n<prompt>`) touched one assertion in
  my ownership — `regenerate.integration.test.ts:382` — now fixed. The routes integration test
  file has no `Echo:` assertions (grep-verified).
- E2E proof deferred to the orchestrator's consolidated run (lock backlog) — not run by this task.
- During the session `turbo … --filter=@hushbox/api` was transiently red on out-of-ownership
  files (`packages/realtime` typecheck; `conversations/adapters/stores.integration.test.ts`
  prettier) from other in-flight tasks; both cleared without any change from me, and the final
  forced turbo run is fully green.

## Confidence

High — the change collapses two resolvers into one already-proven path; the failing-first
tests pin the exact regression and the enforcement matrix guards the class.
