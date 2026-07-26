# B2 — The dimension registry · impl-report-3 (fix cycle)

## Objective

Two validated findings from B2's re-audit, both corrections rather than rework: one wrong durable
comment asserting the per-token rate is §Smart Model 1's mandated candidate order (stated at two
sites), and one uncovered branch — the `moneyPerToken` arm of `cheapestPresentedOption`'s
bigint comparison. The re-audit confirmed all four prior fixes landed; nothing else was reopened.

## Files changed

| Path | Why |
| --- | --- |
| `dimensions/model.ts` | Docblock: states what the rate IS (the requirement's unit, computable from the catalog row alone) and drops the claim that it is §Smart Model 1's order; adds the negative fact that it is not that order, and that the pool's ranking basis belongs to whoever builds the pool. (Finding 1) |
| `dimensions/types.ts` | Same correction on `ReserveContribution`'s docblock, where the claim was restated. (Finding 1) |
| `dimensions/derive.test.ts` | One new assertion covering `cheapestPresentedOption`'s `isNanoUsdResource` true-branch on a rate-denominated dimension. (Finding 2) |

No production behaviour changed — findings 1 and 2 are a comment and a test. Nothing outside
`packages/shared/src/affordability/dimensions/` was opened.

**`estimate/smart-model-affordability.ts` was not touched.** It is B5's (the plan now assigns it
the ordering-basis fix), and its mtime is unchanged at `07-23 22:49` while this cycle's edits are
`07-26 05:22`–`05:26`. F2's files (`affordability/billing/funding-decision.ts`,
`client-billing.ts`, `chat/domain/turn-context.ts`, `billing/domain/spendable.ts`) were not opened
either. `registry.test.ts:120`'s stale test name was left for the close batch as instructed.

**One mtime that needs explaining:** `dimensions/derive.ts` reads `07-26 05:24` because the two
mutations below were applied to it and then restored from a byte-copy taken before the first
mutation. `diff` against that copy prints nothing (`IDENTICAL`), so the shipped content is the
audited content; only the timestamp moved.

## Finding 1 — the wrong ordering claim, before and after

### `dimensions/model.ts`

**Before** (lines 10–14):

```
 * Its requirement is the model's combined billable per-token RATE, declared as
 * the `moneyPerToken` resource. That is the balance-independent,
 * prompt-independent total order §Smart Model 1 mandates — the reason the pool
 * and the classifier's option order are reproducible from the catalog and the
 * prompt size alone, never from database row order.
```

**After:**

```
 * Its requirement is the model's combined billable per-token RATE — input plus
 * output — declared as the `moneyPerToken` resource. A requirement is
 * denominated in its dimension's resource, and the rate is the nano-USD quantity
 * this layer can state: a property of the model's own catalog row, needing
 * neither a balance nor a prompt to compute.
 *
 * The rate is NOT the candidate order of §Smart Model 1. That order is on turn
 * cost with an identifier tiebreak — §Predicates fixes the quantity as
 * `maxCallCost(m)`, whose input leg is prompt-weighted, whose output leg carries
 * storage, and whose ceiling is capped per model — none of which a rate carries.
 * Which quantity a candidate pool ranks by belongs to whoever builds the pool,
 * not to this entry.
```

The paragraph that follows is unchanged and is what still states why the field exists at all: the
amount does not exist at this layer, because `cost(m, ceiling(m))` needs a ceiling that depends on
funding the registry does not hold — so the resource is a rate, and the distinct kind stops it
reaching a hold as money. That is why the NEEDS_CONTEXT trigger did not fire: removing the ordering
claim leaves the docblock with an intact purpose statement (the requirement's unit, plus the
circularity that forces it to be a rate), not a field with no stated reason.

### `dimensions/types.ts` (`ReserveContribution`, lines 171–172)

**Before:**

```
 * open dimension (§The hold). The rate's own role is the balance- and
 * prompt-independent total order the candidate pool is ranked by.
```

**After:**

```
 * open dimension (§The hold). The rate's own role is to be the requirement's
 * unit — a per-token number computable from a catalog row alone. It is not a
 * turn cost, and it is not the candidate order of §Smart Model 1, which is on
 * turn cost (`maxCallCost`) with an identifier tiebreak.
```

**No replacement ordering claim was written.** Both sites now say only what the rate is, plus the
negative fact that it is not that order — the positive question (does the pool rank by rate or by
`maxCallCost`) is left entirely to B5, which the plan now assigns it. Neither site says what the
pool ranks by.

**Sweep for further propagation.** `grep` over `packages/shared/src/affordability` for
`total order|ranked by|prompt-independent|balance-independent` outside tests returns four hits, all
in `estimate/smart-model-affordability.ts` (`:9`, `:16`, `:96`, `:414`) and all about the
balance-independent **threshold** and cost basis, not about the rate being an order. B5's file, and
not the same claim — left alone. The two sites corrected here were the only carriers.

## Finding 2 — the uncovered `moneyPerToken` comparison branch

**Baseline, reproduced before editing.** `derive.ts` at 99.06 stmt / 97.01 branch with uncovered
`158,273` across the four `dimensions/**` test files.

**New assertion** (`derive.test.ts`, in the `cheapestPresentedOption` describe):

```ts
it('compares a nano-USD rate requirement as a bigint', () => {
  // The presented shape of an OPEN model dimension: one option per pool
  // candidate, each carrying its own combined per-token rate. `moneyPerToken`
  // is the resource whose requirement reaches this comparison as a bigint
  // rather than as a widened token count.
  const pool = defineDimension({
    ...EFFORT_DIMENSION,
    resource: 'moneyPerToken',
    costClass: 'additive',
    requirement: (_model, option) => {
      if (option === 'low') return 900n;
      if (option === 'medium') return 5000n;
      return 12_000n;
    },
  });
  const support = dimensionSupportFor(pool, effortModel);
  // The cheapest rate is neither the first option presented ('off') nor the
  // first by id ('high'), so only the comparison itself can produce it.
  expect(cheapestPresentedOption(pool, effortModel, support)).toBe('low');
});
```

The fixture is the real shape of an open model dimension: a multi-option support whose options
carry distinct per-token rates (the union of a candidate pool's self-options). `MODEL_DIMENSION`
itself cannot serve — each model offers exactly one option, so the comparison loop would be empty
and the branch would be reached without being exercised. The rates are deliberately
non-monotonic in both declaration order (`off` first) and identifier order (`high` first), so
`'low'` is producible only by the bigint comparison.

### Watched red under two mutations, not merely added green

An uncovered branch replaced by an unfalsifiable test buys nothing, so both halves of the branch's
job were mutated:

1. **The comparison direction** — `candidate.requirement < best.requirement` → `>`:

   ```
   × compares a nano-USD rate requirement as a bigint
   AssertionError: expected 'high' to be 'low' // Object.is equality
   Tests  6 failed | 51 passed (57)
   ```

   (five pre-existing `cheapestPresentedOption`/fallback pins fail alongside it, as expected —
   they share the comparison.)

2. **The branch selector** — `isNanoUsdResource` narrowed to `spec.resource === 'money'`, which
   sends a rate requirement down the `BigInt(requirementAsNumber(...))` arm:

   ```
   TypeError: dimension 'effort': a non-money requirement must be a number
   × compares a nano-USD rate requirement as a bigint
   Tests  1 failed | 56 passed (57)
   ```

   The new test is the **only** test in the file that fails here — it is the sole guard on the
   `moneyPerToken` arm of line 273.

Both mutations were reverted from a byte-copy taken before the first; `diff` against that copy is
empty.

**After:** `derive.ts` 99.06 stmt / **98.5 branch** / 100 fn / 100 line, uncovered `158` only.
Line 158 is `if (worst <= 1) return heldCeilingTokens;` in `deliveredCeilingTokens` — a
number-resource defensive line, not part of either finding, and left alone (branch coverage is
above the 95% gate without it).

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo test --filter=@hushbox/shared --force` | **pass** — 115 files, **2807** tests (2806 + the new assertion), coverage gate green. `affordability/dimensions` 99.43 stmt / 99.02 branch / 100 fn / 100 line; `model.ts`, `types.ts` 100 across the board. |
| `npx turbo typecheck --filter=@hushbox/shared --force` | **pass** — 0 errors, uncached. |
| `npx eslint src/affordability/dimensions/{model.ts,types.ts,derive.test.ts}` from `packages/shared` | **pass** (exit 0), run **after** the last edit. |
| `npx vitest run src/affordability/dimensions/derive.test.ts` (while iterating) | pass — 57 tests. |

One lint error was hit and fixed on the way: `unicorn/numeric-separators-style` rejected `5_000n`
(under this rule's minimum-digits threshold), so the literal is `5000n`. Caught only because the
lint ran after the final edit, which is the point of that constraint.

Repo-wide typecheck was **not** re-run this cycle: no type, schema, or cross-package contract
changed — the diff is two docblocks and one test assertion — so Global Constraint 10's sweep has no
trigger. Constraint 3 (bigint money), 5 (one implementation), 6 (content-free), 8 (no plan ids in
shipped code) are unaffected by a comment and a test; the new test's comments name no task.

## Acceptance criteria

Both findings are corrections to work already accepted against B2's criteria; the criteria they
touch:

| Criterion | Status | Evidence |
| --- | --- | --- |
| The `moneyPerToken` contract (as corrected in the plan) — the rate's only legitimate role is the requirement's unit; nothing ranks by rate on its strength | **met** | Both docblocks now state exactly that and explicitly disclaim the ordering role; the sweep above shows no other carrier of the old claim inside the module. |
| Derived, with a test each — the failure fallback as the cheapest presented option | **met, now on every resource** | The fallback's bigint path is pinned for the first time; falsified under two independent mutations. |

## Deviations, with reasons

1. **The docblocks carry a negative claim ("the rate is NOT §Smart Model 1's order"), not silence.**
   The finding forbids replacing the sentence with a *different ordering claim*; a bare deletion
   would leave the next reader free to re-derive the wrong claim from the same suggestive
   `ordered: true` + rate combination, which is how the original defect propagated into the plan.
   The negative is derivable from §Smart Model 1 + §Predicates alone and settles nothing B5 owns.
2. **The synthetic dimension declares `costClass: 'additive'`, not `'partition'`** (spreading
   `EFFORT_DIMENSION` would keep `partition`). `cheapestPresentedOption` never reads `costClass`,
   so it is immaterial to the assertion — but `moneyPerToken` + `partition` is a declaration no
   real dimension would make, and a fixture that mirrors `MODEL_DIMENSION`'s own pairing is the
   honest one.

## Concerns and limitations

1. **The corrected wording from impl-report-2 is carried here:** the distinct `kind` makes a wrong
   consumption **unreachable by accident**, not unrepresentable. A deliberate
   `hold += c.nanoUsdPerToken` under the `moneyPerToken` arm still typechecks, because both arms
   carry a raw `bigint`. impl-report-2's "now a type error at the `kind === 'money'` narrowing" was
   true only of accidental consumption and should be read as superseded by this sentence.
2. **The rate's role is still asserted only in prose, and now deliberately so.** `MODEL_DIMENSION`
   has no production consumer, and the one executable claim that could have been made here — what
   the pool ranks by — is B5's to make. Until B5 lands, nothing pins that the pool is not ranked by
   rate; the live `estimate/smart-model-affordability.ts` still sorts by summed rates, tiebreak-free.
3. **Line 158 of `derive.ts` remains uncovered.** Named in the finding's v8 output but not in the
   finding itself; per-file branch coverage is 98.5% without it. Flagged, not fixed.

## Confidence

**High.** The comment correction was derived from §Smart Model 1, §Predicates and §Cost directly and
its before/after is quoted in full for re-derivation; the propagation sweep is grep-complete inside
the module. The new assertion was falsified under two independent mutations, one of which no other
test in the file catches, and the mutated file was restored to a byte-identical copy. The shared
suite is green at 2807 tests with the coverage gate on, typecheck is clean uncached, and lint is
exit 0 after the final edit.
