# T10 — E2E/CI test infrastructure for the sandbox origin — impl report 1

## Objective

Build the shared harness both E2E suites (T7 security corpus, T8 Playwright flow) need
so neither depends on live network and both exercise the REAL sandbox policy: serve the
sandbox origin under its real CSP in dev/CI, single-source that CSP, serve an esm.sh stub
fixture set, make the micropip path deterministic, and wire the Pyodide asset fetch into
the turbo/CI graph.

## Files changed

- `apps/sandbox/src/csp.ts` (new) — the ONE authoritative sandbox policy: `SANDBOX_CSP`
  (byte-identical to the pre-existing `public/_headers` string) + `SANDBOX_SECURITY_HEADERS`
  (CSP + `X-DNS-Prefetch-Control: off`). The single source parts 1/2 require.
- `apps/sandbox/src/dev-server.ts` — injects `SANDBOX_SECURITY_HEADERS` (the real CSP +
  DNS-prefetch lock) on every response via a `BASE_HEADERS` set; routes `/esm-stub/*` to
  the fixture resolver serving JS modules. E2E now hits the deployed policy, not a
  permissive dev server.
- `apps/sandbox/src/esm-stub.ts` (new) — the esm.sh stand-in: fixture modules (react,
  react/jsx-runtime, react-dom/client, canvas-confetti) + `resolveEsmStub` that strips the
  `@version` from every `pkg@ver`/`pkg@ver/subpath` shape (reusing `render/specifier.ts`
  `parseSpecifier`) and keys on bare package + subpath.
- `apps/sandbox/src/python/browser-harness.ts` — dropped the hardcoded reduced CSP copy;
  now imports `SANDBOX_CSP` from `../csp.ts` (single-source, and the harness now serves the
  FULL policy). Added a `beforeLoad` hook to `openPythonPage` and `installPyPIInterception`
  (replays the three PyPI resources micropip fetches from committed fixtures, with a
  catch-all abort of both PyPI hosts guaranteeing zero live network).
- `apps/sandbox/src/python/python-micropip.browser.test.ts` — installs the interception via
  the hook; same document + assertions, now deterministic.
- `apps/sandbox/test-fixtures/pypi/{cowsay-simple-index.json, cowsay-6.1-py3-none-any.whl,
  cowsay-6.1-py3-none-any.whl.metadata}` (new) — recorded-once PyPI cassette for cowsay.
- `apps/sandbox/src/headers.test.ts` — added the drift pins: `_headers` CSP === `SANDBOX_CSP`
  (the prod-unchanged proof) and the DNS header matches the constant.
- `apps/sandbox/src/dev-server.test.ts` — added served-CSP === constant, esm-stub serving
  (module MIME + subpath + 404 + HEAD) tests.
- `apps/sandbox/scripts/fetch-pyodide.sh` — idempotency guard (skips the ~26 MB download
  when the pinned set is already present), so the forced turbo re-run / CI cache-restore is
  cheap.
- `turbo.json` — new `fetch-pyodide` task (inputs = the script, outputs = `public/pyodide/**`);
  `test` and `build` dependsOn it. Per-package: only `@hushbox/sandbox` resolves a command
  (verified via dry-run — all other packages' instances are `<NONEXISTENT>`, i.e. skipped).
- `.github/workflows/ci.yml` — test job: cache Pyodide assets (keyed on the fetch script's
  pins) before the turbo-driven `pnpm test`. E2E job: cache + explicit `fetch-pyodide`
  before `pnpm e2e` (e2e is outside the turbo test graph).

## Tests added (name — behavior — criterion)

- esm-stub × 7 — version-agnostic resolve, jsx-runtime + react-dom/client subpaths,
  unversioned specifier, unknown-package null, unknown-subpath null, non-namespace null —
  the esm-stub routing (part 3).
- dev-server "serves every page under the exact production sandbox CSP" — served CSP ===
  `SANDBOX_CSP` + `X-DNS-Prefetch-Control: off` — parts 1/2 served-policy proof.
- dev-server esm-stub × 4 (module JS + CSP, subpath, 404, HEAD) — part 3 wiring.
- headers "byte-identical to SANDBOX_CSP" + DNS-lock — constant === `_headers` (prod-unchanged
  proof); chained with the served-CSP test = served === constant === `_headers`.
- micropip (rewritten) — cowsay fallback runs with the PyPI hosts aborted except the three
  fixtures — part 4 zero-live-network.

TDD: esm-stub written test-first (watched RED — module missing). The served-CSP/esm-stub
dev-server tests exercise genuinely new behavior (the dev server previously sent no CSP and
no `/esm-stub`). The micropip determinism was proven by recording the real traffic once
(throwaway capture, deleted), then replaying under a catch-all PyPI abort that fails the
test if any un-fixtured PyPI request escapes — the test passing IS the offline proof.

## Self-gate

- `pnpm --filter @hushbox/sandbox test` (coverage gate perFile 95) — pass, 16 files / 120
  tests; package coverage 100%. No pole.
- `turbo typecheck lint --filter=@hushbox/sandbox` — pass (both).
- `npx eslint <owned files>` (package dir, after LAST edit) — exit 0.
- `jscpd apps/sandbox/src` — one clone, between `python/build-python-bundle.ts` and
  `render/build-bundle.ts` (pre-existing T2/T3 files, NOT touched here); my new files add no
  clones. 0.63% total, under threshold.
- `pnpm verify:env --mode=development` / `--mode=production` — pass. `ciVitest/e2e/ciE2E`
  fail on the same cross-mode `.env` mismatch T6 recorded (local `.env` generated for
  development); I touched no env config — `ESM_CDN_URL` test mode already points at
  `/esm-stub`.
- `turbo run test --dry-run` — confirms `@hushbox/sandbox#test` → `#fetch-pyodide`; other
  packages' fetch-pyodide instances resolve `<NONEXISTENT>` (skipped).
- ci.yml + turbo.json — YAML/JSON parse validated. The CI runner itself (useblacksmith/cache
  behavior, the forced-turbo + idempotent-fetch interaction) could not be executed locally.

## Acceptance criteria

- Sandbox served under its real CSP locally — MET (dev-server injects `SANDBOX_CSP` +
  `X-DNS-Prefetch-Control`; test asserts the served header equals the constant).
- Test proves served CSP === the single constant — MET (dev-server test) — and === what
  `_headers` ships (headers test), so served === constant === `_headers`.
- Single-source the CSP — MET (dev-server + python harness both import `SANDBOX_CSP`;
  `_headers` pinned equal by drift test; the harness's old hardcoded copy removed).
- esm-stub serves the fixture set as modules — MET (react/react-dom/canvas-confetti, `pkg@ver`
  and `pkg@ver/subpath` shapes, JS MIME).
- micropip demo runs with zero live-network — MET (fixtures + catch-all PyPI abort).
- fetch-pyodide in the CI graph before dependent suites — MET (turbo `test`/`build` dep +
  CI cache/fetch on both test and e2e jobs).
- Existing sandbox + web suites stay green — MET (full sandbox suite green; web untouched).
- Prod CSP byte-identical to before — MET (`SANDBOX_CSP` is the exact prior `_headers`
  string; drift test pins it; the existing per-directive pins in headers.test unchanged).
- 95% on new logic — MET (100% package coverage).

## Deviations with reasons

- **micropip: chose a stricter variant of plan option (a).** The plan offered (a) a wheel
  stub on a separate host + a TEST-mode connect-src allowance, or (b) a lock package. (b)
  loses the micropip-fallback proof entirely (a lock package is loaded by
  `loadPackagesFromImports`, never micropip) and duplicates the numpy test. (a) as written
  needs a TEST-mode CSP allowance. Instead I replay the REAL PyPI hosts (already in the prod
  connect-src) from committed fixtures via `page.route`, so **no test-mode CSP allowance is
  needed and the prod policy is byte-identical** — strictly better against the CRITICAL "do
  not weaken the prod CSP" directive, and it keeps the genuine micropip-install path under
  test. Note: the bootstrap auto-installs any missing import from live PyPI unconditionally,
  so serving the wheel from `'self'` was not viable (it fights the auto-install); interception
  at the network seam is the only approach that keeps the fallback branch honest.
- **The python browser-harness now serves the FULL policy** (it previously applied a reduced
  2-directive CSP). This is the single-source consequence and it makes the Python tests
  exercise the deployed policy; all pass under it (Pyodide/numpy/matplotlib/micropip).

## Concerns and limitations

- **CI-yaml not executed.** Reasoned, not run: (1) `useblacksmith/cache@v5` restores
  `apps/sandbox/public/pyodide` keyed on the fetch script's hash; (2) with `TURBO_FORCE:
  true`, the sandbox `fetch-pyodide` task re-runs but the new idempotency guard no-ops when
  the cache restored the assets; (3) the e2e job gets an explicit cache + `fetch-pyodide`
  before `pnpm e2e`. Remaining for the CI run: confirm the cache action key/path and that
  the e2e webServer (owned by T7/T8) serves the sandbox with the assets present.
- **fetch-pyodide idempotency sentinel** checks the core wasm + lock + the last wheel
  (micropip) — a partial dir (interrupted fetch) would falsely skip; acceptable because
  curl writes each file whole and the CI cache stores complete sets.
- **`apps/sandbox` is entirely untracked** (the T1 package is uncommitted, per T6's report);
  my changes live inside it. Fixtures under `test-fixtures/pypi/` are not gitignored.

## What T7/T8 can now rely on

- **Served CSP:** the dev server (`pnpm dev` / E2E) and the `startPythonSandbox` harness
  both serve exactly `SANDBOX_CSP` + `X-DNS-Prefetch-Control: off` — the deployed policy.
- **esm-stub fixtures:** the dev server serves react, react-dom, canvas-confetti (and
  subpaths) under `/esm-stub/*` as JS modules; `ESM_CDN_URL` already points there in test
  modes. T8's React/JS documents render offline.
- **Pyodide assets:** present before both the sandbox suite (turbo `test` dep) and the e2e
  job (explicit step), cached in CI.
- **micropip:** `installPyPIInterception` (reusable via `openPythonPage`'s `beforeLoad`) +
  the `apps/sandbox/test-fixtures/pypi/` cassette. T7/T8 in `e2e/` (which cannot import from
  `apps/sandbox`) replicate the three-route pattern against the same fixture bytes.

## Confidence

High on parts 1–4 (all proven by green tests: served CSP === constant === `_headers`;
esm-stub; deterministic micropip under a catch-all abort; 100% coverage). Medium on part 5
CI-yaml — the turbo graph and idempotent fetch are validated locally, but the GitHub-runner
cache-action behavior and the T7/T8-owned e2e sandbox-serving are not exercisable here.
