# B4 — impl report 3 (fix cycle 2)

Three Minor findings from the contract lens. All three fixed; nothing else in the task touched. The
money lens's zero findings and the orchestrator's two settled items are taken as given and not
re-argued.

---

## FINDING 1 — a test comment my own criterion 4 falsified

`apps/api/src/slices/chat/domain/turn-ceiling.property.test.ts` — the per-sibling assertion's stated
reason described the behaviour criterion 4 deleted.

Was:

> The shared cap is the tightest sibling's, so no node ever carries one above its own catalog bound.

Now:

> The searched headroom is the WIDEST sibling's room, so what keeps every node inside its own bound is
> the per-node clamp each one applies when the cap is stamped — not one tightest-sibling value.

The assertion itself is unchanged and still green. **How it happened, since the mechanism matters more
than the line:** I wrote that comment while `physicalAnswerCeiling` still returned the tightest room,
then criterion 4 inverted the function to the widest inside the same cycle — and the comment survived
because the assertion it justified kept passing for a different reason. A durable claim that stays
true by coincidence is exactly the wrong-comment class CODE-RULES rates worse than no comment. The
lesson I am carrying: when a function's contract inverts, the comments citing it need re-reading even
where nothing goes red.

## FINDING 2 — plan identifiers on lines this task added

Global Constraint 8. Three added lines carried a label; all three dropped, with the surrounding
sentence already carrying the durable fact:

| line | was | now |
| --- | --- | --- |
| `turn-definition.ts` `turnAnswerSizing` docblock | "an explicit, affordably-derived completion cap (G2)" | "…completion cap" |
| same docblock | "rather than any silent effort downgrade (G3)" | "…silent effort downgrade" |
| `routes.integration.test.ts` low-level acceptance pin | "ALWAYS explicit on a reasoning call (G2), trial included" | "ALWAYS explicit on a reasoning call, trial included" |

Verified by diff rather than by reading, so the claim covers exactly the added lines:

```
$ git diff HEAD -- <the seven chat files this task touched> \
    | grep -nE "^\+.*\((G[0-9]+|[A-F][0-9]+|T[0-9]+|R[0-9]+)\)"
(no matches)
```

The pre-existing labels the orchestrator listed (`turn-definition.ts:376`, `:852`, the `(G9)` in a
test name, `routes.integration.test.ts:1166`) are untouched and left to the close-phase sweep.

## FINDING 3 — the trial pins now seed a deterministic catalog

This was the one that mattered, and the diagnosis is right: the premium gate ranks a model against
`floor(len × 0.75)` of the whole exposed pool, so a fixture's price decides its own *class* only
relative to whatever else happens to be in the catalog. My money-binding companion added another
cheap-side row, which crowds that percentile for every percentile-dependent test in the file — the
mechanism behind the 403s seen in three of four full runs on tests I never touched. A green run of my
own was one draw of a variable my fixture had made noisier.

**Fix.** The file already had the right shape — `withDearTrialCatalog`, which wipes the catalog under
the lock and seeds a fixed spread. It hard-codes the fixture's pricing, so I generalized it:

- `withPinnedTrialCatalog(fixtureId, descriptorOverrides, postSend)` — wipe, seed the cheap eligible
  model, seed the pricey decoys that hold the top quartile, seed the fixture with the caller's
  overrides, then send.
- `withDearTrialCatalog` now **delegates** to it with its own pricing rather than repeating the body,
  so there is one implementation of the wipe-and-spread and the pre-existing test that depends on it
  is behaviour-identical.

**Four pins wrapped, one more than the three you named.** The three from the finding are the
money-binding companion and the two trial reasoning pins. I also wrapped the fourth in that group —
the physical-bound cap pin — because it expects a 201 and is vulnerable to the identical flip: a
crowded percentile makes its fixture read premium and the send answers 403. Its *seeding* is
pre-existing in shape (I only rewrote its assertion last cycle), so this is one line beyond the
finding, flagged rather than absorbed. Say the word and I will revert that one.

The reasoning fixture's descriptor is now a named constant, `REASONING_TRIAL_FIXTURE`, whose docblock
states the hazard at the seam where someone would otherwise reach for `seedGateModel` again.

**Why this is deterministic rather than luckier.** `withPinnedTrialCatalog` opens with an
unconditional `db.delete(modelCatalog)` inside the cross-suite lock, so the pool each wrapped test
ranks against is exactly five rows it seeded itself — one cheap model, three 1e9-nano decoys, and the
fixture. `floor(5 × 0.75) = 3` indexes into the decoy band, so the threshold is 1e9-scale and a
2,500-nano fixture cannot read premium at any run order. That is a property of the fixture, not of
the draw. It also removes my added row as a crowding source for the file's other percentile-dependent
tests.

Same lock discipline as before: `withSuiteCatalogLock` tracks holdership because the shared lock is
not reentrant, and the new helper acquires through it exactly as the old one did.

---

## Self-gate

| command | result |
| --- | --- |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | **pass** |
| `npx turbo typecheck --force --continue` | **pass** — 16 successful / 16, 0 cached |
| `eslint` (the files touched this cycle, from `apps/api`, after the last edit) | **pass** — exit 0 |
| `pnpm test:watch chat/routes.integration.test.ts` | **pass** — 188 tests, in isolation |
| `pnpm test:api` ×2 (full-suite load, the condition the 403s appeared under) | **7 failed / 6,409 passed / 2 skipped** both runs — all 7 are §Known Breakage `template-html`; `chat/routes.integration.test.ts` **188/188 green in both** |

The two full runs are the empirical half of finding 3: the file that flipped in three of four earlier
runs is green in both draws taken after the fixture change. The structural half is the unconditional
wipe, which is what makes the outcome independent of the draw.

The pool arithmetic, verified against the seeding helpers rather than asserted: `seedModel` inserts
one text model at 2/3 nano (combined 5), `seedTrialDecoys` three at 1e9/1e9 (combined 2e9), plus the
fixture — five rows. `floor(5 × 0.75) = 3` indexes the sorted combined rates `[5, 2500, 2e9, 2e9,
2e9]` at the decoy band, so the threshold is 2e9 and the 2,500-nano reasoning fixture is
non-premium with three orders of magnitude to spare. The two cap-pin fixtures sit at 5.

I changed nothing in `packages/shared` this cycle, but **the tree did** — see §A money invariant is
red in the working tree, and it is not mine. Re-running the gate rather than standing on the earlier
green: `pnpm test:shared` is now **2 failed / 2,985 passed (2,987)**, both failures pre-existing B3
pins that B5's in-flight work moved. My own five shared pins pass in that same run.

## A money invariant is red in the working tree, and it is not mine

**SUPERSEDED — do not hunt this defect; it is not in the tree.** The orchestrator ran it directly and
`turn-core.test.ts` passes 55/55 including the pin named below; the failure was a transient mid-flight
read of another task's in-progress work in a shared directory, not landed work. The observation and its
four-way attribution were accurate when made.

B5 has landed in `packages/shared/src/affordability/**` since my last gate — `OUTLIER_COST_MULTIPLE`,
`maxCallCostNanoUsd`, `medianMaxCallCostNanoUsd`, `outlierModelIds`, a new `percentile.ts`, a new
`turn-core.outlier.test.ts`, plus `exceedsTrialBudget` / `trial_message_cap_exceeded` in
`turn-core.ts`. Two of B3's pins now fail:

1. *holds at least the priced total of every arrangement a presented candidate can create* —
   `expected 89231250n to be 89263685n`. The hold moved **down** by 32,435n. Benign in direction and
   exactly what B5's own criterion predicts ("the hold falls, the presented set grows").
2. *withholds a candidate whose arrangement starves a pinned sibling* —
   **`expected 89263685 to be greater than or equal to 117957435`.** This one is not cosmetic. It is
   B3's core money invariant — the hold must cover every arrangement a **presented** candidate can
   create — and it is violated by ~32%: a hold of 89,263,685n against a presented arrangement pricing
   117,957,435n. That is the same defect class B3's criteria name explicitly ("the presented candidate
   set and the hold domain being different sets neither containing the other, a ≈34% under-reserve"),
   reappearing because a change to the presented set did not move the hold's `MAX` domain with it.

**Why it is B5's and not B4's, established four ways rather than assumed:**

- Both failing pins exist **verbatim at `ada0341c`** (`git show ada0341c:…turn-core.test.ts` finds
  the test name and the `89_263_685n` literal), so they are pre-existing, not written by me.
- My diff to `turn-core.test.ts` removes or changes **zero** lines — `git diff HEAD | grep -cE '^-[^-]'`
  is 0. It is purely additive (my two describe blocks), so I could not have altered those pins.
- `turn-core.ts` now carries **53 non-comment changed lines**. Mine is two comment lines and zero
  non-comment lines, which the orchestrator verified independently before I was dispatched; the added
  symbols (`outlierModelIds`, `exceedsTrialBudget`, `trial_message_cap_exceeded`) are §Smart Model 1–3
  and ruling 5, i.e. B5's criteria.
- `turn-arithmetic.ts` (+99/−1) and `turn-arithmetic.test.ts` (+92) are untouched by me in either
  cycle.

**I did not fix it**, on both applicable rules: the files are another task's ownership, and a red money
pin I did not cause is a finding rather than an expectation to rewrite. Flagging it because B5's own
criterion tells it to *expect* the hold to fall and the presented set to grow — which is precisely the
shape that produces this violation when the two readings are not derived from one place, so it could
pass B5's self-gate as intended behaviour.

---

## Acceptance criteria

Unchanged from report 2 — all eight added criteria plus report 1's three items remain met; this cycle
changed one comment, three label removals, and the seeding of four route pins. No assertion, amount,
or production behaviour moved.

## Concerns and limitations

1. **The wipe is cross-suite, by inheritance not by choice.** `withPinnedTrialCatalog` deletes every
   catalog row, which is what `withDearTrialCatalog` already did — the same statement under the same
   lock, relying on the file's documented invariant that every test re-seeds what it needs. I widened
   the number of tests that do it (four more), which is more wipes per run. If the concurrent
   model-catalog workstream ever adds a test that seeds once in `beforeAll` and reads later without
   the lock, these wipes are one of the things that would break it. Cheap to see coming; noted rather
   than guarded.
2. **I did not construct the 403 myself.** The auditor observed it across full runs; my evidence is
   that the fixture can no longer produce it by construction plus the full-suite run recorded above.
   Reproducing the crowded pool deliberately would need a pre-seeding harness this file does not have,
   and building one to prove a fixture is deterministic seemed the wrong trade.

## Confidence

**High.** Findings 1 and 2 are exact and verified by diff. Finding 3's fix reuses the file's own
established mechanism, makes the percentile independent of run order by construction rather than by
luck, and removes the crowding my previous cycle introduced.
