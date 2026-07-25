# Plan — Affordability, Billing & Effort Remediation (Tier 2)

**Complete rewrite, 2026-07-25**, superseding the original plan and its sixteen amendments.
The design phase that followed the original plan changed the shape of the remaining work, so
the surviving amendments are folded inline here and the stale ones are gone. Task numbering
restarts under lettered lanes; the original T-numbers appear only in §Disposition so a reader
can map old ledger entries.

`docs/BILLING.md` is the specification. It is normative, it is current, and it is the only
place billing semantics live. **Every brief in this run — implementer, auditor, fixer,
validator, critic — must read it in full.**

---

## Handoff — read first (you know nothing about this run)

You are the orchestrator. Execute via the `subagent-driven-dev` skill: you write no
production code; every task is implementer subagent → auditor subagent(s) → your judgment;
fix→re-audit loops; ledger every transition in `ledger.md`. Re-confirm with the human only
where you must deviate from this plan; deviations are recorded here as amendments.

**What happened before you.** A prior orchestrator planned and executed 12 tasks to clean.
Work then stopped on a blocker: the spec promised classifier-resolved effort on multi-model
turns, which was not buildable as designed. A design phase followed — four adversarial
analysts, five focused agents, and a legacy-regression sweep — and produced a ruled design
now written into `docs/BILLING.md`. The design phase also disproved several things the
earlier plan assumed. Read `BILLING.md`, then this plan, then `ledger.md` for
ruling history. **Do not reconstruct the design from the ledger; `BILLING.md` wins.**

**Two documents were deleted from `research/` by an untracked-file wipe** (a git operation by
concurrent work). Their content is in `BILLING.md` and `ledger.md`. Do not recreate them:
anything durable belongs in `BILLING.md`, anything about execution belongs here.

**Non-negotiables** (from the repo's `CLAUDE.md` chain, restated because they bite here):
strict TDD — failing test first, watched red, minimal green; 95% per-file coverage is part of
`pnpm test`; schema edits ship their generated migration (CI fails on drift); no agent runs a
git command that writes state; `.md` files are read-only to subagents.

---

## The completeness contract

**When this plan is done, every aspect of `docs/BILLING.md` is realized in code.** That is the
run's definition of finished — not "the tasks passed", but "the specification is true of the
system".

Two consequences bind execution:

- **A normative clause with no owning task is a planning defect.** If an implementer or auditor
  finds a `BILLING.md` statement that no task claims, that is a gap to report, not a clause to
  ignore. It becomes an amendment with an owner.
- **A task is not done because its criteria passed.** Its criteria exist to make the relevant
  clauses true. Where a criterion could be satisfied without making its clause true, the
  criterion is wrong and the auditor should say so.

**Already-true clauses need verification, not a task.** `BILLING.md` documents the whole billing
system, most of which this run does not change — Payments, New User Bonus, Balance Consumption,
Tier derivation, Trial quota mechanics, the Billing Flow's settlement steps. A clause that is
already true of the system is realized; the correct report is "verified true at `file:line`",
not a new task. Only a clause the code contradicts, or one nothing implements, is a gap. An
auditor or critic that manufactures tasks for working behaviour has misread this section.

The close phase's completeness critic audits against `BILLING.md` directly, section by section,
rather than against this plan's task list — because the task list is the thing under suspicion.

## Global Constraints

Implicitly part of every task's acceptance criteria and every auditor's lens.

1. **`docs/BILLING.md` is required reading for every subagent, in full.** Section references
   in tasks below (§Catalog Admission, §Affordability 7, …) are normative acceptance criteria.
2. **TDD.** Failing test first, watched red for the expected reason, minimal green. A test
   that passes on first run is evidence of nothing and must be rewritten.
3. **Money is nano-USD `bigint` end to end.** `NanoUSD` strings at JSON boundaries, never
   `Number()`-coerced on any path that feeds a charge, hold, or comparison.
4. **No fee application outside the two seams** (catalog ingestion, provider-cost conversion
   at the ModelProvider port). No rate arithmetic outside the affordability module.
5. **One implementation, shared.** A `keep in sync` comment, a mirrored constant, or a test
   proving two implementations agree is a defect, not a resolution. If you are about to write
   one, the task is wrong — stop and report.
6. **Content-free money layer.** No export of the affordability module accepts a prompt, a
   message, or a history array. Counts, rates and ids only.
7. **Zero existing users.** No data-migration backfill, no coexistence windows. Schema changes
   still ship a generated migration for the drift gate.
8. **No plan or task identifiers in shipped code.** No `A1`, `B3`, `T14`, "step 2 of 3", or
   run references in comments, test names, or commit-adjacent text. Comments record durable
   facts about the code.
9. **Re-lint after the final edit.** Run `eslint <owned files>` from the owning package
   directory and get exit 0 _after_ the last edit, not before. `eslint --fix` from the repo
   root silently no-ops under this ESLint version.
10. **Contract-change sweep.** A task changing a shared type, a Zod schema, or a cross-package
    invariant must grep repo-wide for every producer and consumer — including `scripts/`,
    `e2e/`, `apps/marketing`, `apps/admin` — list them with a disposition, and run repo-wide
    `pnpm typecheck`, not only the scoped filter.
11. **No E2E execution this run** (human ruling). E2E _code_ changes remain in scope and are
    delivered lint- and typecheck-clean but unexecuted. Running them is founder-owned.
12. **Attribute around the known failures in §Known Breakage.** Never "fix" a failure your
    task did not cause, and never claim a green run you did not observe.

---

## Known Breakage — attribute around, do not chase

Verified pre-existing at the time of writing. If a scoped run shows one of these, it is not
yours.

- **A concurrent workstream is live in this repo** — notifications/push, the document sandbox,
  service worker, and TTS work all have uncommitted files and their own failures. Never edit
  or "fix" a file outside your task's ownership list.
- **`packages/shared/src/env.config.ts` + notifications typechecks** may be red from that
  workstream. Repo-wide typecheck can therefore be red for reasons that are not yours; scoped
  package typechecks are the meaningful gate until it clears.
- **`scripts` suite collection failure** in `refresh-catalog-run.test.ts` and `seed-run.test.ts`
  — the test runner mangles an SSR-optimized dependency URL under `vi.mock` + `importOriginal`.
  The tests pass when collected. Needs an owner outside this run.
- **`packages/db` `schema.integration.test.ts` "creates exactly the inventory tables"** fails
  intermittently when a parallel worker leaves a scratch table in the shared database. Passes
  in isolation.
- **`packages/config` `pnpm test` can fail its pole gate** — one rule test clocks over half the
  package's test-work under load. The file is unmodified by this run.
- **An orphan `email=''` user row** intermittently appears in the shared dev database and breaks
  email-verification tests. Clear it and re-run; do not chase a product bug.
- **Environment gotcha:** the bundler pre-bundles `@hushbox/shared`. After editing shared code,
  clear `node_modules/.vite` at the root and in `apps/api` / `apps/web` before trusting a test
  result.

---

## Disposition of prior work

**Clean and unaffected — do not revisit:** catalog max-output ingestion · fee baking at
ingestion + descriptor v2 · estimator billable-only refactor · port billable conversion +
consumer deletion sweep · the fee-seam arch rule · output-cap bound · `GET /billing/spendable`
· hold-aware budget scopes · client served-numbers + nano cleanup · preview/send input parity ·
sender on billed rows · group budget lifecycle + guest denial · the fixture repair.
(Original T01–T10, T18, T19, T22.)

**Superseded by this plan — their landed code is a starting point, not a contract:**

| Original | What it shipped                                      | Superseded by                                                             |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| T11      | shared `turnEffortOptions` / `resolveEffortForModel` | **B2/B6** — becomes one dimension's registry entry                        |
| T12      | client union menu + picker greying                   | **E1** — surfaces render the produced sets; its held fix re-audit is moot |
| T13      | server effort resolution, static auto path deleted   | **B6/C3** — one resolver; multi-model auto now works                      |

**Never started, replaced entirely:** original T14–T17, T20, T21.

---

## Lane A — Catalog admission (independent, no dependencies)

### A1 — Restore the catalog price floor, age cutoff, and context exemption

**Objective:** a model that cannot be sold profitably never enters the catalog, and the
operator summary says how many were excluded and why.

**Design context.** §Catalog Admission is normative and states the rationale — **profit** —
which is the load-bearing part: this rule was previously deleted precisely because it shipped
without a recorded reason. The rules restore verified legacy behaviour: zero combined price is
excluded unconditionally and first; below `$0.0002` per 1K combined tokens on the **raw pre-fee**
rate is excluded; older than two years is excluded; a model in the top 5% of context length
(measured over the ZDR-filtered pool) is exempt from the floor **and** the age cutoff but never
from the zero-price check. Text models only — a per-token floor is meaningless for per-unit
media pricing and none is applied.

This is also load-bearing on the classifier: the engine is the cheapest priceable model, so
without the floor it resolves to a free model and the classifier reserve collapses to zero.

**Acceptance criteria:**

- Three new members of the closed exclusion-reason set: zero-priced, below-price-floor, too-old.
  They sit in the quiet-expected group (not the fail-closed group that warns), so the hourly
  refresh line counts and prints them with no extra instrumentation.
- The floor tests the **pre-fee** combined rate, evaluated before fee baking at the ingestion
  choke point.
- The top-context exemption is computed over the ZDR-filtered pool and applies to the floor and
  the age cutoff only. A test pins that a free model with the largest context in the fixture is
  still excluded.
- When a model fails both the floor and the age cutoff the reported reason is deterministic
  (price first), pinned by test so counts are stable across runs.
- New constants are named and exported from the constants module: the floor, the age limit, the
  context percentile.
- Fixture-level tests for each rule and each exemption path; a summary-formatting test showing
  the three reasons appear in the operator line.

- **The seeded catalog survives:** every model id referenced by seed data or E2E fixtures is still
  admitted, or those fixtures are updated in this task. Excluding models at ingestion changes what a
  seeded local catalog contains, and the scoped API/shared suites cannot see `scripts/` seeds or
  `e2e/` fixtures.

**Files:** `apps/api/src/slices/models/domain/normalize.ts` (language path + the exclusion-reason
set), the **money half** of the split constants (B1 owns the split — A1 runs after it), `scripts/`
seeds and `e2e/` fixtures if the criterion above requires, plus colocated tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; `turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/shared`.
**Sensitive:** money — 2 independent auditors.

---

## Lane B — The affordability module (the spine)

Strictly sequential: each task owns files the next one edits.

### B1 — Move the money math behind one barrel

**Objective:** relocate the closed money set into `packages/shared/src/affordability/`. **Behaviour
identity is the whole point of this task** — the wall is closed by B1b, not here.

**Design context.** §Where the Code Lives. Bounded directory rather than a workspace package is
settled and evidence-backed; the extraction trigger is recorded in that section — do not pre-empt it.

The closed set that must move together (leaving any behind creates a cycle): the estimate directory,
the smart-model directory, the billing directory, `money.ts`, `nano-usd.ts`, `tiers.ts`, `budget.ts`,
`fees.ts`, `pricing.ts`, `reasoning-effort.ts`, `model-descriptor.ts`, `modality.ts`, `param-spec.ts`,
the string-distance utility, and a split of `constants.ts` into money and non-money halves.
**Decide and report** whether `models/premium-check.ts` moves inside — it is premium classification,
a structural seam in §Where the Code Lives, and it imports the money set today.

**Do not** write the criterion "deep paths do not resolve from outside" — the package exports map has
no wildcard subpath, so that is **already true** and the criterion would be vacuous.

**Acceptance criteria:**

- The closed set relocated; a new narrow subpath entry in the exports map alongside the existing ones.
- No cycle: nothing inside the module imports a non-money shared module except through an enumerated
  allowlist, and that allowlist is written down in this task for B1b and G1 to enforce.
- `constants.ts` split with no re-export bridge (a bridge is laundering). Its colocated test splits
  with it — this is a permitted semantic test change and must be listed explicitly, because the rest
  of this task permits import-path edits only.
- The module imports no database or cache package.
- **Behaviour identity demonstrated, not asserted:** every package suite passes with no test file
  semantically modified beyond the `constants` split. List every touched test and why.
- **Produce the `BILLING.md` path-diff** as a proposal (do not edit the doc): every path citation
  this move invalidates, with its replacement. There are roughly fourteen, across the Configuration
  Reference and the inline citations in Fee Structure, Storage Fees, the Funding Matrix, Model
  Classification, Tier derivation and New User Bonus.

**Files:** `packages/shared/src/**` (the closed set), every importer repo-wide, `packages/shared/package.json`.
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`; `pnpm lint:unused`.
**Sensitive:** money — 2 independent auditors.

### B1b — Close the export wall (removal half)

**Objective:** make §Where the Code Lives' "deliberately not exported" list true, using the
producers that exist **today**.

**Design context.** The leak is not deep imports — it is the root barrel. `packages/shared/src/index.ts`
`export *`s the whole money set, so `apps/web` imports `MINIMUM_OUTPUT_TOKENS`, `evaluateManifest`,
`planReasoning`, `priceRequest` and `turnEffortOptions` from the package root today, and an api module
re-exports a tier-ratio constant. Closing this **necessarily breaks consumers**, and repairing them is
this task's work — not a behaviour-identity violation to avoid.

**This task is deliberately the removal half only.** The six-export feature surface
(`getTurnOptions`, `chooseFrom`, `wireFor`, `renderOptions`, `resolveFunding`, `notices`) does not
exist yet — B3, B6, B7 and C1 build it. A criterion demanding the barrel expose "only the feature
surface" is therefore unsatisfiable at this position in the spine, and was corrected to this split
before dispatch. **B8 lands the surface** once its producers exist; consumers repaired here are
repointed at internal module paths in the interim, and B8 flips them onto the barrel.

**Acceptance criteria:**

- Every symbol on §Where the Code Lives' not-exported list is **absent from the root barrel**. A test
  imports the root barrel and asserts absence, symbol by symbol.
- Each removed export is dispositioned one of three ways, enumerated per consumer: repointed at an
  internal module path (the interim state B8 closes), replaced by a producer that **already** exists,
  or its consumer deleted. A consumer repointed internally is listed explicitly as B8's inbox.
- No consumer outside the module references a rate, a manifest, a reducer, a ceiling solver, a tier
  ratio, the ladder, or the minimum-answer constant **through the root barrel**. Grep-clean, listed.

**Files:** `packages/shared/src/index.ts`, `packages/shared/src/affordability/index.ts`, every consumer the closure breaks, tests.
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`.
**Sensitive:** money — 2 independent auditors.

### B2 — The dimension registry

**Objective:** one registry entry describes a cost-affecting dimension completely; everything a
dimension author could get wrong about money is derived rather than declared.

**Design context.** §The Dimension Framework. `ParamSpec` is the **option domain** and must be
_consumed_, not extended: it is a `z.strictObject` persisted inside the jsonb descriptor, so it cannot
carry function fields, and a strict object rejects new keys. `DimensionSpec` is therefore a
non-persisted code registry that **references** a per-model `ParamSpec` for its option values — which
is what keeps option domains single-sourced without inventing a second one.

`PriceableModel` is the narrow projection the module consumes instead of the descriptor, so a new
catalog field cannot reshape money inputs.

**Acceptance criteria:**

- `DimensionSpec` and `PriceableModel` exist per §Data Structures. `DimensionSpec` reads its option
  values from the model's `ParamSpec`; a test pins that adding a value to the catalog spec changes the
  offered options with no registry edit.
- `DIMENSIONS` contains the model and effort entries. A non-enumerable dimension declared open is
  rejected at registration; pinned.
- `deliversAtHoldCeiling: false` has a measurable effect: a multiplicative dimension's worst option
  determines the delivered ceiling even when the cheapest is chosen. Pinned — a declared field with no
  behaviour is a comment.
- Derived, with a test each: reserve contribution from resource + cost class; prompt section from the
  description plus option labels; answer parsing from option ids; the failure fallback as the cheapest
  presented option; whether a classifier is bought (≥2 **distinct resolved** requirements, not ≥2 labels).
- `resolution` is a two-value enum, not a callback. Property test: no resolution moves upward except
  the mandatory-reasoning carve-out.
- **One vocabulary per rung.** The id set contains no `none`; `Min` is the label for reasoning-off and
  `off` is its persisted value. Today three tokens exist for that rung (`none` as an id labelled `Min`,
  and `off` in the persistence design) — collapse them here, before D1 writes a column.
- The `medium` ↔ `Mid` mapping is single-sourced; no user-facing surface or classifier prompt emits an id.
- **The re-partition invariant is pinned executably:** for every model and every presented option, the
  priced ceiling derived from `maxB(m)` is unchanged.

**Files:** `packages/shared/src/affordability/dimensions/**`, `reasoning-effort.ts` (vocabulary), tests.
**Scoped checks:** `pnpm test:shared`; typecheck/lint shared.
**Sensitive:** money — 2 independent auditors.

### B3 — `getTurnOptions`: one producer, two sets

**Objective:** the single mint, and the arithmetic vocabulary the specification defines.

**Design context.** §Affordability (the four notions, principles 1–11), §Math & Terms, §Data
Structures. One entry point evaluating one pure core twice — against `effectiveBalance` for
`affordable`, against `spendable` for `admissible`. The pair **derives the reason**: outside
`affordable` is money, inside `affordable` but outside `admissible` is a hold.

**The ruled call pattern — build exactly this.** `getTurnOptions(funding, basis, selection)` is called
**once**, with the composed basis, and internally evaluates one pure core over two `(funding, basis)`
pairs: `(effectiveBalance, EMPTY_BASIS)` → `affordable`, `(spendable, basis)` → `admissible`. **The
producer substitutes the empty basis itself; no caller ever supplies one.** This was ruled after the
review found three `BILLING.md` statements disagreeing on the pattern — the alternative (callers make
two calls with different bases) leaves the real-basis call returning a prompt-dependent `affordable`
that the type's own doc comment invites surfaces to grey from, which §Scope forbids. Under the ruled
shape that state is unobtainable rather than merely discouraged.

`holdNanoUsd` lives on `TurnOptions`, **not** on `OptionSet` — a hold is only ever taken against
`spendable`, so an affordable-side hold is a value with no meaning and must not be representable.

**Acceptance criteria:**

- `TurnOptions` returns the pair plus `holdNanoUsd`; `OptionSet` carries `runnable: NonEmpty` beside
  `all` and **no hold field**, so sendable-with-nothing-runnable and an affordable-side hold are both
  compile errors to write.
- **One call, two evaluations:** a test spies the core and asserts it ran exactly twice per call, with
  the empty basis on the `affordable` pass. No exported signature accepts a basis for `affordable`.
- `PromptBasis` carries components with the total derived. `Selection` requires ≥1 answer source.
- Options are **marked, never filtered**; a test asserts no code path removes an entry.
- `admissible ⊆ affordable` as a property test over generated funding/prompt/selection triples. The
  property must hold across **both** differing inputs, since the sets differ in funding _and_ basis.
- **Completeness:** `presented == feasible` over every model × option assignment, over the
  `admissible` set. The fixture must be non-degenerate — **≥3 models, ≥2 dimensions, one
  mandatory-reasoning model, one plateau-collapsed pair** — because one model with one option
  satisfies the words otherwise.
- **The floor is prompt-independent and hold-blind:** a keystroke sweep leaves `affordable`
  byte-identical, while a pin, a sibling change or a modality change alters it. Both pinned.
- **The arithmetic vocabulary exists as named exports and every call site uses it:** `variableRate(m)`
  (output rate plus per-token storage when the turn persists, bare output rate when it does not),
  `fixedCosts` (input tokens at rate, `inputStorage`, `classifierReserve` when a classifier runs, plus
  any additive dimension). Pinned **by amount**, not by structure.
- **Storage drops on non-persisting turns:** a trial result contains zero storage line items in both
  legs, and the classifier leg carries none on any tier.
- **Inverted output-storage ratios** (paid 2, others 4) with every division rounding against the user;
  pinned on a paid/free pair with identical character counts.
- **Cache reads price at the full input rate**; pinned.
- **Web search reserves 10 × $0.005 × model count**; pinned by amount on a three-model turn.
- Pure: no clock, no I/O, no randomness — asserted structurally, not by comment.

**Files:** `packages/shared/src/affordability/turn-options.ts` and the pricing internals it composes, tests.
**Scoped checks:** `pnpm test:shared`; typecheck/lint shared.
**Sensitive:** money — 2 independent auditors.

### B4 — The shared-budget solve

**Objective:** N siblings sharing one funding number get one shared token count and per-model physical
ceilings.

**Design context.** §Math & Terms → Sharing one budget across siblings. `T` is a **solve variable**;
the **priced basis is `Σᵢ cost(mᵢ, ceiling(mᵢ))`** with each ceiling clamped by its own bounds. Those
are different things and the distinction is load-bearing: §Multi-Model 2 forbids a summed-rate
approximation over a single shared token count as a _basis_, so computing the hold as `T × Σrates`
would violate the specification while looking like it satisfies this task.

**Correction to earlier planning — read this before touching code.** `fitAnswerCapToCeiling`
(`turn-definition.ts:440`) is **not** a second estimator and must **not** be deleted. Its docblock
records the opposite: it calls the canonical `createEstimateRun` precisely to eliminate a second cost
formula, because the per-rate guess applies markup per rate while admission applies it to the subtotal,
and that drift caused live 402 refusals. **The thing to delete is the guess** — the summed-rate answer
cap sizing (`turnMaxOutputTokens` / `answerMaxOutputTokens`) that the fit exists to reconcile.

**Acceptance criteria:**

- `T` solved once per turn; each sibling's ceiling applies its own `providerCap` and `contextHeadroom`.
  Pinned on a heterogeneous pair: the large-context sibling is **not** capped by the small one.
- The reserved amount is `Σᵢ cost(mᵢ, ceiling(mᵢ))`, never `T × Σrates`. Pinned by amount.
- **Verified against the admission estimator, not the module's own cost function:** for every generated
  turn, `createEstimateRun(compiled definition) ≤ funding`. A property test over the module's
  arithmetic alone would miss the integer-nano markup drift that caused the historical 402s.
- `inputStorage` appears **exactly once** in a three-sibling hold; pinned by amount.
- A smart slot's `MAX` over candidates enters the `T` solve; pinned.
- The summed-rate guess is deleted; grep-clean. The fit survives.
- The duplicated value-store byte-budget constant is hoisted to one home and its "MUST stay in sync"
  comment removed with it. The _other_ such comment in that file documents a genuine dual guard and is
  **out of scope** — do not delete it.

**Files:** `packages/shared/src/affordability/**`, `apps/api/src/slices/chat/domain/turn-definition.ts`, `apps/api/src/slices/models/domain/estimate-run.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; typecheck/lint both.
**Sensitive:** money — 2 independent auditors.

### B5 — Outlier exclusion and resolved-corner eligibility

**Objective:** a high-cost outlier cannot tax every other candidate's ceiling, and eligibility is
graded on the corner a model can actually reach.

**Design context.** §Smart Model 1–3, §Predicates. The hold is a `MAX` over the pool, so one extreme
candidate sets the hold for every turn the pool appears in. The median is taken over the **priceable
catalog pool** — not the eligible pool, which would make the test balance-dependent.

**Acceptance criteria:**

- `outlier(m)` as specified. Balance-independence pinned: same catalog and prompt yield the same
  exclusion set at two different balances.
- Excluded models remain explicitly selectable; pinned.
- **`eligible(m)` grades on `B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS`, never on an unreachable zero.**
  Pinned on a mandatory-reasoning model whose ceiling fits the minimum answer but not the minimum
  answer plus its lowest rung — it must be excluded.
- Deterministic total order on the catalog read with an identifier tiebreak; a test pins that row order
  cannot change which model classifies.
- **The biconditional threshold pinned by a balance sweep:** the client's empty-pool verdict equals the
  server's at every point across the sweep.
- Fixture with a synthetic outlier: hold falls, presented set grows, the outlier absent from candidates
  and present in the picker.

**Files:** `packages/shared/src/affordability/**`, `apps/api/src/slices/models/domain/{smart-model-candidates,catalog-store}.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

### B6 — One effort resolver, and the spend bound it carries

**Objective:** delete the resolver that can resolve upward **without deleting the guarantee it
currently provides**.

**Design context.** §Reasoning Effort 4. Two resolvers exist; one orders by nearest distance with ties
preferring lower, so a nearer rung _above_ beats a farther rung below — which the ruled rule forbids.

**The trap:** that same function is what currently guarantees a classified pick can never spend past
its reserve — its returned plan's `maxTokens` always equals the already-held completion cap. Deleting
it removes both the bug and the bound. The bound must be re-established here, not assumed.

**Acceptance criteria:**

- One resolver remains, downward-only with the mandatory-reasoning carve-out. The distance-sorting
  implementation is deleted; grep-clean.
- **`e_min(m)` exists as a named function**: `Min` when reasoning is disableable, the lowest offered
  rung otherwise. Pinned on both shapes.
- **The spend bound survives the deletion:** for every model and every classified level, the wire cap
  equals the held ceiling — `B + H == ceiling` — property-pinned. A classified pick can never exceed
  the priced ceiling.
- The classifier's effort options come from the registry entry with user-facing labels including Min,
  Lite and Max. The hardcoded level triple is deleted.
- Distinctness measured on the **resolved requirement**: a plateau-collapsed pair is one option and buys
  no classifier call. Pinned on a real collapsing shape.
- Property test: every model's feasible set is a downward-closed prefix — no gaps.
- **The classifier's shared context is truncated at 4,000 characters** (§Reasoning Effort 6), pinned by
  amount on an over-long history. This clause had no owner until the pre-execution review; the figure
  is documented but was never verified against code, so **report whether the shipped truncation
  already matches it** — if the code disagrees with the doc, that is a finding for the founder, not a
  number to quietly change on either side.

**Files:** `packages/shared/src/affordability/**` (effort dimension, resolver, classifier prompt assembly), tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`.
**Sensitive:** money — 2 independent auditors.

### B7 — Notices: typed reasons, derived copy

**Objective:** one vocabulary, one wording per condition, every notice naming an action.

**Design context.** §Notices & Refusals 1–9. A rich notification system already exists with severity,
dismissibility and link segments, and most copy already names cause and action — this is
**consolidation, not invention**. The defect is two parallel copy systems describing one condition
differently: three phrasings for balance-too-low, three for premium-locked, two for guest-has-no-budget.

**Acceptance criteria:**

- Copy derives from the typed reason in one place. An enumeration test over **every** reason asserts
  exactly one wording exists for it.
- **Every** reason's copy contains an action clause — not the three named in this criterion. The
  enumeration test covers all of them.
- **No copy names an amount, a token count, or a threshold** (§Notices 6). Asserted by the same
  enumeration over every string.
- **Severity is structural and biconditional:** blocking ⇒ error and non-dismissible; informational ⇒
  dismissible; and a blocked send always carries a notice while a notice never blocks a send the verdict
  permits. Both directions pinned.
- Precedence: money if the funding cannot cover a minimum answer, else length. Pinned where both would
  otherwise be true.
- The hold-versus-balance distinction produces different copy; the hold notice's action is "wait", it
  offers no payment path, and **it names no conversation**.
- The guest reason implies no top-up path.
- The payer-switch disclosure fires for a member with no allocation as well as one whose allocation ran out.
- **The concurrent-run-cap refusal has a typed reason with one wording and an action.**
- **A top-up against a negative balance discloses the deficit and the net credit before submit**
  (§Fee Structure). Currently absent entirely.
- The three notices that name a cause with no action gain one.

**Files:** `packages/shared/src/affordability/notices.ts`, `packages/shared/src/error-codes.ts`, the budget-notification module (post-B1 path), the payment surface, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`.
**Sensitive:** no.

### B8 — Land the public surface (depends on B7 and C1)

**Objective:** the six exports of §The public surface exist under those names, and every consumer
B1b repointed internally now goes through the barrel.

**Design context.** B1b removed the leaked exports but could not land the replacements, because
`getTurnOptions` (B3), `renderOptions` and the classifier prompt assembly (B6), `notices` (B7),
`wireFor` (B2's `wire`) and `chooseFrom` (C1's reducer logic) are built across the spine and into
lane C. This task is the second half of B1b: it closes the interim state rather than introducing
new behaviour. `resolveFunding` already exists as an export today — F2 changes its behaviour, not
its name, so B8 does not wait on F2.

**The naming question this task decides and reports.** The six documented names are the contract;
several producers currently exist under different names. Where a rename is cosmetic, rename to the
documented name — a wrong name is treated like a wrong comment. Where the documented name would
imply a different signature than the producer actually has, report the mismatch rather than
inventing an adapter: that is a `BILLING.md` defect for the founder, not a wrapper to write.

**Acceptance criteria:**

- All six exports exist on the barrel under their documented names, plus the named structural seams
  (the two fee applications, the storage-fee function, tier and premium classification, the
  dimension registry as data, money formatting).
- **The barrel is exactly the documented surface:** a test enumerates the root barrel's affordability
  exports and asserts set equality against the documented list — not merely that the forbidden ones
  are absent. B1b pinned absence; this pins totality, so a leak added later fails.
- Every consumer on B1b's reported inbox is flipped from an internal path to the barrel; the
  enumerated list is discharged item by item, none deferred.
- **No wrapper exists whose only purpose is to satisfy a name.** If one seemed necessary, the
  mismatch is reported instead.
- No behaviour change: every package suite passes with no test semantically modified beyond import
  paths and renames. List every touched test and why.

**Files:** `packages/shared/src/index.ts`, `packages/shared/src/affordability/index.ts`, the producers being renamed, B1b's repointed consumers, tests.
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`; `pnpm lint:unused`.
**Sensitive:** money — 2 independent auditors.

## Lane C — The classifier mechanism (depends on B2, B6)

### C1 — The decision envelope

**Objective:** a runtime decision reaches N consumers through the existing single input port, with no
new node type and no relaxed compile invariant.

**Design context.** §Reasoning Effort → How the decision reaches the answer, and §Mechanisms rejected.
Verified: a `fanIn` node's arity comes from its registered reducer's type tuple; the capability schema
registry is **empty and was built for this**; node input is validated per node and every produced value
is type-checked at commit.

**Correction to earlier planning.** Withholding the classifier's stream is _not_ a single registration
flag. The grant is per-registration, but the model-call execution hardcodes streaming for the **whole
node type** — so making one call non-streaming needs a **second** additive workflow-schema field
threaded through the live execution registry. Two fields, not one, and the registry file is in scope.

**Acceptance criteria:**

- One registered decision-envelope schema — the **first** entry in the capability schema registry.
- One registered reducer taking the prompt and an optional classifier answer, returning the envelope:
  parse, clamp to the printed ceiling, and the declared fallback in one pure function.
- Two additive schema fields: the node's registered input schema, and its streaming disposition. No
  existing definition changes shape; pinned.
- **Compile-layer invariants untouched:** a test asserts the one-input-port rule is unchanged and still
  fires for a genuine violation.
- The classifier emits no stream event; pinned by asserting zero events for that node.
- The envelope flows through schema derivation and fails closed on a malformed value.

**Files:** `packages/shared/src/workflow.ts` (two additive fields), `apps/api/src/slices/workflows/engine/{workflow-capabilities,live-execution-registry}.ts`, the reducer, `apps/api/src/slices/workflows/nodes/model-call-execution.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; repo-wide typecheck.
**Sensitive:** money-adjacent — 2 independent auditors.

### C2 — Smart Model consumes the decision, and the charge lands

**Objective:** one classifier per turn for the whole product, and its charge is billed rather than
silently absorbed.

**Design context.** The model dimension stays on the node holding the candidate set, because a `MAX`
over alternatives is only expressible there.

**The money bug this task exists to avoid.** The existing anchor helper resolves a charge's content by
stripping the last `#` segment of its key — it can only name its **own node's** content. That works
today because the classifier charge lives inside the Smart Model node. Once the classifier is a
turn-level node, a parent-strip resolves nothing, and settlement `continue`s past a charge with no
anchor — the "reserve is a lie" failure §Reasoning Effort names. Naming the classifier after the first
sibling does **not** fix it: when sibling 1 fails and sibling 2 persists — an explicitly supported
outcome — the anchor is undefined again and the charge vanishes.

**Acceptance criteria:**

- Settlement resolves a **run-level** anchor: the first persisted content item of the run in
  deterministic order. The anchor rule change is this task's scope, not just its caller.
- **Pinned on the failure shape that matters:** a multi-model turn where the first sibling fails and a
  later one persists — the classifier charge lands, with the right amount, on the persisted item.
- With an envelope present the slot performs **no** classifier call; pinned by call count.
- Reserve remains `MAX` over candidates; the hold is unchanged by this refactor; pinned.
- **The equivalence invariant** (§Smart Model 8): a Smart-Model-resolved model is sized exactly as a
  direct pick minus the classifier cost, on the same catalog and prompt.
- The internal classifier path is deleted; grep-clean.

**Files:** `apps/api/src/slices/workflows/nodes/smart-model-execution.ts`, `apps/api/src/slices/chat/domain/smart-model-turn.ts`, `apps/api/src/slices/workflows/engine/settlement.ts`, tests.
**Scoped checks:** `pnpm test:api`.
**Sensitive:** money — 2 independent auditors.

### C3 — Multi-model auto, the original blocker

**Objective:** `auto` on a multi-model turn resolves through the classifier for every sibling.

**Design context.** §Turn Stories 2 is the step-by-step specification. This is the promise the run
stopped on; the interim reasoning-free behaviour is deleted here.

**Acceptance criteria:**

- The ladder is pruned against pinned siblings first; a level infeasible for any pinned sibling is gone
  turn-wide.
- Each candidate carries its own effort ceiling, capped by the tightest pinned sibling; candidates with
  no feasible effort are excluded.
- **The classifier is presented the `admissible` set, never `affordable`.** §Affordability calls this
  the one place where the wrong set is a money defect. Pinned: with a live hold, an option present in
  `affordable` and absent from `admissible` does not appear in the prompt.
- **The classifier engine is chosen from the post-admission priceable pool.** A fixture containing an
  excluded free model asserts it is never the engine — this is what makes §Catalog Admission
  load-bearing rather than decorative.
- One classifier call carries both dimensions on **labelled** lines; a test pins that a third dimension
  does not break the parser.
- The chosen effort applies to all siblings, resolved per model; each sibling's wire cap is its own
  budget plus its own headroom.
- An explicit level on a multi-model turn is never rewritten to `auto`; pinned (a live defect today).
- Web-search and trial `auto` turns run the classifier. **The trial smart path** substitutes the fixed
  per-message ceiling for a wallet and runs the same math, classifier included; pinned.
- **Partial-success billing** (§Multi-Model 4): a three-sibling integration test over the three
  outcomes — partial, all-fail, explicit stop — asserting charge counts. All-fail persists and bills
  nothing.
- **The last successful sibling becomes the fork tip**; pinned on three siblings.
- **`reserve ⊇ bill` over reachable outcomes**, not just the shared-ceiling inequality: a property or
  fuzz test asserting `hold ≥ Σ charges` across partial success, deadline partial, user stop and
  cost-circuit trip.

**Files:** `apps/api/src/slices/chat/domain/{turn-definition,turn-reasoning,smart-model-turn}.ts`, `apps/api/src/slices/chat/routes.ts` (refusal mapping only), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

## Lane D — Persistence and display (depends on C2)

### D1 — Persist the resolved effort

**Objective:** each generation records the effort it actually ran at.

**Design context.** §Reasoning Effort 10. It goes on `llm_completions`, beside `reasoningTokens`,
because that table holds language-specific facts while the content row holds modality-agnostic
display data — and because the history read already joins it. A nullable pgEnum: null when the
concept does not apply, `off` when the user chose Min. **No capture point exists today** — the
resolved value is computed and consumed immediately, so it must be threaded from the node's billing
metadata through the settlement charge into the row.

**Acceptance criteria:**

- New pgEnum and nullable column; migration generated and committed with the schema change; the db
  shape-test registry updated.
- Threaded end to end: resolved effort → node billing metadata → settlement charge input → row.
  An integration test on a real turn asserts the persisted value.
- Null versus `off` distinguished, pinned: a non-reasoning model persists null, an explicit Min
  persists `off`.
- **Totality, scoped to text**: every persisted assistant **text** content item has an
  `llm_completions` row, so the badge can never be missing its data. Media items have no such row —
  scope the assertion or it passes vacuously.

**Files:** `packages/db/src/schema/{llm-completions,enums}.ts` + migration, `apps/api/src/slices/workflows/engine/{execution-registry,settlement}.ts`, `apps/api/src/slices/billing/domain/charge.ts`, `apps/api/src/slices/workflows/nodes/smart-model-execution.ts`, tests.
**Scoped checks:** `pnpm test:db`, `pnpm test:api`; migration drift gate.
**Sensitive:** money-adjacent, schema — 2 independent auditors.

### D2 — The effort badge

**Objective:** the answer shows what effort it ran at, using the Smart Model badge component.

**Design context.** The Smart chip lives in the assistant nametag component and is driven by a
boolean on the message. The effort badge sits beside the model name using **the same component**.

**Implementation trap, stated because it is easy to get wrong:** the existing per-content-item
helper **sums** `reasoningTokens` across the several completion rows of one item — one per agentic
step. Summing is right for tokens and **wrong for an enum**. The level is constant across a turn's
steps and must be taken, not aggregated.

**Acceptance criteria:**

- The level reaches the client through the history read and the finish frame, mirroring how the
  token count already does.
- The badge renders beside the model name, reusing the existing chip component; absent level ⇒ no
  badge; `off` ⇒ a Min badge.
- A test pins take-not-sum across a multi-step generation.
- The multi-model case: each sibling's badge shows its own resolved level, so a downgraded sibling
  says so.

**Files:** `apps/api/src/slices/conversations/{adapters/stores.ts,domain/history.ts,ports/stores.ts}`, `packages/shared/src/schemas/api/{conversations,sse-events}.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/chat/message/message-item.tsx`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`, `pnpm test:shared`; repo-wide typecheck.
**Sensitive:** no.

---

## Lane E — Client surfaces (depends on B5, B6, B7, B8)

### E1 — Every surface renders the produced sets

**Objective:** the picker, the effort menu, the search toggle, the media panel and the send gate render
one produced value, and **the client's own verdict engine is deleted**.

**Design context.** §Affordability (the four notions, principle 1), §Notices 9. Greying comes from
`affordable`, the send gate from `admissible`.

**The hole to close deliberately.** The second verdict engine is a **hook, not a component** — the
prompt-budget hook contains a floor computation, a candidate-pool builder and a token-pricing builder,
and imports manifest and reasoning primitives directly. A criterion phrased "no component may import a
pricing function" is satisfiable while all of that keeps computing. Deletion is the criterion.

**Also in scope, because no other task owns them:** the model-validation and default-model hooks derive
premium access from the **balance endpoint**, which §Affordability 4 says is not an affordability input
— and one of them _removes_ premium selections from the store, violating "marked, never filtered".

**Acceptance criteria:**

- All greying derives from `affordable`; the send gate from `admissible`.
- **The local verdict engine is deleted:** the floor computation, the pool builder and the pricing
  builder are gone; grep-clean; `apps/web` imports no affordability symbol outside the feature surface.
- No surface derives funding or premium access from the balance endpoint; premium rows are **marked, not
  removed** from the selection store.
- Every disabled option carries its typed reason as a tooltip and an accessible description.
- The menu's enable rule is existential; pinning culls the candidate set. Both pinned.
- A hold-caused shortfall blocks the send and leaves the picker normal; a balance shortfall greys. Both
  pinned with distinct copy, and **exactly one** hold notice renders for a multi-model selection.
- The remaining intersection clamp is retired; union-only levels de-grey.
- A below-floor selected row is de-selectable — a greying model must not trap the user.
- **No text-modality surface renders a pre-send cost figure** (§Affordability 11); media still may.
- **The remaining trial message count reaches the client and renders before it binds** (§Trial Usage).
- Component tests: heterogeneous multi-model selection, trial greying, picker greying, a single-choice
  model with auto enabled, and the hold-versus-balance pair.

**Files:** `apps/web/src/hooks/billing/*` (except the media-cost hook — G2 owns it), `apps/web/src/hooks/chat/use-reasoning-effort.ts`, `apps/web/src/hooks/models/*`, `apps/web/src/components/chat/{model-selector/*,input/*,budget/*}`, tests.
**Scoped checks:** `pnpm test:web`; typecheck/lint web.
**Sensitive:** no.

### E2 — Every paid action carries the verdict

**Objective:** queueing, draining and regenerating cannot spend what the send gate would refuse.

**Design context.** §Notices 8. Verified current state: the queue store gates only on a count and
never reads the blocking-error state; the drain sends with a hardcoded funding source because "the
composer's per-keystroke budget resolution isn't available at drain time"; regenerate is gated on
role, mode, privilege and streaming state with no money check.

**Acceptance criteria:**

- The queue button reads the same verdict as send.
- The drain **re-resolves** funding and affordability per message at drain time rather than assuming
  a source. On refusal it stops, restores the text, and leaves the remaining queue intact — the
  existing recovery behaviour, now reached deliberately.
- Regenerate reads the verdict and disables with a reason.
- Tests: a queued message that becomes unaffordable before draining; a regenerate blocked by
  balance; a regenerate blocked by a hold showing the transient reason.

**Files:** `apps/web/src/stores/message-queue.ts`, `apps/web/src/hooks/chat/use-authenticated-chat.ts`, `apps/web/src/lib/message-actions.ts`, `apps/web/src/components/chat/input/prompt-input.tsx`, `apps/web/src/components/chat/message/message-item.tsx`, tests.
**Scoped checks:** `pnpm test:web`.
**Sensitive:** no.

### E3 — Freshness

**Objective:** a released hold is visible immediately, on every surface.

**Design context — the premise earlier planning got wrong.** Spendable invalidation is **not**
conversation-scoped: the realtime hook invalidates the global spendable key with no argument, on
socket-ready catch-up and on both run frames. The real gap is that the hook is **only mounted from the
group-chat path**, so a surface with no socket receives no frame at all — and with focus refetching off
and a five-minute stale time, its blackout can outlive the run indefinitely. A criterion phrased
"invalidate regardless of conversation" therefore passes with **zero production change**.

**Acceptance criteria:**

- Identify and report every surface that renders affordability without mounting the realtime hook. Each
  either mounts it or obtains freshness another way; enumerate the disposition.
- Focus refetching enabled for the spendable and conversation-budget keys specifically, not globally.
- Invalidation fires on socket-ready catch-up, `run-started` and `run-finished` — all three
  (§Affordability 1), pinned.
- A test reproduces the stale blackout on a socket-less surface and shows it cleared.

**Files:** `apps/web/src/providers/query-provider.tsx`, `apps/web/src/hooks/realtime/use-realtime-sync.ts`, the mount sites, tests.
**Scoped checks:** `pnpm test:web`.
**Sensitive:** no.

### E4 — Media parameters as dimensions

**Objective:** resolution, duration and aspect ratio become registry entries, so the media picker
greys like the text picker.

**Design context.** §The Dimension Framework, §Extending → Add a modality. Verified: three unlinked
validation layers describe the same values today — the request schema, the untyped node params
record, and raw range checks inside pricing and the byte-floor estimator — with no compile-time link.
Aspect ratio is a **zero-cost** dimension; duration is **continuous** when the catalog declares no
discrete set, so it may be pinned but never opened to the classifier; resolution keys a price matrix.

**Acceptance criteria:**

- Entries registered with resource, cost class, ordered/enumerable, and per-unit reference cost.
- Media rows grey on affordability — the current state greys nothing at any balance.
- The three validation layers collapse to one derived from the registry.
- A continuous dimension is rejected if declared open; pinned.
- A zero-cost dimension skips affordability entirely; pinned.

- **`maxCallCost` gains a per-unit reference quantity** — one image, or N seconds at a resolution — so
  media models produce a finite value and participate in the outlier median. A token-shaped bound is
  never applied to per-unit pricing; pinned.

**Files:** `packages/shared/src/affordability/dimensions/**`, `packages/shared/src/schemas/api/conversations.ts`, `apps/api/src/slices/chat/domain/turn-definition.ts` (media params only — **after B4 and C3**), `apps/web/src/components/chat/media/modality-config-panel.tsx` (sole owner), `apps/web/src/hooks/billing/use-media-cost-estimate.ts` is **G2's**, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`, `pnpm test:web`.
**Sensitive:** money — 2 independent auditors.

---

## Lane F — Group funding fixes (independent)

### F1 — Payer-scoped served numbers

**Objective:** the client computes affordability from the wallet that will actually pay.

**Design context.** §Group Funding 1, §Data Structures (`FundingSnapshot`). The endpoint derives its
user from the calling principal while admission gates on the payer's wallet at the payer's tier — wrong
balance _and_ wrong tier in every group conversation.

**This is a contract change, not a handler edit.** The endpoint takes no conversation id and returns
only the two money fields, while `FundingSnapshot` also requires `tier` and `payer`. Serving the payer's
numbers requires a request-shape change, the shared API schema, and the typed client — so Global
Constraint 10's sweep applies, and the new key shape must be reconciled with E3's invalidation.

**Acceptance criteria:**

- The endpoint accepts the conversation context and serves the payer's numbers plus `tier` and `payer`.
  Contract test: the served figure equals the group's hold-aware remaining at the payer's tier.
- The shared schema and typed client are updated together; repo-wide typecheck green.
- **The key shape is reconciled with E3:** whatever scoping the key gains, invalidation still fires for
  every surface. Coordinate explicitly — a conversation-scoped key silently breaks E3's guarantee.
- Client sizing inputs take the payer's tier.
- Guests and self-funded turns unchanged; pinned.

**Files:** `apps/api/src/slices/billing/{routes.ts,domain/spendable.ts}`, `packages/shared/src/schemas/api/billing.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/hooks/billing/*` (inputs only), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`, `pnpm test:shared`; repo-wide `pnpm typecheck`.
**Sensitive:** money — 2 independent auditors.

### F2 — The group verdict compares the estimate

**Objective:** a positive remaining balance that cannot cover this turn is not fundable.

**Design context.** §Funding Decision Matrix priority 1. Today the group branch tests headroom
greater than zero and never compares the turn's estimate, so one nano of headroom presents as
fundable and the send fails at admission with no prior signal.

**Acceptance criteria:**

- Priority 1 compares the estimate against headroom. A test pins the boundary: headroom one nano
  below the estimate is not fundable, exactly equal is.
- The fall-through and guest-refusal outcomes are unchanged; pinned.
- The payer-switch notice from B7 fires on fall-through.

**Files:** `packages/shared/src/affordability/billing/funding-decision.ts`, `client-billing.ts`, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`, `pnpm test:web`.
**Sensitive:** money — 2 independent auditors.

---

## Lane G — Enforcement and hygiene

### G1 — The arch rules that keep the wall

**Objective:** the boundary and the registry seam are build failures, not conventions.

**Design context.** §Where the Code Lives → What is enforced. Precedents to follow: the fee-seam
rule already allowlists money math by path inside the shared package, the structural-rule harness
already parses that tree, and two directory-isolation rules exist. Depends on B1 for the paths and
B2 for the registry.

**Acceptance criteria:** six rules, each with a **positive control** in its own test proving it
fires — a silent rule proves nothing:

1. Barrel-only access from outside the module. (Note: deep specifiers already fail to resolve via the
   exports map — this rule covers the intra-package relative path, which is where the reach exists.)
2. **No code under `apps/web` outside one named adapter hook** imports a pricing or affordability
   symbol. "No _component_" is too narrow — the second verdict engine E1 deletes is a hook.
3. No branching on a dimension id, and no dimension option literal, outside the registry.
4. Rate arithmetic confined to the module; fee application confined to the two seams.
5. No database or cache import inside the module. Imports _into_ the module are permitted **only from
   an enumerated allowlist** — B1 produces that list — and the allowlist's membership is itself pinned,
   so growth is a visible edit. Phrasing it as "nothing imports into it" is unimplementable: the barrel
   is imported by design.
6. **The export allowlist, structurally.** A rule in the arch harness reads the root barrel's export
   list and fails on any symbol from §Where the Code Lives' not-exported list. This is deliberately
   **not** a duplicate of the package-local tests: B1b pins absence and B8 pins set equality, both by
   importing the barrel at runtime from inside `packages/shared`; this rule is static, lives with the
   other structural rules, and is what catches a re-export added from a package that has no such test.
   Do not reimplement either runtime test here.

Each rule lists its known limitations in a docblock, and any documented limitation carries an
executable pin so the list cannot rot.

**Files:** `packages/config/arch/rules/*`, `packages/config/eslint-extensions/*`, `boundaries.config.mjs`, tests.
**Scoped checks:** `pnpm test:config`, `pnpm arch:check`, `pnpm lint`.
**Sensitive:** no.

### G2 — Collapse the remaining duplication

**Objective:** delete the sync contracts and the local money math this run has now identified.

**Acceptance criteria:**

- The storage float derives from the nano constant; the cost model remains as a comment recording
  how the rate was chosen, not a live parallel computation.
- The group budget modal's plain-number aggregation routes through shared money helpers.
- The media dollar-conversion duplicated across three per-modality hooks becomes one shared display
  formatter.
- The two sync contracts are dispositioned **individually, by citation**, not by grep: the value-store
  byte-budget duplicate (B4 hoists it) and the enclosure dual-guard comment (**out of scope — it
  documents two deliberate guards; do not collapse them**). A grep for "keep in sync" matches neither,
  since both say "MUST stay in sync" — which is why enumeration replaces the grep.

**Files:** `packages/shared/src/constants.ts`, `packages/shared/src/affordability/**`, `apps/web/src/components/chat/budget/budget-settings-modal.tsx`, `apps/web/src/hooks/billing/use-media-cost-estimate.ts`, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`; `pnpm lint:duplication` on the changed paths.
**Sensitive:** no.

### G3 — E2E specs, authored not run

**Objective:** the flows this run changes are covered at the level that would catch them, delivered
unexecuted per the standing ruling.

**Acceptance criteria:** specs authored per `e2e/CLAUDE.md` conventions for — a multi-model turn
including Smart Model as one sibling; an `auto` multi-model turn asserting each answer's effort
badge; **a multi-model turn whose first sibling fails, asserting the classifier charge still lands**;
a hold-blocked send in a second conversation showing the transient reason with the picker still
normal; a group member falling through to personal funds with the disclosure. Lint and
typecheck clean; **not run**. The auditor judges convention conformance and assertion completeness,
not a passing run.

**Files:** `e2e/**`.
**Scoped checks:** `turbo typecheck lint --filter=e2e`.
**Sensitive:** no.

---

## Lane H — End-to-end proof (depends on C3, D1, D2)

### H1 — One real turn, three invariants at once

**Objective:** prove the specification on a real turn, since no per-task audit can see across layers and
E2E does not run this run.

**Design context.** Every task above verifies its own layer. Nothing verifies that a turn priced by
admission is the turn that executed, that the classifier charge lands when the first sibling fails, and
that the persisted effort matches the badge — all three of which are cross-layer by nature. The close
phase runs gates and a critic; neither executes a turn.

**Acceptance criteria:** one integration test, at the api layer against real local infrastructure, of a
multi-model `auto` turn with a Smart Model sibling where the **first sibling fails**, asserting in one
run:

- each surviving generation persists the effort it resolved to, and the value reaching the wire equals
  the persisted one (the take-not-sum rule, across a multi-step generation);
- the classifier charge is anchored to the first **persisted** content item and billed;
- `hold ≥ Σ charges` for the run as settled;
- **`estimate ⟺ executed`**: the definition admission priced is the definition that executed, now that
  the envelope carries a runtime choice. Asserted, not assumed — §Reasoning Effort states it in prose
  and nothing else in this plan pins it.

**Files:** one api integration test file.
**Scoped checks:** `pnpm test:api`.
**Sensitive:** money — 2 independent auditors.

---

## Dependency graph

```
B1 → B1b → B2 → B3 → B4 → B5 → B6 → B7 → B8
      │                        │     │      ↑
      │                        │     └→ C1 ─┘ → C2 → C3 → D1 → D2 → H1
      │                        │
      ├→ A1                       (A1 needs B1's constants split)
      ├→ F1 → F2                  (F1 needs B1's paths + a schema change)
      └→ G1                       (G1 needs B1b's closed barrel + B2's registry)

B5, B6, B8 → E1 → E2            (E2 also needs D2 — shared message component)
E1 → E3
B2, B4, C3 → E4                 (E4 edits turn-definition after B4 and C3)
B4, E1 → G2
C3, D2, E1, E2 → G3
D2 → E2
```

**Lane B is a strict spine.** Nothing in it is parallel, and **B8 closes it** — it needs both B7 and
C1, so lane C's first task lands mid-spine rather than after it.

**What opens when.** A1, F1 and G1 are the only tasks that open on a B1-family clean, and none of
them opens _alongside_ B1 — all three touch paths, constants or barrel state B1 and B1b move:

| Dispatch                          | The moment it becomes ready                                                  |
| --------------------------------- | ---------------------------------------------------------------------------- |
| **B1**                            | immediately — the run's single entry point                                   |
| **A1**, **F1**                    | B1 clean (constants split, moved paths)                                      |
| **G1**                            | B1b clean **and** B2 clean (needs the closed barrel and the registry)        |
| **F2**                            | F1 clean                                                                     |
| **E1**                            | B5, B6 and B8 clean — it renders the produced sets through the landed barrel |
| **E3**                            | E1 clean. **E3 is not parallel with B1** — the graph edge `E1 → E3` governs  |
| everything in C, D, E4, G2, G3, H | as the graph shows                                                           |

An earlier revision of this section listed E3 as "genuinely parallel, dispatched alongside B1" while
the graph carried `E1 → E3`, and listed G1 in one sentence and not the other. The table above is
authoritative; that sentence is deleted. Nothing is dispatched in parallel with B1.

**Ownership resolutions** (each file has exactly one owner at any time):

| File                         | Owner                                      | Note                         |
| ---------------------------- | ------------------------------------------ | ---------------------------- |
| `constants.ts`               | B1 splits; A1 adds to the money half after | never concurrent             |
| `turn-definition.ts`         | B4, then C3, then E4                       | serialized by graph edges    |
| `smart-model-turn.ts`        | C2, then C3                                |                              |
| `settlement.ts`              | C2 (anchor rule), then D1 (charge input)   |                              |
| `smart-model-execution.ts`   | C2, then D1                                |                              |
| `message-item.tsx`           | D2, then E2                                | D2 → E2 edge exists for this |
| `prompt-input.tsx`           | E1, then E2                                |                              |
| `modality-config-panel.tsx`  | **E4 only**                                | removed from E1's glob       |
| `use-media-cost-estimate.ts` | **G2 only**                                | removed from E1's glob       |
| `hooks/billing/*`            | E1, then E2, then F1                       | F1 touches inputs only       |
| `shared/src/index.ts`        | B1b removes; B8 lands the surface          | never concurrent             |

---

## Close phase

1. **Full unscoped pass:** `pnpm typecheck`, `pnpm lint`, every `pnpm test:*` suite,
   `pnpm lint:duplication`, `pnpm lint:unused`, `pnpm arch:check`. Attribute every failure; fix only
   what this run caused.
2. **Batch the validated findings to one fixer**, then re-audit the batch.
3. **No E2E execution.** Specs are delivered static-clean.
4. **Completeness critic** with a close-out brief: which criterion is unverified, which integration
   untested, which doc unupdated.
5. **Doc proposals** presented in chat as per-file diffs; the human decides each. **`BILLING.md` is a
   candidate, not an exception** — B1's move invalidates roughly fourteen of its path citations, and B1
   produces that diff. Also `ARCHITECTURE.md` (its node-type list omits the shipped Smart Model node;
   its exclusion sentence should distinguish commercial from representability exclusions) and
   `DEVELOPMENT.md`'s doc index.
6. **Do not commit.** The tree is the human's.

---

## Deferred, with reasons

- **Extracting the affordability module to its own workspace package.** Trigger recorded in
  §Where the Code Lives: when the arch rule records a legitimate exception, or a build target needs
  affordability without the shared package.
- **The estimator prices mutually-exclusive branch targets additively**, so the first real branching
  workflow over-holds by the branch count. No shipped definition uses `branch`; fixing it now would
  be speculative, and the fix is new money-critical static analysis whose failure direction is
  under-reserve.
- **Magnitude in refusals** ("about 2¢ short") — ruled not now.
- **A usage or receipt surface** — out of scope.
- **The lock-order inversion** between member removal and settlement (sub-millisecond window,
  documented, accepted).
- **Media price floor** — deliberately not extended; a per-unit equivalent would be a new commercial
  rule, not a translation.
