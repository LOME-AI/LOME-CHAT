# E1 — impl report 12 (audit remediation: 2 Criticals, 4 Importants closed)

## Status

**DONE_WITH_CONCERNS.** Both Criticals and Importants 3–6 are closed, each shown red first and
each with an inversion. Minor 7 collapsed as predicted. The `pnpm test:web` gate result is recorded
below.

---

## CRITICAL 1 — the dead trial/guest funnel

`NO_ENDPOINT_FUNDING = {0n, 0n}` reached the producer for every unauthenticated user, because
`useSpendable` is `enabled: isAuthenticated`. **Red first:** both new tests failed — every row
`insufficient_funds`, `admissible.sendable === false`, on the cheapest model.

Fixed with the shared authority: `noEndpointFunding(tier)` returns
`getEffectiveBalanceNano(tier, 0n, 0n)` — the $0.01 fixed ceiling of §Affordability 8. Trial and
guest now send. **This also closes MINOR 7**: there is one derivation of that tier's effective
balance again, and `use-turn-options.ts` uses the same function `use-budget-calculation.ts` does.

My own report 3 named `0n` as "the F1 defect class reproduced exactly" while fixing the loading
window, then shipped it as the steady state for two tiers. The guard I added was for a *transient*
absence; I never asked what a *permanent* absence meant.

## CRITICAL 2 — borrowed hold wording, and the closure argument behind it

**The false argument was: `admissible ⊆ affordable`, therefore the middle state can only be a
hold.** The sets differ in **two** inputs — funding *and* basis — which `turn-options.ts`'s own
header states. **Red first:** a `prompt_too_long` refusal rendered `funds_held_by_run`.

`sendRefusalOf` now reads the **actual refusal**, and claims a hold only for the narrow shape where
it is true: refused for **funding**, and the same funding hold-blind would have sent.

```ts
if (refusal === 'insufficient_funds' && options.affordable.sendable) return 'funds_held_by_run';
return refusal;
```

The docblock asserting the false closure is deleted. It was a proof, which is worse than an
unproven claim — it invited the next reader to trust the shape rather than re-derive it.

## IMPORTANT 3 — the payer re-resolution is gone

Removed `resolvePayerFunding`, the second `useSpendable(null)` and the `useConversationBudgets`
read. **One read.** The server takes the conversation, applies §Group Funding 2, and returns the
winning wallet's figures plus `payer` and `tier`.

The four group pins were rebuilt on what the wire can actually serve. The old
`{spendable:0, held:0, payer:'owner'}` fixture was unreachable — the owner arm only returns when
hold-blind headroom is positive — and its pairing inverted under real data. What survives is the
one genuinely client-side property: **`affordable` reconstructs `spendable + held`, so a held-out
group budget cannot grey a row**, plus a pin that the endpoint is asked for the conversation.

## IMPORTANT 4 — the notice now renders

`sendRefusal` had no consumer; a hold-blocked send showed a disabled button and no explanation.
The composer now folds the refusal into the one notice list it already renders, refusal first,
with any duplicate of the same condition dropped — §Notices 7, exactly one blocking notice.

**Inversion:** dropping the fold reddens all three new tests. The old "certification" compared two
entries of the shared copy map, which cannot tell whether any surface renders either — a test about
data pretending to be a test about rendering.

## IMPORTANT 5 — the text arm's second money verdict is gone

`resolveEstimatedCostNanoUsd`'s text branch, `smartModelMinimumNanoUsd` and
`smartModelPoolFromCatalog` are **deleted**. A text turn now contributes **no** money estimate to
the funding decision, so `useResolveBilling`'s `denied` can no longer refuse a turn `admissible`
admits. The funding decision keeps its non-money jobs — who pays, the premium lock, the guest
refusal. Media keeps its own per-unit estimate by ruling.

Cascade removed: `payerTierOf`, the composer hook's `useSpendable`/`useUserTierInfo` reads,
`outputCharsPerTokenForTier`, and the now-unused `maxOutputTokens`/`estimatedInputTokens` inputs.

**Walled `affordability/**` imports under `apps/web/src/hooks/`: 12 → 8**, of which 3 are G2's
media hook and 4 are `use-budget-calculation.ts`, which now serves only the **context-capacity**
bar (a token concern, not money).

**Seven tests removed, stated as a reduction**: all seven pinned the deleted text-arm money path
(token-derived cost, Smart Model gate minimum, payer-tier sizing). Their properties live on the
adapter — payer scoping and the money verdict are pinned in `use-turn-options.test.ts`.

## IMPORTANT 6 — coverage

Eight new tests cover every fail-closed guard in `priceableFromWire`: the Smart Model sentinel,
missing input rate, missing output rate, non-positive context length, missing release date, plus
the empty-selection and pinned-effort branches.

Scoped result over `src/hooks/billing/**`, `COV_EXIT=0`:

```
All files          |   99.15 |    99.01 |   99.23 |   99.67
 ...ompt-budget.ts |   97.34 |    97.59 |   97.14 |   98.88
```

`use-turn-options.ts` no longer appears — it is at 100% and omitted as full. Both files clear the
95% gate.

**A self-inflicted failure worth recording:** my first `pnpm test:web` failed with *"Something
removed the coverage directory"* — because I ran a scoped `--coverage` run concurrently against the
same `coverage.reportsDirectory`. Not a defect in the tree; the §Known-Breakage
"never run concurrent suites" class, caused by me. Re-run alone after `rm -rf apps/web/coverage`.

## Self-gate

| Command | Result |
| --- | --- |
| `npx tsgo --noEmit` (apps/web) | **zero web errors**; one `apps/api` error (D1's `smart-model-execution.ts`) |
| `npx eslint src/hooks/billing/ src/components/chat/input/` | pass — `LINT_EXIT=0` |
| scoped `--coverage` over `src/hooks/billing/**` | pass — `COV_EXIT=0`, both files > 95% |
| `pnpm test:web` | **NOT READ — still running when I ran out of context.** Re-launched alone after `rm -rf apps/web/coverage`; at the point I stopped it had emitted **zero `FAIL` lines and zero `ERROR: Coverage`**, but I did not read a final exit status. Per the standing rule, an unfinished gate is not a passing gate: treat this as UNVERIFIED, not green. |

## Concerns

1. **`use-budget-calculation.ts` still holds 4 walled imports** and computes an affordability solve
   whose only surviving consumer is the context-capacity bar. It should shrink to a token-count
   helper; that is a follow-on, not a defect.
2. The `apps/api` typecheck error is D1's and unchanged.
3. I have not re-verified the media arm end to end; it was untouched by design.

## Confidence

**High** on Criticals 1 and 2 and Importants 3–5: each reproduced red before the fix, each has an
inversion, and each deletion was swept.

**NOT ESTABLISHED on Important 6.** The scoped coverage numbers are green (`COV_EXIT=0`, both files
> 95%) and the earlier `test:web` failure is fully explained as my own concurrent-coverage
collision — but **I never read a completed `pnpm test:web`**. A scoped run is not the gate the plan
names, and a run I did not see finish is not evidence. The next cycle should run it alone, first,
before anything else.
