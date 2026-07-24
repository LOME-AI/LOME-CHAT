# Task 07 — fix cycle 2: A5 ruling — delete `concurrentRunsRemaining` from `GET /billing/spendable`

Status: COMPLETE. Ruled scope change only; admission path untouched.

## Objective

Apply amendment A5: the `GET /billing/spendable` response becomes exactly
`{ spendableNanoUsd: NanoUSD, heldNanoUsd: NanoUSD }`. Admission's per-wallet
run-cap enforcement frozen (no admission file edited beyond the read-only
script's reply shape).

## Final response schema + serving-code diff summary

- `getSpendableResponseSchema` = `z.object({ spendableNanoUsd: z.string(), heldNanoUsd: z.string() })`
  (packages/shared/src/schemas/api/billing.ts). Doc comment states the cap is
  enforced solely at admission, never served.
- Route (`apps/api/src/slices/billing/routes.ts`): serializes only the two
  NanoUSD strings; `concurrentRunsRemaining` line and `concurrentRunCap`
  pass-through removed.
- Domain (`domain/spendable.ts`): `SpendableView` = two bigint fields;
  `ReadSpendableArgs` lost `concurrentRunCap`; `ActiveHoldsReadout` = `{heldNanoUsd}`
  only; `totalHolds` folds sums only.

## Disposition of the internal count — REMOVED END-TO-END from the read path

Evidence the count was provably unused by T08: the only consumer of
`readBudgetScopeHolds`/`holdReadoutAt` is `apps/api/src/slices/conversations/domain/budgets.ts`,
which reads exclusively `.heldNanoUsd` (lines 212, 220); its tests never touch
`count`. Per the ruling's stated preference, `HOLDS_READ_SCRIPT` now returns one
`%.0f` sum string per key (count dropped from the reply), and
`ActiveHoldsReadout.count` is deleted. The shared `ACTIVE_HOLDS_LUA` fragment is
UNCHANGED — it still returns `sum, count` because `ADMISSION_SCRIPT` needs the
count for the frozen run-cap gate; the read script simply takes the first return
value. Sharing pins (`admission-scripts.test.ts`, both scripts contain the
fragment verbatim) pass unmodified.

## Disposition of concurrentRunCap wiring — DEAD, REMOVED

`BillingRouteDeps.concurrentRunCap` deleted; `app.ts` wiring + its now-unused
`PER_WALLET_CONCURRENT_RUN_CAP` import removed (app.ts back to baseline import
set — the chat-barrel export of the constant is committed pre-existing code, not
a T07 addition, so it stays); `concurrentRunCap: 5` removed from the two
manifest-construction sites T07 added it to (`app-mount.integration.test.ts`,
`routes-usage.integration.test.ts`) and from `routes.integration.test.ts` deps.
`SPENDABLE_RUN_CAP`/`RUN_CAP` test constants remain — still used by the tests'
real `admitRun` calls (admission path, frozen).

## Grep proof (Verified, this session)

`grep -rn "concurrentRunsRemaining" apps packages e2e scripts docs/BILLING.md`
(ts/tsx) → zero hits, exit 1. Remaining `concurrentRunCap` hits are exclusively
the admission path (`admission.ts` request param, `admitRun` call sites in
tests, `ADMISSION_SCRIPT` ARGV comment) — frozen and correct.

## Files changed

- `packages/shared/src/schemas/api/billing.ts` — schema down to two fields
- `packages/shared/src/schemas/api/billing.test.ts` — two-field pins (exact-shape test added)
- `apps/api/src/slices/billing/domain/admission-scripts.ts` — HOLDS_READ_SCRIPT reply drops count
- `apps/api/src/slices/billing/domain/spendable.ts` — count/cap removal (see diff summary)
- `apps/api/src/slices/billing/domain/spendable.integration.test.ts` — count assertions removed; floor-at-zero test deleted (behavior removed); exact-keys pin added
- `apps/api/src/slices/billing/routes.ts` — field + dep removed
- `apps/api/src/slices/billing/routes.integration.test.ts` — wire-shape exact-keys pin; dep removed
- `apps/api/src/slices/billing/routes-usage.integration.test.ts`, `apps/api/src/app-mount.integration.test.ts` — dead dep removed
- `apps/api/src/app.ts` — wiring + import removed

## Tests added/changed → criteria

- shared `carries exactly the two money fields` — schema shape is exactly the ruled two fields
- shared `accepts NanoUSD strings…` / `rejects a missing field` — reworked to two-field shape
- api domain: exact-keys pin on the served view; readout expectations `{heldNanoUsd}` only
- api route: `Object.keys(body)` exact-keys pin — wire shape is exactly two fields

## TDD

- Shared schema: RED watched (2 fails — parse rejected two-field input, shape had 3 keys) → schema edit → GREEN (29/29).
- Domain: RED watched (6 fails — readouts carried `count`, view carried the field) → `HOLDS_READ_SCRIPT` + `spendable.ts` edits → GREEN (48/48 incl. all 29 admission pins).
- Route: the wire-shape pin passed immediately after the domain edit — explainable, not a testing-existing-behavior smell: `JSON.stringify` drops the `undefined` the removed view field left, so the wire RED was observed at the domain step; remaining route edits were dead-code removal, enforced by typecheck.

## Self-gate (Verified, this session)

- `pnpm test:shared`: 2256/2256 pass; coverage gate fails ONLY on
  `src/estimate/smart-model-affordability.ts` (branches 86.02%) — pre-existing
  per amendment A1, file untouched (T03/T06 lane absorbs).
- `pnpm test:api`: 6089 pass / 8 fail / 2 skip; zero coverage errors. Both
  failing files attributed, neither mine: (a) `notifications/.../template-html.test.ts`
  7 snapshot fails — pre-existing per A1; (b) `identity/routes-email-verification.integration.test.ts`
  1 fail — environmental DB debris: an orphan `email=''` user row from a prior
  aborted run violates `users_email_unique`; the test's own comment (lines
  145–146) names exactly this poisoning mode; no identity file touched or dirty.
  All billing/spendable/admission/app-mount files pass; T08's
  `budgets.integration.test.ts` green untouched (127/127 in the focused run).
- Repo-wide `pnpm typecheck` (A3): exit 0 with all my source edits in place
  (21:30 run); a LATER re-run fails with 4 errors in `apps/api/src/slices/models/*`
  on `NanoLineItem.marksUp`/`marksUpOnly` — the T03-lane shared-estimate contract,
  `packages/shared/src/estimate/types.ts` dirty from concurrent sibling work,
  zero overlap with my files; `packages/shared` scoped `tsgo --noEmit` exit 0.
  Attributed to in-flight sibling work, raised to the orchestrator.
- Lint after final edit, from each package dir: `eslint <owned files>` exit 0
  (api: routes, routes tests, routes-usage test, spendable, spendable test,
  admission-scripts, app.ts, app-mount test; shared: schemas/api/billing + test).
  One round of fixes was needed (sort→toSorted+localeCompare; prettier wrap).
- Post-lint re-runs: shared billing tests 29/29; api spendable+routes 58/58.

## Acceptance criteria (A5 ruling)

- Response schema exactly two fields — MET (schema shape pin + wire exact-keys pin).
- Admission untouched — MET (`admission.ts` not edited this cycle; `ACTIVE_HOLDS_LUA`
  and `ADMISSION_SCRIPT` byte-identical to audited state; 29 admission pins green).
- Internal count disposition stated — MET (removed end-to-end from read path;
  T08 evidence above).
- Dead `concurrentRunCap` wiring removed — MET.
- T08 budgets tests green untouched — MET.

## Deviations

None from the ruling. The route-level RED could not be observed at the wire
(domain edit already changed serialization) — documented above.

## Concerns / limitations

- The repo-wide typecheck regression from the T03 lane means the tree as a whole
  does not typecheck at this moment; my packages do. Needs orchestrator
  sequencing awareness, not a T07 fix.
- The identity DB-debris failure will recur for every task's full `test:api` run
  until someone clears the orphan `email=''` row (or the test run that owns it
  completes its cleanup).

## Confidence

High — small, ruled deletion; every removal pinned by an exact-shape test;
admission behavior-identity re-verified by its untouched 29-test suite.
