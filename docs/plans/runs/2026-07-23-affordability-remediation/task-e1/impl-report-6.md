# E1 — impl report 6 (payer resolution landed, four pins re-homed, ENGINE DELETED)

## Status

**DONE_WITH_CONCERNS.** The ruled payer resolution is in, the group regression is closed and
inversion-proven, the four F1 pins are re-homed, and **`useModelFloor` and its floor computation
are deleted** — grep-clean across `apps/web` by the vocabulary method. The added
`RUN_CAPACITY_REACHED` item is done, premise verified first. The effort menu, send gate,
`chat-welcome.tsx`'s fourth verdict site and the remaining component tests are still open.

---

## 1. Payer resolution through `resolveFunding` (the ruling)

`useTurnOptions` now makes **two** funding reads plus `useConversationBudgets`, and asks the shared
decision which wallet the floor is priced against:

```
resolvePayerFunding → resolveFunding(deriveClientFundingInputs({…, estimatedMinimumCostNanoUsd: undefined}))
                    → decision.payer === 'owner' ? payerScoped : ownWallet
```

`turnEstimateNanoUsd` is deliberately `undefined` — the core documents that absence as "the caller
asks only who WOULD pay", which is exactly the picker's prompt-independent question. That is what
keeps the resolution from becoming prompt-dependent, so a row cannot change payer while the user
types. **The adapter acquired no verdict**: it selects an input and calls the producer once.

### The regression, closed and proven

The discriminating pair from report 5, now as permanent tests:

| Case | Before | After |
| --- | --- | --- |
| Group headroom **durably spent**, member self-funds | greyed `insufficient_funds` | **available** |
| Group headroom **held out** by a run in flight | available | available (unchanged) |
| **Both** exhausted | greyed | greyed `insufficient_funds` |
| Owner-funded while headroom lasts, member wallet empty | — | available |

**Inversion:** collapsing `resolvePayerFunding` to `return args.payerScoped` reddens exactly one
test — *"does NOT grey a model the member can self-fund when group headroom is durably spent"*.
Restored byte-exact (`diff` clean).

**The knowledge that survived.** `useModelFloor`'s own docblock recorded the hazard — *"feeding it
the payer-scoped figure would grey models the member can self-fund"* — and that comment was inside
the block I deleted. It is now four executable pins. A comment does not survive a deletion.

### A mock defect I caught in my own harness

Routing `useSpendable(null)` to a separate own-wallet fixture broke three solo tests: a solo
composer really does call `useSpendable(null)` twice, so the two must **share** one fixture. Fixed
with the argument-aware pattern the plan already documents for `use-prompt-budget.test.ts`
(`mockOwnWallet` defaults to `undefined`, meaning both arms share). Had I "fixed" the three failing
tests instead of the mock, I would have hidden that the solo path reads one wallet.

## 2. The deletion

**Deleted** (133 lines, `use-prompt-budget.ts`): `useModelFloor`, `modelFloorNanoUsd`,
`ModelFloorGroupContext`, `UseModelFloorInput`, `ModelFloorResult` — plus `groupScope`, which died
with them, and the 357-line `describe('useModelFloor')` block whose pins are re-homed.

**Survives, as ruled:** `smartModelPoolFromCatalog` and `buildModelTokenPricing` — the composer's
live estimate under the text-arm-only ruling.

**The threading type was renamed, not just moved.** Three files imported `ModelFloorGroupContext`
for prop threading. The floor is gone, so the name became a wrong comment at type scale; it is now
`PickerConversationContext { conversationId }` in `model-selector-types.ts`. `currentUserPrivilege`
went with it — the verdict never read it.

### Vocabulary sweep — grepped clean

Swept `useModelFloor`, `modelFloorNanoUsd`, `isBelowFloor`, `belowFloor`, `showFloorGrey`,
`data-below-floor`, `MODEL_BELOW_FLOOR_REASON`, `ModelFloorGroupContext`, `UseModelFloorInput`,
`ModelFloorResult`, `isPremiumGated`, `groupScope` across **all** of `apps/web` — hook and
component, since a component-only grep cannot close a hook. **Zero hits** except one comment of
mine recording provenance.

The sweep found four things a diff-read would not:

- **Three suites mocked `useModelFloor`, an export that no longer exists** (`chat.index.test.tsx`,
  `chat-welcome.test.tsx`, `chat-header.test.tsx`). A mock of a missing export is dead weight that
  masks a real import error. Removed — and each then needed a `useTurnOptions` mock, because the
  header renders the picker.
- **A vacuous assertion**: `expect(premiumRow).not.toHaveAttribute('data-below-floor')` on an
  attribute the row no longer emits — it passed by naming nothing. Replaced with
  `toHaveAttribute('data-unavailable', 'true')`, which asserts the premium row **is** marked, the
  actual point of that test.
- Orphaned imports in both the hook and its test, each named by the compiler.

## 3. `RUN_CAPACITY_REACHED` — premise verified, then fixed

I checked before changing. Both codes derive from the same wait-then-retry vocabulary:

```
CONCURRENT_RUN       → noticeText('run_already_in_progress')  — "Wait for it to finish, then send again."  [in the set]
RUN_CAPACITY_REACHED → noticeText('funds_held_by_run')        — "Wait for it to finish, then send again."  [NOT in the set]
```

§Notices 9 also makes it explicitly transient ("the reserved funds return when the run finishes").
So it is **not** deliberately non-retryable. Red first — `retryable: false` where the copy promises
retry — then added to the set, with a comment stating the membership rule (agreement with the
code's own copy) rather than restating the list.

**Swept for the same shape elsewhere in `apps/web`:** the only other code-keyed collection is
`lib/trial-refusals.ts`'s `REFUSAL_BUILDERS` map. Its keys are trial codes untouched by the split
and it has a documented fallthrough — **checked and clear**, recorded so the next sweep does not
re-litigate it.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run` — billing hooks, chat hook, model-selector, chat-welcome, chat-header, chat.index (via `with-env`) | pass — **27 files, 676 tests**, `TESTS_EXIT=0` |
| `npx tsgo --noEmit` (apps/web) | pass — `WEB_TC_EXIT=0` |
| `npx eslint` over the changed set (from `apps/web`) | pass — `WEB_LINT_EXIT=0` |

Lint was run after the final edit on the set derived from `git status`. Thirteen prettier errors
were fixed at the cause; none suppressed. Two `--fix` invocations were killed by the 120s timeout
and reported nothing — I re-ran narrowly and re-verified rather than trusting the silence.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| Verdict engine deleted, grep-clean | **met** |
| Re-pin F1's defect class | **met** — 4 group pins + 2 pending pins, inversion-proven |
| All greying derives from `affordable` | met for the picker; effort menu and send gate open |
| Typed reason as tooltip + accessible description | met for the picker |
| Premium marked, not removed | met |
| No funding/premium from the balance endpoint | funding met; `chat-welcome.tsx` still derives premium |
| Session-stable `nowMs` | met |
| Below-floor row de-selectable | met — removal is checked before any refusal |
| Send gate from `admissible` | not done |
| Existential menu rule; intersection clamp retired | not done |
| Hold vs balance pair; one hold notice | not done |
| No text-modality pre-send cost figure | not done |
| Five component tests | 2 of 5 |
| `turnDimensions` on a smart-slot-only turn | not done |
| Widen `usePromptBudget`'s return | not done |

## Concerns

1. **The two-verdict midpoint is materially reduced but not gone**: the picker and the adapter are
   one engine; the composer's send gate still runs the older estimate path (`usePromptBudget`).
   That is the remaining half of the criterion.
2. **`use-filtered-models.ts` still reads `canAccessPremium` for row ordering**, fed by
   `chat-welcome.tsx`'s balance-endpoint derivation. Criterion 3 does not close until that site
   converts.
3. **`RUN_CAPACITY_REACHED` is a client-side render fix only.** If any server path also keys on
   retryability for this code, it is outside my grant and unchecked.
4. I did not touch `notices.ts` (C3 holds it) and did not need to.

## Confidence

**High** on the payer resolution and the deletion: the regression is closed with an inversion
proof, the sweep was run over hook vocabulary and returned clean, and 676 tests pass with both
other gates at zero. **High** on `RUN_CAPACITY_REACHED` — premise verified against the copy and
the spec before changing anything. **Not applicable** to the unconverted surfaces.
