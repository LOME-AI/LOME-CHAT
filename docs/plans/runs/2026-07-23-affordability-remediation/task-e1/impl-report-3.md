# E1 — impl report 3 (the adapter hook landed; surfaces not yet converted)

## Objective

Every client surface renders the produced `affordable` / `admissible` sets (text arm only),
premium rows MARKED not removed, and the client's second verdict engine — a **hook**, not a
component — deleted.

## Status

**DONE_WITH_CONCERNS on the next slice.** This cycle built the one named adapter hook that every
surface will read, pinned the two contracts the coordinator named (the pending guard and the
session-stable instant) with **inversion proofs**, and finished the assigned leftover. The surface
conversions and the engine deletion are **not done**.

---

## What landed

### 1. The one adapter hook — `apps/web/src/hooks/billing/use-turn-options.ts` (new)

The single place under `apps/web` that calls `getTurnOptions`. It owns four adapter concerns and
no verdict:

- **The wire→money projection.** `priceableFromWire` fails closed exactly as the server-side
  `priceableModelFrom` does — a row with no per-token rates, no context length or no `created`
  is left out of the pool rather than defaulted. Defaulting a missing release date would make
  every recency test silently false; defaulting a rate prices a turn as free.
- **The Smart Model sentinel → the smart slot.** `SMART_MODEL_ID` is not a catalog row, so passing
  it through as a pinned id would mark the turn `model_not_priceable` instead of opening the model
  axis. Pinned on the hardest shape the picker supports (two models plus the sentinel).
- **One funding snapshot, no paid/free branch** — the seam from report 2, consumed here.
- **The session-stable instant** (below).

### 2. The pending guard, pinned and proven falsifiable

`useTurnOptions` returns `{ isPending: true, options: undefined }` while funding or catalog is in
flight. It never manufactures a verdict from an absent read.

Inversion proof, as requested — the guard removed (`isPending = modelsData === undefined`):

```
× reports pending and produces NO verdict while the funding read is in flight
AssertionError: expected false to be true
Tests  1 failed | 6 passed (7)
```

With the guard gone the hook falls to `NO_ENDPOINT_FUNDING` (`0n`) and produces a **fully-greyed
verdict** — the F1 defect class reproduced exactly. Source restored **byte-exact** (`diff` clean)
before continuing. The pin no longer depends on a pending guard surviving elsewhere: it is
asserted on the adapter every surface reads.

### 3. The session-stable instant, pinned on the CALL not the constant

`CATALOG_INSTANT_MS` is captured once at module load. My first attempt at this test was
**vacuous** — `expect(CATALOG_INSTANT_MS).toBe(before)` compares a constant to itself and passes
under a per-render `Date.now()`. Replaced with a spy on `Date.now` across three renders.

Inversion proof (`nowMs: CATALOG_INSTANT_MS` → `nowMs: Date.now()`):

```
× reads no clock while rendering — the instant is captured once, at module load
Tests  1 failed | 6 passed (7)
```

Restored byte-exact.

### 4. Premium rows marked and present, with the composer still sendable

The evidence requested:

```
premium row  → { available: false, reason: 'premium_requires_credit' }   (free payer)
premium row  → { available: false, reason: 'premium_requires_account' } (no account)
admissible.sendable → true
```

The row is **in `affordable.all`**, marked, while the turn still sends on a different model. The
two reasons stay distinct because their actions differ — sign up versus add credit; collapsing
them offers a payment path to someone with no account.

**A fixture defect I caught and fixed rather than shipped.** My first premium fixture used four
cheap models at one flat price. The 75th-percentile threshold then lands *on* that tier, so every
cheap model classified premium and the turn was unsendable — the fixture would have proved the
opposite of its name. Prices are now distinct and ascending so the threshold sits strictly above
the pinned model. Recorded because a passing version of that test would have been worthless.

### 5. The assigned leftover — the allowance read is gone

`use-user-tier-info.ts` and `use-tier-info.ts` no longer read
`balanceData.allowance.remainingNanoUsd`. Both now pass `0n`, matching the server's own
`tierForBalance` ("the daily allowance never moves the tier"). Four test assertions that encoded
the old read were updated to state the new rule. Knip will no longer see a dead balance-endpoint
read.

## Files changed this cycle

| File | Why |
| --- | --- |
| `apps/web/src/hooks/billing/use-turn-options.ts` | **new** — the one adapter hook |
| `apps/web/src/hooks/billing/use-turn-options.test.ts` | **new** — 9 tests |
| `apps/web/src/hooks/billing/use-user-tier-info.ts` | stops reading the allowance; falsified comment corrected (sweep) |
| `apps/web/src/hooks/billing/use-tier-info.ts` | stops reading the allowance |
| `apps/web/src/hooks/billing/use-user-tier-info.test.ts` | assertions state the new rule |
| `apps/web/src/hooks/billing/use-tier-info.test.ts` | assertions state the new rule |

## The vocabulary sweep

Grepped the removed mechanism's vocabulary across owned files, not my diff:

- **Found: `use-user-tier-info.ts:22-25`** — "the free-tier allowance is its own (never-negative)
  remaining figure. **Both** cross the wire as NanoUSD strings" — falsified by the change, sitting
  two lines *above* the edit. Corrected to describe the one figure that remains.
- **`Date.now()` in owned files:** one hit, `prompt-input.tsx:99`, a WS typing-indicator throttle.
  Unrelated to the catalog instant — **not** a served-value-contract violation. Stated rather than
  silently skipped, since a future sweep will hit it again.
- "allowance" as an affordability input, "double-cushion", "two endpoints": **nothing else found.**

## Self-gate

| Command | Result |
| --- | --- |
| `npx tsgo --noEmit` (apps/web) | pass — `WEB_TC_EXIT=0` |
| `npx vitest run src/hooks/billing/` (web) | pass — 13 files, 247 tests |
| `npx eslint <11 changed web files>` (from apps/web) | pass — `LINT_EXIT=0` |

**Ordering note that earned its keep:** lint and tests were both green while `tsgo` was **red** —
the hoisted mock was typed `{ tier: 'paid' as const }` and rejected `'free'`/`'trial'`. Vitest does
not typecheck, so only running the real gate caught it. Three genuine lint errors (complexity 11, a
template-literal type, and a disable naming a rule this config does not define) were fixed at the
cause — the complexity by extracting `fundingSnapshotOf`, not by raising a threshold.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| No funding or premium access from the balance endpoint | **met for funding** — one served number, allowance read removed. Premium threading in `chat-welcome.tsx` still derives from the balance endpoint |
| Premium rows marked, not removed | **met in the produced value**, pinned both reasons. Not yet rendered by the picker |
| Session-stable `nowMs` | **met**, pinned on the call |
| Re-pin F1's defect class | **met for the adapter**, proven by inversion |
| All greying from `affordable`; send gate from `admissible` | not done — surfaces unconverted |
| Verdict engine deleted, grep-clean | not done |
| Typed reason as tooltip + accessible description | not done |
| Existential menu rule; intersection clamp retired | not done |
| Hold vs balance pair; one hold notice | not done |
| Below-floor row de-selectable | not done |
| No text-modality pre-send cost figure | not done |
| Five component tests | not done |
| `turnDimensions` on a smart-slot-only turn | not done |
| Widen `usePromptBudget`'s return | not done |

## Concerns and limitations

1. **Two verdict paths now coexist**: the new adapter and the old `useModelFloor`. That is the
   intended midpoint — the adapter had to exist before surfaces could move — but it is exactly the
   state E1 exists to end, and it must not be left here.
2. **`useTurnOptions` has no production caller yet.** Knip will flag it until the picker converts.
   Its 9 tests exercise it, so it is not untested, but it is not yet load-bearing.
3. **The memo keys on a joined id string** because the store hands back a fresh array identity each
   read. If a future edit adds an input and forgets the key, the producer silently goes stale. The
   keystroke-stability of `affordable` is guaranteed by the producer, not by my memo, so the blast
   radius is a stale row rather than a wrong verdict.
4. **`chat-welcome.tsx` remains a fourth verdict site** deriving `canAccessPremium` from the
   balance endpoint. In my grant now, not yet touched.

## Confidence

**High** on what landed: both named contracts are pinned by tests proven to fail under inversion
and restored byte-exact, the premium evidence is a real produced value, and every gate ran from
the right directory with captured status. **High** that the fixture and vacuity defects I caught
would otherwise have shipped as passing-but-worthless tests. **Not applicable** to the unconverted
surfaces.
