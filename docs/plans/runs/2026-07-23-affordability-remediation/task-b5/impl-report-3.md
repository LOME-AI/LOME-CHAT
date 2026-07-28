# B5 — implementation report 3 (fix cycle 2)

All six validated findings are fixed. Reports 1 and 2 remain the record for everything else; this
covers only the delta. `HEAD` is `53daba72`; cycles 2 and 3 are in the working tree on top of it.

---

## FINDING 1 [Important] — the trial Smart Model arm now prices the route's own count

**The finding is right and my unreachability argument was wrong.** I bounded the escape as requiring
`inputRate > outputRate` and reported "0 of 176 live text models are inverted". The real condition
is `inputRate > 0.4 × outputRate`, i.e. `outputRate < 2.5 × inputRate` — a band that contains flat
rates and output-at-2×-input, which is most of a normal catalog. I re-derived it and agree: my
version compared the gate's shortfall against the wrong term (the 1,000-token output surplus alone
rather than the surplus net of the reserve's share), which understated the band by 2.5×.

### The fix

| file                                                            | change                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `models/domain/trial-smart-model-candidates.ts`                 | `TrialSmartModelCandidatesInput` takes `promptCharacterCount` and no longer takes `prompt`/`history`; the local recount is gone. |
| `chat/domain/smart-model-turn.ts`                               | forwards `args.budget.promptCharacterCount` to the builder, and `budget` becomes **required** on the trial arm. |

The local recount could see the system prompt, the history and the input, but never the custom
instructions — only the route sees those. Removing the recount removes the whole class: there is now
exactly one count, produced by the route, consumed by both the gate and the compiled definition.

**Why `budget` became required rather than defaulted.** A trial send is defined by its per-message
ceiling (§Trial Usage), and that same budget carries the only honest character count. With no
budget there is no cap to compile AND no basis to gate on, so the previous "omitted builds without a
cap" shape could only be honoured by gating on a narrower basis — the defect itself. The route
always supplies one, so this removes an unreachable state rather than a supported one. Two
`smart-model-turn.integration.test.ts` cases used the budget-less path to assert classify/effort
WIRING; they now pass a budget, which none of their assertions depend on.

### Pinned at both levels

- **The gate** (`trial-smart-model-candidates.test.ts`): a count that fits is admitted and the same
  count plus 5,000 instruction characters is refused. This is the auditors' case, at the schema's
  maximum instruction length.
- **The forwarding** (`smart-model-turn.integration.test.ts`): same catalog, same prompt, two
  budgets differing only in `promptCharacterCount` → buildable and then not. **Verified
  non-vacuous:** under the old local recount both calls would count ~1,750 characters and both
  would build, so the pin fails if the forwarding is reverted. The model is priced at 2,000n input
  / 1,000n output so the count binds rather than the physical window.

---

## FINDING 2 [Minor] — the lint gate, and how I got it wrong

Reproduced exactly: `npx eslint src/affordability` from `packages/shared` exited **1** on a prettier
error at `smart-model-affordability.ts:37`, where removing `outputCharsPerTokenForTier` left a
two-member import prettier wants on one line. Fixed with `eslint --fix` from the package directory.

**The process failure, stated plainly:** my last shared-package edit came *after* my last
shared-package lint. I linted shared, then deleted that import member, then linted only the api
files and reported exit 0 for both. That is the re-lint-after-the-final-edit rule failing in the one
way it always fails — the final edit was in a different package from the last check.

Every lint verification in this report captures the exit status **directly** on the eslint command,
with output redirected to a file rather than piped, because a pipeline reports the last stage's
status and prints 0 regardless:

```
npx eslint <files> > out.txt 2>&1
echo "EXIT=$?"        # a separate statement, nothing piped
```

---

## FINDINGS 3, 5, 6 [Minor] — falsified comments and a cancelling assertion

- **3** — `smart-model-execution.ts`: the module docblock's "candidates arrive sorted ascending by
  price, so the cheapest — the fallback — is the first entry, and it doubles as the classifier
  model" is now two separate facts, and the deps comment "(by construction the cheapest candidate)"
  is retired. The order is `maxCallCost`, and the engine rides a prompt-independent combined rate, so
  it is neither the first candidate nor necessarily a candidate. Both replacements state what the
  code guarantees — the fallback resolves *within* the candidate list, which is what keeps it inside
  the priced MAX — rather than quoting a neighbouring quantity.
- **5** — `tier-gate.ts`'s `{@link trialPriceThresholdNanoUsd}` pointed at an export the premium
  collapse deleted; it now names the money layer's `premiumPriceThresholdNanoUsd`.
- **6** — `trial-eligibility.test.ts` asserted `toBe(2_005_000n + X − X)`. Now `toBe(2_005_000n)`,
  with the contrast left to the neighbouring `toBeLessThan(2_005_000n + storageWouldHaveBeen)`.

## FINDING 4 [Minor] — the storage arm of the biconditional is disclosed and pinned

Disclosed: cycle 2 changed `smartModelMinimumRequiredNanoUsd` to pass its `storage` context into
`priceSmartModelPool`, so the threshold's pool order and outlier set are priced on the same basis the
caps are. §Smart Model 5 requires exactly that — client refusal ⇔ server refusal — and without it the
threshold ranked its pool on one basis while admission capped on another.

Pinned: a second sweep case runs the whole 201-point balance sweep with **no** storage context and
asserts the biconditional holds there too, plus `minimum(with storage) > minimum(without storage)`.
The inequality is the part that matters — it fails if the `storage` argument is dropped again, which
the previous single-mode sweep could not see.

---

## The classifier-storage figures, corrected upward

Your correction is right and I reproduced both numbers independently from the live snapshot, using
the ids and descriptions the builder actually renders:

| pool                                   | reserve chars | storage removed              |
| -------------------------------------- | ------------- | ---------------------------- |
| trial-eligible pool, n=81              | 15,291        | **7,044,900n = 0.704¢ — 70.4% of the 1¢ cap** |
| exposed text pool, n=176 (paid)        | 27,416        | **9,453,600n = 0.945¢**      |
| one candidate                          | 4,880         | 0.392¢                       |
| *my earlier synthetic basis, n=81*     | *10,162*      | *0.551¢ — the understatement* |

**The basis of the error, explicitly:** I measured with synthetic entries — ids of the form
`vendor/model-N` and a 48-character description each. The real catalog's descriptions have a median
of **219 characters** (38,479 across 176 models), so `classifierReserveChars` renders 50% more prompt
overhead than my fixture did. The one-candidate figure reproduced because a single short entry is
close to a single real one; the pool figures did not, and those are the ones that went to the
founder. Direction and safety are unchanged — the hold falls either way — but the trial number is the
headline: **a trial Smart Model send over the full eligible pool was reserving 70% of its entire
per-message ceiling for storage on a call that stores nothing.**

---

## Self-gate

Every exit status below is captured directly on the command, never through a pipe.

| command                                                              | result                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npx eslint src/affordability` (from `packages/shared`)               | **EXIT=0** after the final edit                                     |
| `npx eslint <9 changed api files>` (from `apps/api`)                  | **EXIT=0** after the final edit                                     |
| `pnpm test:shared`                                                   | **EXIT=0** — 127 files, 3,018 tests; coverage 99.9 / 99.46 / 100 / 100 |
| `npx vitest run --root packages/shared src/affordability`             | pass — 51 files, 1,346 tests                                        |
| `--root apps/api src/slices/{models,chat,workflows}`                  | pass — 98 files, 2,004 tests, 1 skipped                             |
| `npx tsc --noEmit -p apps/api/tsconfig.json`                          | clean                                                               |
| `npx turbo typecheck --force --continue`                              | 16/16 on my run (see below)                                         |
| coverage, the three api files changed this cycle                      | 100 on every axis (all three absent from the shortfall table)       |
| `pnpm test:api`                                                      | **EXIT=1 — 7 failed of 6,430, every one a known `template-html` snapshot** |

**On repo typecheck reading 15/16:** my run showed **16/16**, so the foreign
`packages/config/arch/rules/no-evidence-from-mocked-seam.rule.ts` was either absent or clean at the
moment I ran it. Not chasing it; recording only that I did not observe the failure rather than that
it does not exist.

**On `pnpm test:api`:** this cycle's run is the cleanest of the task and needs no attribution
argument beyond one entry. **469 files, 6,430 tests: 7 failed, all seven in
`notifications/domain/templates/template-html.test.ts`** — the concurrent push/notifications
workstream's snapshot entry, with both the template source and the `.snap` unmodified by this run.
Nothing else failed: no catalog-lock contention, no rate-limiter flake, and no coverage-merge crash
this time. `EXIT=1` is those seven snapshots and nothing else.

Two notes on that gate rather than on the code. The coverage table did **not** print, because vitest
skips the coverage report on any red run — the §Known Breakage entry that says a red `test:api` tells
you nothing about coverage. That is why the coverage evidence above is scoped runs over the files I
changed. And the upstream coverage-merge `ENOENT` crash hit 3 of 6 invocations across cycles 2–3
(zero `FAIL` lines each time — the process dies after the tests, inside the coverage provider); I
disproved the one hypothesis worth recording, since a run that left `apps/api/coverage` untouched
crashed too. The three slices this task touches were also run whole on the final source: **98 files,
2,004 tests, zero failures.**

---

## Corrections to earlier reports

- **Report 2's reachability claim is withdrawn.** "0 of 176 live models are inverted" was true but
  irrelevant: the band is `outputRate < 2.5 × inputRate`, which **20 of the 81** trial-eligible
  models satisfy, worst live overshoot 21.6% of the cap. The residual I described as needing an
  exotic rate shape was reachable on ordinary ones.
- **Report 2's residual is closed, not merely narrowed.** It said the trial Smart Model path "prices
  the system prompt but not custom instructions" and left it to lane C or B8. It now prices the
  route's own count, so both trial arms measure the same characters as the definitions they gate.
- **Report 2's classifier-storage figures (0.39–0.55¢ trial, 0.27–0.43¢ paid) are superseded** by
  0.704¢ and 0.945¢ above.

## Concerns

- **`buildTrialSmartModelTurnDefinition`'s `budget` is now required**, which is a signature change in
  a file granted to me "for the forwarding only". I judged it inseparable from the forwarding — the
  count cannot be forwarded from an optional value without either a fallback basis (the defect) or a
  silent refusal — but it is a scope call worth your eye, and it moved two assertions in
  `smart-model-turn.integration.test.ts`.
- **The gate and the definition now share one count, but nothing structurally forces that.** Both
  read `budget.promptCharacterCount`, and the forwarding pin catches a reversion of the trial arm
  specifically. A type that carried the count as a branded "the measured send" would make the whole
  class unrepresentable; that is a wider change than this task should make.

## Confidence

**High.** Finding 1's fix is pinned at the gate and at the forwarding, with the forwarding pin
verified to fail under the old behaviour; the other five are small and directly verified; and both
corrected money figures were re-derived from the live snapshot rather than accepted.
