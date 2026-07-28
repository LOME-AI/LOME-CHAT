# B9 — the two rulings landed: producers published, ratchet armed

**STATUS: DONE.** Both rulings implemented and pinned. The consumer reach I owned is closed;
the pending list is now a debt that cannot grow silently.

## Files changed this cycle

| file | why |
| --- | --- |
| `packages/shared/src/affordability/estimate/index.ts` | publishes `planReasoning` / `planReasoningOff`; docblock states the producers/ladder split. |
| `packages/shared/src/index.ts` | same two at the package root, so both entry points agree. |
| `packages/shared/src/affordability/index.test.ts` | removed the two from `WALLED_EXPORTS`; added `REASONING_PLAN_PRODUCERS` + a describe block pinning both barrels and the ladder's continued absence. |
| `apps/api/src/slices/models/adapters/integration-setup.ts` | reach closed — imports the two from `@hushbox/shared`. |
| `packages/config/arch/rules/money-internals-owners-only.rule.ts` | `integration-setup.ts` removed from the pending list; `PENDING_CONSUMER_CLOSURES` exported for the ratchet. |
| `packages/config/arch/rules/money-internals-owners-only.rule.test.ts` | the ratchet: length ≤ 8, plus a duplicate guard so a repeat cannot hide under the cap. |

## Ruling 1 — publish the two producers, close the reach

Landed test-first. The pins went in before the exports, and I watched them fail for the
right reason — **4 failures, all "not bound"**, on both barrels:

```
× binds planReasoning on the affordability barrel
× binds planReasoningOff on the affordability barrel
× binds planReasoning on the package root barrel
× binds planReasoningOff on the package root barrel
```

Then published at both entry points → **323 passed, exit 0**.

**What is published and what is not.** The two producers are now on the barrel; the
**ladder they compute from** (`REASONING_BUDGET_TOKENS_BY_EFFORT`) stays walled, and that is
pinned explicitly rather than left implied:

```ts
it('keeps the ladder the plans are built from behind the wall', () => {
  expect(Object.hasOwn(affordability, 'REASONING_BUDGET_TOKENS_BY_EFFORT')).toBe(false);
  expect(Object.hasOwn(root, 'REASONING_BUDGET_TOKENS_BY_EFFORT')).toBe(false);
});
```

That is the line the ruling actually draws: a caller may ask what a model's plan at an effort
**is**, and cannot read the budget table to work one out itself. Without that assertion,
"published the plan family" would have been indistinguishable from "opened the ladder".

The pin also asserts both entry points hand back the **same binding**, matching the existing
move-not-copy discipline. Worth naming: the same-binding cases would pass vacuously while
both sides are `undefined`, so the presence assertions are the discriminating ones — the
same-binding cases only start meaning something once presence holds, which it now does.

**The reach is closed.** `integration-setup.ts` has zero walled specifiers, and its
`planReasoning` / `planReasoningOff` calls are unchanged — so the cassette-stable request
shape is byte-identical, no `B + H` was re-derived, and Global Constraint 5 is not touched.
Removing it from `PENDING_CONSUMER_CLOSURES` and finding `arch:check` still green is the
proof the closure is real rather than allowlisted.

## Ruling 2 — the ratchet, shown to bite

`PENDING_CONSUMER_CLOSURES` is exported so its colocated test can measure it:

```ts
const MAX_PENDING_CONSUMER_CLOSURES = 8;
expect(PENDING_CONSUMER_CLOSURES.length).toBeLessThanOrEqual(MAX_PENDING_CONSUMER_CLOSURES);
```

A ratchet that has never been seen to fail is the vacuity class, so I grew the list by one
entry and ran it:

```
× holds no more pending consumer reaches than the recorded debt
AssertionError: expected 9 to be less than or equal to 8
      Tests  1 failed | 11 passed (12)
```

Reverted **byte-exact** — `diff` clean, sha256 `d6ac6138…62` identical before and after, probe
entry absent — then **12 passed, exit 0**.

A second assertion pins uniqueness, because a duplicated path would otherwise let the list
carry a repeat while the count still satisfied the cap.

## Final classification — what B8b gates on

**67 bindings across 23 files: 55 OWNER · 12 CONSUMER.** Down from 69/14 by exactly the two
this cycle closed.

**Subpath disposition — 11 of 13 units survive because owners need them:**

| disposition | units |
| --- | --- |
| **OWNER-NEEDED (11)** — keep | `constants`, `estimate/{classifier-line-item, effort-options, pre-adapters, price-request, reasoning-plan, reducers, run-ceiling, search-reservation, smart-model-affordability, types}` |
| **CONSUMER-ONLY (2)** — deletable once closed | `smart-model/effort-dimension`, `smart-model/resolve` |

**The 12 remaining consumer reaches, none in files this task owns:**

| file | bindings | closure |
| --- | --- | --- |
| `workflows/nodes/turn-decision.ts` | cheapestClassifierEffort, parseClassifierAnswer, resolveClassifiedEffort | `chooseFrom` |
| `workflows/nodes/turn-decision.test.ts` | cheapestClassifierEffort | follows subject |
| `workflows/nodes/model-call-execution.ts` | pickClassifiedEffortPlan | `wireFor` |
| `workflows/nodes/smart-model-execution.ts` | planReasoningOff · pickClassifiedEffortPlan · resolveClassifierOutput | **planReasoningOff is now a one-line import edit** (published this cycle); the other two via `wireFor` |
| `workflows/nodes/smart-model-execution.test.ts` | REASONING_BUDGET_TOKENS_BY_EFFORT | fixture |
| `workflows/engine/workflow-capabilities.test.ts` | cheapestClassifierEffort | `chooseFrom` |
| `workflows/engine/live-run.test.ts` | cheapestClassifierEffort | `chooseFrom` |
| `chat/routes.integration.test.ts` | REASONING_BUDGET_TOKENS_BY_EFFORT | fixture |

Worth flagging for D1: `smart-model-execution.ts`'s `planReasoningOff` reach **changed
category** this cycle — it was blocked on publication and is now a plain import rewrite.

## Behaviour identity

No pricing path touched. Publishing two symbols adds barrel bindings and removes nothing;
`integration-setup.ts` calls the same two functions with the same arguments through a
different specifier. Amounts stand where report 2 left them: module hold **11,774,800n** /
wide ceiling **12,281**, server hold **19,999,600n** / wide cap **22,562**, both ≤ 20,000,000n;
`trialMessageBillableNanoUsd(target, 10)` = **2,005,000n**.

**`reserve ⊇ bill`: preserved, neither weakened nor improved.**

## Self-gate

| command | result |
| --- | --- |
| `vitest run packages/shared src/affordability` | **pass** — 56 files / 1516 tests, exit 0 |
| `vitest run packages/shared src/affordability/index.test.ts` (after last edit) | **pass** — 323 tests, exit 0 |
| `vitest run apps/api src/slices/models` | **pass** — 42 files + 1 skipped / 815 tests, exit 0 |
| `vitest run` (`packages/config`, full) | **pass** — 31 files / 381 tests, exit 0 |
| `npx tsx packages/config/arch/run.ts` | **pass** — OK, 13 rules / 2046 files, exit 0 |
| ratchet on a grown list | **fail as designed** — `expected 9 to be less than or equal to 8`; reverted byte-exact (sha256 match) |
| `npx eslint …` from `packages/shared` | **pass** — exit 0, after the last edit |
| `npx eslint arch` from `packages/config` | **pass** — exit 0 |
| `npx eslint src/slices/models` from `apps/api` | **pass** — exit 0 |
| `npx turbo typecheck --force --continue` | **pass** — 16/16, 0 cached, exit 0, after the last edit |

Per the environment gotcha, `node_modules/.vite` was cleared at the root and in
`apps/api` / `apps/web` / `packages/shared` after editing shared code, before any test result
here was trusted.

## Three process notes, because each one nearly produced a false green

**1. `packages/shared` lint was RED and only the per-package rule caught it.** My new test
block carried five prettier errors while every test passed. This is Global Constraint 9's
exact failure mode — the one the constraint records a task having shipped — and it was caught
only because the lint set was derived from what *I* touched rather than from what I
remembered touching. Fixed with `--fix`, re-verified exit 0.

**2. Two eslint runs hit the 120s tool timeout and went to background, producing no output.**
Per §Known Breakage, silence from a killed process reads identically to silence from a clean
one. I did not record either as green: I waited for the real exit status (`CFG_LINT_EXIT=0`
with genuinely empty output) and re-ran the shared one in the foreground with the status
captured on the command itself.

**3. `eslint --fix` left a docblock attached to the wrong declaration.** My insert landed
between `WALLED_EXPORTS`'s docblock and its `const`, so a block comment describing the export
wall sat above `REASONING_PLAN_PRODUCERS`. A docblock pointing at the wrong declaration is the
wrong-comment class at its most literal. Reordered so each comment sits on what it describes,
and re-ran the suite (323 passed) and lint (exit 0) afterwards.

Also recorded: `git diff` against `HEAD` is **not** a usable read of one's own edits in this
tree — `index.test.ts` carries B8's uncommitted work, so the diff shows changes I did not
make. I verified the `--fix` was safe by re-running the suite rather than by reading a diff.

## Deviations

- **The `packages/shared` grant is new this cycle** and comes from the coordinator's ruling,
  not §B9's Files list, which still says `packages/shared` is B8/B8b's. Taken as granted.
- `MAX_PENDING_CONSUMER_CLOSURES` is a hand-maintained number, not a computed one. That is
  the mechanism working as specified — it may be lowered freely and raised only deliberately —
  but it is worth stating that nothing forces it *down*, only that it cannot drift *up*.

## Concerns and limitations

- **The laundering gap is unchanged and still real.** `trial-smart-model-candidates.ts`
  remains a price owner with zero walled specifiers, reaching an internal through an owner's
  re-export. Recorded in the plan with its shape named; not closed here.
- **`packages/config/arch/README.md` still under-describes the rule set** — no
  `money-internals-owners-only` entry. `.md` is read-only to me; the coordinator is carrying
  it with the doc batch.
- **The gate is `apps/api`-only.** `apps/web` still has open reaches under E1/G2 and no rule
  enforcing its stricter obligation.

## Confidence

**High.** Both rulings are pinned by tests watched red first — the four unbound-symbol
failures for the publication, and `expected 9 to be less than or equal to 8` for the ratchet —
and both reverts were verified by hash rather than by eye. Every gate was run after the last
edit, including the lint that had actually been red. The classification totals reconcile
exactly against the previous cycle: 69 → 67 bindings, −2, which is precisely the reach closed.
