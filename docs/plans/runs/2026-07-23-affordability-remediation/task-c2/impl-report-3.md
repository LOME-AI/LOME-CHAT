# C2 — impl report 3 (fix cycle 2)

One finding. Reports 1 and 2 stand for everything else.

## FINDING 4 — pin that an uncommitted generation's spend still accrues

### Why it needed a test and not a comment

The behaviour was already correct: cycle 1 gated only the *charge* on the commit and deliberately
left `this.accruedNanoUsd += result.value.costNanoUsd` above it. What was missing is that nothing
would have noticed if that changed. The plan's new §C2 paragraph records the asymmetry as durable
design — absorbed-but-counted, so the user is not billed and platform exposure stays bounded by
`hold × K` — and requires it pinned rather than true by construction.

The specific hazard is one my own cycle-1 edit created: a reader of `applyValueResult` now sees a
charge gated on the commit and an accrual that is not, and the obvious tidy-up is to align them.

### The pin

`interpreter.test.ts`, beside the billable-⟺-committed test:
**"counts an uncommitted generation's spend toward the circuit even though it bills nothing"**.

Two `onError: 'skip'` siblings, circuit limit **500 n**:

- `m0` — provider call succeeds and spends **5 000 n**, but returns the number `42` under a text
  port, so `zodFor(out)` rejects it and the value never commits. It bills nothing (cycle 1).
- `m1` — commits `'real answer'` and spends **0 n**.

Asserted:

```ts
await expect(run.done).resolves.toEqual({
  outcome: 'failed',
  code: ERROR_CODES.INSUFFICIENT_ADMISSION,
});
const [error] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
expect(error).toMatchObject({ absorbedNanoUsd: '5000' });
expect(run.settlements).toEqual([]);
```

The assertion is on **the accrued figure itself**, not on a proxy: `captureCostCircuitTrip` stamps
`absorbedNanoUsd` from `this.accruedNanoUsd`, and `5000` is exactly the uncommitted generation's cost
— nothing else in the run spent anything. So the test says "the uncommitted spend accrued, to the
nano", not merely "something tripped". The `settlements` assertion carries the other half of the
asymmetry: a trip settles nothing, so the committed sibling is not billed either.

### Demonstrated by inversion, which is the point of the test

Passing as shipped is weak evidence on its own, so I made the exact edit a future reader is tempted
to make — moved the accrual into the committed branch — and ran the suite:

```
FAIL  interpreter.test.ts > counts an uncommitted generation's spend toward the circuit
      even though it bills nothing
AssertionError: expected { outcome: 'succeeded' } to deeply equal { outcome: 'failed', …(1) }
-   "outcome": "failed",
+   "outcome": "succeeded",
      Tests  1 failed | 93 passed (94)
```

Two things worth reading off that output. The new pin **does** redden on the inversion — and it is
the **only** test that does: 93 others pass. That is the finding's severity in one line. Before this
test, the tidy-up would have been a fully green edit that silently unbounded platform exposure.

Reverted from a byte-exact backup (`diff` reports the files identical, and a grep for the temporary
marker returns nothing); 94/94 green on the restored tree, with `accruedNanoUsd` verified back above
`const commit`.

### The comment at the site now points at the pin

The one-line comment ("Spend accrues … the money left the platform either way") was true but did not
warn. It now names the asymmetry, the failure mode of aligning the two, and the test that holds it:

> ACCRUAL STAYS ABOVE THE COMMIT. Only BILLING is gated on the value committing (below); the spend
> accrues whatever becomes of the value, because the money left the platform either way. Moving this
> line into the committed branch to match the charge looks like tidying and is not: a model returning
> malformed output would then cost real provider money on every attempt while contributing nothing to
> the circuit that exists to stop that, so exposure would stop being bounded by `hold × K`.
> Absorbed-but-counted is the intended asymmetry, and it is pinned in `interpreter.test.ts` ("counts
> an uncommitted generation's spend toward the circuit").

Under the run's durable-claim rule this is the admissible shape: it states what this code guarantees,
and the cross-file half of it is enforced by a named test that goes red first — verified above, not
assumed.

## Files changed this cycle

| File | Why |
| ---- | ---- |
| `workflows/engine/interpreter.test.ts` | the accrual pin. |
| `workflows/engine/interpreter.ts` | comment only — the accrual site now warns and cites the pin. |

## Self-gate

| Command | Result |
| ------- | ------ |
| `apps/api` `npx tsc --noEmit` | **pass** — exit 0, after the final edit |
| `npx eslint src/slices/workflows/engine/interpreter.ts interpreter.test.ts` from `apps/api` | **pass** — exit 0, after the final edit |
| `interpreter.test.ts` | **94/94** on the clean tree (and 1 failed / 93 passed under the deliberate inversion) |
| Scoped coverage, `interpreter.ts`, clean tree with the pin | **pass** — exit 0, 5088 passed / 2 skipped, 325 files. **98.36** stmts / **95.95** branch / **97.59** funcs / **99.47** lines, all above the 95 gate. Uncovered 562-565 are the `subWorkflow`/`smartModel` arms of the node-dispatch `match` — pre-existing and untouched. |
| `pnpm test:api` | **crashed in the coverage merge, ZERO `FAIL` lines** — `Error: Something removed the coverage directory "…/coverage/.tmp"`. §Known Breakage: "A crash is not a test failure: read the run for `FAIL` lines before concluding anything, and gate on a scoped run instead", and the same entry records that deleting `apps/api/coverage` between runs is **not** the trigger, so retrying is not a reliable path. The scoped `src/slices` run above **is** that gate, and it is green over 325 files. |

### One process hazard I hit, worth recording

A background scoped-coverage script I had launched earlier was still running its third pass while I
performed the deliberate inversion, and it reported the new pin as **FAIL** — a real red caused by a
temporary source mutation that no longer exists. Same shape as §Known Breakage's entry about a
stood-down agent reading the next task's mid-flight state as a landed defect, but self-inflicted and
within one agent. Two consequences: I re-verified on the restored tree rather than trusting either
result, and an auditor reading that scratch log should discard that line. The rule I would draw: do
not mutate source for a red-first demonstration while any background suite is in flight.

## Acceptance criteria

Unchanged from report 2. This cycle adds no criterion; it pins the asymmetry the §C2 ruling's new
paragraph names, so the ruling is enforced rather than documented.

## Concerns and limitations

1. **The pin depends on the trip's Sentry payload to observe the accrual.** `accruedNanoUsd` is
   private and has no other observable, so the assertion reads `absorbedNanoUsd` off the captured
   error. If that payload were ever dropped from the event, this test would fail for a reason
   unrelated to the accrual. I judged that acceptable: the payload is itself normative
   (`ARCHITECTURE.md` — the trip "raises exactly one Sentry event … carrying the DO-minted `runId` and
   the absorbed nano-USD"), so the coupling is to a documented contract, not an implementation detail.
2. **Report 1 and 2 raises stand as routed** — the scope reading (accepted: mechanism, not graph
   wiring), the interim routing regression, the `estimate-run.ts` double-pricing gap, the
   full-history/custom-instructions under-reserve terms and the orphaned classifier properties (all
   against C3), and the stop-path contradiction (with the founder).
3. **The two red suites are unchanged and not mine** — the 7 `template-html` snapshots, and the
   load-dependent trial 403 in `chat/routes.integration.test.ts` (passes 188/188 alone; none of my
   changed test files touch `modelCatalog`, `withSuiteCatalogLock` or `seedModelId`). Corroborated
   independently by auditor B on a different test in the same file. Not chasing it.

## Confidence

**High.** The behaviour was already correct; what this cycle adds is the falsification. I did not
assert that the pin has teeth — I made the tempting edit, watched this test and only this test go
red, and reverted from a byte-exact backup. The code change is one comment.
