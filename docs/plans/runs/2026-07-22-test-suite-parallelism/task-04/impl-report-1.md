# impl-report — BT2 wiring (task-04)

## Objective
Route every workspace package's `test` script through the budget wrapper
(`scripts/run-package-tests.ts`), scope full runs via `HB_TEST_SCOPE=full`, and declare
`HB_TEST_SCOPE` on turbo's `test` `passThroughEnv` so it reaches tasks under strict env
without polluting the cache key. Leave `maxConcurrency: 12` hardcoded; add no env read.

## Files changed (path — why)
Package `test` scripts rerouted through the wrapper (with-env chain, extras preserved,
scripts/ depth corrected per package):
- `apps/admin/package.json` — with-env pkg, no extras.
- `apps/api/package.json` — with-env pkg, no extras.
- `apps/crawler-view/package.json` — with-env pkg, no extras.
- `apps/marketing/package.json` — with-env pkg, `--passWithNoTests` preserved.
- `apps/web/package.json` — with-env pkg, no extras.
- `packages/crypto/package.json` — with-env pkg, `--passWithNoTests` preserved.
- `packages/shared/package.json` — with-env pkg, `--passWithNoTests` preserved.
- `packages/ui/package.json` — with-env pkg, no extras.
- `packages/db/package.json` — with-env pkg; trailing `&& pnpm run test:workers` chain preserved verbatim.
- `packages/realtime/package.json` — with-env pkg; trailing `&& pnpm run test:workers` chain preserved.
- `packages/config/package.json` — non-with-env but nested (`../../` depth); `--config vitest.package.config.ts` preserved; no with-env added (matches prior shape).
- `scripts/package.json` — with-env pkg at its own dir (`./` depth for both with-env and wrapper); `--passWithNoTests` preserved.
- `ops/package.json` — non-with-env repo-root (`../` depth); `--passWithNoTests` preserved.
- `ads/package.json` — non-with-env repo-root (`../` depth); no extras.
- `package.json` (root) — `test` and `test:all` gain inline `HB_TEST_SCOPE=full` prefix on the `tsx scripts/with-env.ts turbo test` segment; `--filter` variants left unset (solo).
- `turbo.json` — `test` task gains `"passThroughEnv": ["HB_TEST_SCOPE"]`.

Not touched: `packages/config/vitest.config.ts` (only Read; `maxConcurrency: 12` intact,
no env read). It shows as working-tree-modified from a prior task (T1: sequence.concurrent
+ maxConcurrency), not from this task.

## Full before→after of every package `test` script
| package | before | after | depth | extras |
|---|---|---|---|---|
| @hushbox/admin | `tsx ../../scripts/with-env.ts vitest run --coverage` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts` | ../../ | — |
| @hushbox/api | `tsx ../../scripts/with-env.ts vitest run --coverage` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts` | ../../ | — |
| @hushbox/crawler-view | `tsx ../../scripts/with-env.ts vitest run --coverage` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts` | ../../ | — |
| @hushbox/marketing | `tsx ../../scripts/with-env.ts vitest run --coverage --passWithNoTests` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts --passWithNoTests` | ../../ | --passWithNoTests |
| @hushbox/web | `tsx ../../scripts/with-env.ts vitest run --coverage` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts` | ../../ | — |
| @hushbox/config | `vitest run --coverage --config vitest.package.config.ts` | `tsx ../../scripts/run-package-tests.ts --config vitest.package.config.ts` | ../../ | --config vitest.package.config.ts |
| @hushbox/crypto | `tsx ../../scripts/with-env.ts vitest run --coverage --passWithNoTests` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts --passWithNoTests` | ../../ | --passWithNoTests |
| @hushbox/db | `tsx ../../scripts/with-env.ts vitest run --coverage && pnpm run test:workers` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts && pnpm run test:workers` | ../../ | trailing `&& pnpm run test:workers` |
| @hushbox/realtime | `tsx ../../scripts/with-env.ts vitest run --coverage && pnpm run test:workers` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts && pnpm run test:workers` | ../../ | trailing `&& pnpm run test:workers` |
| @hushbox/shared | `tsx ../../scripts/with-env.ts vitest run --coverage --passWithNoTests` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts --passWithNoTests` | ../../ | --passWithNoTests |
| @hushbox/ui | `tsx ../../scripts/with-env.ts vitest run --coverage` | `tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts` | ../../ | — |
| scripts | `tsx ./with-env.ts vitest run --coverage --passWithNoTests` | `tsx ./with-env.ts tsx ./run-package-tests.ts --passWithNoTests` | ./ | --passWithNoTests |
| @hushbox/ops | `vitest run --coverage --passWithNoTests` | `tsx ../scripts/run-package-tests.ts --passWithNoTests` | ../ | --passWithNoTests |
| @hushbox/ads | `vitest run --coverage` | `tsx ../scripts/run-package-tests.ts` | ../ | — |

Enumeration proof: swept `apps/*`, `packages/*`, `services/*`, `mocks/*`, `scripts`,
`ops`, `ads`, `e2e` (the full workspace globs from pnpm-workspace.yaml). `services/` and
`mocks/` are empty dirs; `e2e/package.json` has no `test` script. All 14 packages that
have a `test` script were converted; none removed a `test` script (N stays 14). Depths:
`apps/*` and `packages/*` nest two levels (`../../`); repo-root `ops`/`ads` use `../`;
`scripts` is the scripts dir itself so `./`. In each case the leading `run --coverage
--maxWorkers=<n>` is supplied by the wrapper, so only the per-package EXTRA flags are
passed through.

## turbo.json change and why passThrough (not env)
Added `"passThroughEnv": ["HB_TEST_SCOPE"]` to the `test` task. Under turbo strict env,
an undeclared var is stripped from task processes, so without this the wrapper would never
see `HB_TEST_SCOPE=full` and every full run would collapse to solo (box oversubscription).
It is on `passThroughEnv`, NOT `env`/`globalEnv`, deliberately: worker count does not
change pass/fail or coverage output, so scope must not enter the cache key — a cached
solo result stays valid for a full invocation and vice-versa. `env`/`globalEnv` would fold
scope into the hash and needlessly invalidate cache across solo/full.

## Root scope wiring
`test` and `test:all` set `HB_TEST_SCOPE=full` as an inline prefix on the
`tsx scripts/with-env.ts turbo test` segment (the env is present when turbo forks tasks,
which then pass it through). `test:api`/`test:web`/`test:admin`/`test:crypto`/`test:shared`/
`test:config`/`test:db`/`test:realtime`/`test:ui` (the `--filter` variants) leave it unset
→ solo, whole box.

## Self-gate / verification
- JSON validity: all 16 edited files (`package.json`, `turbo.json`, 14 package manifests) parse — pass.
- SOLO run — `pnpm exec turbo test --filter=@hushbox/ops --force`:
  `@hushbox/ops:test: [ops] scope=solo · work-share=solo · workers=20 · maxConcurrency=12`
  · `Tasks: 1 successful, 1 total`. cores=`os.availableParallelism()`=20 → `maxWorkers=20`
  (whole box). The wrapper unconditionally appends `--maxWorkers=${maxWorkers}` to the
  vitest argv (run-package-tests.ts:238), so vitest receives `--maxWorkers=20`.
- FULL scoped run — `HB_TEST_SCOPE=full pnpm exec turbo test --filter=@hushbox/ops --force`:
  `[ops] scope=full · work-share=even · workers=2 · maxConcurrency=12` · `Tasks: 1 successful`.
  Cold cache → even split: budget=round(20×1.5)=30, N=14 → round(30/14)=2. Weight file
  written: `scripts/.cache/test-weights/ops.json = {"totalWorkMs":82.573...}` (gitignored;
  proves the full-run json-capture path fired end-to-end). scope=full reached the wrapper,
  confirming the turbo passThroughEnv declaration works.
- `maxConcurrency: 12` in `packages/config/vitest.config.ts` unchanged (line 28); repo-wide
  grep for `HB_MAX_CONCURRENCY` returns nothing.

## Acceptance criteria
- Every workspace package with a `test` script routes through the wrapper, extras preserved, depths correct — met (table above; 14/14 converted, enumeration swept full workspace globs).
- Full runs scoped (`HB_TEST_SCOPE=full` on root `test`/`test:all`), `--filter` variants unset — met.
- `HB_TEST_SCOPE` on `test.passThroughEnv` (not env/globalEnv) — met.
- `maxConcurrency` stays hardcoded 12, no env read added — met.
- Solo ops prints scope=solo with `--maxWorkers=<cores>` — met (workers=20).
- Full ops reaches wrapper as scope=full and writes a weight file — met.

## Deviations
None from the brief. One clarification the brief did not enumerate: the workspace has two
non-with-env packages that are NOT repo-root — `packages/config` (nested, `../../`, no
with-env) and `scripts` (its own dir, `./`, with-env). Handled by preserving each one's
existing with-env status and using its true relative depth to `scripts/`, consistent with
the brief's depth rule.

## Concerns and limitations
- Inline `VAR=val cmd` env prefix is POSIX-sh syntax; pnpm runs scripts via the system
  shell on Linux (local + CI), so it is portable here. Not Windows-portable, matching the
  rest of the repo's scripts.
- Did not run the whole suite (per brief). Verified end-to-end only on the tiny @hushbox/ops
  package for both scopes.

## Confidence
high — every manifest edited, all JSON valid, both scope paths exercised end-to-end with
the expected allocation lines and a written weight file; no change to the hardcoded
maxConcurrency and no env indirection introduced.
