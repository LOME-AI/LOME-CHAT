# F5 — impl report 1

## Objective

Move the model-tier gate to the seam where the payer is resolved, so every turn route inherits it
and the `POST /chat/guest` premium bypass closes.

## Files changed

- `apps/api/src/slices/chat/routes.ts` — adds `resolveGatedTurnContext`, the one seam through which
  every paid turn route resolves its payer and therefore the one place the model gates are applied;
  the three paid routes (`POST /chat`, `POST /chat/guest`, `POST /chat/regenerate`) now go through
  it. Corrects the guest route's `forkId` comment.
- `apps/api/src/slices/chat/routes.integration.test.ts` — three new pins (below).

Nothing else in the repo was touched (`git status` shows only these two files under my ownership;
`e2e/chat/runnable-documents.spec.ts` was already modified by a concurrent workstream at the start
of the task and I did not touch it).

## What the change is

`tierGateRejection` and `disabledModelRejection` were previously invoked inline by individual
routes: `/chat` ran both, `/chat/guest` ran only the kill switch, `/chat/regenerate` ran neither.
Both gates now live inside `resolveGatedTurnContext`, which wraps `resolveTurnContext` — the
function that freezes the payer wallet and the funding primitives the tier gate reads. A route
cannot obtain a `TurnContext` without passing both gates.

Order inside the seam is `resolveTurnContext` → kill switch → tier gate, which is byte-for-byte the
order `POST /chat` had. The kill switch stays first so a selection carrying both a disabled model
and a premium one answers the specific `MODEL_DISABLED`.

## Tests added

All three sit in `chat route: POST /chat premium-tier gate` (the gate's own describe), so the
gate's coverage of every turn route reads in one place.

1. `refuses a premium model from a zero-balance FULL-SESSION sender on the guest route (403)`
   (`routes.integration.test.ts:2220`) — the bypass in the objective. Criterion 1.
2. `admits a premium model for an owner-funded link guest on the guest route (201)`
   (`routes.integration.test.ts:2242`) — the no-op direction at the newly gated route: a real link
   guest is always owner-funded, so the gate must never fire for one. Criterion 3.
3. `refuses a premium model on a regenerate from a zero-balance caller (403)`
   (`routes.integration.test.ts:2259`) — pins the gate on the third payer-resolving route. See
   §Deviations: this is a behaviour change beyond the named bypass and is raised.

### Watched red (verbatim, before any source edit)

Command: `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts` — `EXIT=1`.

```
 ❯ |api| src/slices/chat/routes.integration.test.ts (191 tests | 2 failed) 19103ms
     × refuses a premium model from a zero-balance FULL-SESSION sender on the guest route (403) 215ms (retry x1)
     × refuses a premium model on a regenerate from a zero-balance caller (403) 222ms (retry x1)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |api| src/slices/chat/routes.integration.test.ts > chat route: POST /chat premium-tier gate > refuses a premium model from a zero-balance FULL-SESSION sender on the guest route (403)
AssertionError: expected 201 to be 403 // Object.is equality

- Expected
+ Received

- 403
+ 201

 ❯ src/slices/chat/routes.integration.test.ts:2237:26
    2237|       expect(res.status).toBe(403);
       |                          ^

 FAIL  |api| src/slices/chat/routes.integration.test.ts > chat route: POST /chat premium-tier gate > refuses a premium model on a regenerate from a zero-balance caller (403)
AssertionError: expected 201 to be 403 // Object.is equality

- Expected
+ Received

- 403
+ 201

 ❯ src/slices/chat/routes.integration.test.ts:2279:26
    2279|       expect(res.status).toBe(403);
       |                          ^

 Test Files  1 failed (1)
      Tests  2 failed | 189 passed (191)
```

What made it red: both routes **admitted** (`201`, a run handle) a premium model selected by a
sender who pays from their own zero-balance purchased wallet — the gate was never invoked on either
path, so no `MODEL_TIER_LOCKED` refusal could be produced. Not an error, not a typo: the assertion
compared the admitted status against the expected refusal. Test 2 (the owner-funded guest) passed in
the same red run, which is what makes the pair discriminating — the reds are not "the gate refuses
everything".

## Acceptance criteria

1. **Red first: a free-tier signed-in user posting a premium model to `/chat/guest` is refused
   `MODEL_TIER_LOCKED`** — **met**. Red output above (201); green after the change, asserting both
   `403` and `{ code: 'MODEL_TIER_LOCKED' }`.

2. **One call site, at the payer-resolution seam, inherited by every turn route** — **met**.

   ```
   $ grep -rn "tierGateRejection\|resolveTurnContext(" apps packages e2e scripts \
       --include="*.ts" --include="*.tsx" | grep -v node_modules
   apps/api/src/slices/chat/routes.ts:530:async function tierGateRejection(
   apps/api/src/slices/chat/routes.ts:1052:  const resolved = await resolveTurnContext(
   apps/api/src/slices/chat/routes.ts:1069:  const tierRejection = await tierGateRejection(c, body, resolved.value.fundingDecisionInputs);
   apps/api/src/slices/chat/domain/turn-context.test.ts: … (15 test call sites of resolveTurnContext)
   ```

   `tierGateRejection`: one definition (`:530`) and exactly **one** call site (`:1069`), inside
   `resolveGatedTurnContext`. `resolveTurnContext` likewise has exactly one production call site
   (`:1052`), inside the same seam — so the gate is not merely called once, it is unavoidable for
   any route that wants a payer. The remaining hits are `turn-context.test.ts` unit calls (and a
   stale `dist/` d.ts, excluded above).

3. **The gate still no-ops when the payer is not the sender; pinned in both directions** — **met**.
   - refused for a self-funded free sender:
     `apps/api/src/slices/chat/routes.integration.test.ts:2081`
     (`refuses a premium model for a zero-balance caller with 403 MODEL_TIER_LOCKED`)
   - permitted for an owner-funded one:
     `apps/api/src/slices/chat/routes.integration.test.ts:2155`
     (`does not tier-lock an owner-funded group turn (the caller is not the payer) (201)`)

   Both are pre-existing pins that now exercise the moved gate, and both stay green. The new test at
   `:2242` adds the owner-funded direction on the guest route specifically.

4. **A full session on `/chat/guest` stays accepted** — **met**. `chat route: POST /chat/guest
   (link-guest send) > lets a FULL-SESSION user send on the guest route, resolved as a user (not a
   guest)` (`routes.integration.test.ts:4993`) passes:

   ```
   ✓ |api| src/slices/chat/routes.integration.test.ts > chat route: POST /chat/guest (link-guest send) > lets a FULL-SESSION user send on the guest route, resolved as a user (not a guest) 105ms
   ```

   That sender holds a positive purchased balance, so the gate is a no-op for them — the fix gates
   the sender, it does not reject the path.

5. **The `forkId` comment is corrected** — **met**. Its exact new text (guest route, `routes.ts`):

   ```
   // The link-guest send: the SAME single-run/single-settlement paid pipeline
   // as `POST /` (reused, not a parallel path), reached on a PUBLIC route
   // because the HTTP matrix admits no link-guest principal. It resolves the
   // guest SERVER-SIDE from its `x-link-public-key` credential (never a
   // client-claimed id), then gates on the active member row, its WRITE
   // privilege, and the typed conversation match, before deferring to the same
   // turn-context/startRun path. The server accepts a guest's `forkId` and
   // validates it downstream; no client surface exposes forking to a guest
   // today, and the affordance is kept for one. The OWNER funds the turn;
   // the guest is the sender.
   ```

## Self-gate

| command | result |
| --- | --- |
| `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts` | pass — 191/191, EXIT=0 |
| `pnpm test:watch apps/api/src/slices/chat/routes.test.ts` | pass — 23/23, EXIT=0 |
| `pnpm test:api` (the plan's scoped check) | **fail — EXIT=1**, 7 tests in 1 file: `notifications/domain/templates/template-html.test.ts`. 471 files passed, 6541 tests passed, 1 file failed. |
| scoped coverage, one include: `pnpm test:watch apps/api/src/slices/chat --coverage --coverage.include='src/slices/chat/routes.ts' --coverage.reporter=text` | pass — EXIT=0, 36 files / 797 tests; **routes.ts 97.31 stmts / 95.84 branch / 100 funcs / 100 lines**, one file in the table |
| `cd apps/api && npx eslint src/slices/chat/routes.ts src/slices/chat/routes.integration.test.ts` (after the LAST edit, from the package dir) | pass — EXIT=0, no output |
| `cd apps/api && npx tsgo --noEmit -p tsconfig.json` | pass — EXIT=0 |
| `npx turbo typecheck --force --continue` (repo-wide, uncached) | pass — 16/16 successful, 0 cached |
| `pnpm arch:check` | pass — OK, 13 rules over 2183 files |

### The one `test:api` failure, attributed

`src/slices/chat/…` is entirely green. The failing file is
`apps/api/src/slices/notifications/domain/templates/template-html.test.ts` — 7 snapshot failures.
This is the verbatim §Known Breakage entry ("fails at HEAD — 7 snapshot failures over a removed
Google-Fonts `<link>` … belongs to the concurrent push/notifications workstream and needs an owner
outside this run"). Count and file match exactly; I touched no notifications file.

Consequence, per §Known Breakage: because a test failed, `test:api` never reached its coverage
report, so its exit code says nothing about coverage. That is why the per-file coverage gate above
was run scoped, with a single `--coverage.include`, driven by the whole chat slice (36 suites) —
both traps that section documents.

## Deviations, and the behaviour change beyond the named bypass

**`/chat/regenerate` is a third payer-resolving route, and it was bypassing both model gates.** The
plan's §F5 design context says "`tierGateRejection` has exactly one call site while **two** routes
resolve a payer". There are **three**: `POST /chat`, `POST /chat/guest` and `POST /chat/regenerate`
all call `resolveTurnContext`. Regenerate ran neither the tier gate nor the admin kill switch.

Consequences of routing regenerate through the seam, stated precisely because they are changes
outside the named bypass:

- A zero-balance self-funding caller regenerating onto a **premium** model is now refused `403
  MODEL_TIER_LOCKED`; it returned `201` before (verified — that is red #2 above). This is a change
  in *which turns are permitted* for a case the brief did not name.
- A regenerate selecting an **admin-disabled** model now answers `403 MODEL_DISABLED` instead of the
  turn build's generic unknown-model refusal (a disabled model is absent from `listDescriptors`, so
  it was already refused — only the code changes). Not pinned by a new test; no existing test
  covered it either.
- Within regenerate, the two model gates now run **before** `canRegenerate`. A request that is both
  unauthorized-for-regenerate *and* carries a disabled/premium model now answers the model refusal
  rather than the regenerate refusal. No existing test covers that combination (the existing
  regenerate gate tests all use callers with a positive purchased balance).

I implemented it this way rather than stopping because acceptance criterion 2 says the gate must be
"inherited by **every turn route**", and leaving regenerate out would leave an identical live bypass
in place while claiming the class was closed. The orchestrator should treat this as the raise it is.

**Ordering was preserved deliberately, and that is why the kill switch moved too.** Had the seam
carried only the tier gate, `POST /chat` would have run tier-before-kill-switch, which changes the
refusal code for a multi-model selection containing both a disabled model and a premium one (from
`MODEL_DISABLED` to `MODEL_TIER_LOCKED`). Moving both gates in their existing order keeps `/chat`
and `/chat/guest` byte-identical in behaviour; only regenerate changes, as itemised above.

**No amount, refusal code, or permitted-turn set changed for `POST /chat` or `POST /chat/guest`
except the bypass itself.** The gate body (`tierGateRejection`, `gatedTierModels`) is unchanged —
this is a relocation of call sites, not a re-expression of the rule, so there is no equivalence
question to answer for the moved logic.

## Concerns and limitations

- **The seam is a route-level function, not the domain's `resolveTurnContext`.** I considered moving
  the gate inside `resolveTurnContext` itself (which would make the gate structurally unskippable
  even from a route that imported the domain barrel directly). I did not, for three reasons: the
  gate returns an HTTP `Response` and reads the exposed catalog with the request logger, both
  route-layer concerns; the domain function's signature is consumed by 15 unit-test call sites that
  would each need a catalog stub; and putting it there forces the tier gate **ahead of** the kill
  switch, which changes a refusal code (above). As shipped, the property is "one call site, and the
  only production call to `resolveTurnContext` is inside it" — provable by grep, but not by the
  compiler. G4's arch rule is the mechanical enforcement the plan already scheduled.
- **`docs/BILLING.md`:** nothing in it is falsified by this task. §Group Funding 1 (the payer owns
  every funding-derived property, model access included) is exactly what the moved gate implements —
  the guest route was the code failing to match the doc, not the reverse. No correction proposed.
- The scoped coverage figure was taken once. It sits ~0.8 points above the branch floor, and this
  run's §Known Breakage documents the instrument being unstable under load; if an auditor reads a
  shortfall on `routes.ts`, re-run before believing it.
- A guest-route E2E exists (`e2e/sharing/link-guest-chat.spec.ts`) but was not run — Global
  Constraint 11 (no E2E execution this run).

## Confidence

**High** for the objective: the bypass is closed, watched red first, and both no-op directions are
pinned; the whole chat slice (797 tests) and a repo-wide uncached typecheck are green.

**Medium** on scope: routing `/chat/regenerate` through the same seam is required by criterion 2 but
changes behaviour beyond the bypass the brief named, and that judgement belongs to the orchestrator,
not to me.
