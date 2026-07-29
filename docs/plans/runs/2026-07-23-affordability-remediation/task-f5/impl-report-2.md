# F5 — impl report 2

## Objective

Apply the founder's regenerate ruling to the seam built in cycle 1: a regenerate may use
ANY model it can afford — the premium/tier filter does not apply to `POST /chat/regenerate`,
while every budget and affordability filter, and the admin kill switch, still do. The
exemption is declared through the type, not implied by which route calls what.

## Files changed (this cycle)

- `apps/api/src/slices/chat/routes.ts` — the seam now takes a required
  `GatedTurnCaller { sender, premiumTierGate }`; the tier gate runs only for
  `premiumTierGate: 'enforced'`. `POST /chat` and `POST /chat/guest` declare `'enforced'`;
  `POST /chat/regenerate` declares `'exemptModelAlreadyChosen'`. The kill switch stays
  unconditional and stays ahead of the tier gate. Seam doc comment corrected (it claimed
  the regenerate "came to accept a premium model from a free-tier sender" — that is now
  the ruled-correct behaviour, not a bypass).
- `apps/api/src/slices/chat/routes.integration.test.ts` — one pin inverted, three added.

No other file in the repo was touched. `git status` shows many other modified files under
`apps/api` and `packages/db` (`spendable.*`, `turn-context.*`, `runtime.*`,
`usage-records.ts`, `guest-funding.ts`, …) — those are the concurrent F4/F8 workstreams,
not mine.

## The typed declaration

```ts
type PremiumTierGateMode = 'enforced' | 'exemptModelAlreadyChosen';

interface GatedTurnCaller {
  readonly sender: TurnSender;
  readonly premiumTierGate: PremiumTierGateMode;
}

async function resolveGatedTurnContext(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: TurnContextRequest,
  caller: GatedTurnCaller
): Promise<Response | TurnContext>;
```

A new turn route cannot obtain a `TurnContext` without writing, literally:

```ts
const context = await resolveGatedTurnContext(c, deps, body, {
  sender: { kind: 'user', userId },
  premiumTierGate: 'enforced', // or 'exemptModelAlreadyChosen'
});
```

`premiumTierGate` is a required, non-optional field of a required argument, so omission is a
compile error and there is no default to inherit silently. The founder's reason rides the
type's doc comment (`routes.ts:1032-1048`): the model was already chosen on the turn being
regenerated, so entitlement was decided then; ONLY entitlement is exempt — every budget and
affordability filter still applies, as does the kill switch, because availability is not
entitlement.

**Why an object rather than a fifth positional parameter:** the first shape shipped was
`(c, deps, body, sender, premiumTierGate)` and `eslint` rejected it — `max-params` (max 4),
`c2-lint.log`. Bundling sender + gate mode into one required argument keeps the declaration
mandatory and explicit while satisfying the rule.

## Pins (the four the amendment names), by `file:line`

| # | Behaviour | Location |
| --- | --- | --- |
| 1 | premium regenerate **permitted** (201), zero-balance self-funding caller | `apps/api/src/slices/chat/routes.integration.test.ts:2259` |
| 2 | premium **send** refused `MODEL_TIER_LOCKED` (403), same caller shape | `apps/api/src/slices/chat/routes.integration.test.ts:2081` |
| 3 | unaffordable regenerate still refused (402 `INSUFFICIENT_ADMISSION`) | `apps/api/src/slices/chat/routes.integration.test.ts:2288` |
| 4 | `MODEL_DISABLED` (403) on a disabled-model regenerate | `apps/api/src/slices/chat/routes.integration.test.ts:5815` |

Pins 1 and 2 sit in the same describe (`chat route: POST /chat premium-tier gate`) and use
the same `seedZeroBalanceMember()` + `withPremiumModel()` fixtures, so the pairing is the
exemption's boundary read in one place: identical caller, identical model, opposite verdicts
by route.

A fifth pin, `routes.integration.test.ts:2317`, covers the **budget** half on the route's own
affordability read rather than a realtime verdict: a smart-model regenerate with the daily
allowance spent is refused 402, exactly as the send at `:1762` is.

## Watched red — verbatim, before any source edit

Command: `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts -t "regenerate"`
→ `EXIT=1` (`c2-red2.log`).

```
 ❯ |api| src/slices/chat/routes.integration.test.ts (194 tests | 2 failed | 152 skipped) 4904ms
     × admits a premium model on a regenerate from the same zero-balance caller (201) 212ms (retry x1)
     × still refuses an unaffordable premium regenerate at admission (402) 176ms (retry x1)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |api| src/slices/chat/routes.integration.test.ts > chat route: POST /chat premium-tier gate > admits a premium model on a regenerate from the same zero-balance caller (201)
AssertionError: expected 403 to be 201 // Object.is equality

- Expected
+ Received

- 201
+ 403

 ❯ src/slices/chat/routes.integration.test.ts:2284:26
    2282|         }
    2283|       );
    2284|       expect(res.status).toBe(201);
       |                          ^
 ❯ withPremiumModel src/slices/chat/routes.integration.test.ts:2027:5
 ❯ src/slices/chat/routes.integration.test.ts:2260:5

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  |api| src/slices/chat/routes.integration.test.ts > chat route: POST /chat premium-tier gate > still refuses an unaffordable premium regenerate at admission (402)
AssertionError: expected 403 to be 402 // Object.is equality

- Expected
+ Received

- 402
+ 403

 ❯ src/slices/chat/routes.integration.test.ts:2312:26
    2310|         }
    2311|       );
    2312|       expect(res.status).toBe(402);
       |                          ^
 ❯ withPremiumModel src/slices/chat/routes.integration.test.ts:2027:5
 ❯ src/slices/chat/routes.integration.test.ts:2289:5

 Test Files  1 failed (1)
      Tests  2 failed | 40 passed | 152 skipped (194)
```

Both failed for the expected reason: the cycle-1 tier gate answered `403 MODEL_TIER_LOCKED`
where the ruling requires 201 (entitlement exempt) and 402 (money still binding). Pin 3 is
the discriminating one for the ruling's second half: it flips from 403 to 402 on exactly
this change, so it distinguishes "entitlement exempted" from "everything exempted".

## Two pins were GREEN on write — stated plainly, not claimed as red

Pins 4 and `:2317` passed the first time they ran (`✓` in the verbose run over the same
`-t regenerate` filter). That is not a TDD miss to hide, it is what the amendment asked for
("the kill switch **still** applies", "budget filters apply **in full**"): both mechanisms
were already correct before this cycle — the kill switch because cycle 1 routed it through
the seam, the smart-model affordability read because it lives downstream in
`turnDefinitionOrRefusal` and never depended on the tier gate.

Applying the run's own vacuity test to them honestly:

- **Pin 4 discriminates.** Deleting the kill switch from the seam, or moving it behind the
  `exemptModelAlreadyChosen` early return, turns it red — the refusal degrades to the
  generic unknown-model one. It is a live guard on the ordering this cycle touched.
- **Pin `:2317` does NOT discriminate against this diff.** No plausible implementation of
  "remove the premium gate from regenerate" moves it: the 402 is produced by the smart-model
  candidate derivation, downstream of the seam. It guards the class the amendment worries
  about (a later deletion that takes affordability with it), not this diff. I am not citing
  it as evidence that this change is safe; pin 3 is that evidence.

## Self-gate

| command | result |
| --- | --- |
| `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts` | **pass** — 194/194, EXIT=0 (`c2-green1`) |
| `pnpm test:watch apps/api/src/slices/chat` (whole slice) | **pass** — 803/803, EXIT=0 (`c2-cov2`, the coverage pass); two earlier passes of the same command hit the documented moving-set flake, below |
| `pnpm typecheck` (repo-wide, after last edit) | **pass** — EXIT=0, 16/16 tasks |
| `npx eslint src/slices/chat/routes.ts src/slices/chat/routes.integration.test.ts` from `apps/api`, after the LAST edit | **pass** — EXIT=0, no output (`c2-lint2`). Both changed files are in `apps/api`; no other package was touched, so that is the whole derived lint set. |
| `pnpm arch:check` | **pass** — EXIT=0, 13 rules over 2184 files |
| `pnpm test:api` (the plan's scoped check) | **fail — EXIT=1**: 17 tests over 8 files. `src/slices/chat/routes.integration.test.ts` itself is `✓ 194 tests`. Attribution below. |
| scoped coverage, `pnpm test:watch apps/api/src/slices/chat --coverage --coverage.include='src/slices/chat/routes.ts'` | **pass** — EXIT=0; `routes.ts` 97.32 stmts / 95.87 branch / 100 funcs / 100 lines |

### `pnpm test:api` — every failure attributed outward

None of the eight files is mine, and none imports `routes.ts` (grepped: `spendable.integration`,
`turn-context.integration`, `turn-context.test`, `runtime.integration` contain no `routes`
import at all — the domain never imports the route layer).

| file | failures | attribution |
| --- | --- | --- |
| `slices/notifications/domain/templates/template-html.test.ts` | 7 | The verbatim §Known Breakage entry (removed Google-Fonts `<link>`, owner outside this run). |
| `slices/billing/domain/spendable.integration.test.ts` | 6 | `readGuestFundingSnapshot` — **F4-owned** (`spendable.ts` is on F4's ownership list) and modified in the tree by that agent, mid-flight. |
| `slices/chat/domain/turn-context.integration.test.ts` | 2 | **Untracked file that did not exist at my `git status` snapshot** — created during my session by the concurrent payer/sender workstream (F8: "records the owner as the payer and the member as the sender"). |
| `slices/chat/domain/turn-context.test.ts` | 1 | Same workstream; the file was unmodified at my snapshot and is modified now. I never opened it for edit. |
| `slices/chat/domain/runtime.integration.test.ts` | 1 | Same workstream ("…when the run identity names the PAYER"); `runtime.ts` is modified in the tree by it. |
| `platform/dev/mint-admin-targets.integration.test.ts`, `slices/newsletter/routes.integration.test.ts`, `slices/identity/domain/credentials.integration.test.ts` | 3 suite-level | `Error: Cannot find module …/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js` — the vitest deps-optimizer ENOENT class, an environment crash with no assertion involved. |

Consequence, per §Known Breakage: because `test:api` failed, it never reached its coverage
report, so its exit code says nothing about coverage — hence the separate scoped-coverage
run above.

### Flakes observed and NOT chased

Two passes of `pnpm test:watch apps/api/src/slices/chat` failed with a **moving set**, both
named verbatim in §Known Breakage as the chat-integration contention flake:

- pass 1: `POST /chat > returns a run handle (201) for a member with a purchased wallet`
  — `expected 400 to be 201` (the model this test seeds itself was gone from the catalog by
  request time). §Known Breakage lists "`POST /chat` `201→400`".
- pass 3 (the first coverage attempt): `regenerate.integration.test.ts` ×2 —
  `expected 'failed' to be 'succeeded'`. §Known Breakage lists "regenerate
  `succeeded→failed`".

Both sets passed on re-run of the identical command with no source change in between
(803/803). Per the same section I am **not** citing any single green api sweep as proof the
suite is healthy; what I claim is narrower: my own file is green on every pass it ran
(194/194, four times), and every failure I saw is either a named breakage or lands in a file
a concurrent agent is editing.

### One infra action taken, worth knowing

The local stack was **down** when I started (Postgres/Neon/Redis/MinIO all refusing
connections; the first test run died on `Failed query: delete from "model_catalog"`). I ran
`pnpm ensure-stack`, which started the containers and applied migrations
(`optimistic readMeta failed … will run migrations`). Concurrent agents' suites would have
been failing the same way before that.

## Acceptance criteria (the 2026-07-29 amendment)

1. **The seam stays ONE call site and takes an explicit, typed decision about the premium
   gate; the type forces a new turn route to state its choice; the declaration carries the
   founder's reason** — **met**. Type and signature above. Call-site proof:

   ```
   $ grep -rn "resolveGatedTurnContext\|tierGateRejection(" apps packages e2e scripts \
       --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "/dist/"
   apps/api/src/slices/chat/routes.ts:530:async function tierGateRejection(
   apps/api/src/slices/chat/routes.ts:1074:async function resolveGatedTurnContext(
   apps/api/src/slices/chat/routes.ts:1098:  const tierRejection = await tierGateRejection(c, body, resolved.value.fundingDecisionInputs);
   apps/api/src/slices/chat/routes.ts:1135:          const context = await resolveGatedTurnContext(c, deps, body, {
   apps/api/src/slices/chat/routes.ts:1215:          const context = await resolveGatedTurnContext(c, deps, body, {
   apps/api/src/slices/chat/routes.ts:1283:          const context = await resolveGatedTurnContext(c, deps, body, {
   ```

   `tierGateRejection` — one definition (`:530`), exactly **one** call site (`:1098`), inside
   the seam. The seam itself — one definition (`:1074`), three route call sites
   (`:1135` send, `:1215` guest, `:1283` regenerate), each stating its mode. `resolveTurnContext`
   still has exactly one production call site (`routes.ts:1080`, inside the seam); its other
   hits are domain unit/integration tests.

2. **Pinned in both directions across two routes** — **met**. Pin 1 (`:2259`, 201) and pin 2
   (`:2081`, 403 `MODEL_TIER_LOCKED`), same caller shape and same premium fixture.

3. **Budget and admission filters apply to regenerate in full** — **met**. Pin 3 (`:2288`)
   red-first, 403 → 402 `INSUFFICIENT_ADMISSION`; plus `:2317` on the route's own
   affordability read. `GROUP_BUDGET_EXHAUSTED`, the other money refusal in this area, is
   raised inside `resolveTurnContext` (`turn-context.ts:444`) which regenerate still calls
   unchanged — it is structurally out of the tier gate's reach and needed no re-pinning.
   (It is also unreachable on `/chat/regenerate` in practice: the core refuses only a link
   guest there, and regenerate is `session`-classed.)

4. **The kill switch still applies to regenerate, pinned by `MODEL_DISABLED`** — **met**.
   Pin 4 (`:5815`). The kill switch runs before the early return, so it is unconditional:

   ```ts
   const disabledRejection = await disabledModelRejection(c, body);
   if (disabledRejection !== null) return disabledRejection;
   if (caller.premiumTierGate === 'exemptModelAlreadyChosen') return resolved.value;
   ```

5. **Owner-funded regenerates are unaffected** — **met**, by construction rather than by a
   new test: with the tier gate exempt on regenerate the payer distinction cannot change any
   regenerate verdict, so an owner-funded regenerate is admitted for the same reason a
   self-funded one is. The gate's no-op-for-owner-funded direction stays pinned on the two
   routes where the gate still runs (`:2155` send, `:2242` guest).

6. **`/chat` and `/chat/guest` untouched by this cycle** (stop-and-report trigger) — **held**.
   Both declare `'enforced'`, which reaches the identical `tierGateRejection` call in the
   identical position, after the identical kill switch. No amount, refusal code, or
   permitted-turn set changed on either route; their eleven gate tests (`:2081`–`:2257`) and
   the guest and disabled-model suites all pass unmodified.

## Deviations

- **Parameter shape.** The amendment says "takes an explicit, typed decision"; the first
  implementation put it in a fifth positional parameter and lint's `max-params` refused it.
  It is now a required field of a required options argument — same force (omission is a
  compile error), different shape.

## Concerns and limitations

- **`docs/BILLING.md` is now incomplete on this point — surfaced, not edited** (`.md` is
  read-only to me). Two places a reader would be misled:
  - **§Funding Decision Matrix** is prefaced "When a message is **sent**" and row 2 reads
    "Premium model, user without premium access → Denied — premium requires the paid tier".
    The row remains an accurate description of the shared `resolveFunding` core, which is
    unchanged; what the doc nowhere says is that `POST /chat/regenerate` does not consult the
    core on the entitlement axis. Suggested addition: a note under the matrix that a
    regenerate is exempt from priority 2 only, with the founder's reason.
  - **§Notices 8** ("Sending, queueing …, draining that queue, and regenerating an answer are
    all paid actions, and all read the same verdict") is upheld by the ruling but reads as
    though the verdict includes its premium leg. Suggested wording: the verdict a regenerate
    reads is the **money** verdict.
- **The exemption may be unreachable from the UI today — needs an orchestrator decision, not
  a fix from me** (Inferred, from read-only inspection; `apps/web` is outside my ownership
  and the shared affordability module is F4's). The regenerate affordance passes only a
  message id (`apps/web/src/components/chat/message/message-item.tsx:65`,
  `:275`) — there is no per-message model picker, so the model a regenerate sends is the
  composer's current selection. If the composer still greys premium models for a free-tier
  payer (the client maps `MODEL_TIER_LOCKED` in
  `packages/shared/src/affordability/billing/client-billing.ts:237-238`), a user cannot
  select the premium model in order to regenerate with it, and the server-side exemption is
  observable only through the API. Whether the client should now permit a premium selection
  when the pending action is a regenerate is a product/lane-E question.
- **Coverage figure taken once**, on a pass where the whole slice was green. `routes.ts`
  branch coverage sits at 95.87 — 0.87 above the floor; the run documents this instrument as
  load-unstable, so re-run before believing a reported shortfall.
- **No E2E executed** (Global Constraint 11). `e2e/sharing/link-guest-chat.spec.ts` exercises
  the guest route this seam gates and was not run.

## Confidence

**High** on the ruling being implemented as ruled: the entitlement exemption is red-first
proven on the regenerate route, the money half is red-first proven on the same route with
the same fixture, the kill switch and the two send routes are pinned unchanged, and the
declaration is a required typed field rather than a convention.

**Medium** on the change being *complete* as a product change: the server now permits a
premium regenerate that the client may still refuse to let a user select. That is the one
thing an orchestrator should route before calling F5 closed.
