# C2 — impl report 1

## Objective

Make the turn-level classifier charge actually bill: a run-level settlement anchor, the Smart
Model slot consuming the decision envelope instead of calling a classifier itself, and the
internal classifier path deleted.

## Scope reading, and the one place I had to choose

C2's criteria pull in two directions and the resolution decides how much code the task is, so
it is stated up front rather than buried:

- "The internal classifier path is deleted" + "with an envelope present the slot performs no
  classifier call" say the slot becomes envelope-consuming.
- "Reserve remains `MAX` over candidates; **the hold is unchanged by this refactor**" plus the
  granted file list (which excludes `apps/api/src/slices/models/domain/estimate-run.ts`) say the
  **shipped definition graph must not change**, because the classifier reserve is priced off the
  `smartModel` **node** (`estimate-run.ts:504-596`, `classifierReserveNanoUsd` +
  `smartModelClassifierDimensions`). Adding a classifier `modelCall` node to a shipped definition
  gets that node priced a **second** time by the generic `modelCeiling` path, so the hold moves.

So C2 delivers the **mechanism** (a slot that consumes a decision, plus the money plumbing a
turn-level charge needs) and does **not** wire the classifier node into any shipped definition.
C3's criteria confirm that split — it owns `chat/domain/{turn-definition,turn-reasoning,smart-model-turn}.ts`
and its objective is the classifier sibling with the `admissible` set and the labelled-line prompt.

Consequences of that reading are RAISED below (interim behaviour change; an unowned estimator gap).

## Files changed

| File                                                              | Why                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/slices/workflows/engine/settlement.ts`              | `anchorChargeKey` gains the run-level third rule; the charging commit passes the run's charge keys once per settlement.    |
| `apps/api/src/slices/workflows/engine/settlement.test.ts`          | Run-anchor unit rules + the failure-shape charging-commit pin.                                                            |
| `apps/api/src/slices/chat/domain/settlement.ts`                    | Display path consumes the same function with the same order source; three comments whose stated mechanism I changed.       |
| `apps/api/src/slices/chat/domain/settlement.integration.test.ts`   | End-to-end failure-shape pin (display == debit on the persisted sibling); one pre-existing test re-pinned (see Deviations). |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.ts`     | Internal classifier path deleted; the slot binds the decision's model and applies its effort.                             |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts` | Rewritten around the envelope; classifier-internals tests removed.                                                        |
| `apps/api/src/slices/workflows/builder/smart-model.ts`             | The `in` port is no longer text-only: an `accepts` claim, persisted as `inputSchema` through the same helper `modelCall` uses. |
| `apps/api/src/slices/chat/domain/smart-model-turn.ts`              | Passes `accepts: textTag()` — the only production caller of the builder.                                                   |
| `apps/api/src/slices/chat/domain/smart-model-turn.test.ts`          | Reserve-`MAX` and equivalence-invariant pins.                                                                             |
| `apps/api/src/slices/workflows/engine/interpreter.test.ts`          | Stop-path pin: an earlier level's consumed charge rides a stopped partial's settlement.                                    |
| `apps/api/src/slices/workflows/engine/live-run.test.ts`             | Reshaped to the turn-level graph (classifier `modelCall` → `decideTurn` → slot).                                            |
| `apps/api/src/slices/workflows/engine/smart-model.integration.test.ts` | Same reshape, over the real provider factory — the end-to-end proof of the mechanism.                                    |
| `apps/api/src/slices/workflows/builder/build-workflow.test.ts`      | `accepts: textTag()` at two builder call sites.                                                                           |
| `apps/api/src/slices/workflows/engine/live-execution-registry.ts`    | Out-of-ownership, forced: the `classifier` binding it passed no longer exists on the deps type (see Deviations).           |

## Tests added

| Test                                                                                                | Behaviour                                                                                | Criterion |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------- |
| `settlement.test.ts` — "anchors a turn-level charge to the run's first persisted content"             | A bare (unsuffixed) key resolves to the run anchor.                                       | run-level anchor |
| `settlement.test.ts` — "anchors a suffixed charge whose own generation persisted nothing…"            | The `#`-strip miss falls through to the run anchor.                                       | run-level anchor |
| `settlement.test.ts` — "takes the FIRST persisted key in run order when several persisted"            | The order rule is charge order, not arbitrary.                                            | deterministic order |
| `settlement.test.ts` — "anchors nothing when the run persisted no content at all"                    | Billed ⟹ the run persisted content.                                                       | run-level anchor |
| `settlement.test.ts` — "lands a turn-level charge on the run's content when the first sibling failed" | The failure shape, with amounts, through the charging commit.                             | failure-shape pin |
| `settlement.integration.test.ts` — "lands a turn-level classifier charge on the run's content when the first sibling failed" | Same shape end to end: both usage records FK the one content item, display == debit. | failure-shape pin |
| `smart-model-execution.test.ts` — "performs NO classifier call when a decision is present…"           | Provider call count is 1; no auxiliary charge.                                            | zero classifier calls |
| `smart-model-execution.test.ts` — "binds the model the decision names…"                              | `decision.modelText` resolves within the node's own candidate list.                       | envelope consumption |
| `smart-model-execution.test.ts` — "binds the cheapest candidate when the decision names nothing…"     | Declared cheapest-presented fallback, one call.                                           | envelope consumption |
| `smart-model-execution.test.ts` — "binds the cheapest candidate when no decision reaches the slot"    | Absent decision is a typed absent value, not a caught failure.                            | internal path deleted |
| `smart-model-execution.test.ts` — the effort-axis block (7 tests)                                    | Decision effort → wire plan inside the held cap; declared fallback; closed axis untouched. | envelope consumption |
| `smart-model-turn.test.ts` — "reserves the MAX over candidates plus one classifier reserve, never the Σ" | Pool reserve decomposes as MAX + one reserve, strictly under the Σ.                    | reserve MAX / hold unchanged |
| `smart-model-turn.test.ts` — "sizes a pooled candidate exactly as a direct pick minus the classifier cost" | §Smart Model 8, numerically.                                                        | equivalence invariant |
| `interpreter.test.ts` — "carries an earlier level's consumed charge into a stopped partial's settlement" | A stop settles the partial WITH the earlier consumed charge.                          | forward item (2) |
| `live-run.test.ts` — the reshaped composite-turn test                                                | Two nodes, two charges (`classify`, `answer`), routed model, badged answer.               | mechanism composition |
| `smart-model.integration.test.ts` — the reshaped factory test                                        | Real provider: classifier line routes the slot to the other candidate; classifier value consumed, not a sink. | mechanism composition |

## Self-gate

| Command | Result |
| ------- | ------ |
| `npx turbo typecheck --force --continue` (repo-wide, 0 cached) | **pass** — 16/16 successful, exit 0 |
| `pnpm test:api` (final run, after the last edit) | **fail (fully attributed)** — 1 file / 7 tests failed, 6449 passed, 3 skipped. All 7 are `notifications/domain/templates/template-html.test.ts` snapshot mismatches over a removed `<link href="https://fonts.googleapis.com/css2?family=Merriweather…">`, which is §Known Breakage verbatim. Attribution evidence: `git status --porcelain -- apps/api/src/slices/notifications/domain/templates/` is **empty** — both the template source and the `.snap` are unmodified relative to `53daba72`, and neither is in my edit set. An earlier run also failed `workflows/engine/live-run.test.ts`; that one WAS mine and is fixed (below). |
| Scoped coverage over owned files (`vitest run --coverage --coverage.include=… src/slices`, excluding the known-broken snapshot file) | **pass** — exit 0, 5078 passed / 2 skipped, 324 files. Per-file: see the table below. |
| `npx eslint <14 changed files>` from `apps/api` after the final edit | **pass** — exit 0 (first run: 9 errors, all fixed; see below) |
| `npx tsc --noEmit -p tsconfig.json` in `apps/api` after the final edit | **pass** — exit 0 |

Lint set derived from `git status`, not from memory: every file I changed is under `apps/api`, so
`apps/api` is the only package present and the one `eslint` invocation covers it. Run **after** the
last edit, which was a comment-only pass over `builder/smart-model.ts`,
`chat/domain/smart-model-turn.ts`, `engine/settlement.ts` and
`nodes/smart-model-execution.ts`; the three affected suites were re-run green after it
(45/45, 27/27, 31/31).

### The one failure that was mine, and what it taught

`live-run.test.ts > classifies, answers from the routed model, and settles both generations` failed
after the deletion:

```
- "text": "echo:go",
+ "text": "answer-model",
```

Cause: that test drove the OLD composite (one `smartModel` node doing its own classify), so with
the internal path gone the node answered from the cheapest candidate on the raw prompt. Fixed by
reshaping the definition into the turn-level graph (classifier `modelCall` → `decideTurn` fanIn →
slot) and making the fake classifier answer a **labelled** `model: answer-model` line. It now passes
in isolation (7/7) and in the full suite.

### Lint, first run (all fixed, exit 0 after)

```
smart-model-turn.test.ts  332:17, 350:17  unicorn/prefer-math-min-max
settlement.test.ts        711:12          prettier/prettier
settlement.ts             181:29          unicorn/no-array-callback-reference
smart-model-execution.test.ts 260,365,547 prettier/prettier
smart-model-execution.test.ts 684:16      require-yield / sonarjs/generator-without-yield
```

`prefer-math-min-max` cannot be satisfied literally on bigints, so the ternaries became a named
`larger(a, b)` helper with the reason in its docblock.

### Per-file coverage (scoped runs, gate is 95 lines/branches/functions)

| File | Stmts | Branch | Funcs | Lines |
| ---- | ----- | ------ | ----- | ----- |
| `workflows/engine/settlement.ts` | 100 (35/35) | 100 (22/22) | 100 (17/17) | 100 (29/29) |
| `workflows/nodes/smart-model-execution.ts` | 100 (51/51) | 100 (40/40) | 100 (12/12) | 100 (40/40) |
| `workflows/builder/smart-model.ts` | 100 (2/2) | 100 (6/6) | 100 (1/1) | 100 (2/2) |
| `workflows/engine/live-execution-registry.ts` | 100 (39/39) | 100 (30/30) | 100 (9/9) | 100 (31/31) |
| `chat/domain/smart-model-turn.ts` | 100 (64/64) | 100 (74/74) | 100 (25/25) | 100 (58/58) |
| `chat/domain/settlement.ts` | 98.65 | 97.08 | 100 | 99.51 |

`chat/domain/settlement.ts`'s only uncovered line (439) is `existing.push(item)` in
`groupByOriginatingNode` — the two-persistable-charges-per-node branch, pre-existing and untouched
by this task. Every figure is above the 95 gate.

**A vitest gotcha worth recording, because it cost three runs:** repeated `--coverage.include` flags
on the CLI do **not** accumulate, and a brace-glob (`'src/slices/{a.ts,b.ts,…}'`) does not either —
in both cases only ONE file appears in the table, and the run still exits 0, so it reads as a clean
gate over six files when it covered one. The working form is one run per file, one include each.

## Acceptance criteria

**1. Settlement resolves a run-level anchor: the first persisted content item of the run in
deterministic order — the anchor rule change, not just its caller. — MET.**

`anchorChargeKey` (`workflows/engine/settlement.ts:170`) is now three rules, nearest first: own key
→ base key (last `#` segment stripped) → the first key in the run's charge-key list that persisted
content. Both consumers pass the same order source: the debit path maps `request.charges` in
`createChargingCommit`, the display path maps the same array in `aggregateDisplayCostByKey`.

**Deterministic order was available**, so the brief's NEEDS_CONTEXT trigger on this point did not
fire: charges are pushed by the interpreter in the compiled definition's topological order
(`interpreter.ts:653` `collectCharge` inside `applyValueResult`, driven by `this.compiled.order`),
so the anchor is the same content item on every replay of the same run. It also coincides with the
key the prompt storage fee rides (`withStorageFees` → `collectPersistableCharges(request)[0]`), which
keeps the whole prompt fee and the run anchor on one item.

**2. Pinned on the failure shape that matters — first sibling fails, a later one persists;
the classifier charge lands with the right amount on the persisted item. — MET, with amounts.**

Unit level (`settlement.test.ts`, "lands a turn-level charge on the run's content when the first
sibling failed"): charges `[classify, sibling-b]`, `contentItemIdFor` resolves only `sibling-b`
(sibling A failed, so it produced **no charge at all** — `collectCharge` only fires on success,
`interpreter.ts:658`). Both usage records FK `c-sibling-b`:

- `run-1:classify` → `applyMarkup(700n)` = **805 nano-USD**
- `run-1:sibling-b` → `applyMarkup(4200n)` = **4830 nano-USD**

Integration level (`settlement.integration.test.ts`, same name): the persisted content item's
`costNanoUsd` is `applyMarkup(1000n) + PROMPT_ANSWER_STORAGE + applyMarkup(40n)` and both
`usage_records` rows carry that item's id — display equals debit on the one item.

Watched red first: before the implementation, the two run-anchor unit rules returned `undefined`
("expected undefined to be 'sibling-b'") and the charging-commit pin captured no usage records.

**3. `anchorChargeKey` remained ONE function — VERIFIED, not repeated.**

```
$ grep -rn "function anchorChargeKey" apps/api/src packages/*/src
apps/api/src/slices/workflows/engine/settlement.ts:170:export function anchorChargeKey(

$ grep -rn "lastIndexOf('#')" apps/api/src apps/web/src packages/*/src
apps/api/src/slices/workflows/engine/settlement.ts:176:  const separator = key.lastIndexOf('#');

$ grep -rn "anchorChargeKey(" apps/api/src packages/*/src | grep -v "export function"
… settlement.ts:190            (the debit path, via anchorContentItemId)
… chat/domain/settlement.ts:473 (the display path)
… settlement.test.ts × 6
```

One definition, one `#`-strip site, two production call sites. C1's collapse of the former
display-path twin (`resolveDisplayAnchorKey`, deleted in `git diff 53daba72 --
apps/api/src/slices/chat/domain/settlement.ts`) is intact; I extended that one function's rule and
its signature rather than adding a second implementation.

**4. With an envelope present the slot performs no classifier call; pinned by call count. — MET.**

`smart-model-execution.test.ts`, "performs NO classifier call when a decision is present — one
provider call, no aux charge": `expect(requests).toHaveLength(1)`, `requests[0].model === HARD`,
`auxiliaryCharges ?? [] === []`. Watched red first (it saw 2 requests). The same count assertion
appears on the unresolvable-name and no-decision paths, so no arm of the slot can reach a provider
twice.

**5. Reserve remains `MAX` over candidates; the hold is unchanged by this refactor; pinned. — MET.**

`smart-model-turn.test.ts`, "reserves the MAX over candidates plus one classifier reserve, never the
Σ": with the paid two-candidate definition, `pooled > max(solo(cheap), solo(wide))` and
`pooled < solo(cheap) + solo(wide)`. `soloReserve(id)` restricts the same definition to one
candidate keeping its stamped cap; a one-candidate slot opens no model dimension
(`smartModelClassifierDimensions`: `model && candidates.length > 1`), so its estimate is the answer
leg alone — which is what makes the decomposition possible without re-deriving any estimator
arithmetic in the test.

**These two pins passed on first run, and that is the evidence rather than a TDD lapse.** The
criterion is that the hold does **not** move; the definition shape and `estimate-run.ts` are
untouched by this task, so a red-first would have meant I had changed the hold. I state it plainly
because "passed immediately" normally means a worthless test: here the same assertions would have
gone red had I wired a classifier node into the shipped definition, which is exactly the change the
criterion forbids.

**6. The equivalence invariant (§Smart Model 8): a Smart-Model-resolved model is sized exactly as a
direct pick minus the classifier cost, same catalog and prompt. — MET, numerically.**

Same describe block, "sizes a pooled candidate exactly as a direct pick minus the classifier cost":
over one catalog (`cheap/classifier` 2n/3n at 8 000 context, `wide/pro` 4n/200 000n at 1 050 000
context), one prompt (400 characters, paid tier), one $100 wallet and the pool's own stamped
per-candidate caps, `max(cheap, wide) + (pooled − max) === pooled` with `pooled − max > 0` and
`pooled − max < max`. So the pooled reserve is exactly the costliest candidate's direct-pick reserve
plus one classifier reserve, and the classifier's leg is small next to an answer leg (it prices a
truncated context and a capped output).

**7. The internal classifier path is deleted; grep-clean. — MET for the slot; two modules left
standing deliberately.**

```
$ grep -rn "classifierCall\|classifierRequest\|resolveClassifierValue\|classifiedAnswerExtras\|\
ClassifierOutcome\|auxiliaryCharges\|keySuffix\|mediumFallback\|latestAssistantMessage" \
    apps/api/src/slices/workflows/nodes/smart-model-execution.ts \
    apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts
apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts:215:
    expect(result._unsafeUnwrap().auxiliaryCharges ?? []).toEqual([]);
```

The only hit is the assertion that the slot produces **no** auxiliary charge. The production file
carries none of those symbols; `SmartModelExecutionDeps.classifier` is gone too.

`classifier-messages.ts` (`buildClassifierMessages`) and `classifier-context.ts`
(`truncateForClassifier`) now have **no production consumer** — the grep for them returns only their
own definitions and their own test files. I did **not** delete them: I cannot prove them dead,
because C3's criteria require exactly that prompt for the turn-level classifier node, and
`computeClassifierPromptOverhead` in the money module prices its length. Deleting and recreating
them would also throw away C1's envelope-character fix in `classifier-context.ts`. Recorded as a
knip-visible residue (a Phase-4 gate, and §Known Breakage says knip is noisy mid-run).

**8. Forward item (1) — `anchorChargeKey` returned `undefined` for a bare top-level key. — CLOSED**
by criterion 1.

**9. Forward item (2) — `finalizeStopped` skips settlement when sink outputs are empty. — PARTLY
CLOSED, and the residue is a documented contradiction I am not resolving.**

What I closed, with a test that fails without it: `interpreter.test.ts`, "carries an earlier level's
consumed charge into a stopped partial's settlement". A two-level definition where the first node
bills and is CONSUMED (so it surfaces no run output — a turn-level classifier's exact shape) and the
second is stopped mid-stream: the settlement carries `charges: ['first', 'second']` and
`outputs: { second }`. Combined with criterion 1, the consumed charge lands on the stopped partial's
content item instead of being absorbed. Watched red first — and the first attempt failed for an
instructive reason: with the three-node `chainDefinition` the *second* node is also consumed (by the
third), so nothing is a sink and `settlements` was empty; that is the same class as the pre-existing
"stops without settling when a stop lands mid-fan-out".

What I did **not** close: a stop where **no** sink produced anything at all — the literal wording of
forward item (2). Code path, cited:

- `interpreter.ts:1102-1109` `finalizeStopped` calls `settle` only when `sinkOutputs()` is non-empty.
- Were it to settle anyway, `chat/domain/settlement.ts:250` raises `AllBranchesFailedError` (no
  persistable content), so the run would be reported **failed** rather than **stopped** and still
  bill nothing — a strictly worse outcome, not a fix.
- And the charge could not be posted regardless: `ChargeInput.contentItemId` is a required `string`
  (`billing/domain/charge.ts:26`), and `packages/db/src/schema/usage-records.ts:11-14` states
  "every row is inserted with a non-null contentItemId inside settle()".

That is a contradiction between two normative statements, both in `ARCHITECTURE.md`:

- §Streaming & realtime: "explicit stop … settles the partial — **a user cancel bills consumed usage
  even when nothing was persisted** (the sole carve-out from saved ⟺ billed)".
- §Data model essentials: "`usage_records` … **insert-time invariant: billed ⟹ the run persisted
  content**".

For "a stop after the classifier ran, before any sibling output" these cannot both hold. Closing it
in favour of the carve-out needs a content-free charge path — a change to billing's published
`ChargeInput` and to the `usage_records` insert invariant (plus a migration), none of which is in
C2's grant. Per the brief's instruction for this item I am reporting the conflict rather than
choosing an interpretation. Money impact of leaving it: on that one path the classifier's provider
spend (~0.1¢ worst case) is absorbed by the platform. Direction is safe (never over-charges), and
the hold is released either way, so `reserve ⊇ bill` is untouched.

**10. The `smartModel` builder's `in` port is no longer text-only. — MET.**

`builder/smart-model.ts` now takes `accepts: A extends TypeTag` with `in: Port<AssignableTag<A>>`,
and persists it through the **same** `persistedInputSchema(accepts)` helper C1 added for
`modelCall` — so the compile-time tag and the persisted `inputSchema` cannot name different schemas.
Six call sites updated to `accepts: textTag()`; two (`live-run.test.ts`,
`smart-model.integration.test.ts`) now pass `accepts: jsonTag(TURN_DECISION_SCHEMA_NAME)` and wire
the slot to a `decideTurn` fanIn.

**11. The mechanism proven end to end, over the real provider factory.**

`workflows/engine/smart-model.integration.test.ts` was reshaped from "one composite node that
classifies" to the turn-level graph, and it passes: two provider calls (the classifier's
`openai/gpt-4o-mini`, the answer's `openai/gpt-4o`), two charges under two **top-level** keys
(`classify`, `answer`), the classifier's value consumed rather than a sink
(`Object.keys(outputs) === ['answer']`), and the classifier's labelled line routing the slot to the
other candidate. This is the shape the run-level anchor exists for, and it now exists.

## Deviations

1. **`workflows/engine/live-execution-registry.ts` edited (not in the Files list).** Forced: it
   passed `classifier` into `createSmartModelExecution`, and with that field removed from
   `SmartModelExecutionDeps` the package does not typecheck (`TS2353`). The edit is behaviour-
   preserving — the resolution **guard** stays (`if (deps.models.resolve(node.classifierModelId) ===
   undefined) return undefined;`), only the now-unused binding is dropped — and its docblock now says
   why the declared classifier model must still resolve (the compile-time port derivation and the
   admission estimate both read it) rather than claiming the node calls it.

2. **One pre-existing test re-pinned, deliberately.**
   `settlement.integration.test.ts` — "excludes a non-anchoring charge from display cost and leaves
   the item not smart" became "anchors an outputless charge to the run's content and leaves the item
   not smart". The run-level rule is general: a media charge whose node surfaced no output now
   anchors to the run's content instead of being skipped. That is correct rather than incidental — a
   charge only exists for a generation that **succeeded** (`interpreter.ts:658`: "A failing
   generation produces no content and is never charged"), so its provider spend is real, and
   `usage_records`' own invariant is "billed ⟹ **the run** persisted content", not "this charge
   persisted content". Display and debit moved together (both `applyMarkup(1000n) +
   PROMPT_ANSWER_STORAGE + applyMarkup(500n)` = 11 025 n).

3. **`smart-model-execution.test.ts` lost ~18 tests of classifier internals** (prompt markers and
   candidate lines, classifier error/throw degrade, accrue-before-answer ordering, the circuit-trip
   abort, non-text classifier value, truncation edges). Each tested code that no longer exists in
   this file. The properties they carried are not lost: the prompt template is covered by
   `classifier-messages.test.ts`, truncation by `classifier-context.test.ts`, the answer parse by
   `turn-decision.test.ts`, and the accrual/abort/degrade behaviour is `model-call-execution.ts`'s,
   which every classifier node now goes through and which has its own suite.

4. **Comments my diff falsified, corrected in a final pass** (re-read against the final code, not the
   code I wrote them against):
   - `chat/domain/settlement.ts` × 3 — "the charging commit skips it — no content, no charge" is no
     longer the rule. The `withStorageFees` docblock now states what the code guarantees (the fee
     rides a charge that minted content) instead of quoting a skip rule that no longer exists.
   - `engine/settlement.ts` — the anchor docblock cited `<node>#<index>#classifier` as its worked
     example, and **nothing produces that key any more** (I deleted the only `keySuffix` producer).
     Reworded to describe the nesting rule without naming a shape that no longer occurs.
   - `nodes/smart-model-execution.ts` — the fallback bullet asserted how the candidate producer sorts
     its list ("sorted ascending by `maxCallCost`, so that is the first entry"). That is the
     mirrored-constant-in-prose shape: a restated quantity owned by another file. Rewritten to state
     this node's own guarantee — it never resolves outside its candidate list, every candidate was
     priced into the `MAX`, so no arm can bind a model the hold did not cover — and to hand the
     ordering claim back to the producer.
   - `builder/smart-model.ts` × 3 — "the classifier model — by construction the cheapest candidate"
     (false before C2 and worse after), "the classifier call sets only its own output cap" (there is
     no classifier call here), and the candidate-ordering restatement.
   - `chat/domain/smart-model-turn.ts` × 2 — "the classifier call never reads them" and "the model
     dimension short-circuits at runtime"; both named mechanisms my deletion removed.

## Concerns and limitations

1. **Interim behaviour change, and it is user-visible if C3 slips.** With the internal classifier
   deleted and no shipped definition producing an envelope, `buildSmartModelTurn` (Smart Model turns
   and the pinned-model+auto-effort turn) now binds the **cheapest candidate** and applies
   `CLASSIFIER_EFFORT_FALLBACK`, performing no classification at all. The classifier reserve is still
   held and simply never spent — which the lane-C ruling licenses explicitly ("the unspent reserve is
   simply never charged … `reserve ⊇ bill` is untouched") — so this is a routing-quality regression,
   not a money one. It ends when C3 wires the classifier node.

2. **An unowned gap: the estimator prices the classifier off the `smartModel` node.** When C3 adds a
   classifier `modelCall` node to a definition, `estimate-run.ts` will price it **again** through the
   generic `modelCeiling` path on top of `estimateSmartModelNode`'s own `classifierReserveNanoUsd`.
   `models/domain/estimate-run.ts` is in neither C2's nor C3's Files list. C3 cannot satisfy its
   criteria without it.

3. **A turn-level classifier `modelCall` receives the FULL run history.** `model-call-execution.ts:205,212`
   forwards `ctx.history` on every modelCall, whereas the classifier reserve prices a **truncated**
   4 000-character context (§Reasoning Effort 6, `MAX_CLASSIFIER_CONTEXT_CHARS`). Verified while
   reshaping `live-run.test.ts`: the old assertion `expect(classifierRequest).not.toHaveProperty('history')`
   stopped holding once the classifier became an ordinary node, and I removed it rather than
   enshrining either behaviour. Left unpinned on purpose — pinning "the classifier carries full
   history" would enshrine an under-reserve on its input leg.

4. **Cassette churn.** Both reshaped integration tests change what crosses the wire, so the
   OpenRouter cassettes for `smart-model.integration.test.ts` are now stale: the classifier request
   is a plain modelCall (no system-prompt marker, `maxOutputTokens: 32`) and the turn prompt changed
   to elicit a labelled routing line. Record-on-miss handles it by design (one real call on the
   restricted key), and `verify:evidence` still sees the OpenRouter path — but it is a real recording
   cost to expect on the next CI run.

5. **`smartModelClassifierDimensions` still gates on `node.classify` + candidate count**, so the slot
   applies the decision's effort only when the axis is open for that node. A decision carrying an
   effort into a closed-axis node is ignored (pinned: "leaves the built params alone when neither axis
   is open for this node"). That is the pinned-dimension rule, but it means C3 must set `classify`
   correctly on the slot or a classified effort silently does nothing.

6. **`pnpm test:api` never printed a coverage table on any red run**, exactly as §Known Breakage
   warns. Every coverage figure here comes from a scoped run that excludes the known-broken snapshot
   file; the api suite's exit code is not the coverage gate.

## Confidence

**Medium.** High on the money mechanics: the anchor is one function with three rules, the failure
shape is pinned at both the unit and integration level with stated amounts, and the reserve/equivalence
invariants decompose numerically. Medium overall because the scope reading in §1 is a judgment call
that determines roughly half this task's size — the criteria contain a genuine tension (delete the
internal classifier vs. leave the hold unchanged with the estimator unowned) and the interim routing
regression it produces is real. If the orchestrator intended C2 to wire the classifier node into the
shipped definitions, this task is materially incomplete and `estimate-run.ts` must be granted.
