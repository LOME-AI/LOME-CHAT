# Task-03 impl-report-3 — Smart Model $0-wallet block: DIAGNOSIS APPEARS WRONG (NEEDS_CONTEXT)

## Objective (as briefed)
Fix a claimed correctness gap: the affordable-subset gate admits a $0 wallet when the
catalog contains a FREE ($0) text model (`classifierWorstCase = 0`, `floorNanoUsd = 0`,
`0 >= 0` admits → `minimumRequired = 0` → client shows "Using free allowance"). Prescribed
fix: block when `balanceNanoUsd <= classifierWorstCaseNanoUsd`, and make
`minimumRequiredNanoUsd > classifierWorstCaseNanoUsd`.

## Outcome
**No code changed. STOP → NEEDS_CONTEXT.** I could not reproduce the diagnosed bug; the
reproduction evidence contradicts every load-bearing premise of the brief, and the
prescribed fix would NOT make the failing e2e pass. Per AGENT-RULES ("do not implement a
fix for an error you cannot reproduce; stop and report the diagnosis appears wrong"), I
did not implement. All findings below are Verified this session.

## Why the diagnosed mechanism cannot occur (Verified)

1. **`floorNanoUsd` can never be `0`.** `estimateRunCeilingNanoUsd`
   (`packages/shared/src/estimate/run-ceiling.ts:199-201`) rejects a zero amount
   (`if (amount === 0n) return estimateErr(...)`), so `floorNanoUsd`
   (`smart-model-affordability.ts:137-155`) returns `undefined` for a truly-free model and
   the candidate is EXCLUDED from `priced`. A priced candidate with `floor = 0` — the brief's
   `item.floorNanoUsd = 0` — is unreachable.

2. **A free-only pool returns `null`, not an admit.** Empirically (ran `priceSmartModelPool`):
   `[free 0/0]` → `null`; `[free 0/0, cheap-paid]` → `classifierWorstCase=0`,
   `minRequired=353625`, `affordable(0n)=[]`. In every construction with a free model, the
   current code ALREADY blocks a $0 balance and `minimumRequired` is strictly positive. The
   `>=` filter does not admit a $0 wallet.

3. **The real failing catalog has NO free model.** I parsed the exact wire catalog the client
   received in the failing trace
   (`e2e/report/2026-07-23T09-05-09/failed/…insufficient-balance…/trace/resources/3f6f5d7bd…json`):
   207 models, cheapest text model `inclusionai/ling-2.6-flash` at `10/30` nano (combined 40);
   zero models priced `0/0`. The `smart-model` row itself is `10/30` and is excluded from the
   pool (`isSmartModel`). So the classifier is `ling`, `classifierWorstCase = 131123` nano
   (`0.0131` cents) — **not 0** — and `priceSmartModelPool(realPool)` returns
   `minimumRequired = 166773` nano (`0.0167` cents), `affordable(0n) = 0`. The current code
   already blocks a true $0 balance on the real catalog.

## The ACTUAL failure (Verified)

The failing user is NOT a $0 wallet. The `lowBalancePage` fixture
(`e2e/fixtures.ts:877-889`) zeroes only the purchased + free_tier WALLETS; it does not touch
the free-tier **daily allowance**. The trace's `/billing/balance` response
(`…/trace/resources/5fc6a2d2…json`) is:
`{"purchased":{"balanceNanoUsd":"0"},"free":{"balanceNanoUsd":"0"},"allowance":{"remainingNanoUsd":"50000000",…}}`
→ **the free-tier daily allowance is `50000000` nano = $0.05 (5 cents)**, not $0.

The client prices Smart Model at `minimumRequired = 166773` nano = `0.0167` cents (reserve +
CHEAPEST floor) and compares against `freeAllowanceCents = 5`: `5 + 1e-6 >= 0.0167` → true →
`free_allowance` → **admits** ("Using free allowance", Send enabled — exactly the trace's
`page-snapshot.txt`). This is the current code behaving correctly for its own pricing: a
5-cent allowance genuinely covers a 0.0167-cent floor.

**The brief's prescribed fix does not fix this.** Blocking when `balance <= classifierReserve`
(`0.0131` cents) does NOT block a 5-cent allowance (`50000000 > 131123`). The affordable
subset stays non-empty; client and server still admit. Legacy `findAffordableCandidates`'
pre-guard (`balance - classifierReserve <= 0`) likewise admits a 5-cent balance. So the
prescribed fix would leave the e2e red.

## The REAL root cause: client floor-pricing vs server worst-case admission (Verified)

The client and server DIVERGE, and the e2e catches it. Computed on the real catalog at
`balance = 50000000` (5 cents):
- **Client** prices Smart Model at `minimumRequired = 166773` nano (reserve + cheapest
  candidate FLOOR) → `166773 < 50000000` → **client ADMITS**.
- **Server admission** reserves the MAX full-context WORST-CASE ceiling over the affordable
  subset (195 candidates fit at 5 cents; `estimate-run` MAXes `modelCeiling`). That max is
  `42262500000` nano = **$42.26** (via `openai/gpt-5.5`, ctx 1.05M) → `42.26e9 > 50e6` →
  **server admission would REJECT (402)**.

This is precisely the asymmetry the brief's own "Hidden coupling (1)" note documents for the
prior Task-03 (`plan.md` §Task-03): *"filter uses turnCeilingNanoUsd floor … reserve uses
modelCeiling worst-case — a candidate can pass the floor yet be refused at admission
worst-case."* The server side honors it; the CLIENT preflight (report-1's
`minimumRequiredNanoUsd = reserve + cheapest floor`, `smart-model-affordability.ts:194-199`
and `use-prompt-budget.ts:355-367`) does NOT mirror the worst-case reserve, so the client
admits sends the server rejects. The e2e "insufficient balance blocks send" asserts the
client blocks — i.e. it expects client == server admission.

So the failing e2e is a **client/server admission divergence at a non-zero free allowance**,
not a "$0 wallet + free model" admit. Report-1's design (client prices at the cheapest floor)
assumed a $0 free-tier; the real fixture gives 5 cents of allowance, which the floor price
clears but the server's worst-case reserve does not.

## What a correct fix would require (a design decision — NOT made)

To make the e2e pass and keep client == server, the CLIENT must price Smart Model at the same
worst-case admission reserve the server uses (MAX full-context `modelCeiling` over the
affordable subset), not `reserve + cheapest floor`. That:
- redefines `minimumRequiredNanoUsd` semantics (money-sensitive; touches the report-1
  invariant and the well-funded-wallet case),
- directly contradicts the brief's prescribed fix and its "mirror legacy cheapest-floor"
  instruction,
- must be reconciled with the server so both price the SAME worst-case (One-Impl-Shared),
- needs the 2-auditor money panel the plan already flags for Task-03.

Alternatively, if free-tier users are *meant* to be able to run Smart Model within a 5-cent
allowance (the current client behavior), then the e2e expectation and/or the `lowBalancePage`
fixture (which fails to zero the daily allowance) is the thing that is stale — an e2e/fixture
fix, out of Task-03's bounds.

I did not choose between these: both are load-bearing, money-adjacent design calls above an
implementer's scope, and both contradict the brief.

## Files changed
None. (I created and then deleted a throwaway `_scratch-explore.test.ts` to run
`priceSmartModelPool`/`estimateRunCeilingNanoUsd` against the real catalog; it is removed —
`git status` shows only the pre-existing uncommitted report-1/2 work, none of it mine.)

## Self-gate
Not applicable — no source change. The reproduction "gate" (write the failing test, watch it
fail for the diagnosed reason) FAILED to reproduce: a free-model pool yields `null`/empty
subset (block), and the real catalog yields `minRequired = 166773 > 0` with `affordable(0n)=[]`
— the opposite of the diagnosed admit.

## Confidence
High that the brief's diagnosis is wrong and its fix would not green the e2e — every premise
was checked against the real failing trace's catalog and balance response. High that the real
cause is the client-floor / server-worst-case divergence at a 5-cent allowance (computed the
$42.26 worst-case reserve vs the $0.05 allowance directly). Medium on which resolution the
founder wants (price client at worst-case vs. fix the e2e/fixture) — that is the decision to
route back.
