# A1 — impl report 2 (fix cycle)

## Objective

Clear the single validated finding from A1's two audits: `scripts/refresh-catalog-run.test.ts`
carries an exhaustive `Record<ExcludeReason, number>` object literal that was not updated when
A1 added three members to the closed exclusion-reason set, so `@hushbox/scripts` typecheck fails
with `TS2739`. Add the three missing keys. Nothing else in A1 is reopened — both auditors
reproduced the live-catalog numbers and found zero findings against the rules themselves.

## Files changed

| File                                | Why                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/refresh-catalog-run.test.ts` | Adds `'zero-priced'`, `'below-price-floor'`, `'too-old'` (each `0`) to the `SUMMARY` literal typed `RefreshSummary`, restoring exhaustiveness. |

Three inserted lines, no other change:

```
     'missing-pricing': 0,
+    'zero-priced': 0,
+    'below-price-floor': 0,
+    'too-old': 0,
     deprecated: 0,
```

Placed in `EXCLUDE_REASONS` declaration order (`normalize.ts:59-74`), matching the near-identical
sibling map in `scripts/refresh-catalog.test.ts:10-25`. `git diff --stat` = `1 file changed, 3
insertions(+)`.

## Tests added

None, and deliberately so — this is a type-level omission in a **test fixture**, not a behaviour
gap. The literal is a static stand-in for a `RefreshSummary`; there is no production code path to
drive red. The failing artefact was the typecheck itself, which I watched fail for the exact
diagnosed reason before editing (below) and watched pass after. Behaviour is already pinned by
`scripts/refresh-catalog.test.ts`, which exercises `formatRefreshSummary` over the full reason set
including the three new members (verified green, 4/4, this cycle).

Writing a test asserting three zero-valued keys exist in a fixture would assert the compiler's job,
not a behaviour.

## Self-gate

### RED — observed before the edit

`npx turbo typecheck --filter=@hushbox/scripts --force`:

```
refresh-catalog-run.test.ts(35,3): error TS2739: Type '{ 'token-priced-image': number; ... }'
is missing the following properties from type 'Record<"below-price-floor" | ... | "zero-priced",
number>': "below-price-floor", "too-old", "zero-priced"
Failed:    @hushbox/scripts#typecheck
```

Exactly the diagnosed cause, exactly the three keys, at the line the finding named.

### GREEN — repo-wide, not scoped

`npx turbo typecheck --force --continue` — the gate this cycle exists to satisfy:

```
• Packages in scope: @hushbox/admin, @hushbox/ads, @hushbox/api, @hushbox/config,
  @hushbox/crawler-view, @hushbox/crypto, @hushbox/db, @hushbox/e2e, @hushbox/marketing,
  @hushbox/ops, @hushbox/realtime, @hushbox/sandbox, @hushbox/scripts, @hushbox/shared,
  @hushbox/ui, @hushbox/web
• Running typecheck in 16 packages

 Tasks:    16 successful, 16 total
 Cached:    0 cached, 16 total
   Time:    37.265s
```

**16/16 successful, 0 cached** (every package genuinely re-executed under `--force`), and zero
`error TS` lines anywhere in the output. Note this also means §Known Breakage's
"`packages/shared/src/env.config.ts` + notifications typechecks may be red" entry has **cleared** —
repo-wide typecheck is now fully green, so it is a usable gate again rather than a scoped fallback.

### Other checks

| Command                                                                | Result                                                                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx eslint refresh-catalog-run.test.ts` from `scripts/`, after the final edit | **exit 0** (Global Constraint 9)                                                                                                                                  |
| `npx turbo test --filter=@hushbox/scripts --force`                     | 87/90 files pass, 1852/1853 tests. 3 red files, **all** §Known Breakage, attribution below                                                                        |
| `npx vitest run refresh-catalog-run.test.ts refresh-catalog.test.ts` in isolation, after `rm -rf node_modules/.vite` | `refresh-catalog.test.ts` **4/4 pass**; `refresh-catalog-run.test.ts` still fails at **collection** on the listed cause |

### Attribution of the three red scripts files

The lesson this cycle encodes is that a §Known Breakage entry must not absorb a second,
independent cause. So each is attributed by its observed failure mode, not by its filename:

1. **`refresh-catalog-run.test.ts` — collection failure, listed cause, verified byte-identical.**
   `Error: [vitest] There was an error when mocking a module` → `Caused by: Cannot find module
   .../deps_ssr/@hushbox_db.js&v=ce1e6bc1` (`ERR_MODULE_NOT_FOUND`). That is precisely the listed
   "test runner mangles an SSR-optimized dependency URL under `vi.mock` + `importOriginal`" —
   a malformed URL with `&v=` concatenated onto the resolved path. It **reproduces after
   `rm -rf scripts/node_modules/.vite`**, so it is not the stale-optimizer artefact §Known Breakage's
   environment gotcha describes and is not clearable by me. **The typecheck break was this file's
   second cause, and it is now gone** — repo-wide typecheck is green, which is the check that reads
   files whose tests never execute. I found no third cause: the only runtime consumer of this
   literal is `formatRefreshSummary`, exhaustively covered by the green sibling.
   I attempted to force collection with `--deps.optimizer.ssr.enabled=false`; vitest 4 rejects the
   flag (`CACError: Unknown option --deps`). I did not pursue further — the entry says it needs an
   owner outside this run, and no config edit is within my ownership.
2. **`seed-run.test.ts`** — same collection class, same listed entry. Untouched by me.
3. **`generate-env.test.ts`** — the assertion diff is the `ci.yml` verify-secrets loop gaining
   `VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY NOTIFICATION_TAG_SECRET`, present in `env.config.ts` and
   absent from the test's expected string. Notifications/push workstream, re-verified in report 1
   and unchanged. Nothing in my one-line-class edit can reach it.

Not run, and outside a three-key type fix's blast radius: `pnpm test:api`, `pnpm test:shared`,
`pnpm test:web`, `pnpm arch:check`, `lint:duplication`, `lint:unused`, E2E (Global Constraint 11).
The edited file is a test fixture in `scripts/`; no non-test module imports it.

## Acceptance criteria

**The validated finding is cleared** — **met**. `TS2739` at
`scripts/refresh-catalog-run.test.ts:35` reproduced before the edit, absent after, evidenced by the
16/16 repo-wide run above rather than by a scoped filter (a scoped pass is what produced the
finding in the first place).

**No other exhaustive `Record<ExcludeReason, …>` literal remains unupdated** — **met, by my own
sweep, not by citing the auditor's.** Method, in three independent passes:

1. **By type name.** `grep -rn` for `ExcludeReason`, `RefreshSummary` and `excludedByReason` across
   `apps packages scripts e2e`, excluding `node_modules`. Every hit is a type reference, an import,
   a re-export, a union member, or a function signature — **not** an object literal — except the two
   known literals: `scripts/refresh-catalog.test.ts:10` (already correct) and
   `scripts/refresh-catalog-run.test.ts:35` (fixed here). One further hit,
   `apps/api/dist/apps/api/src/platform/dev/seed-toolkit.d.ts:9`, is a **build artefact** that
   re-exports the type and contains no literal; it regenerates from source.
2. **By key density**, to catch any literal that never names the type. For every file containing
   `non-runnable-shape`, counted occurrences of the whole reason vocabulary. Five files, in
   descending density: `normalize.test.ts` (47), `normalize.ts` (29), `refresh-catalog.test.ts` (18),
   `refresh-catalog-run.test.ts` (10), `refresh.integration.test.ts` (10). No sixth file anywhere in
   `apps`, `packages`, `scripts`, `e2e` carries a cluster of reason keys.
3. **By new-member presence**, over exactly those five plus `refresh.ts` (which holds
   `emptyExcludedByReason`, the one production exhaustive map). Counting
   `zero-priced|below-price-floor|too-old` per file: `normalize.test.ts` 13, `normalize.ts` 8,
   `refresh-catalog.test.ts` 5, `refresh.integration.test.ts` 3, `refresh.ts` 1, and
   `refresh-catalog-run.test.ts` **0** — the sole omission, now 3.

The three passes agree, and pass 3's result is independently corroborated by the repo-wide typecheck:
an exhaustive `Record<ExcludeReason, …>` literal missing a member is a compile error by construction,
so 16/16 green **is** a proof of completeness for this class, not merely a sample. The brief's
NEEDS_CONTEXT trigger ("a further exhaustive literal the auditor's five-file sweep missed") therefore
did not fire.

## Deviations

None. Scope was three keys and stayed three keys.

## Concerns and limitations

- **`refresh-catalog-run.test.ts`'s four tests still do not execute**, so this fix's correctness
  rests on the compiler plus the green sibling rather than on the file's own run. That collection
  failure predates A1, reproduces on a cleared optimizer cache, and needs the owner §Known Breakage
  already asks for. The specific risk it leaves: any *future* change to this file is again gated only
  by typecheck and lint — which is the exact hiding place this cycle exposed.
- **Everything raised in report 1 stands and none of it changed here** — chiefly that nothing prunes
  a catalog row a new rule newly excludes (plan Amendment §THE GAP, founder-ruled out of A1's
  ownership, with `modelCatalog.adminDisabledAt` identified as the likely mechanism), and that the
  top-context exemption is inert on today's catalog.
- **Ruled items left untouched, per brief:** the `openai/gpt-4o` reference in
  `scripts/lib/seed-fixtures.ts` (accepted; correcting it forces a seed-crypto cache regeneration
  that collides with another workstream's dirty cache), and the two CI cassette model ids.
- **F1-owned paths untouched.** My footprint is one file. `turbo lint`'s redness on
  `billing/domain/spendable.integration.test.ts` is F1's; I neither ran a fix for it nor read those
  files.

## Confidence

**High.** The finding was a compile error with an exact line, an exact type and three exactly-named
missing members; it was reproduced before the edit, the edit is the minimal three keys in the
sibling's established order, and the repo-wide 16/16 forced typecheck both proves the fix and — since
this error class is a compile error by construction — proves no sibling literal remains. The residual
risk is not in the fix but in the unowned collection failure that keeps this file's tests from
running.
