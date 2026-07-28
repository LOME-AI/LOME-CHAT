# B7 — fix cycle 1

Addresses the two audit findings the orchestrator validated, plus the red `test:shared`
report received mid-cycle. Nothing else in the task was reopened; the settled items
(structural severity, the magnitude enumeration, both cleared behaviour changes, the
payment-form exception, the Constraint 9 derivation) are untouched.

## Finding 1 [Important] — `INSUFFICIENT_ADMISSION` was given a falsely specific wording

**Accepted in full, and the diagnosis was right.** The wire code is answered by three
distinct admission refusals (`AdmissionRefusalReason = 'insufficient-balance' |
'run-cap' | 'budget-exceeded'`, `apps/api/src/slices/billing/domain/admission.ts:53`,
collapsed at `apps/api/src/slices/chat/domain/runtime.ts:613`). Cycle 1 pointed it at
`insufficient_funds`, which told a payer with ample funds and five runs streaming that
their balance could not cover the message and offered "Add credit" — the false payment
path §Notices 9 exists to forbid — and told a group member whose scope emptied at
admission to fix a balance that is not the constraint. The previous hedged sentence
covered both; my change was therefore a regression, not an inherited defect, and my test
pinned the wrong identity as correct.

**The fix, entirely inside my own files.** A code is not a condition, so the collapsed
refusal gets its own condition-neutral entry rather than borrowing one:

`send_cannot_start` — *"This message can't start right now. Check your balance and
budgets, or wait for your other replies to finish, then try again."*

Every clause is true of all three collapsed refusals; the action offers checking **and**
waiting as alternatives precisely because the caller cannot be told which applies; and
it carries **no link**, so no payment path is offered to someone paying cannot help.
`ERROR_MESSAGES.INSUFFICIENT_ADMISSION` reads it; the code is out of the
shared-conditions table.

Pins (all new, all watched red first — the reason did not exist, so the four assertions
failed on `Cannot read properties of undefined`):

- `notices.test.ts` §"the unresolved admission refusal" — three tests: its wording is not
  that of `insufficient_funds`, `funds_held_by_run` or `guest_no_group_budget`; no
  segment carries a link and the text contains no "add credit"; the text names both
  waiting and the balance.
- `error-codes.test.ts` "keeps the collapsed admission refusal out of the per-condition
  wordings" — asserts it equals `noticeText('send_cannot_start')` **and** is not
  `noticeText('insufficient_funds')`. That second assertion is the regression pin: it
  fails if anyone re-points the code at a single condition.
- The shared-conditions derivation table now covers six codes, not seven.

The entry's docblock records that it is the copy for an unresolved case and that it
becomes dead when the emitter carries its reason — no claim about which entries replace
it, since that mapping lives in a file I do not own.

## Finding 2 [Minor, ruled] — precedence applies at the composer

**Implemented as ruled, not weighed.** `generateNotifications` previously pushed
`prompt_too_long` and the denial reason independently, so an over-capacity denied turn
rendered two non-dismissible errors demanding contradictory actions ("Shorten your
message" / "Add credit"), and my cycle-1 audit cases enshrined that output.

`budget.ts` now resolves exactly one blocking reason through a named
`blockingReason(billingResult, isOverCapacity)`: the funding floor is tested first — a
denial means either that funding cannot cover a minimum answer or, for the tier denials,
that no balance and no shorter prompt unlocks the model at all — and length answers only
when funding is not the reason. That is §Notices 4's defined order, and the helper's
docblock states why the composer enforces it as well as the option-level path: this is
the surface where both would otherwise be rendered together.

Pins (watched red first — 3 failures before the change):

- `budget.test.ts` §"precedence when funding and length both bind" — money wins over
  length; length wins when funding is not the reason; a tier denial wins over length.
- `budget.test.ts` "still gives exactly one when the prompt is over capacity as well" —
  the one-blocking-notice property over every denial reason at 150% capacity.
- `client-billing.consistency.test.ts` — its "both denial and capacity errors present"
  case is inverted to assert the funding reason alone.

Audit expectations updated: every case pairing `prompt_too_long` with a **denial**
reason lost the length entry (T6, T9, F6, F9, P8, GMP8, GMF6, GMF8, GMG3). Cases pairing
it with an **informational** notice are unchanged (T3, F3, P5, GM3, GMP5, GMF3) — an
info notice is dismissible and makes no competing demand, so the precedence does not
reach it.

## The red `test:shared` reported mid-cycle

Not reproducible against the current tree, and the symptom identifies it as a snapshot of
my own TDD window. The reported crash — `notices.ts:259`, `Cannot read properties of
undefined (reading 'cause')`, in exactly the three files I was editing — is what
`noticeText('send_cannot_start')` does while the tests referencing that reason exist and
the table entry does not. That is the interval between my watched-red step and the
implementation, roughly two minutes.

Verified after: `pnpm test:shared` run **three** times against the current tree
(post-implementation, post-consistency-test, post-prettier-fix), all exit 0, 128/128
files, with `notices.ts`, `budget.ts` and `error-codes.ts` each at 100/100/100/100.

One unrelated infrastructure crash is worth recording because it looks like a failure and
is not one: one `pnpm test:shared` run aborted with `Something removed the coverage
directory ".../coverage/.tmp"` and **zero** FAIL lines — the same class as the
`test:api` coverage-merge crash in §Known Breakage. It did not recur across the four
subsequent runs.

## Files changed this cycle

| File                                                                          | Why                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/shared/src/affordability/notices.ts`                                | `send_cannot_start` reason + copy; comment tightened to claim no mapping        |
| `packages/shared/src/affordability/notices.test.ts`                           | Three pins for the unresolved refusal                                          |
| `packages/shared/src/error-codes.ts`                                          | `INSUFFICIENT_ADMISSION` reads the neutral wording; docblock records why a code is not a condition |
| `packages/shared/src/error-codes.test.ts`                                     | Code dropped from the shared-conditions table; regression pin added            |
| `packages/shared/src/affordability/budget.ts`                                 | `blockingReason` — one blocking notice, by §Notices 4's order                   |
| `packages/shared/src/affordability/budget.test.ts`                            | Precedence describe block; audit expectations for denied + over-capacity        |
| `packages/shared/src/affordability/billing/client-billing.consistency.test.ts` | The both-errors case inverted                                                  |

No file outside `packages/shared` changed this cycle.

## Self-gate

| Command                                                          | Result                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm test:shared`                                               | **pass** — exit 0, 128/128 files. Run 3× post-fix; owned files 100% statements/branches/functions/lines |
| `pnpm test:web`                                                  | 395/395 test files pass; exit 1 solely on the §Known Breakage `markdown-renderer.tsx` branch-coverage entry (file unmodified vs `HEAD`, untouched by this task) |
| `npx turbo typecheck --force --continue`                         | pass — 16/16, uncached                                                                  |
| `eslint <9 files>` from `packages/shared`                        | exit 0                                                                                  |
| `eslint <6 files>` from `apps/web`                               | exit 0                                                                                  |
| `eslint <5 files>` from `e2e`                                    | exit 0                                                                                  |

Lint set re-derived from `git status` **after** the final edit anywhere (a prettier
`--fix` on `notices.ts` + `notices.test.ts`), grouped by package: three packages present
in this task's changed files — `packages/shared`, `apps/web`, `e2e` — one run each, from
the package directory, exit status captured on the eslint command itself. `git status`
additionally lists `apps/api`, `apps/admin`, `apps/marketing`, `packages/config`,
`packages/db`, `packages/ui` and `scripts`; none carries a change from this task. The
shared suite was re-run after the prettier fix, so no gate predates the last edit.

## Criteria affected by this cycle

| Criterion                                                              | Verdict now | Change                                                                                     |
| ----------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| One condition, one wording; no condition has two phrasings              | met         | Strengthened: the wire catch-all no longer impersonates a condition, and a pin forbids re-pointing it |
| Refusals offer no action that cannot help (§Notices 9's false path)     | met         | The regression is gone; `send_cannot_start` carries no payment link                          |
| Precedence money-then-length, "pinned where both would otherwise be true" | met       | Now pinned at the composer as well as the option level, per the ruling                       |

## Concerns

- **`send_cannot_start` is a wording for a disjunction, not a condition**, which is a
  deliberate exception to the vocabulary's shape. It earns its place only while the
  emitter collapses three refusals; the entry says so. When `apps/api` carries the
  reason, this entry should be deleted rather than kept as a fallback — a permanent
  catch-all would quietly re-absorb new conditions.
- **The hedged action mentions "your other replies"**, which is true only for the
  run-cap arm. It is offered as an alternative rather than asserted as the cause, which
  is the most a condition-neutral sentence can do; a reader who wants it sharper should
  fix the emitter, not the copy.
- The model picker's own "Top up" / "Sign up" copy remains a third phrasing of the two
  premium conditions. Routed to E1 by the orchestrator; my cycle-1 sweep claim was
  overstated by that one file, and I have not touched it.

## Confidence

**High.** Both findings were reproducible from the code, both fixes are pinned by tests
watched failing first, the shared suite is green three times over with full coverage on
the owned files, repo typecheck is 16/16, and all three lint sets exit 0.
