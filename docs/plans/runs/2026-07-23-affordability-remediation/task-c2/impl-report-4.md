# C2 — impl report 4 (fix cycle 3)

One finding: the falsified-comment class at six sites in `chat/domain/settlement.ts` plus one test.
Reports 1–3 stand for everything else.

## Verdict on the finding: all six are genuinely false. None was still true.

I checked each against the current code before touching it, per your instruction to stop rather than
reword if any turned out to still hold. All six are false, and two of them are false in the specific
way that matters — they state the two rules this task replaced, in the file the ruling was about.

I also found **three more instances of the same class** while checking, which the finding did not
list. Two are additional stale sites in files already granted to me; one is my own replacement for
site 4, which asserted a behaviour conjunction that no test held. All three are fixed below (sites 7
and 8, and the added assertion under site 4). A fourth candidate turned out to be **still true** and I
left it alone — recorded below so the next reader knows it was checked, not missed.

---

## Site 1 — `:215-216`, the rejected justification in production

**Old:** "A media output paired to a NON-media charge is a shape mismatch, so it mints no content item
of its own; the charge still settles, against the run's anchor, **because the provider spend
happened**."

**Why false:** after cycle 1, provider spend is exactly what does *not* license a charge. The
uncommitted-generation case has real provider spend and bills nothing. This is the sentence the §C2
ruling named as documentation-as-cover, and it was in production code — I wrote it in cycle 0 and
cycle 1's report claimed this file was swept. It was not.

**New:**

> …the charge still settles, against the run's anchor, because its node's value COMMITTED.
>
> Committing is the licence, and provider spend is NOT — a generation whose call succeeded but whose
> value failed the runtime output gate never reaches this function at all, because the interpreter
> charges after the commit and only on success (pinned in `interpreter.test.ts`, "bills nothing for a
> sibling whose value failed output validation"). So every charge here names work the run accepted,
> which is what makes anchoring a contentless one onto the run's content honest rather than an
> over-bill.

**Rule asserted:** billable ⟺ the node's value committed; provider spend alone never licenses a
charge. **Test that holds it:** `interpreter.test.ts` — "bills nothing for a sibling whose value
failed output validation, while a committed sibling bills" (cycle 1, watched red: `expected [ 'm0',
'm1' ] to deeply equal [ 'm1' ]`). The claim "never reaches this function at all" is exact: an
uncommitted generation produces no charge, so it is absent from `request.charges`, which is the only
thing this function iterates.

## Site 2 — `:276-279`, both replaced rules, verbatim

**Old:** "Aggregate the run's FULL charge set (own generations + **auxiliary classifier charges**) …
Only persistable charges mint content items; **a classifier anchors to its answer's item**."

**Why false:** both halves are what this task removed. No production code produces `auxiliaryCharges`
— the classifier is its own node with a top-level charge key. And "anchors to its answer's item" is
the precise failure this task exists to fix: when the answer sibling is the one that failed, its item
does not exist and the charge vanishes.

**New:**

> Aggregate the run's FULL charge set by the content item each anchors to, so display equals debit for
> every turn shape. Only persistable charges mint content items, so a charge with no content of its
> own resolves through `anchorChargeKey`'s run-level rule — the run's FIRST persisted content in
> charge order. A turn-level classifier is that case: it has no content and no parent charge that
> does, and naming a sibling would lose it whenever that sibling is the one that failed. Pinned in
> `settlement.test.ts` ("anchors a turn-level charge to the run's first persisted content", "takes the
> FIRST persisted key in run order") and end-to-end in this file's integration suite ("lands a
> turn-level classifier charge on the run's content when the first sibling failed").

**Rule asserted:** a contentless charge anchors to the run's first persisted content in charge order,
not to a named sibling. **Tests that hold it:** the two `settlement.test.ts` unit rules (both watched
red — returned `undefined` before the fix) plus the integration pin that asserts both usage records
FK the one persisted item with 805 n / 4 830 n.

This is the site your severity note is about: C3 works in this file family next, and these two
sentences were teaching it the two rules it must not use.

## Sites 3 and 3b — `:455-457` and `:641-644`, stale "auxiliary classifier"

**Old (`:455`):** "its own generation PLUS any **auxiliary charge (a Smart Model classifier)** whose
cost the debit path FKs to the same content item, because both resolve the anchor through
`anchorChargeKey`."
**Old (`:641`):** "PLUS **any Smart Model classifier charge** FK'd to the same item by the debit
path."

**Why false:** the classifier is not auxiliary and the slot calls none. The *mechanism* half of
`:455` ("both resolve the anchor through `anchorChargeKey`") is true and load-bearing, so I kept it
and replaced only the characterisation.

**New:** "…PLUS **every contentless charge** whose cost the debit path FKs to the same content item,
because both paths resolve the anchor through the one `anchorChargeKey`." and "…PLUS **every
contentless charge** the debit path FKs to the same item."

Stating the general class rather than one example is what stops this comment going stale again the
next time the set of contentless charges changes.

## Site 4 — `:459-461`, plus the seventh issue I found

**Old:** "`isSmartModel` is true iff a charge anchoring here ran the smartModel routing pipeline
(`smartModelRan`), independent of whether the classifier billed — **a classifier that failed and fell
back** badges the answer just the same."

**Why false:** the slot calls no classifier, so "a classifier that failed and fell back" names
nothing. The `smartModelRan` semantics are still correct.

**New:** "…(`smartModelRan`), which the slot sets from the turn's own shape: an answer that fell back
to its declared candidate because no decision reached the slot badges just the same. The chip reads
'the pipeline ran', never 'a classifier billed'."

**Then I checked whether that new sentence was pinned, and it was not.** The existing test "binds the
cheapest candidate when no decision reaches the slot at all" asserted the bound model but not the
badge, so the conjunction my comment claims (no decision **and** still badged) had no test. Under the
durable-claim rule that makes the comment inadmissible, so I pinned it rather than softening it:

```ts
expect(result._unsafeUnwrap().smartModelRan).toBe(true);
```

added to that test, with a note saying the display path's `isSmartModel` comment rests on it. 27/27
green. This is the class the finding is about, caught one level up — a replacement comment that would
itself have been unenforced.

## Site 5 — `:535`, false mechanism in a `v8 ignore`

**Old:** `groups is non-empty (empty charges terminal-fail upstream)`
**New:** `groups is non-empty (a run with no persistable content terminal-fails upstream)`

True conclusion, false stated mechanism: the detector reads `collectPersistableCharges(request)`
emptiness, not `request.charges.length`.

## Site 6 — `settlement-storage.test.ts:113-115`, unreachable failure mode

**Old:** "The shared prompt fee has to land on a charge that will actually be written, **or the
charging commit skips it and the fee the reservation held is never billed**."

**Why false:** under the run-level anchor no charge is skipped — a contentless charge anchors to the
run's content — so the described loss cannot happen; and a run that persisted nothing terminal-fails
before the commit. The *rule* the test pins is still right, for a different reason.

**New:**

> A turn-level generation (the classifier) runs before the siblings and carries no content of its own,
> so it is the run's FIRST charge. The shared prompt fee still has to ride a charge that MINTED a
> content item, so the whole fee lands on one item deterministically in both the debit and the
> display, rather than on whichever item the run-level anchor happens to resolve for a contentless
> charge.

That now matches the justification already in `withStorageFees`' own docblock, which cycle 0 had
already corrected — the two were inconsistent, which is how this one survived.

---

## Sites 7 and 8 — found by applying the grep method to every file I own

After fixing the six, I ran the method I recommend below across all eight production files in my
ownership, grepping for the vocabulary of the removed mechanisms (`auxiliary`, `zero charges`,
`no content, no charge`, `classifier call`, `cheapest candidate`, `its answer's item`, `accrues its
classifier`). Four hits were my own already-corrected text, correctly bounded. Two were genuinely
stale, and one was still true.

**Site 7 — `execution-registry.ts:149-154`, the `smartModelRan` docblock.** Same class as site 4, and
the finding did not list it.

- **Old:** "The smartModel routing pipeline ran for this generation (**the classifier was
  attempted**), independent of whether it billed … even **a classifier that failed and fell back to
  the cheapest candidate** produces no classifier charge yet still ran."
- **Why false:** the slot attempts no classifier. The flag is set from `node.classify?.model ?? true`
  — the node's declared shape — not from any attempt.
- **New:** "…independent of what any classifier did. The slot sets it from the turn's own declared
  shape — a model-routing slot badges, a pinned-model slot does not — so an answer that fell back to
  its declared candidate because no decision reached the slot badges just the same."
- **Rule asserted / test:** the badge derives from the declared shape, not from a classifier outcome.
  Held by `smart-model-execution.test.ts` — "binds the cheapest candidate when no decision reaches the
  slot at all" (now asserting `smartModelRan === true`) and "pinned + auto … NOT badged", which pins
  both directions.

**Site 8 — `smart-model-turn.ts:284-289`, the `classifyEffort` docblock.**

- **Old:** "True when the request selected `auto` effort: **the ONE classifier call additionally
  classifies** the effort dimension … with none, no effort dimension exists (**no call beyond
  routing**, no extra charge, no reserve change)."
- **Why false:** both clauses assert that a call happens in this build. What the flag actually does is
  declare the effort axis open on the slot, which `smartModelClassifierDimensions` reads and the
  estimator prices a reserve for — true today; the call itself is C3's wiring.
- **New:** "…the slot declares the EFFORT axis open alongside the model axis, so the turn's one
  classifier answers both and one reserve covers both. Gated on at least one reasoning-capable
  candidate — with none, no effort axis exists, so nothing beyond the model axis is asked and the
  reserve is unchanged." This is true both before and after C3 wires the node, which is the point:
  it describes the declaration and what it buys, not a call it cannot see.

**Checked and left alone — `smart-model-turn.ts:346-353`, the `fallback` variant.** It says a
not-classifier-eligible turn resolves "with no classifier call, charge, or reserve". That is an
**absence** claim and it is still exactly true — a fallback turn declares no open axis and buys no
reserve, which is the "one option ⇒ no call, no reserve" rule. Rewording it would have been the error
you warned about.

---

## Files changed this cycle

| File | Why |
| ---- | ---- |
| `chat/domain/settlement.ts` | six comment corrections (sites 1, 2, 3, 3b, 4, 5). No executable change. |
| `chat/domain/settlement-storage.test.ts` | site 6, comment only. |
| `workflows/engine/execution-registry.ts` | site 7, comment only (granted for comment corrections). |
| `chat/domain/smart-model-turn.ts` | site 8, comment only. |
| `workflows/nodes/smart-model-execution.test.ts` | one added assertion, pinning the claim sites 4 and 7 make. |

## Self-gate

| Command | Result |
| ------- | ------ |
| `apps/api` `npx tsc --noEmit` | **pass** — exit 0, after the final edit |
| `npx eslint` on the three changed files, from `apps/api` | **pass** — exit 0, after the final edit |
| Suites over every touched file | settlement.integration 62/62 · settlement-storage 9/9 · smart-model-execution 27/27 · settlement 31/31 · interpreter 94/94 |
| Scoped `src/slices` run, excluding the known-broken `template-html` file | **pass** — exit 0, **325 files passed / 1 skipped**, 5089 passed / 2 skipped |

I ran that gate **without** `--coverage` deliberately. Two earlier coverage-instrumented attempts this
cycle exited 1 with **zero `FAIL` lines** on the documented merge crash
(`ENOENT … coverage/.tmp/coverage-9.json`), which is noise on a cycle that changes no executable
production code. `settlement.ts`'s coverage cannot have moved — the only non-comment change anywhere
this cycle is one added assertion in a test — and its last measured figures stand from cycle 1
(98.65 stmts / 97.08 branch / 100 funcs / 99.51 lines, above the 95 gate).

## Concerns and limitations

1. **This is the second sweep of this file and it still found six sites, which says the method was
   wrong, not just the execution.** Cycle 0 swept by re-reading the diff's own hunks, so it caught
   every comment I had *edited* and none of the comments my edits *falsified elsewhere in the same
   file*. The reliable method is the one this finding used: grep the file for the vocabulary of the
   removed mechanism (`auxiliary`, `classifier`, `skips`, `zero charges`, `provider spend`) and check
   each hit against the new behaviour. I would recommend that as the standing rule for any task that
   removes a mechanism — it is cheap and it is what both my sweeps lacked.
2. **No executable change to `settlement.ts` this cycle**, so its behaviour and coverage are
   unchanged; the only test-visible change is the one added assertion, which passes.
3. Reports 1–3 raises stand as routed: scope reading accepted (mechanism, not graph wiring); the
   interim routing regression, the `estimate-run.ts` double-pricing gap, the full-history and
   custom-instructions under-reserve terms and the orphaned classifier properties are with C3; the
   stop-path contradiction is with the founder; the two red suites (7 `template-html` snapshots, and
   the load-dependent trial 403 that passes 188/188 alone) are not mine.

## Confidence

**High.** Comment-only in production, each of the six verified false against the current code before
being touched rather than reworded to match the finding's description, and the two load-bearing
replacements now name a rule plus a test that reddens. The one substantive addition is the assertion
that makes site 4's replacement enforceable rather than prose.
