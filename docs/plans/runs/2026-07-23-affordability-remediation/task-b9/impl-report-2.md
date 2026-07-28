# B9 — the wall moves from packages to roles, and a gate enforces it — impl report 2

**STATUS: DONE_WITH_CONCERNS.** The ruling is enforced by `pnpm arch:check`, watched red on
real code and reverted byte-exact. 15 consumer reaches found, 2 closed, 13 pending in files
this task does not own. One residual the rule structurally cannot see is reported below
rather than left implied.

## Objective

Make "the wall is against consumers of prices; the api estimator is an owner" **enforced
rather than stated**.

## Files changed

| file | why |
| --- | --- |
| `packages/config/arch/rules/money-internals-owners-only.rule.ts` | **new** — the gate: walled affordability subpaths are importable only from the named price owners; anywhere else in `apps/api` fails. |
| `packages/config/arch/rules/money-internals-owners-only.rule.test.ts` | **new** — 10 cases, written first, covering imports, re-exports, `import()`/`vi.mock`, both barrels, owners, pending entries and out-of-scope trees. |
| `apps/api/src/slices/models/adapters/mock-provider.ts` | closed a consumer reach: the fake provider's synthetic tokenization is its own constant, not the money layer's tier ratio. |
| `apps/api/src/slices/models/domain/index.ts` | deleted the domain barrel's `CLASSIFIER_CHARS_PER_TOKEN` export — a walled tier ratio republished under an alias, with zero consumers. |
| `apps/api/src/slices/models/barrel.test.ts` | extended the existing walled-name pin to cover it; renamed `WALLED_MONEY_TYPES` → `WALLED_MONEY_NAMES` because the list now holds a value. |
| `apps/api/src/slices/models/adapters/integration-setup.ts` | comments only: dropped two `G1` plan identifiers (durable-naming). |

## The classification — 69 bindings, every one with a verdict

Verdict rule: an **owner** produces prices, plans or holds; a **consumer** reads one to
render or decide. Counted on the tree as it stands now.

**55 OWNER · 14 CONSUMER · 69 total**, across 24 files and 13 units.

The total is unchanged from report 1's 69, but the composition moved: `mock-provider.ts`'s
binding is closed (−1) and `workflows/engine/live-run.test.ts` acquired one (+1) from a
concurrent agent mid-task. A static-looking total is not a still inventory.

### OWNER — 55 bindings (legitimate; money-layer code living in `apps/api`)

| file | n | units :: bindings |
| --- | --: | --- |
| `models/domain/estimate.ts` | 10 | `estimate/reducers`::evaluateManifest · `estimate/run-ceiling`::NO_STORAGE, callManifest, estimateRunCeilingNanoUsd, DeclaredCeiling, NodeStorage · `estimate/types`::Manifest · **re-exports**: DeclaredCeiling, NodeStorage, ratesFromPricing |
| `models/domain/estimate-run.ts` | 4 | `estimate/pre-adapters`::outputCharsPerTokenForTier · `estimate/reducers`::reservationCeiling · `estimate/search-reservation`::WEB_SEARCH_RESERVATION_NANO_PER_MODEL · `estimate/types`::NanoLineItem |
| `models/domain/estimate-run.test.ts` | 6 | classifier-line-item, pre-adapters ×2, search-reservation, smart-model-affordability ×2 |
| `models/domain/smart-model-candidates.ts` | 6 | `estimate/smart-model-affordability`::admitSmartModel, classifierReserveLineItems, SmartModelPoolCandidate, SmartModelStorageContext · **re-exports**: CLASSIFIER_CHARS_PER_TOKEN (now off the barrel), classifierReserveLineItems |
| `models/domain/smart-model-candidates.test.ts` | 2 | constants::MINIMUM_OUTPUT_TOKENS · pre-adapters::estimateTokensForTier |
| `models/domain/trial-eligibility.ts` | 4 | pre-adapters ×2 · `estimate/price-request`::priceRequest · `estimate/reducers`::evaluateManifest |
| `models/domain/trial-eligibility.test.ts` | 2 | pre-adapters ×2 |
| `chat/domain/turn-definition.ts` | 6 | constants::MINIMUM_OUTPUT_TOKENS · effort-options::turnEffortOptions · classifier-line-item::classifierReserveChars · pre-adapters ×2 · smart-model-affordability::SmartModelStorageContext |
| `chat/domain/turn-definition.test.ts` | 3 | constants · pre-adapters · reasoning-plan |
| `chat/domain/turn-ceiling.property.test.ts` | 2 | constants · reasoning-plan |
| `chat/domain/turn-classifier.test.ts` | 1 | classifier-line-item::classifierReserveChars |
| `chat/domain/turn-reasoning.ts` | 4 | effort-options::resolveEffortForModel, turnEffortOptions · reasoning-plan::planReasoning, planReasoningOff |
| `chat/domain/turn-reasoning.test.ts` | 1 | reasoning-plan |
| `chat/domain/smart-model-turn.ts` | 2 | constants · effort-options::turnEffortOptions |
| `chat/domain/smart-model-turn.test.ts` | 2 | constants · reasoning-plan |

### CONSUMER — 14 bindings, all pending, none in files this task owns except one

| file | n | bindings | closure | owner |
| --- | --: | --- | --- | --- |
| `models/adapters/integration-setup.ts` | 2 | planReasoning, planReasoningOff | **blocked** — see below | **mine** |
| `workflows/nodes/turn-decision.ts` | 3 | cheapestClassifierEffort, parseClassifierAnswer, resolveClassifiedEffort | `chooseFrom` (published) | C3 |
| `workflows/nodes/turn-decision.test.ts` | 1 | cheapestClassifierEffort | follows its subject | C3 |
| `workflows/nodes/model-call-execution.ts` | 1 | pickClassifiedEffortPlan | `wireFor` (published) | C3 |
| `workflows/nodes/smart-model-execution.ts` | 3 | planReasoningOff, pickClassifiedEffortPlan, resolveClassifierOutput | `wireFor` + plan producer | **D1, concurrent** |
| `workflows/nodes/smart-model-execution.test.ts` | 1 | REASONING_BUDGET_TOKENS_BY_EFFORT | follows its subject | D1 |
| `workflows/engine/workflow-capabilities.test.ts` | 1 | cheapestClassifierEffort | `chooseFrom` | C3 |
| `workflows/engine/live-run.test.ts` | 1 | cheapestClassifierEffort | `chooseFrom` | C3 (arrived mid-task) |
| `chat/routes.integration.test.ts` | 1 | REASONING_BUDGET_TOKENS_BY_EFFORT | fixture; barrel has no equivalent | C3 |

**`integration-setup.ts` is the one consumer reach I own and could not close**, and the
exact symbols are `planReasoning` and `planReasoningOff`. The barrel publishes the
*wire vocabulary* around them — `REASONING_OFF_WIRE`, `ReasoningWire`,
`reasoningBudgetForWire`, `reasoningPlanModelFrom` — but not the two plan producers. The
in-repo owner (`chat/domain/turn-reasoning.ts`) exposes `reasoningEntryFor`, which returns
`{ effort, wire, reasoningBudgetTokens }` and **not** `maxTokens`, so routing through it
would mean re-deriving `B + H` in a test-support file: a second implementation of a
documented identity (§Reasoning Effort 3), banned by Global Constraint 5. The file also
builds cassette-hash-stable requests, so a reconstruction that is off by one token silently
buys a charged provider call. Smallest ask that closes it: publish `planReasoning` /
`planReasoningOff`, or put `maxTokens` on `TurnReasoningEntry`.

## Which subpaths survive because an owner needs them (B8b's gate)

**11 of 13 units survive.** B8b's deletion criterion can proceed on 2, and only 2:

| unit | disposition |
| --- | --- |
| `constants`, `estimate/{classifier-line-item, effort-options, pre-adapters, price-request, reasoning-plan, reducers, run-ceiling, search-reservation, smart-model-affordability, types}` | **OWNER-NEEDED** — keep |
| `smart-model/effort-dimension`, `smart-model/resolve` | **CONSUMER-ONLY** — deletable once the `workflows/nodes/*` closures land, which are import rewrites onto `chooseFrom` / `wireFor` |

So B8b's revised gate ("no consumer reach remains") is reachable by C3/D1 doing import
rewrites; it does **not** require publishing anything, except for `integration-setup.ts`.

## The gate, and watching it fail

`money-internals-owners-only` names two sets: `PRICE_OWNERS` (permanent, the ruling) and
`PENDING_CONSUMER_CLOSURES` (temporary, each annotated with its fix, documented as needing
to reach empty). Both must be edited to grow.

It scans **import declarations, re-export declarations, and the string-literal call forms**
(`import()`, `vi.mock`). Re-exports are covered deliberately: an aliased
`export { X as Y } from '<walled>'` republishes an internal under a name no grep for the
original finds, which is how five such sites survived two inventories of this wall.

**Red-first proof.** No background suite was in flight (the sequencing rule). Two
deliberate violations at once — a fresh non-owner file and re-adding the exact reach I had
just closed:

```
$ npx tsx packages/config/arch/run.ts
EXIT=1
arch:check: ARCHITECTURE RULE VIOLATIONS
apps/api/src/slices/chat/domain/wall-probe.ts:1 [money-internals-owners-only]
  '@hushbox/shared/affordability/estimate/price-request' is a money-layer internal. …
apps/api/src/slices/models/adapters/mock-provider.ts:12 [money-internals-owners-only]
  '@hushbox/shared/affordability/constants' is a money-layer internal. …
```

**Byte-exact revert**, verified by hash rather than by inspection:

```
$ sha256sum … (before)  7c88c9d15e8ae21ba9e9aaa3748aa03f8b8c55ece3eeb0e5abf5ff5d1cd0d288
$ diff backup mock-provider.ts   → no output
$ sha256sum … (after)   7c88c9d15e8ae21ba9e9aaa3748aa03f8b8c55ece3eeb0e5abf5ff5d1cd0d288
$ ls …/wall-probe.ts    → No such file or directory
$ npx tsx packages/config/arch/run.ts
EXIT=0  arch:check: OK — 13 rule(s) over 2046 file(s)
```

**The gate immediately earned itself.** On its first real run it flagged
`workflows/engine/live-run.test.ts`, which my own inventory grep — taken 25 minutes
earlier — did not contain. The file was modified at 18:29 by a concurrent agent. A
grep-and-classify pass is a snapshot; the rule is continuous. That is the whole argument
for enforcement over prose, produced by accident within minutes of landing it.

## Consumer reaches closed

**1. `mock-provider.ts` — `CHARS_PER_TOKEN_STANDARD`.** The fake provider synthesizes token
counts from characters. It is not required to agree with the money layer: it reports an
inline `providerCostUsd`, and inline cost is billing truth, so its count never reaches a
charge. Closed by giving it its own constant at the same value — behaviour identical, 65/65
mock-provider tests unchanged. The old comment ("the shared standard constant is the single
source (equals 4)") was a mirrored constant in prose; the replacement states that the values
being equal today is a coincidence, not a contract.

**2. `models/domain/index.ts` — `CLASSIFIER_CHARS_PER_TOKEN`.** A walled tier ratio
(`CHARS_PER_TOKEN_CONSERVATIVE`) aliased onto the models **domain barrel**, with **zero
consumers** — both real consumers import it directly from `./smart-model-candidates.js`.
This is B8's `DeclaredCeiling`/`NodeStorage` breach one barrel down, and it was invisible to
every name-grep because of the alias. Closed test-first: extended the existing
`barrel.test.ts` pin, watched it go red on `does not republish the walled
CLASSIFIER_CHARS_PER_TOKEN`, then deleted the export → 815 passed (from 813; the two new
pin cases).

## Findings

**1. Laundering hides owners from every specifier-based inventory — including mine.**
`models/domain/trial-smart-model-candidates.ts` prices the trial smart-model pool by calling
`classifierReserveLineItems`, a walled function, and has **zero** walled specifiers: it
reaches it through the owner re-export at `smart-model-candidates.ts:55`. It and its test are
price **owners by role** that no `@hushbox/shared/affordability/` grep can find, so they are
absent from the 69 and from the rule's allowlist. I left them out of `PRICE_OWNERS`
deliberately — an entry that allows nothing today is dead config, and if either ever imports
directly the gate will demand the decision, which is the allowlist working.

**2. The rule cannot see laundered reaches, and I did not extend it to.** An owner may still
re-export a walled name, after which any non-owner reaches it by relative import — invisible
to a rule that gates package specifiers. Every current consumer of the four laundered names
(`ratesFromPricing`, `classifierReserveLineItems`, `DeclaredCeiling`, `NodeStorage`) is
itself an owner, so nothing is wrong today. The closure would be an "owners may consume
internals but not republish them" clause, which forces 4 remaining re-export sites and their
consumers to import directly. That is a real design change touching files beyond this task's
criteria, so it is reported rather than taken.

**3. `packages/config/arch/README.md` now under-describes the rule set.** Its "Current
rules" list does not mention `money-internals-owners-only`. `.md` files are read-only to
subagents (2026-07-27 ruling), so this needs the founder or an explicit grant.

**4. Plan typo, for the record.** §B9's re-scope writes the server hold as
`19,999,600n → 11,974,800n`; the measured figure is **11,774,800n**, as stated correctly
30 lines above it. No consequence beyond a future reader re-deriving it.

## Behaviour identity

No pricing path was touched, so the money amounts are unmoved by construction — the only
`apps/api` source edits are a constant given a local home at the same value, a
consumerless barrel export deleted, and two comments. The saturating-sibling and trial
figures from report 1 stand unchanged and re-verified green: module hold **11,774,800n** /
wide ceiling **12,281**, server hold **19,999,600n** / wide cap **22,562**, both ≤ the
fixture's 20,000,000n spendable; `trialMessageBillableNanoUsd(target, 10)` = **2,005,000n**.

**`reserve ⊇ bill`: preserved, neither weakened nor improved.**

## Vocabulary sweep

Removed mechanism: `CHARS_PER_TOKEN_STANDARD` in `mock-provider.ts`, and the
`CLASSIFIER_CHARS_PER_TOKEN` barrel export.

- `CHARS_PER_TOKEN_STANDARD` anywhere in `apps/api` → **zero hits**.
- Its vocabulary (`CHARS_PER_TOKEN`, "single source", "standard constant", "equals 4")
  across my owned adapters → two unrelated "single source" comments about provider
  selection, neither falsified; the local `CHARS_PER_TOKEN` is the intended survivor.
- **Applying the new standing rule — grep the re-export SITES, not only the name** — is what
  found finding 1 and closure 2. Grepping `CHARS_PER_TOKEN_CONSERVATIVE` returns nothing in
  `apps/api`; grepping the *site* at `smart-model-candidates.ts:51` returns the alias, and
  the alias returns four consumers plus a barrel export. The name-grep alone would have
  reported "nothing else found" and been wrong.

## Self-gate

| command | result |
| --- | --- |
| `npx tsx packages/config/arch/run.ts` | **pass** — OK, 13 rules over 2046 files, exit 0 |
| same, on two deliberate violations | **fail as designed** — exit 1, both flagged; reverted byte-exact (sha256 match) |
| `vitest run` (`packages/config`, full) | **pass** — 31 files / 379 tests, exit 0; no pole-gate failure |
| `vitest run --root apps/api src/slices/models` | **pass** — 42 files + 1 skipped / 815 tests, exit 0 |
| `npx eslint src/slices/models` (from `apps/api`) | **pass** — exit 0, after the last edit |
| `npx eslint arch` (from `packages/config`) | **pass** — exit 0, after the last edit |
| `npx turbo typecheck --force --continue` | **pass** — 16/16, 0 cached, exit 0 |

No `pnpm test:api` sweep is cited: §Known Breakage is explicit that a single green api sweep
is uninformative while the chat-integration failing set moves, and the scoped models run is
the gate that actually covers the changed files. The documented `template-html` snapshot red
was not re-observed because it lies outside every suite run here.

## Deviations

- **The Files list is stale and the coordinator's grant governs.** §B9 still lists
  `apps/api/src/slices/models/**`; the re-scope requires a rule in `packages/config/arch/`.
  Taken as granted by the coordinator's message.
- `PRICE_OWNERS` names 7 production files plus 8 test files, including two satellite tests
  (`turn-ceiling.property.test.ts`, `turn-classifier.test.ts`) whose names do not match their
  subject. Test paths are listed rather than derived from source paths on purpose: derivation
  would silently admit any file that adopted the naming.

## Concerns and limitations

- **`PENDING_CONSUMER_CLOSURES` holds 9 files.** It is documented as needing to reach empty,
  but nothing forces it to shrink — no gate counts it down. If C3/D1 do not close them, it
  will read as permanent within a release or two. A follow-up could assert its length is
  non-increasing, which is the cheapest available ratchet.
- **The rule's scope is `apps/api` only.** `apps/web` owes a stricter obligation
  (§What is enforced: no web code outside one named adapter hook touches a pricing symbol),
  **nothing enforces it today** — I checked; only `fee-seams` exists — and reaches remain
  there under E1/G2. My first draft of the rule's docblock asserted such a rule existed; that
  was false and is corrected.
- Finding 2's laundering residual is the honest limit of this gate.

## Confidence

**High** on the enforcement and the closures: the rule was watched red on real code and
green after a hash-verified revert, both closures are pinned by tests that were watched red
first, and every gate was run after the last edit. **Medium** on the classification's
completeness — not on its verdicts, which follow directly from the owner/consumer ruling,
but on its coverage: finding 1 proves the specifier-based method under-counts owners
wherever a re-export launders a name, and I found that route once by sweep rather than by
construction. There may be another.
