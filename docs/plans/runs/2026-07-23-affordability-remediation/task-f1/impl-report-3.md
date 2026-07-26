# F1 — Payer-scoped served numbers · impl-report-3 (fix cycle)

## Objective

One validated finding, nothing else. Both of impl-report-2's findings were verified closed
and the re-audit passed; the sole remaining item is an inaccurate closing clause in a comment
that cycle added at `apps/web/src/hooks/billing/use-prompt-budget.ts`.

The clause claimed `useResolveBilling` splits the two `useSpendable` reads. It does not —
that hook issues exactly one, argument-free. What splits them is the composer **path**.
Fix: name the path, keep every other sentence (all of it correct and load-bearing).

## The comment, before and after

Location: `apps/web/src/hooks/billing/use-prompt-budget.ts`, the block immediately inside
`useModelFloor` above the two `useSpendable` calls (now lines 678–685).

**Before** (final two lines of the block; the first four lines are unchanged):

```
  // personal funds — feeding it the payer-scoped figure would grey models the
  // member can self-fund. `useResolveBilling` splits them the same way.
```

**After:**

```
  // personal funds — feeding it the payer-scoped figure would grey models the
  // member can self-fund. The composer path splits them the same way:
  // `usePromptBudget` takes the scoped read for sizing and delegates the compare
  // to `useResolveBilling`, which takes the argument-free one.
```

Full block as it now stands:

```
  // Two reads, two wallets, two jobs. The conversation-scoped snapshot names the
  // PAYER, so it sizes the turn (§Group Funding 1). The argument-free snapshot is
  // the CALLER's own wallet, which is what `resolveClientBilling` compares once
  // the group headroom fails to cover the turn and the member falls through to
  // personal funds — feeding it the payer-scoped figure would grey models the
  // member can self-fund. The composer path splits them the same way:
  // `usePromptBudget` takes the scoped read for sizing and delegates the compare
  // to `useResolveBilling`, which takes the argument-free one.
```

I used the auditor's suggested replacement with one improvement: rather than listing the two
hooks as peers, it states the actual relation — `usePromptBudget` *delegates the compare to*
`useResolveBilling`. The two are not siblings each picking a read; one calls the other, which
is why the split exists inside a single path. Naming the delegation is what makes the claim
dereferenceable in one hop.

### Why the new clause is checkable (the whole point of the fix)

Every hop a reader must take, verified in the code this cycle:

| Claim | Evidence |
| --- | --- |
| `usePromptBudget` takes the scoped read | `use-prompt-budget.ts:466` — `useSpendable(conversationScope(input.conversationId))` |
| …and it is for sizing | that snapshot's tier feeds `outputCharsPerToken`, the sizing input; it never reaches `resolveClientBilling`'s `spendableNanoUsd` |
| `usePromptBudget` delegates the compare | `use-prompt-budget.ts:546` — `useResolveBilling(...)` |
| `useResolveBilling` takes the argument-free read | `use-resolve-billing.ts:35` — `useSpendable()`, no argument, the hook's only such call |
| the path is the composer's | `usePromptBudget` has exactly one production caller: `apps/web/src/components/chat/input/prompt-input.tsx:696` |

The last row is the one the finding's STOP-AND-ASK trigger guarded: naming "the composer
path" asserts something about `usePromptBudget`'s call sites, so I verified it rather than
assumed it. A repo-wide grep for `usePromptBudget(` across `apps/web/src` excluding tests
returns the definition plus that single call site in the composer's `prompt-input.tsx`. No
NEEDS_CONTEXT was required.

The false clause's cost, for the record: a reader following the old pointer to
`useResolveBilling` to establish the precedent finds one unscoped read and can confirm
nothing — CODE-RULES' "a wrong comment is worse than none".

## Files changed

- `apps/web/src/hooks/billing/use-prompt-budget.ts` — the clause above. One `Edit`, both
  sides comment-only.

No other file in the repo was touched this cycle.

## No executable line changed

Explicitly confirmed, as the brief requires:

- The single edit's `old_string` and `new_string` are both entirely `//` comment lines. No
  statement, expression, identifier, import, or type moved.
- The two `useSpendable` calls the comment describes, the `isPending` composition, and the
  `resolveClientBilling` call are byte-identical to what impl-report-2 left.
- Consistent with that: the focused test file reports the same **68 passed** as impl-report-2
  did, with no test added, removed, or modified this cycle.

## Tests added

**None, correctly.** The change is comment text; there is no behavior to pin, and inventing a
test that asserts a comment's wording would be a sync contract against the code it describes.
The behavior the comment documents — payer-scoped read → sizing, unscoped read → affordability
compare — is already pinned by the two tests impl-report-2 added and watched red
(`funds a member's fall-through from their OWN wallet when group holds zero the headroom out`,
`suppresses greying while the caller's OWN wallet read is still in flight`), both of which pass
unchanged here.

This is the same disposition impl-report-2 recorded for its own comment-only finding, and it
does not violate the TDD iron law: the law governs production code, and no production code was
written.

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint src/hooks/billing/use-prompt-budget.ts` — run from `apps/web`, **after** the last edit | **exit 0** (Global Constraint 9) |
| `npx turbo typecheck --filter=@hushbox/web --filter=@hushbox/api --filter=@hushbox/shared --force --continue` | **pass — 3/3, 0 cached** |
| `npx turbo typecheck --force --continue` (repo-wide) | **pass — 16/16, 0 cached** |
| `npx vitest run src/hooks/billing/use-prompt-budget.test.ts` (the one file touched) | **pass — 1 file / 68 tests** |
| `npx vitest run src/hooks/billing` (the owning directory) | **pass — 12 files / 237 tests** |

Scoped test evidence for the one file touched, as the brief requires: `use-prompt-budget.test.ts`
alone is **68/68 green**, identical to impl-report-2's count — the expected signature of a
comment-only change.

### The brief's named non-mine failures did not materialise

- **The repo-wide typecheck is 16/16, not 15/16.** The brief said `packages/shared/src/affordability/dimensions/derive.ts`
  carried a `TS6133` from B2, which owns that untracked tree, and told me to verify `apps/web`,
  `apps/api` and `packages/shared` clean instead. All three are clean — **and so is the full
  repo**, uncached. The file is still untracked (`?? packages/shared/src/affordability/dimensions/derive.ts`),
  so B2 evidently closed the error between the brief being written and this run. I did not
  touch it, and I did not touch `packages/shared/src/models/premium-check.ts`.
- **No `model-catalog test lock` timeouts** — the new §Known Breakage entry names five
  `apps/api` integration files; I ran no `apps/api` suite this cycle (no `apps/api` file
  changed), so the entry had no occasion to fire.
- **`pnpm test:web`'s intermittent `markdown-renderer.tsx` per-file coverage flake** was not
  exercised: I gated on the focused file and the owning directory rather than the full web
  suite, which §Known Breakage explicitly licenses for F1 ("judge those on the file list and
  the per-file numbers, not on the gate's exit code"). Coverage is unaffected regardless — a
  comment is not a coverable line, and the covering tests are unchanged.

## Acceptance criteria

The plan's F1 criteria were met in run 1 and passed both audit lenses; impl-report-2's two
findings were verified closed by the re-audit. Only the one clause was in scope here.

1. **The comment's closing clause is accurate and dereferenceable** — met. The path is named
   instead of the hook, and every hop is verified in the table above.
2. **Everything else in the comment is preserved** — met. The first four lines (which read
   feeds which parameter, and why feeding the payer-scoped figure would grey a self-fundable
   model) are byte-identical; only the final sentence was replaced.
3. **No behavioural regression** — met. No executable line changed; 68/68 on the file,
   237/237 on the directory, 16/16 repo-wide typecheck.

## Deviations, reasons

One, and it is a wording improvement rather than a departure: I did not take the auditor's
suggested replacement verbatim. Its phrasing ("`useResolveBilling` takes the argument-free
read, `usePromptBudget` the scoped one") is accurate but presents the two hooks as peers,
which invites the same wrong mental model that produced the original error — that each hook
independently chooses a read. Stating the delegation (`usePromptBudget` → `useResolveBilling`)
makes the split's existence intelligible and keeps the claim one hop from verification. The
brief explicitly permitted improving on the suggestion.

## Concerns and limitations

- **The comment is interim by design.** E1 is slated to delete `useModelFloor`, so this
  comment will go with it. That is precisely why the clause was worth a cycle: until E1 lands,
  it is the pointer E1's own implementer would follow to establish the precedent, and it was
  pointing at a hook that demonstrates nothing.
- **It will need re-verification if the composer path is restructured.** The clause names
  `usePromptBudget`'s single call site indirectly ("the composer path"). If a second caller of
  `usePromptBudget` ever appears outside the composer, "the composer path" narrows to an
  example rather than the path — still true of the delegation it describes, but less precise.
  I judged naming the path better than naming `prompt-input.tsx` outright, since CODE-RULES
  bans specific file paths in comments (paths move).
- **Unchanged from impl-report-2, still open, still not mine:** the raw owner-dimension
  divergence (settled in the spec's favour; refusal copy is B7's), `payerSizingTier`'s missing
  production consumer, and the repeated `cap − spent − held` composition — both routed to G2.

## Confidence

**High.** The finding was narrow, factually verified against the code before editing
(`use-resolve-billing.ts:35` is a single argument-free `useSpendable()`, so the old clause was
false as stated), and the replacement's every hop is confirmed by file and line. No executable
line changed, which bounds the blast radius to zero; lint is exit 0 after the final edit, the
repo typechecks 16/16 uncached, and the touched file's suite is green at its prior count.
