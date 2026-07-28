# C3 — impl report 6 — the three audit Minors, closed

## Objective

Close the three Minor findings from the money audit. The Important one is `apps/web` and goes to
E1; this report records what I verified about it and where my method's radius was wrong.

## Finding 1 — the stale figure in my own shipped comment

`language-adapter.test.ts` said "the ~2.6 KB base preamble" — the estimate I had already
**measured and corrected to 1,739 characters**, and which the plan records as high by roughly a
third. Carrying a number I had personally superseded is the mirrored-constant shape in prose.

Rewritten to the measured value, and to the quantity that makes it load-bearing rather than
decorative: 1,739 characters against a 4,708-character reserve basis whose worst-case emitted
input already uses all but **317** of it — so the preamble alone overruns the headroom.

**Swept for other copies:** `grep` for `2.6 KB`, `2.6KB`, `~2,600`, `2600 char` across `apps`,
`packages` and `BILLING.md` returns nothing outside this run's own report files. One site, now
correct.

## Finding 2 — the reserve pin asserted against a twin

The auditor is right, and the file's own header convicted it: it claims its assertions are about
"the definition a REQUEST compiles, rather than about a reassembled twin", while `assembledInput()`
rebuilt the classifier input by hand — `` `${prompt}\n\n${excerpt}` `` — duplicating the join that
`turnInputs` performs, in a file that calls `turnInputs` two describes later.

It now reads the string out of `turnInputs(build, LONG_USER, history)` and asserts on what the run
actually receives.

**Shown to redden on a change inside `turnInputs`,** which is exactly what the twin could not see:
I made `turnInputs` send the untruncated user message instead of the truncated excerpt, and the pin
failed with `expected 12391 to be less than or equal to 4708` — a 2.6× overrun of the reserve. The
file was restored byte-exact (`diff` verified). Before this fix that regression passed silently:
the twin kept truncating no matter what production did.

## Finding 3 — the sibling builder's typed options

`siblingOptions()` returned `Readonly<Record<string, unknown>>` and both call sites cast with
`as Parameters<typeof modelCall>[0]`. The auditor's reasoning is the part that matters: `Node`
variants are `z.object`, so an unregistered or mistyped key is **silently stripped** at parse — a
wrong `onError` would compile, parse, and default to `'fail'`, converting a skipping sibling into a
turn-killer with nothing to observe.

Now typed as the builder's own options minus the ports, which differ by turn shape:

```ts
type SiblingOptions = Omit<ModelCallOptions<TypeTag, TextTag>, 'id' | 'accepts' | 'in'>;
```

**Both casts are gone** (`grep` for `as Parameters<typeof modelCall>` is clean) and the generic
still infers `accepts` at each call site, so no cast was unavoidable after all.

**Shown to bite:** with `onError: 'skipp'` the compile fails —
`TS2820: Type '"skipp"' is not assignable to type '"fail" | "skip"'. Did you mean '"skip"'?`
Restored byte-exact. The docblock records why the type is the guard here: no test can assert the
absence of a key nobody wrote.

## The Important one — verified, and my sweep radius was wrong

**Current state, checked rather than assumed:** `RETRYABLE_REFUSAL_CODES` in
`apps/web/src/hooks/chat/use-authenticated-chat.ts` **now contains `RUN_CAPACITY_REACHED`**, and
carries a docblock naming `CONCURRENT_RUN` and `RUN_CAPACITY_REACHED` as the pair to reason from
and recording that this has "now happened twice to code-keyed collections for one wording change".
So it is fixed. I did not touch the file.

**I then ran the sweep at the radius that should have caught it** — repo-wide, per Global
Constraint 10 — and it finds **two further sites** keyed on `INSUFFICIENT_ADMISSION` alone, which
my split moved run-cap out of: `use-authenticated-chat.ts:1079` and `:1345`, both invalidating the
balance query on refusal.

**Assessed, not left open:** neither is a defect in the same direction. A run-cap refusal is not a
balance event — the balance did not move, only the held figure did — and §Notices 9 already
invalidates the served numbers on run completion regardless of which conversation raised the hold.
So the split loses a redundant refresh and arguably makes the branch more correct. Reported so the
class is closed by inspection rather than by silence; E1 owns the file either way.

**Where my method's edge was, stated as a rule rather than an apology.** My vocabulary sweeps were
**package-scoped** — I swept `apps/api` and `packages/shared`, the files I owned. A wire code is a
**cross-package contract**, so the sweep radius for one is the repo, which is what Global
Constraint 10 says and what I did not do. The sharpened rule for the next agent, because
"sweep repo-wide" is too vague to act on:

> When a change adds, renames or splits a **wire code**, grep the repo for every *sibling* code in
> the collections it appears in — not for the new code, which by definition appears nowhere yet.
> The new code cannot be found; the collections that should now contain it can only be found
> through the codes already in them.

That is precisely how I found `RUN_REFUSAL_STATUS` (by following `INSUFFICIENT_ADMISSION`) and
precisely what I failed to repeat one package further out.

## Not mine, recorded

- **Two consumption walks decide one fact** — definition-level `consumedProducerIds` and the
  interpreter's compiled-level walk. Verified they cannot disagree today; if they ever do, storage
  under-reserves. Not assigned.
- **`renderOptions` still has zero production consumers**, because I narrowed through
  `buildClassifierSystemPrompt` instead. Two prompt composers therefore exist and only mine is
  priced. The coordinator records this as a correction against the plan's text rather than against
  the work; I note only that the priced one is the one that runs, so the reserve is honest today,
  and the unpriced one is the hazard if a future caller reaches for it.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:api` | **7 failures, all the documented template-html family** — zero chat-integration failures this run, which is the moving set's own behaviour |
| `turbo typecheck --force` (api + shared) | **2/2** |
| `eslint` from `apps/api`, this cycle's 3 files | **exit 0**, empty output |
| targeted re-runs | `turn-classifier.test.ts` + `language-adapter.test.ts` — 66 passed |

Two inversions were run this cycle (Findings 2 and 3), each with a byte-exact restore verified by
`diff`, and no background suite was in flight during either.

## Confidence

**High.** Each of the three fixes was proven to discriminate rather than merely made: the figure
was re-measured, the reserve pin was shown to redden on a production change it previously could not
see, and the sibling type was shown to reject the exact mistyped value the auditor named.
