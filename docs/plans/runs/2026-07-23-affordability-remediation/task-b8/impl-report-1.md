# B8 — impl report 1 — STOPPED, NEEDS_CONTEXT (no files changed)

## Objective

Land the six documented public exports on the barrel, flip every consumer off the 14 interim
per-unit subpaths, delete those 14 export-map entries, add `ModelId` as a branded string, land
premium marking's data (`releasedAtMs` + `nowMs`), and pin the barrel to the documented surface
by set equality.

## Status

**Stopped before the first edit.** `git status --porcelain` for
`packages/shared/package.json`, `packages/shared/src/affordability/index.ts` and
`packages/shared/src/index.ts` is empty; no production file, test, doc or export map was
touched by this agent. Everything below is read-only verification.

Four of the acceptance criteria are unsatisfiable as written **at this position in the spine**,
and three of them are unsatisfiable *independently* of each other. This is the same shape as the
defect the plan itself records against B1b's original criteria ("A criterion demanding the barrel
expose 'only the feature surface' is therefore unsatisfiable at this position in the spine, and
was corrected to this split before dispatch", plan `:786-789`) — so the resolution is an
orchestrator re-scope, not an implementer judgment call. My standing instruction is explicit for
the deletion half: *a live consumer you cannot cleanly rewire within ownership is a
NEEDS_CONTEXT stop, not a judgment call.*

---

## What I verified (all first-hand, this session)

### 1. The inbox, re-derived from the tree rather than from B1b's report

`packages/shared/package.json` carries exactly **14** `./affordability/*` per-unit entries
(`budget`, `constants`, `estimate/{classifier-line-item, effort-options, pre-adapters,
price-request, reasoning-plan, reducers, run-ceiling, search-reservation,
smart-model-affordability, types}`, `smart-model/{effort-dimension, resolve}`).

Enumerated every `@hushbox/shared/affordability/…` deep specifier under `apps/`, `packages/`,
`e2e/`, `scripts/` (excluding `node_modules` and `apps/api/.wrangler/tmp/**` build artifacts):

**29 files · 98 symbol references · 13 units in use.**

The plan's stated totals are 28 files / 102 references / 14 units. The deltas are both explained
and neither is a discrepancy:

- **+1 file**: `apps/api/src/slices/workflows/nodes/turn-decision.ts` is new and untracked —
  C1 created it after B1b's enumeration, and it imports two walled symbols.
- **−1 unit in use**: `./affordability/budget` has **zero** consumers anywhere. It is the one
  entry deletable today with no consumer work at all.
- The 102 vs 98 reference count is a counting convention (import statements vs. imported
  symbols); I counted imported symbols, per-file per-unit, and list all 98 below.
- Errata item 2 confirmed: `apps/web/src/hooks/billing/use-budget-calculation.test.ts` has **no**
  `affordability/constants` reach. The phantom is absent from my enumeration.
- Errata item 3 is moot as predicted: `packages/shared/src/models/premium-check.ts` **no longer
  exists** (B2 moved it to `affordability/premium.ts`), and nothing outside the module reaches it.

Per-unit reference counts:

| unit | refs | wall category (`BILLING.md` §Where the Code Lives) |
| --- | ---: | --- |
| `constants` | 9 | minimum-answer constant; tier ratios |
| `estimate/effort-options` | 9 | reasoning-budget ladder |
| `estimate/pre-adapters` | 18 | tier ratios; ceiling solver (`computePromptCapacity`) |
| `estimate/price-request` | 6 | manifests |
| `estimate/reasoning-plan` | 14 | reasoning-budget ladder |
| `estimate/reducers` | 9 | reducers |
| `estimate/run-ceiling` | 5 | per-candidate ceiling solvers (re-export site) |
| `estimate/search-reservation` | 3 | rates |
| `estimate/smart-model-affordability` | 12 | per-candidate ceiling solvers |
| `estimate/types` | 5 | manifests |
| `estimate/classifier-line-item` | 1 | rates |
| `smart-model/effort-dimension` | 6 | classifier-answer reducers |
| `smart-model/resolve` | 1 | classifier-answer reducers |
| `budget` | **0** | — (no consumer) |

### 2. Blocker A — 91 of the 98 references have no barrel destination, by design

Every symbol in the first eleven rows above is on the module's **deliberately-not-exported**
list, and each is pinned absent from *both* barrels by B1b's `WALLED_EXPORTS` test
(`packages/shared/src/affordability/index.test.ts`, grouped in the doc's own category order).
"Flip the consumer from the internal path to the barrel" therefore has exactly three possible
readings, and all three are closed to me:

1. **Re-export the walled symbols from the barrel.** Directly reverses B1b (whose absence tests
   would go red) and breaches `BILLING.md` §Where the Code Lives. Not available.
2. **Rewrite the consumers onto the public producer** (`getTurnOptions` and friends). This is the
   correct end state and is what the wall's own doctrine says ("if a consumer needs one of these,
   the producer is a missing function"). But it is **~4,270 lines across 11 primary modules** —
   `turn-definition.ts` (1,110), `use-prompt-budget.ts` (737), `estimate-run.ts` (670),
   `reasoning-effort-menu.tsx` (344), `turn-reasoning.ts` (257), `use-budget-calculation.ts` (243),
   `smart-model-candidates.ts` (243), `estimate.ts` (231), `trial-eligibility.ts` (178),
   `use-media-cost-estimate.ts` (126), `use-reasoning-effort.ts` (128) — plus their tests. Two of
   those files are owned by **in-flight C2**, `hooks/billing/*` is owned by **E1** per the plan's
   own ownership table (`:2582`), and `use-media-cost-estimate.ts` is **G2 only** (`:2581`). E1
   and G2 both depend on B8, so the rewrite cannot be inside B8 and inside E1 at once.
3. **Leave them and delete the entries anyway.** Breaks the repo (TS2307 × 91).

Only **7** of the 98 references have a documented public replacement — the classifier-answer
family (`parseClassifierAnswer`, `resolveClassifiedEffort`, `pickClassifiedEffortPlan`,
`resolveClassifierOutput`) that `chooseFrom`/`wireFor` are meant to supersede — and 6 of those 7
sit in files I may not touch (see Blocker C).

### 3. Blocker B — three of the six documented exports have no producer, and one is uncertain

Grep across `packages/shared/src`, `apps/api/src`, `apps/web/src`: `chooseFrom`, `renderOptions`
and a public `notices(...)` **do not exist anywhere**; the only `wireFor` in the repo is a local
parameter name inside `estimate/reasoning-plan.ts:207`. Against the documented signatures:

| documented export | producer today | verdict |
| --- | --- | --- |
| `getTurnOptions(funding, basis, selection, catalog)` | `affordability/turn-options.ts:39` — exact | **exists**, just needs publishing |
| `resolveFunding(inputs)` | `billing/funding-decision.ts:173` `resolveFundingDecision(inputs)` | **cosmetic rename** — safe |
| `chooseFrom(options, rawAnswer)` — *total, resolves against the presented set, applies the declared fallback* | pieces only, at **dimension** granularity: `dimensions/derive.ts` `parseDimensionAnswer(spec, support, raw)` + `cheapestPresentedOption(spec, model, support)`; `smart-model/resolve.ts` `resolveClassifierOutput(raw, eligibleIds): string \| null` (model-only, **not total** — returns `null`, carries no fallback) | **no producer at the documented signature** |
| `renderOptions(options)` | `dimensions/derive.ts:214` `renderDimensionSection(spec, support)` (per dimension); `smart-model/prompts.ts:122` `buildClassifierSystemPrompt(ClassifierPromptDimensions)` (already a separately-documented seam) | **no producer at the documented signature**, and a naive one would be a second authority for the string `buildClassifierSystemPrompt` already owns |
| `wireFor(chosen, modelId)` | `DimensionSpec.wire(model, option)` per dimension; `smart-model/effort-dimension.ts:102` `pickClassifiedEffortPlan` | **no producer at the documented signature** |
| `notices(decision, options)` | `affordability/notices.ts` exports `noticeFor(reason)` / `noticeText(reason)` / `NOTICE_COPY`; the whole file is **absent from both barrels** | **no producer at the documented signature** |

Writing the missing four means composing over `OptionSet` / `DimensionAvailability` back to
`(spec, support, model)` — new design work, not a rename. The criterion "**No wrapper exists
whose only purpose is to satisfy a name** — if one seemed necessary, the mismatch is reported
instead" is the criterion I am obeying by reporting rather than writing them. Whether these are
"missing producers B8 should build" or "`BILLING.md` signatures that should be corrected to the
dimension-granular shapes that exist" is a founder/orchestrator call, not mine.

### 4. Blocker C — file ownership collides with in-flight C2

Of the 7 flippable references, 6 live in files I was told to hand off or that C2 owns:

| file:line-ish | symbols | disposition |
| --- | --- | --- |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.ts:9,14,15` | `planReasoningOff`; `parseClassifierAnswer`, `pickClassifiedEffortPlan`, `resolveClassifiedEffort`; `resolveClassifierOutput` | **HANDOFF to C2** — brief-named C2 file |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts:11` | `REASONING_BUDGET_TOKENS_BY_EFFORT` | **HANDOFF to C2** — the test of a C2 file; C2 will be editing it |
| `apps/api/src/slices/chat/domain/smart-model-turn.ts:*` | `MINIMUM_OUTPUT_TOKENS`, `turnEffortOptions` | **HANDOFF to C2** — brief-named C2 file (walled anyway, see Blocker A) |
| `apps/api/src/slices/chat/domain/smart-model-turn.test.ts:*` | `MINIMUM_OUTPUT_TOKENS`, `REASONING_BUDGET_TOKENS_BY_EFFORT` | **HANDOFF to C2** (walled anyway) |
| `apps/api/src/slices/workflows/nodes/model-call-execution.ts:9` | `pickClassifiedEffortPlan` | mine, but blocked on `wireFor` existing (Blocker B) |
| `apps/api/src/slices/workflows/nodes/turn-decision.ts:6` | `parseClassifierAnswer`, `resolveClassifiedEffort` | mine, but blocked on `chooseFrom` existing (Blocker B) |

The other three brief-named C2 files (`workflows/engine/settlement.ts`,
`workflows/engine/interpreter.ts`, `chat/domain/settlement.ts`) carry **no** affordability deep
specifier, so they are not in the inbox at all — no handoff needed for those.

### 5. Blocker D — set equality against the documented list is a ~103-name deletion

Measured at runtime by importing the barrels (the same mechanism a set-equality test would use):

```
affordability barrel runtime exports: 123
root barrel names shared with the affordability barrel: 117
```

The documented list is 6 exports plus five seams (storage-fee function, tier + premium
classification, dimension registry as data, `buildClassifierSystemPrompt`, money formatting) —
generously ~20 concrete names. Set equality therefore means deleting ~103 currently-published
names, including `getUserTier`, `MODALITIES`, `ModelDescriptor`, `DIMENSIONS`, `nanoUSD`,
`MAX_ALLOWED_NEGATIVE_BALANCE_CENTS`, the whole fee/pricing display set and the whole catalog
admission set — each with live consumers across `apps/api`, `apps/web`, `scripts` and `e2e`.
That is a repo-wide contract change an order of magnitude larger than the rest of this task, and
it is not what the criterion's stated purpose ("B1b pinned absence; this pins totality, so a leak
added later fails") requires: totality can be pinned against an **explicit allowlist** in the
test without deleting anything. Which of the two the criterion means is load-bearing and
unstated, so I am not choosing it silently.

Note also that **none** of the six documented exports is on either barrel today —
`affordability/index.ts` does not export `turn-options.js`, `turn-types.js` or `notices.js` at
all. So the "documented surface" and the "actual surface" are currently **disjoint** on the
feature half and overlapping only on the seams.

### 6. Errata items 4 and 5, reported as facts (they need a ruling, not my guess)

- **`estimateOk` / `estimateErr`**: zero consumers outside `packages/shared` (grepped `apps`,
  `packages/db`, `packages/realtime`, `e2e`, `scripts`). Nothing breaks if they come off; nothing
  is served by keeping them. Their disposition is entangled with Blocker D's ruling.
- **`affordability/catalog-admission.ts`** (A1): its only reach outside the module is
  `apps/api/src/slices/models/domain/refresh.integration.test.ts`. Production ingestion consumes
  it through the barrel from inside the api slice. Same entanglement.

### 7. The premium-marking data — feasible, and the one criterion with no blocker

Verified the inputs exist and the shape is clean:

- `ModelDescriptor` already carries `releasedAt: z.number()`
  (`affordability/model-descriptor.ts:121`), so `priceableModelFrom` can populate a new
  `releasedAtMs` without a new data source.
- `premium.ts` **already** takes time as an argument — `PremiumClassificationInput.nowMs`
  (`:93`) with the comment "An argument, not `Date.now()`: this module reads no clock". So the
  money core reads no clock today and would still read none; `nowMs` would ride
  `getTurnOptions`' input and reach `isPremiumModel` unchanged.
- `turn-types.ts:111-119` already declares the TIER-axis refusal codes
  (`premium_requires_account`, `premium_requires_credit`) precisely so a premium row can be
  MARKED, and states that the data does not reach a `PriceableModel` — which is exactly the gap
  this criterion closes.
- One comment would have to be corrected, not merely edited: `priceable-model.ts:9-12` currently
  asserts "A release timestamp … [is] deliberately NOT here". Landing `releasedAtMs` invalidates
  that sentence.
- Cost, stated honestly: `PriceableModel` is constructed in fixtures across `packages/shared`,
  `apps/api` and `apps/web` tests; adding a required field is a repo-wide sweep under Global
  Constraint 10.

This criterion is **separable and unblocked**. So is `ModelId` as a branded string (also a
repo-wide sweep: `turn-types.ts:79-80,182` and `priceable-model.ts:23` are the declaration
sites), and so is publishing `getTurnOptions` + renaming `resolveFundingDecision` →
`resolveFunding`.

---

## Files changed

None. Verification was read-only; `git status --porcelain` for every file this task would own is
empty.

## Tests added

None — stopped before the first RED.

## Self-gate

Not run. Nothing was changed, so there is nothing to gate; running the suites would only report
the concurrent workstreams' state (§Known Breakage), which is not evidence about this task.

## Acceptance criteria

| criterion | met | evidence |
| --- | --- | --- |
| `ModelId` branded string | not met — not started | separable and unblocked (§7) |
| six exports on the barrel under documented names | **not met — 3 have no producer, 1 uncertain** | §3, grep: `chooseFrom`/`renderOptions`/public `notices` do not exist |
| barrel is exactly the documented surface (set equality) | **not met — ambiguous and ~103 deletions wide** | §5, 123 runtime exports measured |
| every inbox consumer flipped to the barrel | **not met — 91/98 refs have no barrel destination** | §2, §1 |
| delete the 14 subpath entries, prove non-resolution | **not met — blocked by the above** | §2; only `./affordability/budget` is deletable today |
| premium marking data (`releasedAtMs`, `nowMs`) | not met — not started | separable and unblocked (§7) |
| no wrapper exists only to satisfy a name | **held** — reported the four mismatches instead of writing adapters | §3 |
| no behaviour change | held trivially — no change made | `git status` |

## Deviations

None — no work was performed. The stop itself is the deviation from "implement", and it is
mandated by the brief's own NEEDS_CONTEXT triggers (a documented export name whose producer
cannot supply the signature; a re-export site whose consumers would need a contract change I was
not granted) and by the standing rule on deletion criteria with live consumers.

## Concerns and limitations

- **The `T`-clamp criterion (plan `:1606-1620`) is downstream of the stop.** It becomes reachable
  only once `getTurnOptions` has a production consumer; since wiring that consumer is exactly the
  work Blocker A puts out of reach, I could not collapse the two clamp orders nor pin the
  saturating-sibling case. Whichever task ends up wiring the first production consumer inherits
  it — it must not be dropped in the re-scope.
- **`BILLING.md` editing rights are contradictory in the plan** and I did not resolve them by
  acting. `:124` says ".md files are read-only to subagents"; `:95` (ruling 6) says "a task that
  invalidates a normative statement corrects it in that task", and this task's own premium
  criterion says the signature change is "this task's surface to land **and document**". A
  re-scoped brief should say plainly whether the implementer may edit `docs/BILLING.md`.
- **Reported, not decided, per the brief:** the walled types `DeclaredCeiling` and `NodeStorage`
  travel out of the money module through `apps/api/src/slices/models/domain/estimate.ts:38-39,43`
  → `models/domain/index.ts:55` → `models/index.ts:38`, i.e. onto the **models slice's own public
  barrel**. Verified present. It is load-bearing: `estimate.ts:227-228` uses both as its public
  function signature's parameter types, so removing the republication is a contract change for
  every caller of that API, not an import edit. Neither barrel's absence test nor G1 rule 6 sees
  it (they read the shared package's export map only). Founder question, per the plan.
- **A suggested split, offered as material and not as a decision** (it mirrors the B1 → B1b split
  the plan already used):
  1. **B8a — surface, additive only.** Publish `getTurnOptions` + `TurnOptions`/`OptionSet`/
     `Selection`/`FundingSnapshot`/`RefusalCode` types, rename `resolveFundingDecision` →
     `resolveFunding`, land `ModelId` branding, land `releasedAtMs` + `nowMs` with the two pinned
     premium cases, and pin **totality against an explicit allowlist** (not a ~103-name
     deletion). Unblocks E1's premium marking immediately. Touches no C2 file.
  2. **A founder ruling** on the four missing producers (build `chooseFrom`/`wireFor`/
     `renderOptions`/`notices` at the documented signatures, or correct `BILLING.md` to the
     dimension-granular shapes that exist), plus the disposition of `estimateOk`/`estimateErr`
     and `catalog-admission`, plus the slice-barrel republication above.
  3. **B8b — the consumer migration**, sequenced *after* the api rewrites (lane C) and the web
     adapter-hook collapse (E1) rather than before them, since those tasks are what remove the
     walled reaches. It ends by deleting the 14 entries and proving TS2307. G1 hangs off B8b, not
     B8a.
  Under that split, `./affordability/budget` can be deleted in B8a today: zero consumers.

## Confidence

**High** that the four criteria are unsatisfiable as written — each rests on a first-hand
measurement in this session (98 enumerated references with their wall categories; 123 runtime
barrel exports; a repo-wide grep showing four documented names absent; the ownership table's own
assignment of `hooks/billing/*` to E1 and `use-media-cost-estimate.ts` to G2).
**High** that stopping was correct rather than partially delivering: every partial path either
reverses B1b, edits an in-flight task's files, or leaves the tree half-migrated across a package
boundary while C2 runs.
