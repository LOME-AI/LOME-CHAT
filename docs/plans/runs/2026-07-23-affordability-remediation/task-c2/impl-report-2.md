# C2 — impl report 2 (fix cycle 1)

Addresses the three validated findings from the first audit. Report 1 stands for everything not
touched here; this report is the delta.

## Objective of this cycle

1. Stop billing a generation whose value never committed (an over-bill my run-level anchor
   introduced).
2. Replace a tautological equivalence assertion with one that can fail.
3. Correct five comments this task's diff falsified but did not touch.

---

## FINDING 1 — billable ⟺ the node's value was committed

### The finding is correct, and my justification was wrong

I wrote "a charge only exists for a generation that SUCCEEDED" and cited `interpreter.ts`'s own
comment. The comment says "A **failing** generation produces no content and is never charged", which
is true of a *provider* failure and says nothing about the case that matters. Verified ordering
before the fix: `applyValueResult` called `this.collectCharge(...)` and only **then**
`return this.commitValue(...)`, and `commitValue` fails when
`zodFor(compiledNode.out, this.schemaRegistry).safeParse(value)` fails. Multi-model and media
siblings carry `onError: 'skip'` (`turn-definition.ts:635`, `:767`), so `applyNodeFailure` returns
`{ kind: 'ok' }` and the run still succeeds. The charge was therefore already pushed, with no output
— and my run-level anchor attached it to the run's first persisted item, debiting the wallet and
inflating that item's displayed cost.

I accepted the ruling's resolution and did **not** narrow the comments to "the provider call
succeeded".

### The fix — one ordering, no flag

`interpreter.ts`, `applyValueResult`:

```ts
// before
this.accruedNanoUsd += result.value.costNanoUsd;
this.collectCharge(chargeKey ?? node.id, result.value);
return this.commitValue(compiledNode, node, scope, result.value.value);

// after
this.accruedNanoUsd += result.value.costNanoUsd;
const commit = this.commitValue(compiledNode, node, scope, result.value.value);
if (commit.committed) this.collectCharge(chargeKey ?? node.id, result.value);
return commit.step;
```

`commitValue` now returns `CommitOutcome { committed: boolean; step: NodeStep }`, because a
`NodeStep` alone cannot express the distinction: a `skip`-declared node whose output failed
validation *also* yields `ok`. Accrual stays before the commit — the money left the platform
regardless, so the cost circuit must still see it; only the *charge* is gated.

**No new field on `SettlementCharge`, and no marker.** The plan's ruling asks for one rule that
distinguishes the classifier from a validation-failed sibling without a flag, and the ordering is
that rule: the classifier's value **is** committed (the `decideTurn` reducer consumes it), so it
charges; a validation-failed sibling's never commits, so it does not. Settlement is unchanged —
which is the point, since settlement cannot tell the two apart by content and must not try.

The two non-billing call sites (`runFanIn`, `runFanOut`) take `.step` and say why in one line: a
reducer and a fan-out join are not billable generations.

### Shown failing first, with both amounts

`interpreter.test.ts` — "bills nothing for a sibling whose value failed output validation, while a
committed sibling bills". Two `onError: 'skip'` siblings over the fake text→text registry:
`m0` returns the **number** `42` with `costNanoUsd: 5000n`, `m1` returns `'real answer'` with `7n`.

Red, before the fix:

```
AssertionError: expected [ 'm0', 'm1' ] to deeply equal [ 'm1' ]
+   "m0",
    "m1",
```

- **What it would have billed:** `m0` = **5 000 n**, anchored (via my run-level rule) onto `m1`'s
  content item — so the wallet debit and `m1`'s displayed `costNanoUsd` were each inflated by 5 000 n
  on top of `m1`'s own 7 n plus storage.
- **What it now bills:** `m0` = **nothing** (absorbed as platform loss); the settlement request
  carries exactly one charge, `m1` at **7 n**, and `outputs` holds only `m1`.

Run outcome stays `succeeded` in both cases — which is why this was reachable without a failing run,
and why the pin asserts the outcome too.

### The settlement test that encoded the old shape, re-pinned

`settlement.integration.test.ts` — was "anchors an outputless charge to the run's content and leaves
the item not smart", carrying the false justification verbatim. Now: **"anchors a consumed
generation's charge to the run's content, display and debit together"**.

The scenario is unchanged in mechanics (a charge with no `outputs` entry) but honestly named: such a
charge is one whose value was **consumed by a later node rather than surfaced as a sink** — the
turn's classifier is exactly that class. The comment now states what makes it safe and **where the
mechanism lives**, and that claim is pinned rather than asserted:

> What makes that safe is NOT anything settlement can see: a charge reaching here always names a
> generation whose value COMMITTED, because the interpreter charges after the commit and only on
> success. A generation whose output failed validation therefore never arrives, and its spend is
> absorbed — pinned in `interpreter.test.ts` ("bills nothing for a sibling whose value failed output
> validation").

So the cross-file claim earns its place under the run's durable-claim rule: reversing the ordering in
`interpreter.ts` reddens a named test before any reader is misled.

### Comments corrected at the seam

`collectCharge`'s docblock no longer says "A failing generation produces no content and is never
charged"; it states the invariant its caller establishes — it is invoked only for a generation whose
value committed — and names what that invariant buys settlement (a charge always names accepted work,
so run-anchoring a consumed generation bills real work). `applyValueResult`'s summary line changed
from "Accrues, charges, and commits" to "Accrues, commits, and charges", since the order *is* the
guarantee.

---

## FINDING 2 — the equivalence pin could not fail

### Confirmed, and worse than "weak"

`const classifierReserve = pooled - max; expect(max + classifierReserve).toBe(pooled)` is an identity
over any two bigints. Demonstrated rather than argued — a scratch run on a **double-priced** reserve
(`pooled = max + 2 × 11 088`), the exact defect I routed to C3:

```
expect(max + (doubled - max)).toBe(doubled);      // old assertion   → PASSES
expect(doubled - max).toBeLessThan(max);          // old guard       → PASSES
expect(doubled - max).toBe(11_088n);              // new assertion   → FAILS
      AssertionError: expected 22176n to be 11088n
```

So neither of the two things I wrote could have caught it. (Scratch file created under `apps/api`,
run, and deleted — `estimate-run.ts` was **not** touched, since B8 owns it this cycle.)

### The replacement

`smart-model-turn.test.ts` — "sizes a pooled candidate exactly as a direct pick minus the classifier
cost" now asserts the delta against the figure the **admission** side computes independently, plus
the literal:

```ts
expect(pooled - max).toBe(paidCandidates().classifierWorstCaseNanoUsd);
expect(pooled - max).toBe(11_088n);
expect(pooled - max).toBeLessThan(max);
```

`paidCandidates()` is a new helper extracted from `paidDefinition()` (same inputs, same catalog,
same prompt) returning `buildSmartModelCandidates(...)`, whose `classifierWorstCaseNanoUsd` comes
from `admitSmartModel` — a different code path from `estimate-run`'s `classifierReserveNanoUsd`. So
the two sides of `reserve ⟺ classify` are now cross-checked rather than compared to themselves.

**Auditor B's figure reproduces exactly.** Measured on this catalog/prompt/wallet:

| Quantity | Value (nano-USD) |
| -------- | ---------------- |
| `pooled` (two-candidate slot) | 99 999 833 288 |
| `max` = `soloReserve('wide/pro')` | 99 999 822 200 |
| `soloReserve('cheap/classifier')` | 4 883 900 |
| `pooled − max` | **11 088** |

11 088 = 2 472 input tokens × 2n + 2 048 output tokens × 3n — 4 943 reserve characters at 2
chars/token, and the classifier output cap. Provider legs only: a storage term folded into the
classifier reserve would break the equality, so the literal pins that too, and the comment says so.

I kept `larger()` and the MAX-not-Σ test unchanged; that one was never tautological
(`pooled > max` and `pooled < cheap + wide` are both falsifiable).

---

## FINDING 3 — five comments my diff falsified

All five corrected; no mechanism removed (the `auxiliaryCharges` / `ctx.accrue` deletion question
stays with the founder). Corrected text:

| Site | Was | Now |
| ---- | --- | --- |
| `interpreter.ts` `collectCharge` loop | "Auxiliary generations (smartModel's classifier) charge under the node key plus their suffix … their costs were accrued mid-node via ctx.accrue." | "An auxiliary generation charges under the node key plus its suffix, so its DB idempotency key never collides with the node's own. **No node execution produces one today** — the turn's classifier is its own node with its own top-level key — so this loop is the mechanism without a producer." |
| `interpreter.ts` settle catch | "An all-branches-failed turn (**every sibling failed → zero charges**) is a real 'providers unavailable' outcome…" | "An all-branches-failed turn — **no branch produced content the turn could persist** — is a real 'providers unavailable' outcome…" (rest unchanged) |
| `failures.ts` `all-branches-failed` | "Every branch of a multi-model turn failed, so settlement had **zero charges** to commit…" | "…so settlement had **no persistable content** to commit … The signal is read off content rather than off charge count, because a run may charge for a generation that persists nothing of its own." |
| `execution-registry.ts` `accrue` | "…for multi-generation executions (**smartModel accrues its classifier's cost BEFORE starting the answer call**)." | "…for an execution that runs MORE THAN ONE generation and must be stoppable between them. … **No shipped execution is multi-generation today**: every node runs one generation, so nothing calls this. It is the mechanism without a caller, kept because the circuit's between-generations guarantee is only expressible here." |
| `execution-registry.ts` `NodeGenerationCharge` | "One additional billable generation a multi-generation execution produced under its node (**smartModel's classifier call**)." | Same opening without the parenthetical, plus: "**Nothing produces one today** — the turn's classifier is its own node with its own top-level charge key, not an auxiliary of the Smart Model slot." |

Each replacement states a *current* fact ("nothing produces one today") rather than describing a
producer that no longer exists. Verification grep over the engine and node trees for
`smartModel's classifier` / `smartModel accrues` / `zero charges` / `classifier call` returns only
three legitimate survivors: C1's `decideTurn` reducer comment (the classifier *node* genuinely is
optional) and the two classifier prompt-builder module headers, which describe the classifier call in
the abstract and remain true for C3's node.

---

## Files changed this cycle

| File | Why |
| ---- | ---- |
| `workflows/engine/interpreter.ts` | billable ⟺ committed at the `collectCharge`/`commitValue` seam; `CommitOutcome`; two comment corrections. |
| `workflows/engine/interpreter.test.ts` | the validation-failed-sibling pin. |
| `workflows/engine/failures.ts` | comment only (granted for that). |
| `workflows/engine/execution-registry.ts` | comments only (granted for that). |
| `chat/domain/settlement.integration.test.ts` | the deliberate re-pin + its corrected justification. |
| `chat/domain/smart-model-turn.test.ts` | `paidCandidates()` helper; the independent-figure equivalence assertion. |

## Self-gate

| Command | Result |
| ------- | ------ |
| `apps/api` `npx tsc --noEmit` | **pass** — exit 0, run after the final edit |
| `npx eslint <17 changed files>` from `apps/api` | **pass** — exit 0 (one prettier error on the new `CommitOutcome` return, fixed) |
| Affected suites individually | interpreter 93/93 · live-run 7/7 · failures 20/20 · settlement 31/31 · chat settlement integration 62/62 · settlement-storage 9/9 · smart-model-turn 45/45 · smart-model-execution 27/27 · smart-model integration 2/2 |
| `npx turbo typecheck --force --continue --filter=@hushbox/api --filter=@hushbox/db --filter=@hushbox/realtime` | **pass** — 3/3, 0 cached. Deliberately not repo-wide this cycle: B8 is mid-flight on `packages/shared/**`, so repo typecheck is red there and is not mine to chase. |
| Scoped coverage, `interpreter.ts` (the only production file this cycle changed behaviourally) | **pass** — 98.36 stmts / **95.95 branch** / 97.59 funcs / 99.47 lines (5087 passed, exit 0). Above the 95 gate on all four. Uncovered 562-565 are the `subWorkflow`/`smartModel` arms of the node-dispatch `match`, pre-existing and untouched. `failures.ts` and `execution-registry.ts` changed comments only, so their coverage is unchanged by construction. |
| `pnpm test:api` | **fail, both files attributed** — 8 failed / 6457 passed / 3 skipped. See below. |

### The two failing files, attributed

**(a) `notifications/domain/templates/template-html.test.ts` — 7 snapshot failures.** §Known Breakage
verbatim (the removed Google-Fonts `<link>`); the template source and `.snap` are unmodified relative
to `53daba72`. Not mine.

**(b) `chat/routes.integration.test.ts > round-trips history from a trial send into the run body` —
`expected 403 to be 201`, 11 677 ms, retry ×1.** New relative to my pre-fix run, so I did not
attribute it outward on that basis alone. Checks performed, in the order §Known Breakage demands:

1. **Is it my own fixture?** No. The entry that exists precisely for this shape warns that one extra
   seeded catalog row shifts a shared percentile and produces 403s in untouched tests. Verified by
   grep across all eight test files I changed in this task: **zero** occurrences of `modelCatalog`,
   `withSuiteCatalogLock`, or `seedModelId`. The only fixture I added is a `seedFixture()` call in
   `settlement.integration.test.ts`, which seeds a user, conversation and epoch — nothing that any
   suite ranks or aggregates over. Nothing I changed writes a shared counter either.
2. **Does it reproduce alone?** No — the file passes **188/188** in isolation.
3. **Is the mechanism consistent?** Yes: a trial send 403s when the shared `model_catalog` holds
   enough foreign rows to push the seeded `MODEL` over the trial premium percentile. `seedModel()`
   inserts under the cross-suite catalog lock with `onConflictDoNothing` and wipes nothing, so what
   crowds it comes from concurrently-running catalog suites — the documented class, made worse by
   B4's widening of the wipe sites (also documented).

So: load-dependent catalog crowding, not this task's. Recorded with the checks rather than the
conclusion, because the conclusion alone is what that entry exists to prevent.

### Two environmental notes worth recording

**Collection failures from B8.** Four suites reported "no tests" mid-cycle and passed on re-run: B8 is
live on `packages/shared/**`, which invalidates the api vitest pre-bundle so unrelated `apps/api`
files fail at **collection** (§Known Breakage — this is the class "a cache clear genuinely cures").
`rm -rf apps/api/node_modules/.vite` before the full run.

**The coverage-merge crash fired once.** The first full `pnpm test:api` after the fix exited 1 with
**zero `FAIL` lines** and `Error: Something removed the coverage directory "…/coverage/.tmp"` — the
documented upstream Vitest bug, not a test failure. Note for other agents: I had scoped
`--coverage` runs in flight against the same `coverage.reportsDirectory`, which is exactly what that
error text warns about, so concurrent coverage runs are one reachable trigger. The figures above come
from a run with nothing else in flight.

## Acceptance criteria re-checked

- **Run-level anchor** — unchanged and still met, now with the invariant it rests on established
  upstream rather than assumed.
- **Failure-shape pin (first sibling fails, later persists)** — unchanged, still 805 n classifier /
  4 830 n sibling on the persisted item.
- **Zero classifier calls with an envelope** — unchanged, 27/27.
- **Reserve MAX / hold unchanged** — unchanged, and now genuinely falsifiable (Finding 2).
- **Equivalence invariant** — met against an independently computed figure.
- **Internal classifier path deleted** — unchanged, grep-clean.
- **NEW: billable ⟺ committed** — met, pinned, watched red.

## Concerns and limitations

1. **The over-bill was reachable before my task too, in one narrower shape.** A `#`-suffixed charge
   whose base node committed content but whose *own* node failed validation would already have
   anchored to that base. My run-level rule widened it to every uncommitted charge in the run. Either
   way the fix now closes both, and it closes them at the source rather than in settlement.
2. **Nothing pins that the accrual still happens for an uncommitted generation.** I kept
   `accruedNanoUsd += result.value.costNanoUsd` above the commit deliberately — an absorbed spend
   must still count toward the cost circuit, or a model returning malformed output repeatedly becomes
   an unbounded platform cost. The existing circuit tests exercise the failure path, not this one. I
   did not add a pin because the grant is for the billing seam; flagging it as a gap rather than
   widening scope.
3. **`estimate-run.ts` untouched, on purpose** — B8 owns it this cycle, so the double-priced-reserve
   defect stays routed to C3 exactly as reported. The new assertion is what will catch it there.
4. Report 1's raises stand unchanged: the scope reading (mechanism, not graph wiring), the interim
   routing regression until C3, the unowned estimator gap, the stop-path contradiction (with the
   orchestrator's correction that no migration is implied), the full-history under-reserve for C3, and
   the cassette churn.

## Confidence

**High** on all three findings. Finding 1 is a real user-facing over-bill, reproduced with a test
that was red for the right reason and whose amounts are stated on both sides; the fix is one
reordering plus one return type, with no new state and no marker, and it leaves settlement untouched.
Finding 2's replacement is cross-checked against a separately computed figure and I demonstrated the
old form could not fail. Finding 3 is mechanical. The residual medium-confidence item is unchanged
from report 1 and is the scope reading, not this cycle's work.
