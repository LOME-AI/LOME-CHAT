# impl-report-2 — Smart Model affordability: two reverse-biconditional findings

**STATUS: DONE_WITH_CONCERNS.** Both findings investigated to the money level. Finding 1's
diagnosed break does **not** exist in the real admission flow — the reverse biconditional
(client-deny ⇒ server-deny) already holds exactly; I added guard tests that pin it end to end
(including through the real run estimator) for the exact scenario the finding names, and did
**not** make the literal change because it would instead break the *forward* direction
(client-admit/server-deny). Finding 2's divergence is **real**; single-sourcing it pulls in the
broad tier-derivation surface (`getUserTier` → premium access, whole client billing resolution),
so per the brief I STOP and report specifics rather than sprawl. No source/money-formula changed.

## Objective

Make the Smart Model client==server affordability biconditional exact in the reverse direction
(client-deny ⇒ server-deny) for the two validated money-panel findings.

## Finding 1 — classifier-reserve basis (client vs estimator)

### What I found (the diagnosis is benign)

The premise "the client threshold prices the classifier reserve over the FULL pool while
`estimateSmartModelNode` prices it over the ELIGIBLE subset ⇒ the client denies a config the
server would admit" does not hold against the real flow:

- **The runtime classifier's menu IS the eligible subset.** `smart-model-execution.ts:191`
  renders the classifier prompt over `node.candidates` (the eligible subset). So the estimator
  pricing its reserve over `node.candidates` (`estimate-run.ts:499-533`) is **correct** — it
  matches what the classifier actually costs at runtime. It is not a drift; it is the truth.
- **The client threshold and the actual 402 pre-gate share one basis.** Both
  `smartModelMinimumRequiredNanoUsd` (client) and `admitSmartModel` non-null (the server
  pre-gate that returns `buildable:false` → 402 in `buildSmartModelTurnDefinition`) call
  `priceSmartModelPool(fullPool)` and price the classifier reserve over the **full pool** with
  identical math. Algebraically `admitSmartModel` is null ⟺ `balance < smartModelMinimumRequiredNanoUsd`.
  So **client-deny ⟺ server-deny is already exact** (both edges), independent of the estimator.
- **The estimator only ever holds *less*.** Since the eligible subset ⊆ full pool,
  `classifierReserve(eligible) ≤ classifierReserve(full)`, so the estimator's hold
  `≤ R ≤ balance` whenever `admitSmartModel` is non-null. The smaller hold never causes a deny
  the client did not predict. The forward direction (client-admit ⇒ server-admit) holds too.
- **`admitSmartModel.reserveNanoUsd` (R) is not consumed** by any hold logic (grep: only set/
  returned, never read for admission). The actual hold is the estimator. So R being priced over
  the full pool while the estimator prices over the eligible subset is a documentation
  imprecision in impl-report-1 ("estimator hold == R"), not a money bug — R over-states, the
  estimator holds the smaller, correct amount, and `estimator ≤ R ≤ balance`.

### Why I did NOT apply the literal fix

Lowering the client threshold to the eligible-subset basis (the finding's instruction) would
make the client threshold **lower** than the `admitSmartModel` pre-gate (which stays on the full
pool). For a balance in `[eligibleThreshold, fullPoolThreshold)` the client would then ACCEPT
while `admitSmartModel` returns null → **server 402 (client-admit/server-deny)** — the dangerous
direction. Making it safe would require simultaneously rewriting `admitSmartModel`'s eligibility
gate to a fixpoint/greedy over the eligible-subset reserve (money-critical, oscillating map),
which is unnecessary because the reverse biconditional already holds.

### What I delivered (TDD: attempted to reproduce the break, could not)

Guard tests pinning the exact biconditional for the scenario the finding names ("a catalog where
the full pool's cheapest classifier differs from the eligible subset's"), i.e. the full-pool
cheapest (the classifier) is itself **ineligible** and thus absent from the eligible subset the
estimator prices:

- `smart-model-affordability.test.ts` — new `describe('biconditional holds when the eligible
  subset ⊊ the full pool')`: (a) the ineligible cheapest stays the classifier but is excluded
  from `candidates`; (b) admit at exactly `smartModelMinimumRequiredNanoUsd`, refuse one nano
  below (both edges exact); (c) a balance sweep asserting `serverAdmits === clientAffordable`.
- `estimate-run.test.ts` — new `describe('the run estimator (eligible-subset reserve) never
  exceeds the client threshold')`: crosses the **real** `estimateSmartModelNode` — builds the
  node via `buildSmartModelCandidates`, runs `createEstimateRun`, and asserts (a) refuse one nano
  below the client threshold / admit at it; (b) the classifier stays the ineligible `tiny` while
  `candidates` excludes it (a two-candidate eligible subset when well funded); (c) the estimator
  hold `≤` the admitted balance at the boundary and when well funded (no unpredicted 402).

These pass (see self-gate), which is the evidence the diagnosed break does not exist.

## Finding 2 — client tier vs server payer-funding tier

### Determination: they CAN diverge (verified numerically)

- Client: `useUserTierInfo` → `getUserTier` decides `paid` iff `balanceCents > 0`, where
  `balanceCents = nanoUsdToCents(purchased.balanceNanoUsd)` and `nanoUsdToCents` is
  **bigint truncation** (`Number(nano / 10_000_000n)`).
- Server (solo): `senderPayerWallet` (`turn-context.ts:275`) sets `funding.kind='purchased'` iff
  `purchased.balanceNanoUsd > 0n`, and `tierForFunding` (`turn-definition.ts:189`) maps
  `purchased → paid`.

For purchased balance ∈ **[1, 9_999_999] nano** (0 < balance < 1 cent): client sees `balanceCents=0`
→ tier **free**; server sees `> 0n` → tier **paid**. Confirmed with a probe across
`{1, 5_000_000, 9_999_999}` nano — all diverge; `10_000_000` (1 cent) and `0`/negative agree.

This flips both tier-sized inputs: the storage ratio (`outputCharsPerTokenForTier`: 2 paid vs 4
free) **and** the effective-balance basis (free allowance vs purchased + $0.50 cushion),
producing a **client-stricter** verdict (client-deny while server admits) in that regime — a
violation of the reverse biconditional. (Note: `client-paid ⟹ balance ≥ 1 cent ⟹ server-paid`,
so the brief's feared client-accept→402 direction does NOT arise from this signal; the violation
is the reverse-edge, client-deny/server-admit.)

### Resolution: single-source sprawls → STOP and report (per brief)

The correct single-source is to make the client's paid/free decision use the **nano** signal
(`balanceNanoUsd > 0`), matching the server's `senderPayerWallet`/`tierForFunding`. That means
changing `getUserTier` (`packages/shared/src/tiers.ts`), whose output feeds far beyond the
Smart Model storage context:

- premium access (`canAccessPremium`, `canUseModel`) — a <1¢ balance would flip to premium;
- the entire client billing resolution (`useResolveBilling`, allowance-vs-purchased balance
  basis, cushion) — not just the storage threshold.

A storage-tier-only fix in `use-prompt-budget.ts` (deriving the ratio from `purchased.balanceNanoUsd
> 0n`) would (1) create a **second** tier derivation on the client (violating One-Implementation-
Shared) and (2) still not fix the balance-comparison divergence, so it would not restore the
biconditional. Per the brief's explicit guidance, I STOP and report rather than sprawl.

## Files changed (tests only — no source/money-formula change)

- `packages/shared/src/estimate/smart-model-affordability.test.ts` — +1 describe (3 tests):
  exact biconditional when the eligible subset ⊊ full pool with the ineligible cheapest as
  classifier.
- `apps/api/src/slices/models/domain/estimate-run.test.ts` — +1 describe (3 tests): the same
  biconditional crossing the real run estimator; estimator hold ≤ admitted balance / client
  threshold.

## Tests added

- shared `biconditional holds when the eligible subset ⊊ the full pool` — pins classifier-basis
  difference does not open a client/server gap. Covers the finding's requested test.
- api `the run estimator (eligible-subset reserve) never exceeds the client threshold` — pins
  no unpredicted 402 through the actual estimator.

## Self-gate (coverage-free / DB-free, per instruction; `test:X -- <filter>` triggers global coverage that spuriously fails on unrelated schema files)

- `turbo typecheck lint --filter shared,api,web` — **pass** (exit 0; fixed 2 lint nits in my
  api test: multiline type import → single line, `.map(fn)` → `.map(x => fn(x))`).
- shared `smart-model-affordability.test.ts` — **pass** (20 tests, incl. 3 new).
- api `estimate-run.test.ts` — **pass** (69 tests, incl. 3 new).
- api `smart-model-candidates.test.ts` + `smart-model-turn.test.ts` — **pass** (56).
- web `use-prompt-budget.test.ts` — **pass** (47).

## Acceptance criteria

- **Reverse biconditional (client-deny ⇒ server-deny) exact** — MET (already held; now guarded
  by tests at both the shared gate and the real estimator, incl. eligible⊊fullPool).
- **Finding 1 fix (align client classifier-reserve basis)** — NOT APPLIED; the literal change is
  unsafe (breaks forward direction) and unnecessary (biconditional already exact). Delivered the
  guard test the finding requested instead. RAISED.
- **Finding 2 tier agreement** — diverges; single-source sprawls → STOP and report per brief.
  NOT APPLIED. RAISED for orchestrator ruling.

## Money invariants (brief checklist) — all preserved (no source change)

reserve ≤ effective balance (all tiers) · exact estimator identity
(`candidateCost == estimateRunCeilingNanoUsd`) · storage folded into cap · **no under-reserve**
(new api test pins `estimatorHold ≤ balance`) · high-balance concurrency (existing test) · one
shared implementation · nano bigint, no `Number()` coercion. None regressed — I added tests only.

## Concerns / RAISED

1. **Finding 1's premise appears incorrect.** The client threshold and the actual 402 pre-gate
   (`admitSmartModel`) share the full-pool basis, so client-deny ⟺ server-deny is already exact;
   the estimator's eligible-subset reserve only shrinks the hold (`≤ R ≤ balance`). The literal
   fix would break client-admit ⇒ server-admit. Orchestrator/panel should confirm my reading or
   direct otherwise. Evidence: `smart-model-execution.ts:191`, `smart-model-candidates.ts:218`,
   `turn-definition`/`buildSmartModelTurnDefinition` gate, new passing guard tests.
2. **impl-report-1 wording:** "the admission estimator's hold equals R" is imprecise — R (full
   pool) over-states; the estimator holds the smaller eligible-subset amount. Safe (`estimator ≤
   R ≤ balance`), and R is unconsumed. Not a money bug.
3. **Finding 2 is a real reverse-edge violation** for purchased balance ∈ (0, 1 cent). Fixing it
   correctly requires a broad `getUserTier` change (nano signal) touching premium access and the
   whole client billing resolution — beyond the smart-model files. Needs an orchestrator ruling:
   approve the broad single-source, or accept the divergence in this sub-cent regime.

## Confidence

High on the analysis (numerically probed, guard-tested, cross-checked against the real runtime
classifier menu and the estimator). Medium on process fit: I intentionally did not apply either
finding's literal code change — Finding 1's would be unsafe, Finding 2's sprawls — so the
orchestrator/panel must reconcile this with the findings' validated status.
