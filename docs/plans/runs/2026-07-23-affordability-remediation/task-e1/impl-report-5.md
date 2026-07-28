# E1 — impl report 5 (deletion BLOCKED on a real gap, found by trying to re-home the pins)

## Status

**BLOCKED on one ruling.** I started the deletion first as instructed. Re-homing the 42
references is what surfaced the blocker: **two of the F1 pins do not both re-home, and the one
that does not is a live defect in my own adapter.** I did not delete `useModelFloor`, because
deleting it now would drop exactly the coverage the coordinator said must be re-homed rather than
dropped — and would ship the regression it currently prevents.

No production file changed this cycle. The probe that established the facts was reverted
byte-exact (`diff` clean, 9 tests green after restore).

---

## What I found, verified rather than reasoned

`useTurnOptions` makes **one** funding read — `useSpendable(input.conversationId ?? null)`, the
payer-scoped one. `useModelFloor` makes **two**: the payer-scoped read *and* the caller's own
unscoped wallet (`mockUnscopedSpendable` in its tests). That second read is F1's own finding —
"two reads, two wallets, two jobs".

I probed the adapter directly rather than inferring, because the last time I reasoned about a
funding number from source I got it backwards. Two group cases, one discriminating difference:

| Case | Served snapshot | Adapter's `affordable` row |
| --- | --- | --- |
| Group headroom **held out** by in-flight runs | `{spendable: 0, held: 1e12, payer: 'owner'}` | **available** ✅ |
| Group headroom **durably exhausted**, member has own funds | `{spendable: 0, held: 0, payer: 'owner'}` | **greyed `insufficient_funds`** ❌ |

**The first pin re-homes cleanly, and for a better reason than it had.** `getTurnOptions`
reconstructs `effectiveBalance = spendable + held`, so `affordable` is hold-blind *by
construction*. The old test needed a second wallet read to avoid greying on a hold; the producer
needs nothing — the hold-blindness is structural. That pin is strictly stronger after the move.

**The second pin does not re-home, and its absence is a live defect.** §Group Funding 2: "Headroom
covers the estimate → owner pays; it does not → **signed-in members fall through to personal
funds**." A member whose group budget is genuinely spent can still send from their own wallet, and
the picker must not grey models they can self-fund. My adapter greys them. That is the F1 defect
class verbatim — "payer-scoped `spendableNanoUsd` passed into a parameter documented as the
caller's own, so greyed models a member could self-fund".

## Why I did not just fix it

The obvious fix is a second `useSpendable(null)` read plus "available if either payer's set says
available". I did not write it, because it is a **client-side rule about which payer applies**, and
it can disagree with the server's:

- §Funding Decision Matrix priority 1 compares the **estimate** against durable headroom. A union
  over two producer outputs compares the **floor** — a different quantity, so the client would
  present a model as callable in cases the server refuses, and the two would drift on exactly the
  boundary F2 was created to pin.
- `getTurnOptions` takes **one** `FundingSnapshot`. Calling it twice and unioning is a second
  verdict rule living in `apps/web` — the thing this task exists to delete. `useModelFloor` gets
  away with it today only because it delegates to `resolveClientBilling`, which routes through
  `resolveFunding` — the shared implementation of exactly this decision.

So there is a legitimate shape here, and it is **not** a union: the adapter should resolve the
payer through `resolveFunding` (shared, already the authority) and then call `getTurnOptions` once
with the winning payer's snapshot. That needs both funding reads and the group headroom the
budgets endpoint serves — which is what `useModelFloor` already assembles.

**Ruling needed:** does the adapter take on `resolveFunding`-based payer resolution (two funding
reads + `useConversationBudgets`, one `getTurnOptions` call with the resolved payer), or does
`getTurnOptions` gain the ability to express two candidate payers? The first is inside my grant
and is my recommendation — it reuses the shared authority and keeps one call — but it materially
grows the adapter, and I am not choosing that shape unilaterally after being wrong about a funding
number once already.

## What the 42 references actually contain

Sized so the re-home is a known quantity once the ruling lands:

| Group | Count | Disposition |
| --- | --- | --- |
| Free/paid floor boundary (`floor` vs `floor − 1n`) | 6 | re-home unchanged — the adapter already gates on the served figure |
| Pending-window suppression | 2 | **already re-homed and inversion-proven** (report 3) |
| Trial fixed arm, media rows with no token floor | 3 | re-home unchanged |
| Smart Model row: pool minimum, provider-cap exclusion, catalog loading | 5 | re-home — the adapter maps the sentinel to the smart slot |
| Mandatory-reasoning lowest-rung floor | 1 | re-home unchanged |
| **Group payer scope** | **4** | **blocked on the ruling above** |
| Fixtures/helpers shared by the above | 21 | mechanical |

## The deletion, pre-sized

Still accurate and still contained — `useModelFloor` has zero production consumers:

- Dies: `useModelFloor` (`use-prompt-budget.ts:677`), `modelFloorNanoUsd` (`:633`, called only from
  `:712`), `UseModelFloorInput`, `ModelFloorResult`.
- Survives: `smartModelPoolFromCatalog` (`:407`) and `buildModelTokenPricing` (`:457`) — the
  composer's live estimate, kept by the text-arm-only ruling; `payerTierOf` (`:529`);
  `ModelFloorGroupContext`, still used by `groupScope` (`:172`) and type-imported by
  `model-selector-button.tsx` for prop threading.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/hooks/billing/use-turn-options.test.ts` (via `with-env`) | pass — 9 tests, after byte-exact restore |
| Working tree vs. start of cycle | **no production change**; probe reverted, `diff` clean |

Gates from report 4 (23 files / 545 tests, both typechecks 0, both lints 0) still describe the
tree — nothing landed since.

## Acceptance criteria

Unchanged from report 4. The deletion criterion moves from "unblocked" to **"blocked on the group
payer-resolution ruling"** — a correction to my own report 4, which called it "unblocked and
provably contained". It is contained; it is not unblocked.

## Concerns

1. **My adapter has a live group-funding defect right now**, and the picker already ships on it —
   a member with a spent group budget sees models greyed that they can self-fund. It is masked
   only for the held-out case. This is my regression, introduced in report 4, and it is the
   strongest argument against deleting the hook that still handles it.
2. **The two-verdict midpoint persists** and now has a concrete reason to.
3. I have not touched `notices.ts` (C3 holds it) and did not need to.

## Confidence

**High** on the finding — it is a probe result with the discriminating input named, not a reading
of source. **High** that stopping was correct: deleting now would drop four pins and ship a
group-funding regression. **Medium** on my recommended shape (`resolveFunding` inside the adapter);
it reuses the shared authority, but it is a design choice I want confirmed rather than assumed.
