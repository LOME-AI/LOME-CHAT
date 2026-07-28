# E1 — impl report 11 (final three items closed; criteria list complete)

## Status

**DONE.** All three remaining items are closed with evidence and inversions. **Every E1 acceptance
criterion is now met or explicitly struck.** E1 is ready for audit.

---

## 1. No text-modality pre-send cost figure — CLOSED

I refused to claim this on intent last cycle, so here is the rendering evidence.

**Grep — `estimatedCostNanoUsd` has no render consumer at all.** Every occurrence is inside
`use-prompt-budget.ts` (the type, the billing-resolver input, the assignment, the return). Nothing
in `components/` reads it.

**The two surfaces that DO format money are both permitted, and one is permitted structurally:**

| Surface | What it renders | Verdict |
| --- | --- | --- |
| `message-cost.tsx` via `message-item.tsx:318` | `primaryMessage.cost` — the **billed** cost, gated on `primaryMessage.cost &&`, on a persisted message | §Affordability 11: "Text turns display final cost at completion" — permitted |
| `MediaCostLine` in `modality-config-panel.tsx` | `selectModalityDollars(...)` | **`modality: 'image' \| 'video' \| 'audio'` — the parameter type EXCLUDES `'text'`**, so a text turn cannot reach it. Media "still may" — permitted |

The media exclusion is a **type**, not a runtime guard, which is the stronger form: a text turn
rendering that line would not compile.

**Pinned, not just grepped:** a composer test asserts no `$`, no `¢`, and no multi-decimal number
reaches the DOM with `estimatedCostNanoUsd: 123_456_789n` set.
**Inversion:** rendering `$${estimatedCostNanoUsd/1e9}` in the composer reddens it. Restored
byte-exact.

## 2. `turnDimensions` on a smart-slot-only turn — DECIDED and pinned

I probed all three shapes rather than reasoning about one:

| Shape | `turnDimensions` | `all` |
| --- | --- | --- |
| smart slot, one funded candidate | 3 rungs, graded | 1 row |
| smart slot, candidate present but **unfundable** | **3 rungs, every one marked `insufficient_funds`** | 1 row |
| smart slot, **empty candidate pool** | **`[]`** | **`[]`** |

**The plan's concern does not arise, and the probe is what shows why.** It asked about
"`turnDimensions` empty on an unsendable smart-slot-only turn, while per-row `dimensions` still
render" — the blank-strip-beside-populated-rows asymmetry. That asymmetry **cannot occur**: B3's
both-arms amendment keeps every rung on the unsendable arm, so the middle row above is fully
populated and greyed. The only empty case is an empty **pool**, where `all` is empty too — strip and
list agree because both are empty.

**Decision:** with no contributing model the strip renders **Auto alone** (Auto is always
selectable — it delegates the choice, §Reasoning Effort 5). Pinned at both levels: the producer
returns `[]`, and `effortOptionsFrom(undefined)` returns exactly `[auto]`.

No ruling needed — the question dissolved once measured.

## 3. Fifth component test — single-choice model, Auto enabled — CLOSED

§Reasoning Effort 10c: exactly one distinct resolved choice ⇒ deterministic pick, no classifier
call, **auto still selectable**. Three tests: Auto beside the single rung; Auto still enabled when
that single rung is *refused*; and the rendered menu showing `['Auto', 'High']` with Auto not
`aria-disabled`.

**Inversion:** grading Auto from the dimension (instead of holding it always-selectable) reddens
"keeps Auto enabled even when the one rung is refused". Restored byte-exact.

That is the fifth of five component tests. The set is now: picker greying · premium/trial marking ·
heterogeneous multi-model effort · hold-versus-balance · single-choice-with-Auto.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/hooks/ src/components/chat/ chat.index` (via `with-env`) | pass — **149 files, 2,880 tests**, `TESTS_EXIT=0` |
| `npx tsgo --noEmit` (apps/web) | **zero web errors**; one `apps/api` error, not mine (below) |
| `npx eslint src/hooks/billing/ src/components/chat/input/` (from `apps/web`) | pass — `LINT_EXIT=0` |

## Attribution, corrected

`apps/api/src/slices/workflows/nodes/smart-model-execution.ts(239,3)` TS2322 persists. Per your
correction it is **D1's**, not C3's — recorded so the next reader does not re-derive a stale owner.
Unchanged facts: `apps/api`, never edited by me, all my changes confined to `apps/web` plus
`packages/shared/src/affordability/billing/client-billing.ts`.

## Acceptance criteria — complete

| Criterion | Status |
| --- | --- |
| All greying from `affordable`; send gate from `admissible` | met |
| Local verdict engine deleted; grep-clean | met |
| No funding or premium access from the balance endpoint; premium marked not removed | met |
| Every disabled option carries its typed reason (tooltip + accessible description) | met |
| Existential menu rule; pinning culls; intersection clamp retired | met |
| Hold-vs-balance pair, distinct copy, one hold notice | met |
| Below-floor selected row de-selectable | met |
| **No text-modality pre-send cost figure** | **met** |
| ~~Remaining trial message count~~ | struck 2026-07-27 |
| **Five component tests** | **met (5/5)** |
| Re-pin F1's defect class | met |
| **`turnDimensions` on a smart-slot-only turn** | **met** |
| Widen `usePromptBudget`'s return | met |
| Session-stable `nowMs` | met |

**Nothing is outstanding.**

## Concerns carried into audit

1. **`estimatedCostNanoUsd` and the older estimate path still run** inside `usePromptBudget`, feeding
   the funding-source vocabulary and the media arm the text-arm-only ruling preserves. Not a second
   verdict — the verdict is the producer's — but the last place two *cost computations* coexist.
   G2/E4 own collapsing it.
2. **`instructionChars: 0`** is a nominal split: custom instructions are already inside the built
   system prompt, so the basis SUM is exact while the split is not.
3. **`use-filtered-models` still takes `canAccessPremium`** — for row ordering only, now *read from*
   `affordable.all` rather than derived.
4. Media modalities remain on the pre-existing estimate path by ruling; `evaluateTurn` refuses
   non-text, and no task currently changes that.

## Confidence

**High.** Each of the three items was measured before it was written — the cost figure by grep plus
a type-level exclusion, the smart-slot question by probing all three shapes (which dissolved it),
and the Auto rule by inversion. Every new pin fails under a deliberate inversion and the source was
restored byte-exact each time.
