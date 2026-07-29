# E1 — impl report 16 (owner-funded ordering Critical; false-mechanism comment)

## Status

**DONE.** The Critical is closed by **reordering**, not by patching the instance — which is what
removes the class rather than the case. The Minor is closed with a replacement assertion that
actually bites. Gate green: `TESTWEB_EXIT=0`, 396 files, 6,452 tests, zero threshold errors.

---

## 1. CRITICAL — owner-funded turns blocked by verdicts about the wrong wallet

`withServedPayer` returned early on `denied`, so **every denial arm bypassed the patch**. On an
owner-funded turn the composer refused two sends the server admits:

| member, owner-funded conversation | before | after |
| --- | --- | --- |
| free-tier, **premium model** | `denied: premium_requires_balance` → blocked | **`owner_balance`** |
| **negative own balance**, basic model | `denied: insufficient_balance` → blocked | **`owner_balance`** |

Both are statements about the **self** wallet, and neither applies when the owner pays.
§Funding Decision Matrix priority 1 is *"Conversation owner pays, **premium allowed**"*, and the
picker on the same screen already marked those rows **available** — the served tier for an
owner-funded turn is the owner's `paid`. The composer contradicted the picker beside it.

### The fix is the ordering

```ts
// ORDER IS THE RULE, not an optimisation.
if (payer === 'owner') return { fundingSource: 'owner_balance' };
if (result.fundingSource === 'denied') return result;
```

The owner-funded arm now sits **ahead of** the denial early-return. That is the structural note
made concrete: **a patch applied after a short-circuit cannot reach the paths that short-circuit
into it.** Three cycles of group-path second-order effects had one cause — deriving a self-funded
verdict and then patching it — and ordering the whole-answer branch first removes the class.

The result is **replaced, not spread**: a denial carries a `reason` about a wallet that is not
paying, and it must not travel with the answer.

**It still adds no client rule.** The branch reads the server's `payer` and returns the arm the
server's own decision implies.

**Inversion:** restoring the shipped order — denial return first — reddens both new pins. Restored
byte-exact.

### The evidence gap is closed too, not just the code

The suite mocks `useResolveBilling` wholesale, and the three disclosure pins fed it an **approved**
result, so no test exercised a denial arm against `payer: 'owner'`. The two new pins do not invent
their fixtures: each **calls the real `resolveClientBilling`** to establish that a free-tier member
on a premium model, and a member with a negative balance, genuinely resolve to `denied` when only
their own wallet is considered — then asserts that denial does **not** survive the server saying
the owner pays. The premise is derived from the real resolver; only the hook boundary is mocked.

## 2. MINOR — a comment naming a mechanism the code does not have

`prompt-input.test.tsx` claimed the composer *"drops the text-only search affordance … the
composer's own decisions from `activeModality`"*. False: `showSearch = searchProps !== undefined &&
isAuthenticated !== undefined` has **no `activeModality` term**, and my test omitted `searchProps`,
so that button was absent whatever the modality — **the assertion could not fail for the reason
stated.** Same class as the docblock I closed last cycle, one assertion down.

I did not simply reword it. I checked what the composer **does** decide from `activeModality` and
found a real one: `BottomRows` selects `ImageBottomRow` over `TextBottomRow`, and only the text row
carries the capacity meter. The assertion is now
`expect(queryByTestId(TEST_IDS.capacityBar)).not.toBeInTheDocument()` — genuinely modality-driven.

**Inversion:** removing the `activeModality === 'image'` branch from `BottomRows` reddens it. The
assertion it replaced could not have reddened under any change.

The comment now also states what is **deliberately not** asserted and why, naming `searchProps`
omission as chat-layout's decision — so the next reader does not re-add it.

## 3. The media arm is NOT covered — stated, not papered over

The fix is the **text** arm only. For media the estimate is real and is compared against the
caller's **unscoped** spendable, so an owner-funded media turn still prices against the wrong
wallet. `withServedPayer` corrects the funding *source*, not the *figure* the media estimate is
compared against. **That is G2/E4's arm and this change does not reach it.** I am naming it rather
than letting "owner-funded is fixed" read as covering media.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web` (alone) | **`TESTWEB_EXIT=0`** — 396 files, **6,452 tests**, **zero** threshold errors |
| `npx tsgo --noEmit` (apps/web) | pass — `TC_EXIT=0`, zero web errors |
| `npx eslint src/hooks/billing/ src/components/chat/input/` | pass — `LINT_EXIT=0` |

## Concerns

1. **Media, as above** — the one thing this fix deliberately does not cover.
2. **`client-billing.ts`'s `group` input shape now has no production caller**, so
   `client-billing.test.ts`'s coverage of it is coverage of a dead shape. I did not delete it this
   cycle: it is a shared-package deletion with its own blast radius, and the Critical was the
   priority. Named as a follow-on rather than left for someone to rediscover.
3. The `apps/api` typecheck error is D1's, unchanged.

## Carried from the auditor

The two defects I kept catching in myself across sixteen cycles — **vacuous assertions and
over-correction** — are the two hardest to catch from inside, and both showed up again here: the
search assertion was vacuous, and the group-dimension removal was an over-correction whose repair
then had this second-order effect. The durable lesson is the structural one: **when a correction
takes the form of patching a derived value, ask what short-circuits before the patch.**
