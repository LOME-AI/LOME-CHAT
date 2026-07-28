# B9 — api estimator moves onto barrel — impl report 1

**STATUS: NEEDS_CONTEXT. Zero files changed.**

## Objective

The api's estimator reaches the money module only through the barrel, so no `apps/api`
file imports a walled subpath.

## Why this stopped instead of shipping

The task's own NEEDS_CONTEXT trigger fired, and it fired on **every** reference in the
grant, not on an edge case:

> if the barrel genuinely cannot express something the estimator needs, that is a
> finding about the surface — report it with the exact symbol and what it is needed for,
> and do NOT keep the subpath.

**Measured: 32 of 32 distinct symbols that `apps/api` reaches through walled subpaths are
absent from both `@hushbox/shared` and `@hushbox/shared/affordability`.** Not one is an
import-path edit. Every one is named in `BILLING.md` §Where the Code Lives' explicit
"Deliberately **not** exported" list (the minimum-answer constant, tier ratios, the
reasoning-budget ladder, rates, manifests, reducers, per-candidate ceiling solvers,
clamping). Closing any of them means **adding an export to
`packages/shared/src/affordability/index.ts` or `.../estimate/index.ts`** — which B9's
Files list excludes outright ("**Not yours:** anything under `packages/shared` (B8/B8b)").

The one in-grant alternative — rewriting `estimate-run.ts` / `estimate.ts` onto
`getTurnOptions` — is independently forbidden and would move money (§Blocker 2 below).

### Evidence — barrel probe (runtime exports)

Run from `apps/api`, so it resolves exactly as the slice does:

```
$ npx tsx -e "import * as aff from '@hushbox/shared/affordability';
              import * as root from '@hushbox/shared'; ..."

ABSENT    evaluateManifest                        aff=false root=false
ABSENT    reservationCeiling                      aff=false root=false
ABSENT    priceRequest                            aff=false root=false
ABSENT    callManifest                            aff=false root=false
ABSENT    estimateRunCeilingNanoUsd               aff=false root=false
ABSENT    NO_STORAGE                              aff=false root=false
ABSENT    ratesFromPricing                        aff=false root=false
ABSENT    estimateTokensForTier                   aff=false root=false
ABSENT    outputCharsPerTokenForTier              aff=false root=false
ABSENT    WEB_SEARCH_RESERVATION_NANO_PER_MODEL   aff=false root=false
ABSENT    admitSmartModel                         aff=false root=false
ABSENT    classifierReserveLineItems              aff=false root=false
ABSENT    smartModelMinimumRequiredNanoUsd        aff=false root=false
ABSENT    CHARS_PER_TOKEN_STANDARD                aff=false root=false
ABSENT    planReasoning                           aff=false root=false
ABSENT    planReasoningOff                        aff=false root=false
ABSENT    MINIMUM_OUTPUT_TOKENS                   aff=false root=false
ABSENT    turnEffortOptions                       aff=false root=false
ABSENT    resolveEffortForModel                   aff=false root=false
ABSENT    classifierReserveChars                  aff=false root=false
ABSENT    REASONING_BUDGET_TOKENS_BY_EFFORT       aff=false root=false
ABSENT    cheapestClassifierEffort                aff=false root=false
ABSENT    pickClassifiedEffortPlan                aff=false root=false
ABSENT    parseClassifierAnswer                   aff=false root=false
ABSENT    resolveClassifiedEffort                 aff=false root=false
ABSENT    resolveClassifierOutput                 aff=false root=false
---- affordability barrel export count: 138
```

Type-only names do not appear in `Object.keys`, so they were checked separately by
grepping the whole barrel chain (`packages/shared/src/index.ts`,
`affordability/index.ts`, `affordability/estimate/index.ts`,
`affordability/smart-model/index.ts` + its two starred files). All six absent:
`Manifest`, `NanoLineItem`, `DeclaredCeiling`, `NodeStorage`, `SmartModelPoolCandidate`,
`SmartModelStorageContext`.

26 value + 6 type = **32/32 absent**.

---

## Blocker 1 — the criterion's grep cannot be made empty this cycle, by anyone

The brief asks for a repo grep proving emptiness. Here is the command and its **actual,
non-empty** result — reported as measured rather than as claimed:

```
$ grep -rn "@hushbox/shared/affordability/" apps/api --include="*.ts" | wc -l
54

$ grep -rn "@hushbox/shared/affordability/" apps/api --include="*.ts" \
    | sed -E 's#^apps/api/src/slices/([a-z-]+)/.*#\1#' | sort | uniq -c
     19 chat
     27 models
      8 workflows
```

Only the 27 in `models/**` are in B9's grant. The other 27 sit in `chat/**` and
`workflows/**`, and **one of those files is owned by a task running right now**:
`apps/api/src/slices/workflows/nodes/smart-model-execution.ts` carries 3 walled refs and
is on **D1's** concurrent Files list. So even a B9 with an unlimited `packages/shared`
grant could not empty this grep in this cycle without editing a file another live task
owns. The criterion is a run-level end state, not a task-level one; it needs a
`packages/shared` publication decision **plus** re-dispatch over `chat/**` and
`workflows/**` after D1 lands.

---

## Blocker 2 — the `getTurnOptions` rewrite moves money and is already ruled against

The design context proposes expressing the estimator's needs "principally through
`getTurnOptions`". For the two largest units that is not a re-expression, it is a
repricing, and the plan has already ruled it out.

`apps/api/src/slices/chat/domain/turn-ceiling.clamp-order.test.ts` is C3's
cross-implementation pin and is **green in the current tree** (5 tests, exit 0). It
drives both implementations off one fixture (`SPENDABLE = 20_000_000n`,
`PROMPT_CHARS = 1000`, siblings `vendor/tight` cap 2,000 and `vendor/wide` cap 64,000):

| quantity                | module (`getTurnOptions`) | server (`createEstimateRun`) |
| ----------------------- | ------------------------- | ---------------------------- |
| `vendor/wide` cap       | 12,281 tokens             | 22,562 tokens                |
| `vendor/tight` cap      | 2,000 tokens              | 2,000 tokens                 |
| hold                    | 11,774,800n               | 19,999,600n                  |
| unspent remainder       | 8,225,200n                | 400n                         |

Both holds are ≤ `SPENDABLE`, asserted in the test, so `reserve ⊇ bill` holds on both
paths today. Collapsing the server onto `getTurnOptions` would move the wide sibling's
hold from **19,999,600n → 11,774,800n** and its cap from **22,562 → 12,281**.

That is exactly B9's own stop condition ("if any amount changes, stop and report before
proceeding … a moved amount means the two paths were never equivalent"), and it is
independently forbidden: plan §B8, closed 2026-07-27 by C3 and upheld by the
orchestrator, records **"the orders were deliberately NOT collapsed"** with the module as
the presentation authority and the server free to fit longer, bounded by the same
spendable figure.

### And two units have no `getTurnOptions` expression at all, by design

- `estimate.ts`'s `priceUsageBillableNanoUsd` prices **observed usage at settlement**.
  `getTurnOptions` answers "what can start"; it has no expression for "what did this
  cost".
- `estimate-run.ts` prices an **arbitrary compiled workflow definition**, folding
  fan-out width × steps × iterations. `BILLING.md` §Where the DAG lives *designs* this
  split — "Fan-out width, step counts and iteration counts are derived from the workflow
  definition by the engine and passed in as opaque integers" — and the walled
  `estimateRunCeilingNanoUsd(pricing, usage, ceiling, storage)` **is** that seam. The
  doc mandates the seam and the barrel does not publish it.

---

## The exact ask, grouped so B8b can rule per group

Per `BILLING.md` §Where the Code Lives: "If a consumer needs one of these, the producer
is missing a function — that is the wall's own test." Six missing functions, by
capability. Symbols are the current internal names, not proposed public ones.

| # | Capability the api estimator needs | Walled symbols it reaches for | Consumers (all in grant) | Published counterpart today |
|---|---|---|---|---|
| 1 | Price a compiled workflow definition's hold, and price observed usage at settlement | `callManifest`, `estimateRunCeilingNanoUsd`, `NO_STORAGE`, `ratesFromPricing`, `evaluateManifest`, `reservationCeiling`, `Manifest`, `NanoLineItem`, `DeclaredCeiling`, `NodeStorage` | `estimate.ts`, `estimate-run.ts` | **none** — and §Where the DAG lives mandates the seam |
| 2 | Convert the server's own character counts to tokens / storage chars at the payer's tier | `estimateTokensForTier`, `outputCharsPerTokenForTier`, `CHARS_PER_TOKEN_STANDARD`, `CHARS_PER_TOKEN_CONSERVATIVE` | `estimate-run.ts`, `trial-eligibility.ts`, `mock-provider.ts`, `smart-model-candidates.ts` | **none** — "tier ratios", explicitly walled |
| 3 | The billable cost of one trial message on the minimum basis | `priceRequest`, `evaluateManifest` (+ group 2) | `trial-eligibility.ts` | partial: `exceedsTrialBudget` is published, the per-send figure is not |
| 4 | Server-side smart-model pool admission **as manifest line items** | `admitSmartModel`, `classifierReserveLineItems`, `smartModelMinimumRequiredNanoUsd`, `SmartModelPoolCandidate`, `SmartModelStorageContext` | `smart-model-candidates.ts` | `getTurnOptions` yields the client-facing pool, not line items |
| 5 | The per-node web-search reservation | `WEB_SEARCH_RESERVATION_NANO_PER_MODEL` | `estimate-run.ts` | **none** — root barrel comment says the per-call search rate is behind the wall |
| 6 | The reasoning wire plan for the integration adapter | `planReasoning`, `planReasoningOff` | `integration-setup.ts` | **closest to expressible**: `reasoningPlanModelFrom`, `reasoningBudgetForWire`, `ReasoningWire`, `REASONING_OFF_WIRE` are already on `estimate/index.ts`; only these two functions are absent |

Group 6 is the smallest, cheapest ruling and the one I would take first. Note it cannot
be resolved by duplication: `integration-setup.ts:240` records an arch rule that **no
code path sets `reasoning` except via `planReasoning` output**, and Global Constraint 5
bans a second copy regardless.

Group 2 is the same shape — a mirrored ratio constant is precisely the banned
"mirrored constant", so `mock-provider.ts` cannot simply own its own `4`.

---

## Re-derived inventory (B8's counts superseded; B8b gates on this)

Counted on the tree **as C3 left it**, 2026-07-28. Two columns because they answer
different questions and B8's "22" only reproduces on one of them:

| area / kind    | files | specifier lines | symbol bindings |
| -------------- | ----: | --------------: | --------------: |
| chat / prod    |     3 |               9 |              12 |
| chat / test    |     6 |              10 |              10 |
| models / prod  |     6 |              19 |              27 |
| models / test  |     3 |               8 |              10 |
| workflows/prod |     3 |               5 |               7 |
| workflows/test |     3 |               3 |               3 |
| **TOTAL**      |**24** |          **54** |          **69** |

Distinct walled units in use: **models 10 · chat 6 · workflows 3 · 13 distinct
repo-wide**. Repo-wide specifier lines: **79** (54 `apps/api` + 25 `apps/web`; E1 has
been shrinking the web side, down from B8's 96/97).

**B8's "22 in `apps/api/src/slices/models/**`" reproduces exactly** — 22 is the count of
symbols on `import` statements in **production** files under `models/**`
(`integration-setup` 2 · `mock-provider` 1 · `estimate` 7 · `estimate-run` 4 ·
`smart-model-candidates` 4 · `trial-eligibility` 4). The 27 in the table adds the five
walled **re-export** bindings below, which no import-shaped enumeration finds.

### Delta to B8's re-export inventory — five sites, not three

B8 named three walled re-export sites, all in `estimate.ts`. There are **five**, and two
are in a file B8 did not name:

| site | re-exported walled name |
| --- | --- |
| `models/domain/estimate.ts:37-40` | `DeclaredCeiling`, `NodeStorage` (types) |
| `models/domain/estimate.ts:43` | `ratesFromPricing` |
| `models/domain/smart-model-candidates.ts:51` | `CHARS_PER_TOKEN_CONSERVATIVE` **aliased to** `CLASSIFIER_CHARS_PER_TOKEN` |
| `models/domain/smart-model-candidates.ts:55` | `classifierReserveLineItems` |

The alias matters: a walled tier ratio travels under a **different name**, so neither a
specifier grep nor a symbol grep for `CHARS_PER_TOKEN_CONSERVATIVE` finds it downstream.

Bounding it honestly: `CLASSIFIER_CHARS_PER_TOKEN` **is** on the models *domain* barrel
(`models/domain/index.ts:22`) but **is not** on the slice's *public* barrel
(`models/index.ts`) — so this is a slice-internal republication, not a second instance of
B8's public-barrel breach. B8's own unwind did land: `models/domain/index.ts:54-58`
keeps `DeclaredCeiling`/`NodeStorage` off the barrel with `barrel.test.ts` pinning the
absence.

---

## Behaviour identity

Nothing was changed, so identity is trivially preserved; the figures are recorded so the
next cycle has a before-state that was measured rather than assumed.

**Saturating-sibling turn** (`chat/domain/turn-ceiling.clamp-order.test.ts`, 5 tests,
exit 0): the table in Blocker 2. Before == after: module hold 11,774,800n, server hold
19,999,600n, wide cap 12,281 vs 22,562, tight cap 2,000 on both.

**Trial turn** (`models/domain/trial-eligibility.test.ts`):
`trialMessageBillableNanoUsd(target, 10)` = **2,005,000n**, priced provider-only with no
storage term (§Trial Usage, "trial never persists"). Before == after.

**`reserve ⊇ bill`: preserved, neither weakened nor improved.** No pricing path was
touched. Both holds above are asserted ≤ the fixture's `SPENDABLE` (20,000,000n) by the
clamp-order test, which is green. Blocker 2 states the direction a rewrite would have
moved it (down 8,224,800n on the server side) — that would have been a *reduction in
over-reserve*, i.e. safe for the invariant but a changed amount, which is why it stops
here rather than proceeding.

## Vocabulary sweep

Nothing was removed, so the standing post-removal sweep has no subject. Recording the
answer explicitly per the rule: **nothing else found**, because nothing was deleted.

## Self-gate

| command | result |
| --- | --- |
| `vitest run --root apps/api src/slices/models/domain/{trial-eligibility,estimate}.test.ts` | **pass** — 2 files / 75 tests, exit 0 |
| `vitest run --root apps/api src/slices/chat/domain/turn-ceiling.clamp-order.test.ts` | **pass** — 1 file / 5 tests, exit 0 |
| `git status --porcelain -- apps/api/src/slices/models` | 16 modified + 1 untracked, **all pre-existing** (B8/C3); zero authored by this task |
| `npx turbo typecheck --force --continue` | **pass** — 16/16 successful, 0 cached, exit 0. Tree-state reading, not evidence about this task (zero files changed); recorded because C3/D1/E1 are live. |

No `pnpm test:api` sweep was run and none is cited. It would have proved nothing about a
zero-file change, and §Known Breakage is explicit that a single green api sweep is
uninformative while the chat-integration failing set moves.

**One procedural note, recorded because it produced a false red.** Four early runs of
`npx tsx scripts/with-env.ts development -- npx vitest …` returned **zero output and exit
1**. That is not the documented timeout class — `with-env.ts` takes the command directly
(`with-env.ts <command> [...args]`), with no mode argument and no `--`, so it was trying
to execute a binary named `development`. `execa` runs with `stdio: 'inherit'` and
`reject: false`, so an ENOENT surfaces as a silent exit 1. Same reading trap as the
timed-out-gate entry: silence from a misinvocation is indistinguishable from silence
from a clean run, and the flattering reading is the wrong one. Establishing why took one
`with-env.ts … echo hello` probe.

## Deviations

None — no code was written. The task's stated stop condition was met and the stop was
taken rather than widening the wall or keeping the subpaths.

## Concerns and limitations

- **Plan identifiers in shipped comments** (durable-naming violation, pre-existing, in a
  file I own): `models/adapters/integration-setup.ts:240` and `:281` both cite "G1" —
  `(G1: no code path sets 'reasoning' except via planReasoning output)`. Left in place;
  it is outside B9's acceptance criteria and is not mine to clean up mid-run. The fact
  the comment records is real and worth keeping; only the label needs to go.
- **The 27 walled refs outside `models/**` have no owner again.** The plan assigned them
  to "lane C covers the chat turn", but C3 has landed and `chat/domain/{turn-definition,
  turn-reasoning,smart-model-turn}.ts` and `workflows/nodes/{turn-decision,
  model-call-execution,smart-model-execution}.ts` still carry them. Three of those
  symbols — `parseClassifierAnswer`, `resolveClassifiedEffort`, `pickClassifiedEffortPlan`
  in `workflows/nodes/turn-decision.ts` — do have published counterparts
  (`chooseFrom` / `wireFor` on the barrel), so that file is the one genuinely
  import-rewritable site in `apps/api`. It is not in B9's grant.

## Confidence

**High** that the blocker is real and correctly diagnosed: the barrel probe is executable
and reproducible, the 32/32 absence is exhaustive rather than sampled, the ruled
no-collapse decision is quoted from the plan and its amounts re-measured green in the
tree, and D1's concurrent ownership of `smart-model-execution.ts` is checkable from the
brief. **Medium** on the six-group decomposition being the right *shape* of fix — it is
the honest statement of what each consumer needs, but which names join the documented
surface is B8b's ruling and the founder's, not mine.
