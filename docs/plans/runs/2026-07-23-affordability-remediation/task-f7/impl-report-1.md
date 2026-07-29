# F7 — impl report 1 — NEEDS_CONTEXT (no production code written)

## Objective

Make the payer freeze resolve the candidate payer against a **real estimate**, so a member
with positive-but-insufficient group headroom falls through to their own funds instead of
being frozen to the owner and then refused at admission.

## Status

**NEEDS_CONTEXT. No production file was modified.** The defect is confirmed real and
reproduced (below). The task cannot be delivered inside the stated ownership
(`turn-context.ts` + `funding-decision.ts` comment + tests), and two of the blockers are
design questions the ruling does not answer, not file-list omissions.

## The defect is confirmed — red watched, verbatim

A temporary probe test was written against the existing `resolveTurnContext` unit harness,
run in isolation, and then **deleted** (the tree carries none of it; `git status` on
`apps/api/src/slices/chat/domain/` after removal shows only pre-existing entries).

Scenario: group conversation, sender `u1`, owner `owner-9`; member budget remaining `1n`
(positive, and far below the cost of any real turn); conversation cap `1_000_000_000n`;
owner purchased balance `1_000_000_000n`; **sender purchased balance `1_000_000_000n`**
(ample personal funds). BILLING §Funding Decision Matrix priority 1 and §Group Funding 2
require the member to fall through to their own wallet.

Command (from `apps/api`):

```
pnpm exec tsx ../../scripts/with-env.ts vitest run \
  src/slices/chat/domain/turn-context.probe.test.ts --coverage.enabled=false
EXIT=1
```

Verbatim failure:

```
 FAIL  |api| src/slices/chat/domain/turn-context.probe.test.ts > payer freeze against a real turn estimate > funds from the SENDER's wallet when group headroom is positive but cannot cover the turn
AssertionError: expected 'owner-9' to be 'u1' // Object.is equality

Expected: "u1"
Received: "owner-9"

 ❯ src/slices/chat/domain/turn-context.probe.test.ts:84:33
     83|     const context = result._unsafeUnwrap();
     84|     expect(context.payerUserId).toBe('u1');
```

The member is frozen to the owner with 1 nano-USD of headroom. Admission then gates that
turn against the owner's member scope, which cannot cover it, so the send is refused —
permanently and deterministically, whatever the member personally holds. Diagnosis in the
brief and in `plan.md` §F7 is **confirmed**.

## Why the task cannot be completed within the stated ownership

### 1. The seam carries neither of the estimate's two inputs, and its only caller is out of bounds

`resolveTurnContext` (`apps/api/src/slices/chat/domain/turn-context.ts:454`) takes exactly:

```ts
deps: { conversations: ConversationsStoresFactory; billing: BillingStores }
db:   Database
args: { conversationId, sender, forkId?, now }
```

No model selection, no prompt character count, no catalog reader. `minTurnCost` — BILLING
§Math & Terms: `Σᵢ (inputTokens × inputRate(mᵢ) + MINIMUM_OUTPUT_TOKENS × variableRate(mᵢ))`
at the candidate payer's tier — needs **model rates** and **`promptChars`**. Neither is
reachable from inside the function, and neither can be synthesised there.

Its single production caller is `resolveGatedTurnContext` in
`apps/api/src/slices/chat/routes.ts:1145`, which holds both (`body.model` / `body.models`,
and `turnPromptCharacterCount(body, …)` computed at line 1212 — **after** the freeze).
`routes.ts` is explicitly out of bounds in my brief (C5) and is not in `plan.md` §F7's
Files list. Adding an optional estimate argument that the route never supplies would ship a
dead seam and leave the acceptance criterion ("today they are refused" → they send) unmet,
so that is not a within-bounds workaround.

### 2. Smart Model has no priced model at freeze time — the ruling's asymmetry does not resolve this instance

The ruling ("price at the owner's tier first, re-price at the sender's tier on
fall-through") resolves the **tier→ratio→estimate** circularity. It does not resolve the
**payer→candidate-set→estimate** one, which is a different loop:

- `POST /chat` with `body.model === SMART_MODEL_ID` chooses no model at freeze time.
- The Smart-Model candidate set is derived **downstream from the payer's spendable**
  (`payerSpendableNanoUsd(budget)` / `turnStorageContext(budget)` in
  `turn-definition.ts:186,196`, and `models/domain/smart-model-candidates.ts`), and
  `budget.funding` is precisely what the payer freeze produces.
- So on a Smart-Model turn there is no `minTurnCost` to compare against headroom until
  after the payer is frozen. "The owner is the candidate payer" fixes the tier; it does not
  produce a model set.

This needs a ruling (cheapest priceable candidate? the classifier reserve alone? exempt
Smart Model from priority 1's estimate clause and keep `undefined` there?). I will not pick
one silently — it changes who pays on a live money path.

### 3. Media turns have no per-token `minTurnCost`

`resolveGatedTurnContext` also fronts image/video sends (`body.modality`), which BILLING
§Catalog Admission 6 and §Affordability price **per unit**, not per token.
`minTurnCost`'s formula has no meaning for them, and the media build carries a
`TurnBudget` too (`turn-definition.ts:1010`). Whether priority 1 compares a media turn's
deterministic per-unit estimate, or media stays unpriced at the freeze, is unstated.

### 4. Pricing at the freeze puts a catalog read on the paid hot path

Model rates come from the catalog. Today the catalog is read inside
`turnDefinitionOrRefusal` (after the freeze) and, on the rare gated path only, in
`tierGateRejection` — whose own comment states the intent: "The catalog is read only on the
rare gated path … never on the paid hot path" (`routes.ts:529-530`). Pricing `minTurnCost`
at the freeze adds a catalog read to **every** paid send. That is a deliberate cost
decision, not an implementation detail, and it belongs to whoever owns `routes.ts`.

## Two smaller items, resolvable but worth stating rather than guessing

- **Which estimate.** The brief and §F7 say "the turn's estimate"; BILLING §Math & Terms
  says normatively that "the payer is decided on `minTurnCost` at the candidate payer's
  tier, and … the payer decision consumes this, never a full estimate". I would take
  `minTurnCost` (BILLING is normative and it is the only non-circular choice), but the two
  texts read differently and this is a money decision.
- **§Notices 5 on the server.** The disclosure is a *pre-send* client notice, and the
  client already produces it from `decision.payerSwitch` (F2). Today
  `resolvePayerWallet`'s fall-through **discards** `payerSwitch`. Whether the server must
  surface it anywhere (it currently has no consumer) is unclear; the criterion reads as
  satisfied by the client path once the server stops disagreeing about the payer.

## A comment outside my ownership that F7 falsifies

`plan.md` §F7 requires deleting the violation comment in `funding-decision.ts:12-24`
("The RULE is shared; the INPUTS are not … That divergence is a spec violation, not a
documented stop …"). **The same violation is documented a second time**, in
`packages/shared/src/affordability/billing/client-billing.ts:1-13`:

> "This shell passes the turn's estimate into the core; the server's payer freeze passes
> none (it chooses the payer before the turn is priced), so §Funding Decision Matrix
> priority 1's estimate clause applies here and not there. A member whose group headroom is
> positive but below the estimate is told here that personal funds will pay, while the
> server still resolves the owner as payer and admission refuses the send."

`client-billing.ts` is **not** in §F7's Files list. When F7 lands, that comment becomes a
wrong comment of exactly the class the criterion exists to prevent. It needs to be added to
F7's ownership (or given an owner).

The same paragraph exists a third time as the in-code comment at
`turn-context.ts:376-382`, which **is** mine and would go with the fix.

## Files changed

None. The probe test file was created, run, and deleted; nothing else in the repo was
touched.

## Self-gate

Not run — no edit was made, so there is nothing to gate. (The one command executed was the
isolated probe run above, `EXIT=1`, which is the intended red.)

## Acceptance criteria

| Criterion                                                | Status                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Red first: member with too-small headroom sends, charged to self | **Red observed and verbatim above; not made green** — blocked   |
| Server passes a real estimate into the shared decision    | Not met — the estimate's inputs cannot reach the seam within bounds     |
| Both branches pinned, fall-through priced at sender's tier | Not met                                                               |
| Guest still refused on the same boundary                  | Not met (unchanged today; no code moved)                               |
| `funding-decision.ts` violation comment removed           | Not done — removing it while the violation still exists would be false |
| §Notices 5 disclosure fires on fall-through               | Not met; scope question recorded above                                 |

## Deviations

None. The stop is the deviation, taken under the brief's own instruction not to guess on
anything load-bearing and under implementer rule 6 (an out-of-scope need is reported, never
made).

## Concerns and limitations

- The defect is real and the fix is worth sequencing promptly — a paying member is
  permanently refused. The blocker is scope, not doubt about the diagnosis.
- Blockers 2 and 3 (Smart Model, media) mean this is not "the file list forgot
  `routes.ts`". Even with `routes.ts` in scope, two turn shapes have no defined estimate at
  the freeze, and picking one would ship an unruled who-pays change.
- The `?? apps/api/src/slices/chat/domain/turn-context.integration.test.ts` untracked entry
  in `git status` is **not** mine — it predates this task (it is referenced by greps taken
  before my first edit).

## Confidence

**High** that the defect and its reproduction are correct (watched red, exact scenario from
the criterion). **High** that the task is not deliverable within the stated ownership
(seam signature and its single caller both read directly). **Medium** on the completeness
of the Smart-Model/media analysis — it is read from the call graph, not executed.
