# C3 — impl report 4 — criteria closure

## Objective

Close the remaining C3 acceptance criteria the coordinator named as mine, on top of the wired
multi-model `auto` classifier from report 3.

## What closed, and the pin that holds each

### The two-fallbacks collapse — one authority, constant grepped clean

`CLASSIFIER_EFFORT_FALLBACK = 'medium'` is **deleted**. `grep -rn CLASSIFIER_EFFORT_FALLBACK`
over `apps` + `packages` (excluding `node_modules`/`dist`) returns **nothing**.

The rule replacing it is §Reasoning Effort 8's — the cheapest presented option — expressed once as
`cheapestClassifierEffort()` beside the axis's other classifier rules, reading the dimension's own
ascending domain order rather than naming a rung. A reorder of the axis moves the fallback with it;
a second constant cannot drift from it because there is no second constant.

There were genuinely **two** fallbacks, and the second one is also gone: the Smart Model slot
applied its own `?? CLASSIFIER_EFFORT_FALLBACK` when no decision reached it. It now applies
nothing. That is the more faithful reading — a slot handed no decision means no classifier ran for
it, and §Effort 5 forbids a silent static level in exactly that case; the ONE declared fallback
belongs to the reducer, the only place that knows the axis.

Pinned in four places, each discriminating against the old rung rather than restating the new one:

| Pin | What would break it |
| --- | --- |
| `effort-dimension.test.ts` ×2 | the rule is `domain[0]`, and explicitly `not.toBe('medium')` |
| `turn-decision.test.ts` ×2 | the reducer's fallback equals the shared rule, and is not `'medium'` |
| `workflow-capabilities.test.ts` | the REGISTERED reducer resolves an absent answer through the same rule |
| `smart-model-execution.test.ts` | a slot handed raw text sends **no** reasoning wire |

### Routed item (c) — graceful degrade, pinned behaviourally

Report 3 pinned the shape (`optional` + `onError: 'skip'`). This cycle pins the behaviour: a run
whose classifier **fails** still succeeds, still answers, and bills only the sibling
(`[7n]`, one charge). A third pin checks the sibling receives the reducer's fallback rather than
no decision at all — the skip leaves an absent answer, which is the typed failure path the
reducer's optional second input exists for.

**One finding worth the auditor's attention:** a classifier that *throws* still kills the run
(`INTERNAL`). I wrote that test, watched it fail, and **removed it rather than changing the
engine** — a throw is a defect by the engine's own doctrine, and the provider adapters convert
every expected inference failure into a typed `Result` error, so the production path degrades.
The deleted internal classifier caught any throw; that catch-all is not restored, deliberately.
Recorded because it is a real difference from the path C2 removed.

### Partial-success billing, the three outcomes, and the fork tip

A three-sibling classified definition, pinned across all three outcomes §Multi-Model 4 names:

- **partial** — one sibling fails: charges are exactly `['answer-model', 'second-model']`;
- **all-fail** — no charges and no persisted outputs;
- **explicit stop** — a hanging sibling stopped mid-flight still settles the completed siblings'
  charges.

Plus **fork tip**: the persisted outputs are `['answer0','answer1']` when the third sibling fails —
the record's ORDER is the fork tip, so the assertion is on order, not membership. And a fourth pin
that the **classifier is not in the persisted set** — it is consumed, so it is not a sink, which is
the same fact the storage exclusion prices.

These four pin behaviour that already existed; they passed on first run. I say so rather than
implying they were red — the criterion was that nothing guarded these properties *for the
classified shape*, and the classifier-not-persisted one is genuinely new. Each discriminates: a
failed sibling billing, an all-fail turn billing, a reordered output record, or a persisted
classifier would each fail exactly one of them.

### The refusal mapping — narrowed to what I can prove, with the rest surfaced

The named defect is closed: **a run-cap refusal no longer tells the user their balance is short.**
`run-cap` now carries `RUN_CAPACITY_REACHED`, whose copy is `funds_held_by_run` — "your funds are
reserved by a reply that's still generating; wait for it to finish". Pinned three ways: it reads as
that condition, it differs from the balance wording, and it contains neither "add credit" nor
"balance".

**I did not split `budget-exceeded`, and that is a finding rather than an omission.** My first
attempt mapped it to `group_owner_funds_unavailable` and the suite caught it: three tests failed,
including *"refuses a free-tier turn once the daily allowance is spent"*. `budget-exceeded` is not
one condition — the scope that bound may be a group owner's budget or the sender's own free daily
allowance, and their actions point at **different people**. `AdmissionRefusalReason` does not carry
which. Splitting it needs the scope on the refusal (`billing/domain/admission.ts`, F3's tree and
not my grant); guessing would have replaced one wrong sentence with another.

**Consequence: `send_cannot_start` is NOT deleted, and could not be.** `INSUFFICIENT_ADMISSION`
still has three producers whose conditions differ — a cost-circuit trip (the run *started* and was
killed), an empty balance, and an exhausted budget scope. The catch-all's copy is the only wording
true of all three. The plan is right that a permanent catch-all re-absorbs new conditions; removing
this one needs the scope split above plus a decision on the cost-circuit's own copy, which is a
different condition entirely (absorbed platform loss, not a refusal to start).

### Already closed in earlier cycles, re-stated because the coordinator listed them

- **`_pinned`, both sides in one edit** — closed in cycle 2
  (`smart-model-candidates.ts` declaration + `smart-model-turn.ts` call site); `grep` for `_pinned`
  and "selects nothing" is clean.
- **§Reasoning Effort 6 end-to-end** — closed in cycle 3: the prompt renders the turn's presented
  set via `turnEffortOptions`, pinned both ways (a three-rung turn prompts High and **not** Lite; an
  open-ladder turn prompts Lite, Mid and Max).

## Not closed, with the reason

**`reserve ⊇ bill` as a property over reachable outcomes.** I did not ship one, and chose that over
shipping a vacuous one. Every version I could build inside a unit fixture is arithmetic over
numbers the fixture itself chose: charges I invent are bounded by ceilings I invent, so the
assertion cannot fail for a reason about the system. Deriving the maximum billable independently
would be the golden cross-check Global Constraint 5 bans. A property with real content needs real
provider costs against a real hold — which is **H1**'s shape ("one real turn, three invariants
once"), and I recommend it lands there. What exists instead: pin 4 bounds the classifier's billed
input by its priced basis on the real assembled request, and the estimator suites bound each node's
reserve. **This is the one named criterion I am leaving open, and it is open on judgement, not
budget.**

## Not mine — reachability from what I landed

| Item | Reachable? |
| --- | --- |
| **Single-model `auto`** | Yes, and cheaply. It compiles a `smartModel` node; give it the same `classify → decideTurn → slot` shape `classifyingMultiModelGraph` builds. The slot already reads the envelope (`decisionOf`), and my `inputSchema` guard already zeroes its internal reserve so the classifier is not priced twice. No new mechanism. |
| **Smart-Model slot** | Same shape, same answer. The slot's model axis also resolves from the envelope's `modelText`, which C2 already wired. |
| **Web-search arm (H1)** | Falls out of single-model `auto`: the route sends web-search + auto down the single-model path today, so wiring that path wires this one. No new mechanism, hence H1 rather than a separate owner. |
| **Trial `auto`** | Same smartModel shape, plus one thing the others do not need: the trial's 1¢ per-message ceiling must cover the classifier node now that it is priced as an ordinary node. The reserve side is handled (my double-pricing guard); the gate side wants checking. |

**B8's cross-implementation clamp-order amount is mine, and I did not do it.** B8's residual says
it belongs to "whoever holds `turn-definition.ts` next" — that is me, and I am naming it rather
than letting it fall between owners. It needs the module-side and `turn-definition.ts`-side clamp
orders compared **by amount** on a saturating-sibling turn (B8 pinned 8,225,200 nano on its side).

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:api` | 7 failures, all the documented template-html family, nothing else |
| `pnpm test:shared` | **pass**, exit 0, coverage gate; `error-codes.ts`, `notices.ts`, `prompts.ts` all 100% |
| `turbo typecheck --force` (api + shared) | **2/2** |
| scoped coverage (whole owning slice, per the new §Known-Breakage entry) | `runtime.ts` 99.31/100/98.46/99.27 · `turn-decision.ts` 100/100/100/100 · `turn-definition.ts` 99.59/97.63/100/100 |
| `eslint` from `packages/shared`, 9 files | **exit 0**, empty output |
| `eslint` from `apps/api`, 23 files | **exit 0**, empty output |

**One repo-wide typecheck failure is not mine:** `@hushbox/web` fails on
`apps/web/src/hooks/billing/use-turn-options.test.ts` (`'trial' not assignable to 'paid'`). Both
that file and its subject are **untracked, created 22:06 today** — E1's in-flight work on
`apps/web/**`. My packages are green.

**Two suite runs were invalidated by my own later edits** and are not cited: the run before the
`BUDGET_EXCEEDED` revert (three budget-refusal failures, all caused by the mapping I then narrowed)
and the run before the final prettier pass. The cited api run is the one after the last code edit;
the two prettier-touched test files were re-run separately (132 passed).

## Vocabulary sweep

Swept the mechanisms this cycle removed — the mid-rung fallback constant, the slot's second
fallback, and the collapsed admission code. **Two falsified comments found, both outside the diff's
hunks:**

1. `smart-model-execution.ts`'s module docblock — "the effort axis takes the decision's own level,
   **or the axis's declared fallback** when the dimension is open and no decision arrived". False
   the moment the slot stopped inventing one; it sits ~80 lines from the change.
2. `mock-provider.ts` — "the canonical middle rung — **the same option the real stage falls back
   to**". False once the real fallback became the cheapest option. Rewritten to say what the mock's
   choice actually is and why it must *differ* from the product's fallback: a mock answering what
   the reducer falls back to could not tell "the classifier chose" from "nothing was chosen".

That second one is the more interesting find — the comment was not merely stale, it described a
coupling that would have made the classified-decision pins vacuous if anyone had honoured it.

The sweep has now found falsified comments outside the hunks in **every** cycle of this task
(4, 5, 3, 2). Nothing else found for this cycle's vocabulary: `'medium'` as a fallback greps clean
across `workflows` and `chat`.

## Confidence

**High.** The collapse is pinned by its rule rather than its value, the degrade and billing
outcomes are pinned on the real graph shape, and the refusal mapping was narrowed by a failure the
suite found rather than by my judgement alone. The one open criterion is named with its reason and
a recommended owner.
