# C3 — impl report 5 — the clamp-order residual, closed

## Objective

Close B8's cross-implementation `T`-clamp amount comparison — the residual assigned to whoever
holds `turn-definition.ts`, which is me.

## The comparison, with both amounts

One fixture, deliberately B8's own down to the rates and the funding, so the two sides answer the
same question. Two 200,000-context siblings at 100n input / 200n output, 20,000,000n spendable,
a 1,000-character prompt; `vendor/tight` has a 2,000-token provider cap and saturates,
`vendor/wide` has 64,000 and does not.

| | module (`getTurnOptions`) | server (`fitAnswerCapToCeiling`) |
| --- | --- | --- |
| saturated sibling | **2,000** | **2,000** |
| wide sibling | **12,281** | **22,562** |
| hold | **11,774,800n** | **19,999,600n** |
| funding left unspent | **8,225,200n** | **400n** |

**Which order is authoritative, and for what.** `BILLING.md` §Sharing one budget across siblings
fixes the module's order: `T` is solved against the **unclamped** summed cost, and each sibling's
physical bounds clamp afterwards. That is the spec, and it is authoritative for **what is
presented** and for the hold the client computes. The server's fit prices the
**already-clamped** definition and raises the cap until the priced total meets the funds, so the
saturated sibling's unused room is released to the sibling that can use it — 8,224,800 of the
8,225,200 nano the module leaves on the table.

**Why the divergence is safe, stated as the direction rather than as a claim of agreement.** Both
sides solve against the *same* spendable figure (the test asserts
`payerSpendableNanoUsd(BUDGET) === 20,000,000n`, the module's own input), and the fit gates on
`priced ≤ spendable`. So the server can only **lengthen an answer** — it can never admit a send the
client refused, and never holds past the funds. And the presented ceiling is the **smaller** of the
two, so the served number is not a promise the run breaks: §Data Structures allows an
over-presented ceiling to degrade to a shorter answer, and this direction cannot even do that.

**Why this is not the banned cross-check.** Global Constraint 5 bans a test proving two
implementations *agree*, as a substitute for sharing one. This asserts they **diverge**, by exactly
how much and in which direction; it fails if the gap closes silently or changes sign, either of
which means one side moved without the other. B8 refused to re-derive the solver inside
`packages/shared` for precisely the reason that would have been the banned shape; I hold the real
solver, so the comparison runs against it rather than a twin.

I did **not** collapse the two orders. Doing so would either cost a paid user 8.2M nano of
deliverable answer on this shape, or change what the client presents — neither is mine to decide,
and B8's resolution was "state the authority and pin by amount", which is now done on both sides.

**Pinned:** `apps/api/src/slices/chat/domain/turn-ceiling.clamp-order.test.ts` (5 tests). The
agreement assertion on the saturated sibling is deliberate — it isolates the divergence to the
**order** rather than to the fixture. All five amounts were derived from first principles before
running and matched the measurement exactly, which is the strongest form of knowing why a
characterization pin passes.

The divergence is now also named where a reader of the solver will meet it: `fitAnswerCapToCeiling`'s
docblock states the clamp order, says it differs from the module's on purpose, gives the direction
that makes it safe, and points at the pin file. That is the "pin it, then the comment may point at
it" form — no quantity is quoted in the prose.

## A live defect the sweep caught on the way

Adding `RUN_CAPACITY_REACHED` last cycle gave the run-cap refusal its own code — and
`RUN_REFUSAL_STATUS` is a `Partial<Record<…>>` whose **fallthrough is 409**. The refusal would have
answered **409 instead of 402**, silently changing how every client handles it, because splitting a
wording moved the code out of a status map I had not looked at.

Found by following the sweep's own vocabulary ("collapse every refusal", "one code") into
`realtime-do.ts`, whose comment names the status map as the thing that assigns HTTP status per
code. Fixed with a map entry holding the status exactly where it was, and pinned in
`app-mount.integration.test.ts`. **Proven to discriminate:** I removed the entry, watched the pin
fail with `expected 409 to be 402`, and restored the file byte-exact (`diff` verified).

That is the second time this cycle the vocabulary sweep found a defect rather than a stale
sentence.

## Final vocabulary sweep

Swept every mechanism this task changed, across all owned files: the derived classifier, the
withheld client context, the suppressed preamble, the consumed-node storage rule, the answer-cap
class rule, the collapsed fallback, the split refusal code, and the clamp order.

- **One falsified-by-omission site**, fixed: `fitAnswerCapToCeiling`'s docblock described its own
  clamp order accurately but never said it diverges from the spec's `T` — a reader would have
  assumed the module's order. Now stated with a pointer to the pin.
- **One live defect**, above (the 409/402 fallthrough).
- Checked and left alone: the `'always'`/`'every'` claims in `model-call-execution.ts` (all about
  image inline cost, untouched by this task); `realtime-do.ts`'s refusal-class comment (an open
  list ending in "…", so a new code does not falsify it); the "single input port" claims (about node
  ports, still one each).
- `grep` clean, repo-wide: `CLASSIFIER_EFFORT_FALLBACK`, `_pinned`, `'medium'`-as-a-fallback.

Across the five cycles the sweep has found **12 falsified comments and 2 live defects**, and in
every cycle at least one sat outside the diff's hunks.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:api` | 7 template-html failures (documented) **+ 2 chat-integration trial failures — attributed outward, see below** |
| `turbo typecheck --force` (api + shared) | **2/2** |
| `eslint` from `apps/api`, 8 files touched this cycle | **exit 0**, empty output |
| scoped coverage, `turn-definition.ts` over the whole chat slice | **99.60% statements / 97.63% branches** (248/249, 165/169) |

**The two trial failures are the documented moving set.** "starts a trial run (201) echoing the
supplied session id" and "starts a trial run when custom instructions are supplied" both live in
`routes.integration.test.ts`, which **passes 188/188 in isolation** — the determinism test
§Known Breakage prescribes. §Known Breakage names "trial `201→403`" as one of the four members it
observed. I attributed inward first as the standing rule requires: my diff adds no catalog fixture
and writes no state another suite reads. The immediately preceding full run of essentially this
code had zero chat-integration failures, which is the moving-set behaviour itself.

## A strengthening of the coverage entry I contributed

The new §Known-Breakage entry says a scoped run missing the driving suites reads like a real
shortfall. This cycle produced a sharper case: **the same command over the same glob returned
87.68% lines and then 99.60%.** Nothing functional changed between them — the second run's
`coverage-final.json` shows a single uncovered statement out of 249. So the instrument is unstable
run-to-run under load, not merely sensitive to which suites you include, and the api coverage table
never printing leaves no cross-check. **Read a scoped shortfall from the JSON and re-run before
believing it** — I nearly reported a 12-point regression that does not exist.

## Confidence

**High.** The clamp-order amounts were predicted before measurement and matched; the status-map pin
was proven to discriminate by inversion with a byte-exact restore; and the one red I am attributing
outward passes 188/188 in isolation.

## State at hand-off

Closed across cycles 2–5: the derived-classifier mechanism and all four pins · the multi-model
`auto` wiring · the two-fallbacks collapse · graceful degrade · partial-success billing over three
outcomes · fork tip · the presented-set narrowing · `_pinned` · the run-cap refusal split · the
clamp-order amount.

Open, each with its reason recorded: `reserve ⊇ bill` as a property (moved to H1) · the
`budget-exceeded` scope split and `send_cannot_start` deletion (blocked, flagged to the founder) ·
single-model `auto`, the Smart-Model slot, the web-search arm and trial `auto` (not mine;
reachability assessed in report 4, with trial's 1¢ ceiling flagged as the one money risk).
