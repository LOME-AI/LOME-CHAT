# B5 — implementation report 4 (fix cycle 3)

Three Minors, all fixed. Reports 1–3 remain the record for everything else. `HEAD` is `53daba72`,
which absorbed the first cycle's code; all three fix cycles (reports 2, 3 and this one) are in the
working tree on top of it.

---

## FINDING 1 — the sweep case did not discriminate; it does now, and I proved it both ways

**The finding is right and my cycle-3 pin was worthless for its purpose.** It asserted
`minimum(withStorage) > minimum(withoutStorage)`, and `storage` enters
`smartModelMinimumRequiredNanoUsd` in three places: the pool pricing, `inputStorageNanoUsd`, and the
output-storage term on the minimum answer. The gap I asserted is produced entirely by the second and
third, so the inequality holds whether or not the pool sees storage at all — which is exactly the
regression the pin was added to catch. Finding 4 of the previous cycle was still open.

### The discriminating fixture

Storage costs the same per token for every model, so it is multiplied by each model's **own cap** —
which means a cheap-per-output-token, enormous-capacity candidate can sit inside the outlier multiple
on a non-persisting basis and outside it on a persisting one. `vendor/vast` is that shape: 10 nano per
output token, a 1,000,000-token cap, `maxCallCost` of **10,000,000n ephemeral** against
**610,000,000n persisting**, where the pool threshold is 320,000,000n and 576,000,000n respectively.

Three pins, in `smart-model-order.test.ts`:

1. **At the pool:** `priceSmartModelPool(WITH_VAST, 0, STORAGE).priced` excludes it while
   `priceSmartModelPool(WITH_VAST, 0)` includes it.
2. **At the threshold** — the function whose argument is at risk:
   `smartModelMinimumRequiredNanoUsd(WITH_VAST, 0, STORAGE)` **equals** the same call over
   `WITH_TAME`, a pool whose fifth member is an ordinary shape with an identifier of the **same
   length**. Two things had to be neutralised for that equality to isolate the exclusion, and the
   first cut of this pin failed on both: the classifier ENGINE (so `vast` carries a huge INPUT rate
   and is never cheapest by combined rate) and the classifier RESERVE (whose char count is rendered
   over the pool's identifiers, hence the equal-length stand-in). The prompt basis is empty so the
   input leg does not enter the floors either.
3. **The counterfactual**, so the equality cannot pass by both sides being computed the same wrong
   way: priced ephemerally the outlier survives and is the cheapest floor, so the threshold drops.

### Verified discriminating, not merely added

I dropped the third argument from `priceSmartModelPool` inside `smartModelMinimumRequiredNanoUsd` and
re-ran: pin 2 goes **red** — `expected 4398900n to be 5388900n`, a 990,000n gap that is precisely
`vendor/vast`'s floor advantage — then restored the file and confirmed green. The old pin passed
under that same mutation, which is what made it a no-op.

The claim on the non-discriminating sweep case is corrected in place rather than deleted: it still
sweeps the no-storage arm (worth having, since that is the client's predicate on an ephemeral turn)
and now says so, including that it does **not** discriminate the pool basis.

---

## FINDING 2 — the parameters my change orphaned, and the chain behind them

`prompt` and `history` on `buildTrialSmartModelTurnDefinition`'s args had exactly one reader, the
local recount cycle 3 deleted. Both are gone, from the args type and from the `routes.ts` call site.

Removing them exposed a chain of my own orphans, all removed under the same rule:

| orphan                                                            | disposition                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `prompt` / `history` on the builder's args                        | deleted                                                                  |
| the `ChatHistoryMessage` type import in `smart-model-turn.ts`     | deleted — that args type was its only use                                |
| `history` on `trialSmartModelDefinitionOrRefusal` (`routes.ts`)   | deleted; it existed only to forward to the builder                       |
| `prompt` on that helper's `body` type                             | narrowed to `{ reasoningEffort? }` — the last reader of the text on this path |
| three `prompt`/`history` pairs in `smart-model-turn.integration.test.ts` | deleted from the call sites                                       |

The narrowing is worth naming separately: it removes the same misreading the finding is about one
level up. A reader of `trialSmartModelDefinitionOrRefusal` saw a `prompt: string` on its body type and
would assume the trial Smart Model path still measures text somewhere. It does not — the only prompt
quantity on that path is now `budget.promptCharacterCount`, produced by the route.

`routes.ts` is granted to me for the trial gate's argument; the deletions above are that argument's
own consequences, which AGENT-RULES makes mine to remove. Nothing else in the file moved.

---

## FINDING 3 — my diagnosis named the wrong mechanism

Report 3's sentence — that the cause was ordering, "my last shared-package edit came after my last
shared-package lint" — described only half of it and then paired it with a remedy for neither half.
The corrected diagnosis, which supersedes it:

> **The cause was COVERAGE, not ordering.** I linted the package I was thinking about (`apps/api`)
> and reported its exit 0 for a package I had also touched (`packages/shared`). Capturing
> `EXIT=$?` perfectly on an api-only lint reproduces that defect exactly, so status-capture cannot
> be the remedy. What binds it is the step I took by choice last cycle and by rule now: after the
> final edit anywhere, **derive** the changed-file list from `git status`, group it by package, and
> run one lint per package present.

Status-capture remains a real and separate improvement — a pipeline reports its last stage's status,
so `eslint … | tail; echo $?` prints 0 regardless — but it addresses reporting fidelity, not lint-set
coverage. Both now live in Global Constraint 9, which I re-read before running this cycle's gates.

I also accept the severity correction: a red lint gate blocks every downstream gate in CI and is not
Minor. I treated it as small in cycle 3, which is precisely the under-investment the label invites.

**The enumeration, run for this cycle.** `git status` shows changed `.ts`/`.tsx` files in eight
packages, of which **two contain files this task changed** — `packages/shared` and `apps/api`. Both
were linted from their own directories after the final edit (statuses below). The other six belong to
the concurrent workstream; linting those would report their state as mine.

---

## Self-gate

Every status captured directly on the command — `cmd > out 2>&1` then `echo "EXIT=$?"` as a separate
statement, nothing piped.

| command                                                                | result                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npx eslint src/affordability` (from `packages/shared`)                 | **EXIT=0**, after the final edit                                        |
| `npx eslint <12 changed files>` (from `apps/api`)                       | **EXIT=0**, after the final edit                                        |
| `npx turbo typecheck --force --continue`                                | **EXIT=0** — 16/16, zero cached                                          |
| `pnpm test:shared`                                                     | **EXIT=0** — 127 files, 3,021 tests; coverage 99.9 / 99.46 / 100 / 100  |
| `--root apps/api src/slices/{chat,models}`                              | pass — 75 files, 1,559 tests, 1 skipped                                 |
| `--root packages/shared src/affordability/estimate/smart-model-order.test.ts` | pass — 13 tests, including the three new pins                    |
| mutation check: storage argument dropped inside the threshold           | pin 2 **red** (`4398900n` vs `5388900n`), restored and green            |
| `pnpm test:api`                                                        | **EXIT=1 — 7 failed of 6,430, all seven the known `template-html` snapshots** |

**On `pnpm test:api`:** 469 files, 6,430 tests — **7 failed, every one in
`notifications/domain/templates/template-html.test.ts`**, the concurrent push/notifications
workstream's snapshot entry, with both the template source and the `.snap` unmodified by this task.
Digit-for-digit the same result as cycle 3, including the same passing count: no catalog-lock
contention, no rate-limiter flake, and no coverage-merge crash this run. `EXIT=1` is those seven and
nothing else. The coverage table does not print on a red run (the §Known Breakage entry), which is why
the coverage evidence is the scoped runs above.

**On repo typecheck:** 16/16 again on my run, so I still have not observed the foreign
`packages/config/arch/rules/no-evidence-from-mocked-seam.rule.ts` failure. Recorded as not-observed,
not as absent; not chased either way.

---

## Corrections to earlier reports

- **Report 3's finding-2 diagnosis is superseded** by the coverage-not-ordering statement above.
- **Report 3's storage sweep claim is withdrawn.** "the pair is asserted to differ — otherwise the
  storage argument could be dropped and every sweep would still pass" was exactly backwards: the pair
  differs for reasons unrelated to the argument, so every sweep *did* still pass. The pins above are
  the replacement, with the mutation result as evidence rather than the assertion's wording.

## Concerns

- **`smart-model-turn.ts`'s args are now `{ now, budget, classifyEffort?, reasoningOff? }`** — no
  content at all reaches the trial Smart Model builder. That is the desired end state, and it also
  means the builder can no longer measure anything even by accident; the only way to reintroduce the
  defect is to add a parameter back, which is a visible signature change.
- **Pin 2's isolation rests on two neutralisations** (the engine's combined-rate order and the
  identifier-length equality behind the reserve). Both are stated in the test's own comment, because
  a future edit to either — an id rename, or a change to what the classifier prompt renders — would
  make the equality fail for a reason unrelated to what it pins. It fails loudly rather than
  silently, which is the right direction, but the next reader needs to know why.

## Confidence

**High.** Every fix is verified by the mechanism the finding named: pin 2 by mutation (red under the
regression, green without), findings 2 and 3 by direct inspection of what remains. The one judgement
call is the `body`-type narrowing in `routes.ts`, which I took as an orphan of my own change and have
named explicitly rather than left for an auditor to find.
