# E1 — impl report 9 (SEND GATE on `admissible`; the two-verdict state is gone)

## Status

**DONE_WITH_CONCERNS.** The composer's send gate now reads `admissible`, and the hold-versus-balance
pair derives its reason from *which set the selection fell out of*. **The two-verdict state the plan
says must not ship is closed** — picker, adapter, selection store, both choice-hooks and now the
composer are one engine. The effort menu and three remaining items are open.

No git write. `notices.ts` and `smart-model/prompts.ts` untouched — seven cycles.

---

## The evidence you asked for: `admissible ⊂ affordable`, refusing exactly the difference

Both sets stated, from one `getTurnOptions` call, funding `{spendable: 0, held: 100e9}`:

| | `affordable` | `admissible` |
| --- | --- | --- |
| funding input | `effectiveBalance` = spendable + held = **100e9** | `spendable` = **0** |
| `sendable` | **true** | **false** |
| every row's availability | **`{ available: true }`** | — |

The selection is **inside `affordable`, outside `admissible`** — a strict subset. The picker greys
**nothing** (`affordable.all.every(row => row.availability.available)` holds), and the composer
refuses with **`funds_held_by_run`**: *"Your funds are reserved by a reply that's still generating.
Wait for it to finish, then send again."*

The contrast case, nothing held and no funds, falls out of **both** sets — `affordable.sendable`
false, row marked `insufficient_funds`, so the picker greys **and** the reason is money.

That is the two-set design doing the one job it exists for: **a hold blocks the send and never
greys the options.**

### The reason is derived, never set

```ts
if (options.admissible.sendable) return undefined;
return options.affordable.sendable ? 'funds_held_by_run' : options.admissible.refusal;
```

`admissible ⊆ affordable` always holds, so exactly three states exist and the middle one can only
be a hold — the sets differ solely in hold-awareness and prompt basis. Nothing sets a flag.

**Distinct copy, pinned:** `noticeText('funds_held_by_run')` ≠ `noticeText('insufficient_funds')`;
the first contains "Wait", the second "Add credit". Offering payment for a hold would be a false
path — paying does not release a reservation.

## Inversions (both bite)

| Inversion | Result |
| --- | --- |
| Gate on `affordable` instead of `admissible` | **fails** — the hold stops blocking |
| Collapse the pair to `admissible.refusal` alone | **fails** — the hold borrows the money wording |

Restored byte-exact after each (`diff` clean).

## `usePromptBudget`'s return, widened

`sendRefusal: NoticeReason | undefined` — the typed reason reaching the send-gate surface, exactly
the one-line widening the plan specified. It is folded into `hasBlockingError`, so a refused turn
cannot render an enabled composer.

## Files changed

| File | Why |
| --- | --- |
| `use-prompt-budget.ts` | calls `useTurnOptions` with the composed basis; `sendRefusalOf` derives the reason from the pair; `promptBasisOf` and `readOnlyOverride` extracted; return widened |
| `use-prompt-budget.test.ts` | producer mocked; 4 hold-vs-balance pins |
| `use-turn-options.test.ts` | 2 strict-subset pins stating both sets |
| `prompt-input.test.tsx`, `chat-welcome.test.tsx` | `sendRefusal` on the result fixture |

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/hooks/ src/components/chat/ chat.index` (via `with-env`) | pass — **149 files, 2,893 tests**, `TESTS_EXIT=0` |
| `npx tsgo --noEmit` (apps/web) | pass — `WEB_TC_EXIT=0` |
| `npx eslint` over the changed set (from `apps/web`) | pass — `LINT_EXIT=0` |

Two genuine lint errors were fixed at the cause: import order, and **complexity 11** — resolved by
extracting `promptBasisOf` and `readOnlyOverride`, not by raising the threshold. One `eslint --fix`
was killed at 120s again; I re-ran narrowly rather than banking the silence, and the complexity
error was still there when I did.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| **Send gate from `admissible`** | **MET** |
| **Hold vs balance pair, distinct copy** | **MET** |
| **Widen `usePromptBudget`'s return** | **MET** |
| No funding/premium from the balance endpoint | met (report 8) |
| Verdict engine deleted, grep-clean | met (report 6) |
| Premium marked, not removed | met (reports 4, 7) |
| All greying from `affordable`; typed reasons | met for the picker |
| Session-stable `nowMs`; F1 re-pins; de-selectable row | met |
| Effort menu / intersection clamp | **not done** |
| No text-modality pre-send cost figure | not done |
| Five component tests | 2 of 5 |
| `turnDimensions` on a smart-slot-only turn | not done |

## Concerns

1. **`estimatedCostNanoUsd` and the older estimate path still run** inside `usePromptBudget` — they
   feed `useResolveBilling`'s funding-source vocabulary and the media arm, which the text-arm-only
   ruling keeps. The **verdict** is now the producer's; the estimate beside it is not a second
   verdict, but it is the last place two cost computations coexist, and G2/E4 own collapsing it.
2. **`instructionChars` is passed as 0** because custom instructions are already inside the built
   system prompt and counting them twice would inflate the basis. The sum is exact; only the split
   is nominal. Flagged because a future reader may expect that field to be populated.
3. The effort menu still runs `offeredEffortLabels`' intersection clamp — the next item, and the
   one place a menu can still enable a rung the producer would refuse.

## Confidence

**High.** Both new pins fail under two independent inversions and were restored byte-exact; the
strict-subset case states both sets and the exact refusal; 2,893 tests pass with typecheck and lint
at zero. **Not applicable** to the effort menu.
