# F7 — impl report 3 — DONE

## Objective

Two Minors from the cycle-2 audits, both of which the auditors passed:

1. Re-express the `minTurnCost` biconditional **through the exported producer** rather than a
   test-local re-composition of the ceiling solve, and add a **web-search** case.
2. Rewrite the `undefined` contract on `FundingInputs.minTurnCostNanoUsd`, which enumerated two
   shapes where four reach it and mis-described the Smart Model slot.

**No production behaviour changed this cycle.** The only two files touched are one test file and
one JSDoc block.

## Files changed

| Path                                                            | Why                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/affordability/min-turn-cost.test.ts`       | The biconditional now runs through `getTurnOptions`; the three test-local solve helpers are deleted; web-search case added; the `-1n` assertion now names the refusal reason. |
| `packages/shared/src/affordability/billing/funding-decision.ts` | The `undefined` docstring, rewritten as a rule. **Comment only** — proven below.                            |

## Finding 1 — the biconditional now asks the producer

### What was wrong

The middle and right steps ran `ceilingsFor` / `everySiblingEligible` / `holdFor` — a
**test-local arrangement** of `fixedCostsNanoUsd → budgetBuysTokens → ceilingTokens → eligible →
costNanoUsd`. Those are the production primitives, but not the production **arrangement**:
`priceArrangement` in `turn-core.ts` composes the same primitives, and nothing in the old file
reached it. A change to how the solve composes them left the pin green. The docstring's claim
("this is the production path, not a restatement of it") was therefore false in the way that
matters.

The old helper also hard-coded `additiveNanoUsd: 0n`, so a web-search case was not even
expressible — the one additive term the producer's own comment warns about was pinned by amount
only.

### What it is now

All three legs go through `getTurnOptions`, the one producer, and read the `admissible` set —
the set the send gate reads:

```ts
function optionsAt(input: MinTurnCostInput, fundingNanoUsd: bigint): TurnOptions {
  const models: NonEmpty<ModelId> = [
    input.siblings[0].modelId,
    ...input.siblings.slice(1).map((model) => model.modelId),
  ];
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(fundingNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: input.tier,
      payer: 'self',
    },
    basisOf(input.promptChars),
    {
      answerSources: { models, smartSlot: false },
      modality: 'text',
      pinned: {},
      webSearch: input.webSearch,
    },
    // The pool is the siblings themselves: too small to carry a price
    // threshold, and released at the epoch, so neither premium leg fires and no
    // tier-access refusal is confounded with the money one being pinned.
    { models: input.siblings, nowMs: PREMIUM_RECENCY_MS }
  );
}
```

The three assertions, each over six cases:

| Assertion                                                | What it reads                                    |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `funding equal to it leaves the turn sendable — $name`   | `optionsAt(input, minTurnCost).admissible.sendable === true` |
| `one nano below it refuses for want of money — $name`    | `set.sendable ? 'sendable' : set.refusal` is `'insufficient_funds'` |
| `the hold it buys never exceeds it — $name`              | `TurnOptions.holdNanoUsd ≤ minTurnCost`           |

Cases: one model · a trial turn (which stores nothing) · a free-tier payer · **a turn with web
search on** · a mandatory-reasoning model · siblings whose cheapest corners differ.

Two deliberate changes to the case list, both forced by the producer being the real thing:

- **`persists: false` is now expressed as `tier: 'trial'`.** The producer derives persistence
  from the tier (`tier !== 'trial'`), so a `paid`+non-persisting case would have had the two
  sides pricing different turns. The obligation is stated in `optionsAt`'s docstring, since no
  type carries it. The `paid`+non-persisting **amount** pin is untouched in the by-amount block.
- **The `classifierReserveNanoUsd: 12_345n` case is gone from the biconditional**, and the file
  records why: the producer DERIVES the reserve from the catalog and the open dimensions, so no
  case can hand it one, and handing it a figure computed in the test would be exactly the
  re-composition this change removes. Its **amount** stays pinned in the by-amount block
  (`adds the classifier reserve as a fixed term`).

### Evidence it discriminates

Three probes, each applied to a restored-byte-exact tree afterwards (`diff` clean, re-run green).

**Probe A — a change to the SOLVE's composition, which the old pin could not see.** In
`turn-core.ts`'s `priceArrangement`, `additiveNanoUsd` was dropped from `solveFixed`
(`additiveNanoUsd: 0n`) — the production primitives all unchanged, only how the solve composes
them:

```
× one nano below it refuses the turn — 'a turn with web search on'
× the hold it buys never exceeds it — 'a turn with web search on'
      Tests  2 failed | 22 passed (24)
```

The old pin could not have reddened on this at all: it never imported `turn-core`, so no change
to `priceArrangement` was observable from it. That is the finding, demonstrated.

**Probe B — the additive term dropped from `minTurnCostNanoUsd` itself:**

```
× adds the web-search reservation per sibling when the turn's search tool is on
× funding equal to it leaves the turn sendable — 'a turn with web search on'
× the hold it buys never exceeds it — 'a turn with web search on'
      Tests  3 failed | 21 passed (24)

AssertionError: expected false to be true // Object.is equality
```

The producer refuses the turn at a figure missing the search reservation. The biconditional pins
the exact boundary, so **any** dropped term reddens the `equal ⇒ sendable` side — the web-search
term is now load-bearing rather than merely asserted by amount.

**Probe C — vacuity of the `-1n` red.** A throwaway `PROBE` block printed the refusal code at
`minTurnCost − 1n` for all six cases (surfaced through a deliberately failing `toBe`), then was
deleted (`diff` against the pre-probe copy clean). Every case returned **`insufficient_funds`** —
vitest collapsed six identical `AssertionError: expected 'insufficient_funds' to be 'SHOW-ME'`
into one, which is itself the proof they agreed. The red arrives for the money reason, not
because a prompt got too long or a cap too low. That result is now an assertion rather than a
one-off observation: the `-1n` test asserts the code, which strictly subsumes `sendable === false`.

## Finding 2 — the `undefined` contract, rewritten

The old text named two reasons (a caller asking who would pay; a per-unit media generation) and
described the second as "the turn's shape has no per-token minimum to compare". Four shapes reach
`undefined` — the served-funding/premium-gate caller plus all three `UnpricedTurnReason` members
(`media-per-unit`, `smart-slot-pool`, `model-not-priceable`) — and the Smart Model slot **does**
have a per-token minimum (§Smart Model 5's balance-independent threshold); it is unreachable at
this seam, not absent. The replacement states the generating rule and keeps the instances as
illustrations of it:

```
  /**
   * `minTurnCost` — the least this turn could cost at the CANDIDATE PAYER's
   * tier, which the group headroom must cover for the owner to fund it (BILLING
   * §Funding Decision Matrix priority 1). Headroom that cannot cover the
   * minimum can never cover the turn, so a signed-in sender falls through to
   * personal funds and a guest is refused.
   *
   * `undefined` means the CALLER could not put a minimum on the table — never
   * that the turn has none. Two ways to reach it, and the second is a rule
   * rather than a list: the caller is not pricing a turn at all (the served
   * funding snapshot names the payer before a prompt exists, and the premium
   * tier gate asks the same question), or the turn's minimum is derived
   * somewhere this caller does not reach — a per-unit media generation, whose
   * unit parsing sits downstream; a Smart Model slot, whose threshold ranges
   * over a candidate pool the caller has not built; a selection nothing prices,
   * which the turn build refuses on its own. All of them leave priority 1's
   * comparison inapplicable, and it is deliberately not an amount: an
   * unreachable minimum must not be mistaken for a zero one.
   */
  readonly minTurnCostNanoUsd: bigint | undefined;
```

**Vocabulary sweep** for the falsified enumeration (`per unit`, `priced per unit`,
`who WOULD pay`, `no priced turn`, `unpriced turn`, `comparison inapplicable`) across
`packages/shared/src`, `apps/api/src`, `apps/web/src`: the enumeration existed only here. Three
hits are site-local and remain true — `turn-types.ts:174` (`modality_not_priceable`'s own
meaning), `spendable.ts:493` (the served-funding site explaining its own `undefined`), and
`turn-context.test.ts:574` (a media case, where "no per-token minimum" is accurate). The
`UnpricedTurnReason` members already describe themselves as reach rather than absence, so the
rewritten contract and the union now agree.

## No production behaviour changed

`git diff -U0` on `funding-decision.ts` filtered to non-comment lines returns only cycle 2's
field rename — this cycle added zero:

```
-  readonly turnEstimateNanoUsd: bigint | undefined;
+  readonly minTurnCostNanoUsd: bigint | undefined;
-function coversTurn(headroom: bigint, turnEstimateNanoUsd: bigint | undefined): boolean {
+function coversTurn(headroom: bigint, minTurnCostNanoUsd: bigint | undefined): boolean {
-  return turnEstimateNanoUsd === undefined || headroom >= turnEstimateNanoUsd;
+  return minTurnCostNanoUsd === undefined || headroom >= minTurnCostNanoUsd;
-    if (coversTurn(effective, inputs.turnEstimateNanoUsd)) {
+    if (coversTurn(effective, inputs.minTurnCostNanoUsd)) {
```

The other file is a test. `min-turn-cost.ts` and `turn-core.ts` were touched only by the probes
and restored byte-exact (`diff` clean against pre-probe copies, both verified).

## Self-gate

| Command                                                                                                     | Result                                |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `vitest run src/affordability/min-turn-cost.test.ts` (shared, isolated)                                     | **pass** — 24 tests, exit 0           |
| `vitest run src/affordability` (shared, isolated)                                                           | **pass** — 57 files / 1531 tests      |
| same + `--coverage.include` on `min-turn-cost.ts` and `billing/funding-decision.ts`, reports to a scratch dir | **pass** — 100% stmts / 100% branch / 100% funcs / 100% lines (34/34, 24/24, 11/11, 30/30) |
| `npx eslint src/affordability/min-turn-cost.test.ts src/affordability/billing/funding-decision.ts` from `packages/shared`, after the last edit | **pass** — exit 0 (one prettier error found and fixed first) |
| `npx eslint .` from `packages/shared`, after the last edit                                                  | **pass** — exit 0                     |
| `npx turbo typecheck --force --continue`                                                                    | **pass** — 16/16, 0 cached            |
| `npx tsx packages/config/arch/run.ts`                                                                       | **pass** — 13 rules over 2189 files   |

Every status was captured on the command itself (`cmd > log 2>&1; echo "EXIT=$?"`), never off a
pipeline. `pnpm test:api` and `pnpm ensure-stack` were not run, per the brief; the lint set was
derived from this cycle's own two edits, both in `packages/shared`, and the whole package was
linted as well.

## Deviations

None from the brief. Two judgment calls, both recorded in the file itself and above: the
classifier case leaves the biconditional (unexpressible through the producer, still pinned by
amount), and `persists: false` rides `tier: 'trial'` in the biconditional because the producer
derives persistence from the tier.

## Concerns and limitations

- **The biconditional's cases are single- and two-sibling, no smart slot.** The producer's
  smart-slot arm takes the `MAX` over candidate arrangements, which `minTurnCost` does not price
  at all — that shape is F14's (`smart-slot-pool` is still a typed exemption).
- **`holdAt ≤ minTurnCost` has real slack on the differing-corners case.** A probe that
  double-charged prompt storage in `costContextFor` did **not** redden it, because `MODEL`'s
  ceiling clamps at its 8,000-token provider cap while the funding pays for the 33,768-token
  widest corner. That slack is the widest-corner over-pricing already reported in cycle 2 (the
  `BILLING.md` correction the auditor verified), not a weakness introduced here — but it does
  mean the hold leg is a bound, not a tight one, on multi-sibling turns.
- **`optionsAt`'s tier/persists obligation is a comment, not a type.** `MinTurnCostInput` carries
  `persists` independently while the producer derives it; a future case that sets them
  inconsistently would silently compare two different turns. Stated where a case author reads it;
  collapsing the two would mean changing `minTurnCostNanoUsd`'s signature, which is production
  code and out of this cycle's scope.
- The production classifier reserve reaches `minTurnCostNanoUsd` from `routes.ts`
  (`pickEffortClassifier(…).classifierWorstCaseNanoUsd`) while the producer derives its own
  inside `turn-core`. Both are out of this cycle's two findings and neither was touched; noted
  only because the biconditional cannot cover that pairing from `packages/shared`.

## Confidence

**High.** Both findings are addressed at the level they were raised: the pin now fails when the
production solve's composition changes (probe A), the new web-search case is load-bearing rather
than decorative (probe B), the `-1n` red is proven non-vacuous and now asserts its reason (probe
C), and the rewritten contract is exhaustive against `UnpricedTurnReason` plus the served-funding
caller. No production line moved.
