# Affordability & Reservation — Ideal Principle Set

Ratified by the product owner 2026-07-23 after reconciling the intended design
against the implementation. This is the target design. Deviations and the
remediation plan follow at the end. Proposed permanent home: `docs/AFFORDABILITY.md`
(on-demand, listed in `docs/DEVELOPMENT.md`'s doc index) — pending approval.

## The principles

1. **One verdict, two renderers.** Client and server compute affordability through
   the same shared implementation (`packages/shared/src/estimate/`) with the same
   inputs, so in practice they never disagree. The server is the authoritative
   enforcement point; the client is the same verdict rendered early. Inputs prone
   to divergence (spendable balance, group-budget remaining, active holds) are
   computed server-side and served to the client as numbers — never re-derived
   client-side from partial data.

2. **The minimum-viable-answer floor is THE minimum.** One constant,
   `MINIMUM_OUTPUT_TOKENS` (1000), defines sendability: a model is callable iff
   the user affords fixed costs + a minimum answer at the model's minimum-effort
   configuration (reasoning off where offered; the lowest offered reasoning budget
   where reasoning is mandatory). "Can't afford min effort" and "can't send at
   all" are the same condition by construction — min effort is the lowest cap.
   Below the floor, the model greys (client) and refuses (server). Above it, a
   low-balance user is never blocked — the max-tokens cap shrinks instead.

3. **Effort ladder shape.** The canonical 5-rung ladder (`lite low medium high
   max`), positionally normalized per model by one authority (`offeredLevels()`).
   Each level maps to a reasoning-budget target `B(level)`; the wire `maxTokens`
   is always `B + answerHeadroom`, derived per turn — never a static constant. A
   level is enabled iff the user affords
   `fixed + (B(level) + MINIMUM_OUTPUT_TOKENS) × rate` and it fits the model's
   context and output limits. Unaffordable or unfitting levels grey with a
   reason — never hidden — for every tier, including trial and guest. An explicit
   level is never silently substituted: it runs as asked or refuses.

4. **Auto is a smart node.** Auto-effort selection is model-driven, the same
   mechanism as Smart Model's effort dimension — not a static preference order.
   Auto is enabled iff the user has 2+ enabled effort options, disabled otherwise
   (with one or zero real choices there is nothing to select). If no level fits,
   auto engages nothing (reasoning-free).

5. **Worst-case reservation, doubly bounded.** The reservation prices the true
   worst case, with the output ceiling =
   `min(budget-affordable tokens, model max output tokens, context headroom)`.
   Model max output tokens is a catalog field (from the provider's live metadata),
   falling back to `contextLength` when unpublished. Never reserve beyond what the
   model can physically emit or the user can actually pay for.

6. **The cushion is spendable-side.** Paid users get a $0.50 cushion added to
   spendable funds in every affordability and admission decision — equivalently,
   paid balances may go $0.50 negative. Unpaid users get no cushion. Trial/guest
   users get a fixed $0.01 effective balance, quota gates, and no holds.

7. **Tier token ratios.** Input estimation: paid 1 token per 4 chars, all other
   tiers 1 per 2 chars. Output-storage estimation is deliberately inverted (paid
   2 chars/token, others 4) so the tier that over-reserves input also
   over-reserves output storage. Always round against the user (ceil).

8. **Reservation ⊇ bill; always over, never under.** Every cost component a real
   bill contains is priced in the reservation, through the same shared folding.
   Estimates only over-reserve: cache reads priced at full input rate, reasoning
   folded into output tokens, web search reserved at worst case.

9. **Fees are baked once, at the seam.** The only prices that exist downstream of
   ingestion are after-fee (billable). The catalog stores marked-up rates; the
   provider's inline `usage.cost` is converted to billable exactly once at the
   ModelProvider port. No consumer — settlement, estimator, display — ever applies
   markup; pre-fee numbers never leave their seam (the raw provider cost is
   retained only for the monthly provider reconcile).

10. **Smart Model equivalence.** The model the classifier picks gets its
    `maxTokens` from the normal restrictions and math as if the user had picked it
    directly, minus the classifier call's cost from the available budget. Any
    candidate Smart Model admits must therefore pass its own direct-pick
    affordability naturally — an invariant, pinned by tests.

Standing enforcement invariants (unchanged, recorded elsewhere): admission is the
only balance gate; settlement charges unguarded and negative balances are legal
states; holds are TTL'd Redis state with a per-wallet concurrent-run cap; the
hold×5 cost circuit kills runaway runs unbilled.

## How the current design deviates

- **(P5)** No max-output-tokens catalog field exists; `descriptor.limits` carries
  only `contextLength`, so reservations bound output by context length — a large
  over-reservation on big-context/small-output models.
- **(P2)** The model picker never greys for affordability (premium lock only);
  the floor is enforced only at the composer (blocking notification) and at
  server admission (402). The min-effort ⇔ minimum-floor identity holds
  numerically but is not surfaced as one concept anywhere.
- **(P3)** Trial/guest users get infeasible effort options *hidden*, not greyed
  (`reasoning-effort-menu.tsx` filters to enabled for unauthenticated).
- **(P4)** Auto is never disabled regardless of option count, and on pinned
  models it is a static order (`medium → high → low`), not a smart node. Only
  Smart Model runs classify effort.
- **(P9)** Markup is applied at consumption throughout: catalog stores pre-fee
  rates; `applyMarkup()` runs inside the estimator reducers, inside settlement's
  `chargeWithinTx`, and in display formatters.
- **(P1)** Client inputs diverge from the server's: group budgets are cached with
  `staleTime: Infinity` (refreshed only on budget edits, never on other members'
  spend); Redis admission holds and the concurrent-run cap are invisible to the
  client; the client re-derives spendable from a separately fetched balance.
- **(P10)** Smart Model's admission math already subtracts the classifier reserve
  and caps per candidate, but the "smart-pick ≡ direct-pick minus classifier
  cost" equivalence is not pinned as an explicit invariant test.

## Remediation plan (ordered)

1. **Catalog `maxOutputTokens`.** Ingest the provider's max-completion-tokens
   into `descriptor.limits` at normalize time; thread it through
   `declaredOutputCeiling`, `clampBudget`, `answerHeadroomTokens`, and
   `candidateCapTokens` as `min(existing, maxOutputTokens)`. Fallback to
   `contextLength` when absent. Strictly tightens holds.
2. **Bake fees at ingestion.** Normalize applies the markup to every stored rate;
   delete `applyMarkup` from reducers, settlement, and formatters; add one
   billable-conversion at the ModelProvider port for inline `usage.cost`; store
   the raw provider cost alongside the billable charge for the monthly reconcile;
   re-base the provider-cost sanity check to matching units.
3. **Couple the minimum.** Express min-effort affordability as the existing
   shared `canSend` floor; grey models in the picker with the same shared test;
   server behavior unchanged (402).
4. **Grey, never hide, for all tiers.** Remove the trial-only filtering of effort
   options; keep reason tooltips.
5. **Auto rules.** Disable auto below 2 enabled options; convert pinned-model
   auto to classifier-driven effort selection (reusing the Smart Model effort
   dimension). Note: adds a classifier call to auto turns on pinned models —
   accepted cost, decision ratified 2026-07-23.
6. **Kill input divergence.** Server returns spendable (cushion- and hold-aware)
   and live budget remaining; client consumes those numbers instead of
   re-deriving; group-budget cache invalidated by realtime events rather than
   `staleTime: Infinity`.
7. **Pin Smart Model equivalence.** Add the invariant test: for every admitted
   candidate, smart-pick sizing equals direct-pick sizing given
   `balance − classifier reserve`.
8. **Docs.** Promote this file to its permanent home and update
   `docs/BILLING.md` / architecture docs where superseded.
