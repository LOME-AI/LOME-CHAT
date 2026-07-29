# F4 — implementation report 3 (fix cycle 3)

## Objective

Close one validated finding, raised by this task in cycle 2 and ruled in scope:
`apps/web/src/hooks/billing/use-budget-calculation.ts` carried the same pending-only funding
gate that finding 7 removed from `use-turn-options.ts`, with a different wrong fallback —
spendable `0n` at the **sender's** tier rather than the trial ceiling. A *failed* funding read
settles with no data, so the pending-only gate published that fallback as a settled answer.
§F4's criteria require the composer's snapshot for a guest to be the **served** one and require
that **nothing is fabricated when the query has not resolved**.

No widening. One gate line, one test, one falsified comment corrected.

## Files changed

| File | Why |
| --- | --- |
| `apps/web/src/hooks/billing/use-budget-calculation.ts` | The loading gate keys on the ABSENCE of the snapshot instead of the query's `isPending`; the comment above it records why (a failed read settles with no data, and the fallback it would publish for a guest is a money verdict the server never gave). |
| `apps/web/src/hooks/billing/use-budget-calculation.test.ts` | The new pin; the `hasServedFunding` double now mirrors the real rule instead of only its authenticated arm; one falsified fixture doc corrected. |

## Tests added

| Test | Behavior | Criterion covered |
| --- | --- | --- |
| `a funding read that failed is not a served figure > keeps a link guest loading when its funding read settled with no snapshot` | A door-holding caller whose funding query has **settled with no data** (`isPending: false`, `data: undefined`) is reported as loading, not as answered | "the composer's snapshot for a guest is the **served** one; nothing is fabricated when the query has not resolved" |

The mock change is what makes the pin possible and is itself a correctness fix: the previous
double was `hasServedFunding: (isAuthenticated) => isAuthenticated`, which returns `false` for a
link guest and therefore could not express the case under test. The double now reads
`isAuthenticated || (linkGuestCredential !== null && conversationId !== null)` — the real
predicate's rule (`use-spendable.ts:18-21`), driven by one controllable fact that also drives the
sender's tier through `useUserTierInfo`, exactly as production does. With that fact left at its
default (`null`), the double is identical to the old one, so no existing test's inputs moved.

## The red, watched, verbatim

**Red 1 — the gate** (`pnpm test:watch apps/web/src/hooks/billing/use-budget-calculation.test.ts`,
exit 1, 1 failed / 33 passed):

```
 FAIL  |web| src/hooks/billing/use-budget-calculation.test.ts > useBudgetCalculation > a funding read that failed is not a served figure > keeps a link guest loading when its funding read settled with no snapshot
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/hooks/billing/use-budget-calculation.test.ts:737:47
```

**Red 2 — the same red, widened for one run only, to record the moved verdict verbatim.**
The brief asks for evidence that a link guest's verdict *moves* on a failed read, so the
assertion was temporarily broadened to print the numbers the hook publishes alongside the gate.
No background suite was in flight; the file was restored from a byte-exact copy and `diff`
confirmed `RESTORED_EXACT`.

```
 FAIL  |web| src/hooks/billing/use-budget-calculation.test.ts > useBudgetCalculation > a funding read that failed is not a served figure > keeps a link guest loading when its funding read settled with no snapshot
AssertionError: expected { isBalanceLoading: false, …(2) } to deeply equal { isBalanceLoading: true, …(2) }

- Expected
+ Received

  {
    "estimatedInputTokens": 500,
-   "isBalanceLoading": true,
+   "isBalanceLoading": false,
    "maxOutputTokens": 0,
  }
```

Read that received object as the composer sees it. For a link guest inside a conversation whose
funding read **failed**, the hook published, as a settled answer: *the payer's figure is in hand*
(`isBalanceLoading: false`), *it funds nothing* (`maxOutputTokens: 0`), *sized at 2 chars/token*
(`estimatedInputTokens: 500` on a 1000-character prompt — the **sender's** guest ratio; a paid
owner's ratio is 4, which would have been 250). That is a complete zero-capacity money verdict at
the wrong tier, produced from a read that returned nothing. `use-prompt-budget.ts:367` folds
`isBalanceLoading` into `isBillingLoading`, so `false` is precisely the value that tells the
composer to stop waiting and act on those numbers.

**Green** — same command, exit 0, 34 passed / 34.

## The gate, before and after

Before (`use-budget-calculation.ts`, cycle-2 state):

```ts
const { data: spendableData, isPending: isSpendablePending } = useSpendable(input.conversationId);
const isBalanceLoading =
  hasServedFunding(input.isAuthenticated, input.conversationId ?? null) &&
  (!isBalanceStable || isSpendablePending);
```

After (`:199-210`):

```ts
const { data: spendableData } = useSpendable(input.conversationId);
const isBalanceLoading =
  hasServedFunding(input.isAuthenticated, input.conversationId ?? null) &&
  (!isBalanceStable || spendableData === undefined);
```

Identical in shape to finding 7's fix at `use-turn-options.ts:211-212`
(`hasServedFunding(...) && served === undefined`). `isPending` is no longer read from
`useSpendable` anywhere in production. `!isBalanceStable` is untouched — it is an independent
loading input (auth/balance stability), not part of the finding.

## Is there a third instance of this shape?

**No third instance of the finding's defect class exists.** One adjacent, weaker instance of the
same *gate keying* does, on a different read; it is reported below and was not touched.

Sweep, re-run binary-inclusively (see §Sweep integrity — the first pass was unsound):

- `hasServedFunding(` — **two** production call sites, both now keyed on absence:
  `use-turn-options.ts:212` (cycle 2) and `use-budget-calculation.ts:209` (this cycle). The third
  and fourth hits are the definition and the query's own `enabled` flag in `use-spendable.ts`.
- `useSpendable(` — six production sites. Four read `data` only and hold no gate at all
  (`use-resolve-billing.ts:43`, `use-turn-options.ts:203`, `use-budget-calculation.ts:200`, plus
  the definition). The remaining two are `use-model-validation.ts:81` and
  `use-resolve-default-model.ts:60`, which read the unscoped `useSpendable(null)` door — **F10's
  territory, not touched**, and neither carries a pending-versus-failed gate.
- `isPending:` destructured anywhere under `apps/web/src/hooks` — the surviving reads are
  `useSession()` (auth, not funding) at four sites, and one money-adjacent read described next.

**The adjacent instance, reported not fixed:** `use-prompt-budget.ts:532` reads
`useConversationBudgets(...)` and destructures `isGroupBudgetPending`, consumed at `:367` as
`isBalanceLoading || (isGroupMember && isGroupBudgetPending)`. That is the same keying — pending
rather than absence — over a served money read, and on a failed read
`resolveHasDelegatedBudget(:113-119)` returns `false` from `data === undefined`.

I checked its blast radius rather than assuming it: `hasDelegatedBudget` reaches only
`pushInfoNotifications` in `packages/shared/src/affordability/budget.ts:91-93`, where its sole
effect is whether the `group_budget_pays` **informational** notice is pushed. It does not gate
the send, does not select a funding source, and does not produce a refusal — the payer-switch
disclosure (§Notices 5) rides `billingResult.payerSwitch`, a different value. So a failed group
budget read costs a signed-in member one disclosure line, not a fabricated money verdict. It is
the same shape at a lower stake, and it is a group-member path a link guest cannot reach
(`resolveIsGroupMember` returns `false` for a link guest). I have not touched it; whether one
shared helper should replace all three keyings is the orchestrator's call.

## Sweep integrity — this repo's `grep` silently skips two source files

Load-bearing enough to state before the gate results, because it invalidated my own first sweep
and it invalidates the method every report in this run has used.

`grep` in this environment is **ugrep 7.5.0**, not GNU grep. It classifies a file containing a
NUL byte as binary and, without `-a`, **skips it entirely — no match, no warning, exit 0**. Two
repo source files contain a raw NUL inside a string literal (enumerated by reading every
`.ts/.tsx/.js/.json/.md/.css/.html` file under `apps/` and `packages/` in Node, so the
enumeration itself does not depend on grep):

- `apps/web/src/hooks/billing/use-turn-options.ts:216` — ``.join('<NUL>')``, the memo key
  separator for selected model ids
- `apps/web/src/lib/conversation-socket-registry.ts:17` — `const TRIAL_KEY_PREFIX = 'trial<NUL>';`

Both look deliberate (a NUL is a collision-free separator, and neither file is one this run's
tasks authored), but both are written as raw bytes rather than the byte-identical escape
`'\u0000'`, which is what makes them invisible to grep.

The measured consequence, not an inferred one: my first sweep of this cycle reported that
`use-turn-options.ts` **does not contain** `hasServedFunding`. It contains it at lines 20 and
212. Re-running the identical command with `-a` returns both. The file that vanished is the money
layer's single adapter hook under `apps/web` — the file finding 7 was fixed in. Every repo-wide
grep in reports 1 and 2 (`tier === 'guest'`, the `heldNanoUsd:` wire-shape sweep, each mandated
vocabulary sweep) silently excluded it. That does not make those conclusions wrong; it makes
their evidence narrower than stated. This is the plan's own "an aliased re-export defeats every
name-grep" class, one level worse: an entire file drops out, and nothing in the output says so.

I did not change either file — outside this finding, and the `use-turn-options.ts` line is
behaviour-adjacent (a memo key).

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch apps/web/src/hooks/billing/use-budget-calculation.test.ts` | **pass** — exit 0, 34/34 |
| `pnpm test:web` (the plan's scoped check, coverage gate included) | **pass** — exit 0, 396 files. Gated on the **second** run; see attribution. |
| `npx eslint src/hooks/billing/use-budget-calculation.ts src/hooks/billing/use-budget-calculation.test.ts`, run from `apps/web/` after the last edit | **pass** — exit 0, no output |
| `npx turbo typecheck --filter=@hushbox/web --force` | **pass** — exit 0 |
| Coverage, `use-budget-calculation.ts` | **100%** statements / branches / functions / lines, from the `pnpm test:web` coverage table |
| `pnpm test:api`, `pnpm ensure-stack` | **NOT RUN** — forbidden by brief. No `apps/api` or `packages/shared` file was edited this cycle, so neither suite's inputs moved. |

**`pnpm test:web` run 1 was void, and I did not gate on it.** It died at the coverage-report
stage with `Error: Something removed the coverage directory ".../apps/web/coverage/.tmp" Vitest
created earlier. Make sure you are not running multiple Vitests with the same
"coverage.reportsDirectory" at the same time`, plus an `ENOENT` on `coverage-299.json`. Every one
of the 358 per-file result lines it had printed was `✓`; there were zero `×`/`FAIL` lines. This is
§Known Breakage's documented `apps/api` collision, on `apps/web`: a concurrent agent's vitest wiped
the shared coverage temp directory. I confirmed no competing vitest process remained (`ps`
returned none), re-ran, and gated on run 2 — exit 0, captured to its own file, not read from a
wrapper's status.

**Note for the run:** the two-runs-cannot-overlap constraint §Known Breakage records for
`apps/api` applies to `apps/web` identically — same mechanism, same shared
`coverage.reportsDirectory`. The brief serialised `test:api` but not `test:web`.

## Acceptance criteria

Only the criterion this finding reopened is re-evidenced; the rest were met in reports 1 and 2
and no code under them changed.

| Criterion | Status | Evidence |
| --- | --- | --- |
| The composer's snapshot for a guest is the **served** one; nothing is fabricated when the query has not resolved; the pending state is the existing neutral one | **met** | Gate keys on `spendableData === undefined` (`:210`); red 2 above shows what the old gate published for a guest on a failed read (`isBalanceLoading: false`, `maxOutputTokens: 0`, sender-tier sizing) and the pin now holds the composer in the same neutral loading state the authenticated in-flight case already used (`reports loading while the served spendable is still pending…`, unchanged and still green) |
| No third instance of the gate shape is left unreported | **met** | Binary-inclusive sweep above: two `hasServedFunding` gates, both fixed; zero `isPending` reads off `useSpendable`; one adjacent lower-stake instance named with its blast radius measured |

## Deviations, with reasons

1. **The `hasServedFunding` double in the test file was changed, not only added to.** The old
   double could not express a link guest, so the finding was untestable through it. The new double
   mirrors the real predicate and is behaviourally identical for every pre-existing test (the
   controlling fact defaults to `null`). Reported rather than silent because a mock change is a
   change to what every test in the file means.
2. **One comment corrected outside the diff's hunks.** `noSpendable()`'s doc said "every read is
   pending on first render" while the fixture returns `isPending: false`; my change removed the
   mechanism that sentence described. Corrected to state what the fixture is — a settled read that
   produced no snapshot. This is the plan's "grep the removed mechanism's vocabulary" rule
   applied; the only other `pending` hit in either file is the new comment itself and the
   still-accurate in-flight test.

## Concerns and limitations

1. **The silent wait is still silent, by instruction.** A guest whose funding read fails now waits
   in the neutral loading state indefinitely rather than seeing a fabricated refusal. That
   satisfies the criteria as written, and the brief records the missing "could not read your
   funding" copy as a founder product decision. Nothing was invented here.
2. **The fix gates the verdict; it does not blank the numbers.** `spendableNanoUsd` is still `0n`
   and `payerTier` still falls back to the sender's tier inside `computeBudget` while no snapshot
   is in hand — they are simply no longer published as settled, because `isBalanceLoading` is the
   sole neutral-state signal and every consumer reads it (`use-prompt-budget.ts:367`). This is
   exactly the pre-existing behaviour for an authenticated in-flight read, so failed and pending
   are now indistinguishable to callers, which is the finding's requirement. A caller that ignored
   `isBalanceLoading` would still see the fallback numbers; none does today.
3. **`use-turn-options.ts` was verified by `grep -a`, not re-read.** Both the `Read` tool and
   `sed` returned visibly lossy, reflowed text for that file in this session (mangled import
   lines, dropped words), which is what first made the grep discrepancy look like a file change.
   Exact-content claims in this report about files I did not edit rest on `grep -a` output and on
   `od`, not on paged reads.
4. **No E2E run** (Global Constraint 11).

## Confidence

**High** for the fix: one gate line, watched red for the stated reason and green after, with the
moved verdict recorded verbatim rather than argued; `pnpm test:web` green in full including the
coverage gate, per-file coverage 100% on the changed file, lint and typecheck green after the
last edit.

**Medium** for the negative claim — "no third instance" — and the reason is worth the
orchestrator's attention rather than my confidence rating: the sweep behind it is only as good as
the tool, and this cycle proved that tool silently drops files. I re-ran every sweep with `-a` and
enumerated the affected files independently of grep, so the claim is sound as of now; but any
earlier grep-based negative claim in this run's reports should be treated as narrower than it
reads until re-run the same way.
