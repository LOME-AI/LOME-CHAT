# C5 — impl report 3 (fix cycle)

## Objective

One comment. The Important finding from cycle 2 is closed and verified (arm's taken-count
0 → 1, established as exactly 1, so a counter-raising-but-non-discriminating pin is
arithmetically excluded). The validated Minor: the durable maintenance note written in
cycle 2 lived only in the impl report, which is a run record — never updated, never cited
as current — so the guidance was unreadable by the person who will need it. Moved into the
fixture's own comment, in the file that goes red, written as a guarantee rather than a
quantity, plus the calibration asymmetry the auditor raised.

## Files changed

| File                                                      | Why                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` | Comment-only: the maintenance guarantee and the fixture/contract asymmetry now sit on the calibrated `fallback` case. |

Nothing else in the repo was written this cycle. One `Edit` call, one file.

## The comment's final text

Appended to the existing comment on `falls back when the fitted cap buys no offered rung`
(`smart-model-turn.test.ts:923-931`), directly above the assertion it explains:

```
      //
      // This rate is chosen so the fitted cap lands inside that bracket. If the
      // ladder is retuned, re-place the rate to restore the bracket rather than
      // delete the case: this is the only measurement of that arm, so dropping
      // it un-pins the arm silently. Only this case is calibrated to the ladder
      // — the built neighbour below asserts against the shared budget
      // constants, so it follows a retune on its own. Lower a rung and the pair
      // reddens on one side only, and it is this one: this side is the fixture,
      // that side is the contract.
```

The three sentences already above it state the bracket ("past the minimum-answer floor but
short of the cheapest rung's budget plus that same floor") and the open ruling; the
addition attaches the maintenance instruction and the asymmetry to them rather than
restating either.

### Why this placement and not the shared reasoning constant

The note is about how to keep **this fixture** calibrated. On
`REASONING_BUDGET_TOKENS_BY_EFFORT` it would be a cross-package prose claim about a
quantity in a file `packages/shared` cannot see — the unbounded-durable-claim shape
§Known Breakage bans — and it would invert the dependency, pointing a shared constant at
an api test fixture. Here the claim is bounded by construction: the assertion it sits on
_is_ the gate, so a retune that falsifies the comment reddens the file the comment is in.

### Why a guarantee, not a quantity

Cycle 2's report stated the calibration numerically ("if lite is retuned below ~1,498").
That is a count in prose — a sync contract with a constant in another package, stale after
one retune. The committed form names no rung, no rate and no budget; it states what the
rates are chosen to achieve and what to do when that stops holding, which survives a
retune instead of decaying with it.

### The asymmetry, which was stated nowhere

Only the `fallback` case is calibrated to the ladder. Its `built` neighbour asserts
`cap >= REASONING_BUDGET_TOKENS_BY_EFFORT.lite + MINIMUM_OUTPUT_TOKENS`
(`smart-model-turn.test.ts:931-933` pre-edit / `940-942` post-edit) — shared constants, not
a literal — so it tracks a retune automatically. Lowering the rung therefore reddens the
pair on the `fallback` side alone, and a reader who does not know which side is fixture and
which is contract will "fix" the contract side. The comment names which is which.

## Acceptance criteria

| Criterion                                                        | Status | Evidence                                                                                                        |
| ------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| Durable note moved out of the impl report into the fixture comment | met    | Text above, at `smart-model-turn.test.ts:923-931`, immediately above the assertion.                              |
| Not placed on the shared reasoning constant                        | met    | Only `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` was written; `packages/shared` untouched.        |
| Written as a guarantee, not a quantity                             | met    | No rung name, rate, budget or token count appears in the added text.                                             |
| Asymmetry stated (which side reddens, which side is the contract)  | met    | Final three sentences of the addition.                                                                           |
| Nothing else changed                                               | met    | Counts and hashes below.                                                                                         |

## Nothing else changed — measured

- **No production file differs.** `apps/api/src/slices/chat/domain/smart-model-turn.ts`
  md5 `6086119e6e654915d382add4d82f2dbb` **before and after** the edit — byte-identical to
  its state at the start of this cycle (that file's difference from `HEAD` is cycle 1's
  approved production change, untouched here). No other file was opened for write.
- **Test count unchanged:** 54 `it(` blocks before, 54 after.
- **Assertion count unchanged:** 82 `expect(` calls before, 82 after.
- **No assertion text changed:** the fixture rates (`4000n` / `3000n` / `10_000n`), the
  `engine` and `answerAt` descriptors, and all three outcome assertions are as cycle 2 left
  them; the diff of this cycle is nine comment lines inserted between the existing comment
  and the existing `expect`.

## Self-gate

| Command                                                                                        | Result                                                                     |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm test:watch run apps/api/src/slices/chat/domain/smart-model-turn.test.ts` (isolated, per brief) | **EXIT=0** — Test Files 1 passed, Tests **54 passed (54)**, 4.58s.        |
| `npx eslint src/slices/chat/domain/smart-model-turn.test.ts` from `apps/api`, after the last edit  | **EXIT=0**, no output.                                                     |

Both statuses were captured on the command itself (`cmd > log 2>&1; echo "EXIT=$?"`), not
from a pipeline's last stage and not from the background harness, which has misreported an
exit code three times in this run.

**Lint set derived, not remembered:** this cycle's changed-file list is one file in one
package (`apps/api`), so `apps/api` is the whole lint set. `packages/shared` was
deliberately not edited (see above), so there is no second package to cover.

`pnpm test:api` and `pnpm ensure-stack` were not run, per the brief.

## Neighbours — attributed, not chased

Live agents own files this task does not: F7 (`chat/routes.ts`,
`chat/domain/turn-context.ts`, `packages/shared/src/affordability/**`), D2
(`conversations/**`, `schemas/api/**`, `apps/web/src/lib/api.ts`, `message-item.tsx`), D3
(in audit over `workflows/**`, `models/domain/estimate-run.ts`,
`packages/shared/src/workflow.ts`). The one file this cycle ran is green in isolation and
imports none of their in-flight edits at runtime, so no cross-agent failure surfaced in my
scope. Cycle 2's typecheck errors in `turn-context.integration.test.ts` /
`turn-definition.integration.test.ts` belong to F7's `turn-context.ts` contract change; a
comment-only edit cannot have moved them, and I did not re-run typecheck this cycle — its
error set is F7's and still moving.

## Deviations

None.

## Concerns and limitations

- The comment's guarantee is enforced by the assertion it sits on, which is the point —
  but the enforcement is one-directional: a retune that _raises_ the rung leaves the
  fixture still bracketed and the comment still true, while a retune that lowers it reddens
  this case. That is the intended shape (the arm should surface when it stops being
  measured), recorded so no later reader reads the one-sided redness as a flake.
- C6 still owns whether this arm's outcome is correct at all. The comment pins the outcome
  and says so without naming any task, per the durable-naming rule.

## Confidence

**High.** The change is nine comment lines with no executable content; the production file
is byte-identical by hash across the edit, test and assertion counts are unmoved, the one
owned file passes in isolation at 54/54, and lint is exit 0 from the package directory
after the final edit. The one judgement call — placing the note on the `fallback` case
rather than on the shared constant — is the placement the brief specified and the one the
bounded-claim rule requires.
