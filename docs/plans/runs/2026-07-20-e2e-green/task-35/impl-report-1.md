# Task-35 impl-report-1 — Smart-Model admission reserve: context-bounded, BALANCE-INVARIANT (money keystone)

## Objective

Make the Smart-Model admission reserve balance-INVARIANT and context-bounded (legacy
magnitude), so a rich wallet no longer reserves ≈ its whole balance for one in-flight run
(the real chat-402 flood). Fix is confined to the PRICED candidate set and a binary refuse
gate; no settlement/ledger/admission-script change.

## Confirmed diagnosis (empirically, this session)

Reproduced the balance-scaling on current code with a laddered catalog (cheap classifier +
three text models whose realistic floors ladder across balances), no-budget path, priced by
the real `createEstimateRun`:

```
$1:      candidates=a/cheap                      estimate=58227          (~$0.00006)
$100:    candidates=a/cheap,m/a                  estimate=57500012238    (~$57.5)
$1000:   candidates=a/cheap,m/a,m/b              estimate=575000012248   (~$575)
$10000:  candidates=a/cheap,m/a,m/b,m/c          estimate=5750000012259  (~$5750)
$100000: candidates=a/cheap,m/a,m/b,m/c          estimate=5750000012259  (saturated)
```

Root cause exactly as the plan states: `node.candidates` was the balance-scaled `affordable`
subset (`smart-model-candidates.ts` filter `balance >= reserve + ceiling`). The estimator
(`estimateSmartModelNode`) takes MAX over `node.candidates`; as the wallet grows the filter
admits more/pricier/larger-context models, so the MAX climbs toward the balance. Legacy
classified FIRST and priced ONE model → context-bounded, balance-invariant.

## The balance-independent menu chosen + why it matches legacy magnitude

`node.candidates` is now the **full priceable engine-text pool** — every `isEngineTextModel`
descriptor whose `turnCeilingNanoUsd(...)` is defined (priceable + has a context window),
independent of balance. No new constant added; it is the same "engine-text/pool" set the UI
already advertises the Smart-Model price range over (`isPriceableTextDescriptor` in
`list-models.ts`). Because the set is fixed, the estimator's MAX prices ONE context-window
worth of the single priciest candidate — the same magnitude legacy reserved by resolving one
model. In the real PAID path (budget present) `answerMaxOutputTokens` caps the answer leg for
well-funded wallets, so the realised hold is the normal-answer ceiling (~$1–2), invariant
across all well-funded balances; the cost-circuit (hold×K=5) still backstops well clear of a
normal answer's cents.

Affordability is now a **single BINARY refuse gate** (reuses the existing `null →
buildable:false` channel): the turn is refused only when NO candidate is affordable at its
realistic floor (a genuinely under-funded wallet). Balance decides pass/refuse, never the
SHAPE of the menu. A modestly funded wallet that clears the gate but cannot cover the priciest
candidate is refused later by ADMISSION on the bounded (not balance-tracking) reserve — a 402
that places no hold, so it does not linger and refuse subsequent sends (the flood mechanism).

## Files changed

- `apps/api/src/slices/models/domain/smart-model-candidates.ts` — `buildSmartModelCandidates`:
  replaced the balance-scaled `affordable` filter (which became `node.candidates`) with a
  balance-independent priceable `menu` + a binary `some()` affordability gate; `candidates`
  now maps the full `menu`. Rewrote the file header doc and the `promptInputTokens` field doc
  to describe the balance-independent menu + binary gate (the old text described a filter that
  no longer exists — a wrong comment left in place would be worse than none). Classifier
  selection (`sortedText[0]`) and the unpriceable-classifier `null` guard are unchanged.
- `apps/api/src/slices/models/domain/smart-model-candidates.test.ts` — removed the two tests
  that pinned the balance-scaled-subset semantics (`keeps a candidate affordable at exactly …`,
  `prices the affordability floor …`); added `stamps a balance-INDEPENDENT menu …` (coherence)
  and `refuses the whole turn (binary gate) …`. Dropped the now-unused `MINIMUM_OUTPUT_TOKENS`
  import.
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — added the money-keystone
  `Smart Model admission reserve is BALANCE-INVARIANT` describe (3 tests) driving
  `buildSmartModelCandidates → buildSmartModelTurn → createEstimateRun` over a laddered
  catalog through the no-budget path; added a local `priced()` descriptor helper and imports
  for `buildSmartModelCandidates`, `createEstimateRun`, `estimateRunCeilingNanoUsd`,
  `snapshotResolver`.

NOTE: the same source file carries pre-existing uncommitted changes to `turnCeilingNanoUsd`
(now takes `promptInputTokens`) and `classifierWorstCaseBaseNanoUsd` (widened `textCatalog`
type) — that is Task-15's input-leg work, NOT mine; I built on top of it and did not alter it.

## Tests added (name — behavior — criterion covered)

- `reserves the same amount at $100 as at $10 (invariant to balance)` — estimate invariance —
  criterion 5 (invariance). RED before fix.
- `reserves the same amount at $1000 as at $10 (invariant to balance)` — estimate invariance —
  criterion 5 (invariance). RED before fix.
- `bounds the reserve by a single model context-window ceiling, not the balance` — reserve <
  balance AND < 2× the priciest single-model full-context ceiling — criterion 5 (bounded, not
  ≈ balance).
- `stamps a balance-INDEPENDENT menu: the full priceable set, never a balance-scaled subset` —
  the stamped `candidates` do not vary with `balanceNanoUsd` — criterion 5 (coherence). RED
  before fix.
- `refuses the whole turn (binary gate) when the wallet cannot afford even the cheapest
  candidate` — under-funded wallet still refused (`null`) — criterion 5 (binary gate).

## RED → GREEN evidence

RED (before implementing, current code), the two invariance tests failed for the right reason
(estimate grows with balance):

```
× Smart Model admission reserve is BALANCE-INVARIANT > reserves the same amount at $100 as at $10
× Smart Model admission reserve is BALANCE-INVARIANT > reserves the same amount at $1000 as at $10
Tests  2 failed | 12 passed
```

The candidates-coherence test was also RED on current code (old code returned a partial subset
where the fix stamps the full menu).

GREEN (after implementing): `smart-model-candidates.test.ts` 13/13, `smart-model-turn.test.ts`
14/14.

## Cost-circuit / settlement confirmation

- No change to settlement, ledger, `charge.ts`, admission, admission-scripts, budget, or
  turn-definition. Money stays nano-USD `bigint`; no `Number()` coercion on money in the
  changed code (the two new `Number()` uses in tests are for `$`-label loop counters, not
  money math).
- Cost-circuit (hold×K=5) is untouched and still backstops on the now-bounded hold; because
  the hold is a bounded context-ceiling (not balance-tracking), a normal answer's cents stay
  far below the trip threshold (no false trips) while runaways are still killed.
- Settlement still charges the authoritative inline `usage.cost` regardless of the hold — the
  change affects only the admission GATE (reserve size / refuse), never the BILL. Negative
  balances remain legal (settlement is never balance-guarded).

## Self-gate (command — result)

- `npx eslint <3 owned files>` (from `apps/api`, after the LAST edit) — pass (exit 0).
- `npx turbo lint typecheck --filter=@hushbox/api --force` — pass (2 successful; `eslint .`
  is the authoritative prettier-as-eslint-rule gate; `tsgo --noEmit` clean).
- `pnpm test:watch smart-model-candidates.test.ts` — pass (13/13).
- `pnpm test:watch smart-model-turn.test.ts` — pass (14/14).
- Regression scope (unit): `estimate-run` + `estimate` + `list-models` +
  `trial-smart-model-candidates` + `smart-model-execution` — pass (160/160).
- Regression scope (integration, via `pnpm test:watch` env wrapper, infra up):
  `smart-model-turn.integration` 3/3; `chat/routes.integration` 156/156 (the multi-model
  candidate-membership + admission-201 assertions — the cross-suite polluted-catalog 402 risk
  did NOT materialise); `chat/settlement.integration` 57/57. `workflows/engine/
  smart-model.integration` is cassette-gated and skipped (2 skipped) — pre-existing, unrelated
  to this change.

## Deviations with reasons

- The plan's invariance test literal fundings are "$10/$100/$1000"; I built the invariance
  test on the NO-BUDGET path with a laddered catalog and compared $10/$100/$1000 reserves.
  Reason: with a budget present, `answerMaxOutputTokens` (owned by turn-definition, out of my
  scope and unchanged) independently shrinks/saturates the answer leg with funding, which
  would confound a pure candidate-set invariance assertion. The no-budget path isolates the
  candidate-set contribution (estimator uses full context), which is exactly what this task
  fixes, and it mirrors `buildSmartModelTurnDefinition`'s real omitted-budget branch. The
  RED→GREEN behaviour is faithful.

## Concerns and limitations (see RAISED in the return message)

- Stale cross-file comment I could not touch: `estimate-run.ts` lines ~383–384 assert "over
  the node's (affordable-subset) candidate list … a turn that passes the filter can never 402
  here." After this fix `node.candidates` is the full pool, not the affordable subset, so that
  invariant no longer holds by construction — a modestly funded wallet can clear the binary
  gate and still 402 at admission (by design: "genuinely under-funded refused", with no
  lingering hold). `estimate-run.ts` is outside my file ownership; the comment needs an update
  by whoever owns it.
- Product-behaviour shift (intended, plan-sanctioned): the reserve is now bounded to the
  priciest pool candidate's ceiling rather than the wallet. Wallets that genuinely cannot fund
  that bounded worst-case are refused at admission. In the real paid path this is ~$1–2 (answer
  leg capped), so real wallets are unaffected; the refusal is the correct, non-lingering
  replacement for the balance-tracking flood.

## Follow-up (coordinator request): estimate-run.ts JSDoc correction

Corrected the now-false `estimateSmartModelNode` JSDoc block in
`apps/api/src/slices/models/domain/estimate-run.ts` (prose only — no code touched). The old
text claimed the node prices "over the node's (affordable-subset) candidate list" so "a turn
that passes the filter can never 402 here." New text states the true post-fix behavior:
`node.candidates` is the balance-INDEPENDENT priceable pool, so the reserve (classifier
worst-case + MAX candidate ceiling) is a bounded, balance-invariant constant — and therefore
clearing the builder's binary affordability gate does NOT guarantee admission (a modestly
funded wallet below the bounded reserve is refused at admission by design — a 402 with no
lingering hold).

Re-verify:
- `npx prettier --check estimate-run.ts` — exit 0.
- `npx eslint <all 4 edited files>` (from `apps/api`) — exit 0.
- `npx turbo typecheck lint --filter=@hushbox/api --force` — typecheck task successful;
  the lint task FAILED, but SOLELY on `src/slices/billing/domain/payments.integration.test.ts`
  (unused import `billingPrincipalUserId`) — a pre-existing uncommitted change from a sibling
  billing task (Task-37 territory), OUTSIDE Task-35's ownership. Not mine; not touched; not
  fixed (per AGENT-RULES: ignore other agents' work). All four Task-35-owned/edited files lint
  clean individually.
- Task-35 tests still green: `smart-model-candidates.test.ts` 13/13, `smart-model-turn.test.ts`
  14/14.

## Confidence

high — root cause reproduced and fixed test-first; invariance/coherence/gate all RED→GREEN for
the right reason; broad regression scope (376 unit+integration tests) green; authoritative
`pnpm`-equivalent lint + typecheck clean.
