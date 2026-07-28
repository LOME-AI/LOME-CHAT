# E1 — impl report 2 (partial: the funding seam closed; surfaces not started)

## Objective

Every client surface renders the produced `affordable` / `admissible` sets (text arm only, per
the 2026-07-27 ruling), premium rows MARKED not removed, and the client's second verdict engine
deleted.

## Status

**DONE_WITH_CONCERNS on a strict subset.** This cycle closed the funding seam — the item the
coordinator named as "the live defect you are closing" — and traced the `'0'`. The surface
rewrite (adapter hook, picker, effort menu, send gate, premium threading, engine deletion) is
**not started**. I am reporting at this boundary rather than half-landing a rewrite, because the
seam is independently correct and independently verifiable, and the surfaces all consume it.

---

## Where my `'0'` came from — three layers, and only the third is a defect

The coordinator asked me to trace this before building on it. I was wrong, and the correction
matters more than the blocker did.

**Layer 1 — it was my own fixture, not the endpoint.** My probe wrote `funding('free', 0n)` by
hand. I never called `/billing/spendable`. I reported an Inferred value as an observed one, and
it was relayed to the founder as fact. That is the primary error and it is entirely mine.

**Layer 2 — why I picked `0n`, which is the interesting part.** I traced `readSelfFunding` →
`resolveEffectiveSpendable` and then resolved the cushion against the **shared, tier-keyed**
helper `getCushionNano(tier)` in `estimate/pre-adapters.ts` — paid-only ⇒ free gets none ⇒ 0.
The server does not use that helper on this path. `admission.ts:101`
`spendableFor(balanceNanoUsd, type)` keys off **wallet type**, and `:105` maps
`type === 'purchased' → tier 'paid'` unconditionally, so a purchased wallet at balance 0 returned
`spendableFundsNanoUsd(0n, 'paid')` = **500,000,000n**. F3's finding exactly: the number keyed off
wallet type, the label off balance.

So I substituted one implementation of "what is this payer's cushion" for another and read a **10×
overstatement as a zero** — inverting the direction of the defect from unsafe to safe. The
substitution was only possible because the question had two implementations, which is the shape
Global Constraint 5 exists to forbid. F3's auditor recorded the same duplication class
independently ("remaining allowance today" derived twice). Worth stating plainly: **a
two-implementation defect can corrupt the diagnosis of an unrelated agent, not just the runtime.**

**Layer 3 — a client path really does manufacture `0n`, in three of my files.** Not the endpoint,
but real: `use-budget-calculation.ts:201`, `use-prompt-budget.ts:703` and
`use-resolve-billing.ts:40` all read `spendableData ? BigInt(...) : 0n`. That is the F1 defect
class E1 must re-pin ("the figure fell back to `0n` and greyed every affordable row for a
render"). **Both consumers currently defuse it with pending guards** — `useModelFloor` returns
`false` from `isBelowFloor` while `isPending`, and `computePromptBudgetDisplay` ORs
`isBillingLoading` into `hasBlockingError` — so it is latent, not live, today. It is a `0n` that
means "unknown", and the re-pin criterion is about keeping it defused through the rewrite. Not
closed this cycle; carried below.

## The live defect, shown wrong first then fixed

**Shared layer — `client-billing.ts`.** Red first, and the first attempt was **vacuous**: the
default fixture carried `freeAllowanceNanoUsd: 0n`, so the new test passed for the wrong reason
(`0n >= 20¢` is false either way). Discriminating input added — the hold-blind allowance set to
50¢ — and it went red the right way:

```
- { fundingSource: 'denied', reason: 'insufficient_free_allowance' }   expected
+ { fundingSource: 'free_allowance' }                                  received
```

A free payer with 50¢ of allowance, 40¢ reserved by their own in-flight run, was **offered** a 20¢
send that admission refuses. Green after the free arm moved onto the served hold-aware number.

**Client layer — `use-budget-calculation.ts`.** The composition F3's auditors warned must not be
read as gone. Red with a named amount:

```
sizes a free-tier turn on the HOLD-AWARE served allowance, not the balance endpoint
AssertionError: expected 15855 to be 3035
```

The hook sized the turn at **15,855** output tokens off `/billing/balance`'s hold-blind 50¢, where
the hold-aware served 10¢ funds **3,035** — a **5.2× over-offer**. Green after
`effectiveBalanceFor` dropped its free branch.

**The paid/free branch is now gone in both places.** What remains is the authentication boundary
(trial and guest are 403/401 at that route class by design), which is what the coordinator
specified.

## Files changed

| File | Why |
| --- | --- |
| `packages/shared/src/affordability/billing/client-billing.ts` | `freeAllowanceNanoUsd` input field deleted; paid and free collapsed onto one compare against the served spendable, tier-keyed only in vocabulary |
| `packages/shared/src/affordability/billing/client-billing.test.ts` | free-tier cases moved onto the served number; new hold-aware pin |
| `packages/shared/src/affordability/billing/client-billing.consistency.test.ts` | free-tier fixtures carry the allowance as the served spendable, cushion-free |
| `packages/shared/src/affordability/billing/funding-decision.contract.test.ts` | 12 inert `freeAllowanceNanoUsd: 0n` fixture lines removed (verdicts unchanged — all three free cases already carried `spendableNanoUsd: 0n` and a `0n` estimate) |
| `apps/web/src/hooks/billing/use-budget-calculation.ts` | free branch removed from `effectiveBalanceFor`; tier key narrowed |
| `apps/web/src/hooks/billing/use-budget-calculation.test.ts` | counterfactual "never the cushioned spendable" test retargeted (it mocked a response the corrected endpoint cannot produce); hold-aware sizing pin added |
| `apps/web/src/hooks/billing/use-resolve-billing.ts` | stops passing the balance-endpoint allowance; doc corrected |
| `apps/web/src/hooks/billing/use-prompt-budget.ts` | `useModelFloor` stops passing it; **falsified doc comment corrected** (see sweep) |
| `apps/web/src/hooks/billing/use-prompt-budget.test.ts` | six floor tests re-driven off the served figure, boundary pins (`floor` / `floor − 1n`) preserved; one fixture's stale 500,000,000n corrected |

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `free tier whose allowance is reserved by a run in flight → insufficient_free_allowance` | the free arm is hold-aware | "no surface derives funding from the balance endpoint" |
| `sizes a free-tier turn on the HOLD-AWARE served allowance, not the balance endpoint` | sizing reads the served figure, pinned by amount (3,035) | same |

## The vocabulary sweep

Applied per the standing rule — grepped the removed mechanism's vocabulary across owned files
rather than re-reading my diff. It found one thing my diff structurally could not:

- **`use-prompt-budget.ts:670`** — `useModelFloor`'s doc said `resolveClientBilling` runs "over the
  served spendable / **free allowance** / fixed trial arm". Falsified by the change, sitting six
  lines *above* the edited code. Corrected to state what the code now guarantees (one served
  number for every authenticated tier) rather than enumerating arms that can drift.
- `freeAllowance` elsewhere: `use-user-tier-info.ts:28` and `use-tier-info.ts:39` still read
  `balanceData.allowance.remainingNanoUsd` into `UserTierInfo.freeAllowanceNanoUsd`. **No
  production consumer reads that field any more** (grep: tests only). Not removed this cycle —
  see concerns.
- "double-cushion", "two endpoints", "allowance" as an affordability input: **nothing else found.**

## Self-gate

| Command | Result |
| --- | --- |
| `npx tsgo --noEmit` (packages/shared) | pass — `SHARED_EXIT=0`, captured on the command |
| `npx tsgo --noEmit` (apps/web) | pass — `EXIT=0`, captured on the command |
| `npx vitest run src/affordability/billing/` (shared) | pass — 4 files, 105 tests |
| `npx vitest run src/hooks/billing/` (web) | pass — 12 files, 238 tests |
| `npx eslint <5 changed web files>` (from apps/web) | pass — `WEB_LINT_EXIT=0` |
| `npx eslint <4 changed shared files>` (from packages/shared) | pass — `SHARED_LINT_EXIT=0` after one prettier fix |

Lint was run from each package directory after the final edit, on the set derived from
`git status`, with status captured on the command itself.

**Tooling note worth recording:** `npx tsc --noEmit -p tsconfig.json` reports an error in
`model-list-body.test.tsx` (`getPinnedLabel: () => {}` returning `void`) that `tsgo` — the actual
gate, per `apps/web/package.json` — does not. The two typecheckers disagree on that file. I nearly
reported it as a pre-existing break; it is not one against the real gate.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| No surface derives funding from the balance endpoint | **partially met** — the funding *figure* is now single-sourced everywhere; the dead `freeAllowanceNanoUsd` population in the two tier hooks remains |
| All greying from `affordable`; send gate from `admissible` | not started |
| Local verdict engine deleted, grep-clean | not started |
| Premium marked not removed; no premium access from the balance endpoint | not started |
| Typed reason as tooltip + accessible description | not started |
| Existential menu rule; pinning culls | not started |
| Hold vs balance pair, exactly one hold notice | not started |
| Intersection clamp retired | not started |
| Below-floor selected row de-selectable | not started |
| No text-modality pre-send cost figure | not started |
| Component tests (five named) | not started |
| Re-pin F1's defect class | not started — traced and confirmed still defused (layer 3 above) |
| `turnDimensions` empty on smart-slot-only turn | not started |
| Widen `usePromptBudget`'s return | not started |
| ~~Remaining trial message count~~ | struck 2026-07-27 |

## Deviations

- **`use-budget-calculation.test.ts`'s "gates free-tier affordability on the served allowance,
  never the cushioned spendable"** was retargeted rather than kept. Its premise — the endpoint
  serving 500,000,000n at `tier: 'free'` — is the pre-F3 bug; post-F3 the endpoint cannot produce
  it, so the test mocked a counterfactual. Its guard (a depleted allowance must refuse) is
  preserved; the hazard it named moved server-side and is pinned there by F3.
- Six `useModelFloor` tests changed their **driver** from `mockTierInfo.freeAllowanceNanoUsd` to
  `mockSpendable`. Assertions and boundary amounts are unchanged — this is the same behaviour read
  through the input that now carries it, not a weakened test.

## Concerns and limitations

1. **The bulk of E1 is not built.** Everything above is the input layer the surfaces consume.
2. **`UserTierInfo.freeAllowanceNanoUsd` is now populated from `/billing/balance` and read by
   nothing in production.** Removing the read means passing `0n` to `getUserTier` — which the
   server already does (`spendable.ts:271`, "the daily allowance never moves the tier"), so the
   tier answer cannot change. I left it because it touches two hooks and four test files that the
   surface work will rewrite anyway, and doing it now would conflict with that. Knip will flag it.
3. **The `: 0n` unknown-means-zero fallback survives at three sites**, defused by pending guards at
   both consumers. The F1 re-pin criterion covers it and is not yet done; if the rewrite drops a
   pending guard the flash-of-denial returns silently.
4. I have **not** re-verified the free arm against the running endpoint — F3 did that, and after
   this cycle I am deliberately not restating an endpoint's behaviour I did not observe.

## Confidence

**High** on what landed: both defects were shown red with named amounts (a wrong verdict, and
15,855 vs 3,035 tokens), both fixes are minimal, and every gate was run from the right directory
with captured status. **High** on the `'0'` trace — it is a code-path reading plus my own fixture,
not a reconstruction. **Not applicable** to the unbuilt majority of E1.
