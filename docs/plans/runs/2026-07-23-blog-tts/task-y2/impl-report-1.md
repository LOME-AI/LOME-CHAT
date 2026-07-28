# Y2 — Delete the callerless production build path (impl report 1)

## Objective

Remove `pnpm build:web` / `--target=prod` — a build path with zero callers — from
`package.json` and `scripts/build-web-bundle.ts`, without disturbing `pnpm build:e2e`,
`selectE2eEnvMode`, or the bundle verifier seam another task is concurrently extending.

## Files changed

- `package.json` — deleted the `build:web` script entry (the only definition of the prod path).
- `scripts/build-web-bundle.ts` — removed `parseTarget`'s `'prod'` branch, the `BuildTarget`
  `'prod'` member, the `target` parameter of `buildWebBundle` (it became single-valued and
  therefore an unused parameter once the three `target === 'e2e'` branches collapsed), and the
  three prod-only code paths those branches selected. Comments that described the prod path
  were rewritten or deleted.
- `scripts/build-web-bundle.test.ts` — one test inverted, two deleted, six call sites updated
  for the new `buildWebBundle` signature (detail below).

Nothing else was touched. `scripts/verify-web-bundle.ts`, `scripts/build-admin-bundle.ts`,
`playwright.config.ts` and every workflow file are unmodified by this task.

### Attribution note for the auditor

`scripts/build-web-bundle.ts` already carried **uncommitted edits from the X5b fix cycles**
when I started, so `git diff` against HEAD for this file shows their work plus mine. The
pre-existing working-tree text I edited read: "`--target=e2e` builds in dev mode (loads
`.env.development`); `playwright.config.ts`'s preview server and CI's `e2e-build` job invoke it
that way, via `pnpm build:e2e`. `--target=prod` runs the same sequence in prod mode." The
`verify:web-bundle` line that appears added in `package.json`'s diff is likewise X5b's, not
mine; my only `package.json` change is the one deleted `build:web` line.

## Tests

| Test                                                              | Behaviour                                                            | Criterion covered                       | Disposition                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `throws for --target=prod`                                        | the deleted target is rejected loudly, not silently treated as e2e   | `parseTarget`'s `'prod'` branch is gone | **inverted** (was `parses --target=prod`)                                                                                                                                 |
| `does not generate env for prod and omits --mode development`     | prod skipped env generation and the `--mode development` passthrough | —                                       | **deleted**: its entire subject is the removed prod path; the surviving half (e2e _does_ generate env and _does_ pass `--mode development`) already has its own two tests |
| `generates headers without with-env for prod (caller-inline env)` | prod ran `generate-headers.ts` bare                                  | —                                       | **deleted**: entire subject removed; the surviving with-env invocation is pinned by `generates headers (under with-env) as the final step`                                |
| `does not generate headers when verification fails`               | verification failure aborts before headers                           | verifier seam survives                  | **updated** (was driven through `'prod'`, now through the sole path) — behaviour is not prod-specific                                                                     |
| 5 other `buildWebBundle` tests                                    | unchanged behaviours                                                 | `build:e2e` sequence intact             | **updated** for the new signature only                                                                                                                                    |

No test was weakened. Test count 15 → 13, entirely from the two deletions.

## Self-gate

| Command                                                                                          | Result                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx turbo typecheck lint --filter=@hushbox/scripts --force --continue`                          | **pass** — 2 successful, 2 total                                                                                                                                                                                       |
| `npx turbo test --filter=@hushbox/scripts --force`                                               | **fail — foreign only**: 1879 tests passed, 88/90 suites passed; the 2 failed suites are `refresh-catalog-run.test.ts` and `seed-run.test.ts`, both failing at module load, neither touched by this task               |
| `eslint build-web-bundle.ts build-web-bundle.test.ts` (run from `scripts/`, after the last edit) | **pass**, exit 0                                                                                                                                                                                                       |
| `npx prettier --check package.json scripts/build-web-bundle.ts scripts/build-web-bundle.test.ts` | **pass**                                                                                                                                                                                                               |
| `pnpm lint:unused` (knip)                                                                        | **unchanged from the baseline I captured before editing**: same 1 unused file (`packages/config/vitest.package.config.ts`) + same 1 configuration hint (`wrangler` / `apps/sandbox`). No finding added, none resolved. |
| `npx vitest run build-web-bundle.test.ts --coverage.include=build-web-bundle.ts`                 | 100% statements / branches / functions / lines                                                                                                                                                                         |

Foreign test failure excerpt (identical for both suites):

```
Caused by: Error: Cannot find module
'/…/scripts/node_modules/.vite/vitest/…/deps_ssr/@hushbox_db.js&v=8a56db6e'
```

Attribution: both fail at module _load_ on a stale Vite `deps_ssr` cache entry for
`@hushbox/db`; my change touches neither file, neither imports `build-web-bundle.ts`, and both
are recorded as known-red foreign failures in the plan (§KNOWN PRE-EXISTING FAILURES, cause
corrected in §CONCURRENCY CORRECTION). I ran the knip baseline before my first edit precisely
so the after-state could be compared; it is identical.

## Acceptance criteria

1. **`build:web` gone from `package.json`** — **met**. Line 14 deleted; `build:e2e` and
   `build:e2e:admin` untouched.
2. **`parseTarget`'s `'prod'` branch and prod-only code paths gone** — **met**.
   `BuildTarget` is now `'e2e'`; the error message reads `requires --target=e2e`; the three
   prod-only paths (skip env generation, omit `--mode development`, run `generate-headers.ts`
   without `with-env`) no longer exist.
3. **`pnpm build:e2e` still works end to end** — **met, executed**.
   `NODE_ENV=development pnpm build:e2e` → **exit 0**. Full sequence observed: turbo built
   `@hushbox/web` + `@hushbox/marketing` (`Tasks: 2 successful, 2 total`), the marketing merge
   ran, the bundle verification passed (it throws on failure and the step after it ran), and
   the final line was
   `Wrote …/apps/web/dist/_headers (14 marketing pages, 32 blocks)`.

   `NODE_ENV` must be set by the caller — CI does this at `ci.yml:411-414`
   (`env: NODE_ENV: development`). This is pre-existing and unrelated: the original code called
   `selectE2eEnvMode(process.env)` on the same path, and `createEnvUtilities` has always
   required an explicit `NODE_ENV`. My first invocation without it failed identically to how
   the pre-change code would have.

   **Env hygiene:** `build:e2e` regenerates `.env.development` / `.env.scripts` in E2E mode. I
   copied both files aside beforehand and restored them byte-for-byte afterwards (md5 verified
   identical to the pre-run state: `0a84d053…` / `13583e6c…`). I did **not** run
   `pnpm generate:env` or `pnpm install`, so no workflow file was regenerated.

4. **`selectE2eEnvMode` remains exported** — **met**. Still `export function` at
   `scripts/build-web-bundle.ts:52`; `scripts/build-admin-bundle.ts:26` still imports it, and
   the `@hushbox/scripts` typecheck (which compiles that file) passes.
5. **`playwright.config.ts:96` unaffected** — **met**. Not edited. It invokes
   `pnpm build:e2e`, whose definition is unchanged, and passes no `--target` of its own.
6. **Tests updated, not deleted, where they covered surviving behaviour** — **met**. See the
   table above: only the two tests whose entire subject was the prod path were deleted.

## Surviving-reference sweep

Repo-wide grep for `build:web`, `target=prod`, and `BuildTarget`, excluding `node_modules`,
`.git`, `.turbo`, `.wrangler`, `dist*`, and this run's own `docs/plans/runs/` records:

```
scripts/build-web-bundle.ts:32:export type BuildTarget = 'e2e';
scripts/build-web-bundle.ts:41:export function parseTarget(args: readonly string[]): BuildTarget {
scripts/build-web-bundle.test.ts:16:    it('throws for --target=prod', () => {
scripts/build-web-bundle.test.ts:17:      expect(() => parseTarget(['--target=prod'])).toThrow(/--target/);
```

Zero hits for `build:web`. The only two `--target=prod` occurrences are the test that pins its
rejection. No workflow, doc, README, comment, or config mentions either string. `prod` does not
appear anywhere in `build-web-bundle.ts`, `verify-web-bundle.ts`, or `build-admin-bundle.ts`.

## Comment sweep

Per the plan's standing rule for these two files — ground every reach claim in a caller you can
point to, or delete the claim, and never use a universal quantifier about reach — I rewrote the
module docstring to enumerate the two callers by name (`playwright.config.ts`'s preview server,
CI's `e2e-build` job, both via `pnpm build:e2e`; verified at `playwright.config.ts:96` and
`ci.yml:410`) and deleted every claim tied to the removed path:

- the module docstring's `--target=prod` bullet and "Shared by every caller" framing;
- `selectE2eEnvMode`'s "Prod has no analogue: its `VITE_*` arrive inline from the caller" —
  the third instance flagged in X5b fix cycle 2, now moot rather than rewritten;
- the "e2e self-generates … prod takes its `VITE_*` inline" body comment;
- "dev/prod (passthrough args are hashed)" → "differing passthrough args (they are hashed)",
  which is the durable fact and no longer names a mode that cannot be built;
- the `v8 ignore` reason `build:* package scripts` → `build:e2e package script`.

No shipped comment references a task ID, plan section, or this run.

## Deviations

1. **`buildWebBundle`'s `target` parameter was removed** (signature is now
   `(rootDir, env, deps)`). Not optional: with `'prod'` gone the parameter is single-valued,
   all three `target === 'e2e'` conditions become statically true, and the unreachable branches
   would both fail the branch-coverage gate and leave the parameter unread (a typecheck error).
   The plan's "any prod-only code paths … are gone" covers this; I am flagging it because it is
   an exported signature change. The only caller is the CLI entry in the same file (plus tests).
2. **`parseTarget` was kept**, per the brief's instruction not to unilaterally simplify it.
   Its return value is now discarded at the single call site; it functions as an argument
   validator. See below.

## Design call surfaced (not made)

`parseTarget` can now return exactly one value, and the CLI entry calls it purely for its
throw. Its remaining value is real but narrow: an invocation that still says `--target=prod`
fails loudly instead of silently producing an e2e bundle. Three shapes, for the orchestrator to
rule on rather than me:

- **(a) as shipped** — keep `parseTarget` and `--target=e2e` in the `build:e2e` script; a
  stale `--target=prod` invocation dies with a clear message. Costs one exported function whose
  return nobody reads.
- **(b) delete `parseTarget` + `BuildTarget`** and drop `--target=e2e` from the `build:e2e`
  script, making the script argument-free. Smallest surface; a leftover `--target=prod` would
  then be silently ignored and quietly build an e2e bundle.
- **(c) keep the guard, rename it** to something that reads as an assertion and return `void`.
  This is a naming change, so it belongs with Y6 (durable renames), which already depends on
  Y2 — that is the natural home for it rather than this task.

I shipped (a) because it is the minimum change consistent with "do not unilaterally simplify",
and because it preserves fail-fast. If the orchestrator prefers (b) or (c), it is a small
follow-up.

## Concerns and limitations

- The `pnpm build:e2e` proof was run locally, not in GitHub Actions; agents cannot execute
  workflows. What is verified: the script's full sequence exits 0 and produces the merged dist
  plus `_headers`. What is not: the CI job itself. CI's invocation differs from mine only in
  supplying `VITE_HELCIM_JS_TOKEN_SANDBOX` and running under `CI=true` (which selects
  `Mode.CiE2E`), neither of which this change touches.
- Running `build:e2e` rewrote `apps/web/dist` and `apps/marketing/dist`. Both are gitignored
  build outputs, but other workstreams are active in this checkout; if one was mid-way through
  reading a stale `apps/web/dist`, it now sees a freshly built e2e one.
- Two `@hushbox/scripts` test suites remain red for a foreign reason (above). I did not touch
  them and did not clear the Vite cache that would mask them.

## Confidence

**High.** The deletion is small and fully swept; `build:e2e` was executed end to end at exit 0;
coverage on the edited file is 100%; typecheck, lint, and prettier are green; knip is
byte-identical to the baseline I took before editing. The one judgement call — keeping
`parseTarget` as a single-valued validator — is surfaced above rather than settled.
