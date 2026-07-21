# Task-03 — device-key E2E variant resolved at build time — impl-report-1

## Objective

Eliminate the runtime `env.isE2E`-gated dynamic `import('./device-key-store.e2e.js')` on
the auth-bootstrap path (loaded for every route, guests included). On guest share routes a
racing navigation aborts the in-flight `.e2e` chunk fetch → `TypeError: Importing a module
script failed` → router CatchBoundary blank page (research/sharing.md §RC1, 3 sharing
failures). Select the store variant at **build time** instead, keeping the production bundle
free of any `.e2e` code and `pnpm arch:check` green.

## Approach chosen + why

Build-time module substitution via a Vite `resolveId` plugin, gated on the baked `VITE_E2E`
env value:

- New pure helper `apps/web/src/lib/device-key-store-e2e-resolution.ts` —
  `resolveDeviceKeyStoreE2eVariant(source, importer, e2eModulePath)` returns the e2e module
  path for any specifier resolving to `device-key-store` (relative or `@/` alias, optional
  `.js`/`.ts`), and `null` otherwise (including imports originating from the e2e module
  itself, so its type-only back-reference to the production module never loops). Pure and
  unit-tested in isolation so the resolution logic has Rung-1/3 coverage independent of a
  full Vite build.
- `apps/web/vite.config.ts` installs `deviceKeyStoreE2eVariantPlugin()` with
  `enforce: 'pre'` **only when `env['VITE_E2E'] === 'true'`**, so the swap wins before
  Vite's own `@/` alias resolution and is entirely absent from production builds. The E2E
  build path is `scripts/build-web-bundle.ts --target=e2e`, which regenerates the
  `.env.development` files with `VITE_E2E=true` before `vite build --mode development` — the
  same build the Playwright preview server and CI `e2e-build` job serve, so the define
  actually applies to the build the suite runs against (verified by reading
  build-web-bundle.ts + env.ts).
- `device-key-store.ts` loses all three `if (env.isE2E) { await import('./…e2e.js') }`
  branches and the now-unused `env` import; it is pure IndexedDB production code again. The
  e2e variant is reached only by resolver substitution — never by a source reference.

Rejected alternative: a `resolve.alias` entry keyed on `VITE_E2E`. An alias would also
work, but a `resolveId` plugin lets the swap be a tested pure function and scopes it to the
exact `device-key-store` specifier without risk of catching `not-the-device-key-store`; the
regex + unit tests pin that boundary.

## Enforcement rung (AC4)

Rewrote the `e2e-store-isolation` arch rule (`packages/config/arch/rules/`): previously it
allowed the gated dynamic `import()` of the e2e store. Now it forbids **every** source-level
reference to any `*.e2e` module from production web code — static import, static
`export … from` / `export *`, and dynamic `import('…')` with a string-literal specifier.
Scope unchanged: `apps/web/src/`, excluding `*.e2e.*` module files and `*.test`/`*.spec`
files. Non-literal dynamic-import args are skipped (cannot target a co-located e2e module
without also tripping bundler resolution). Rung 3 (ts-morph structural rule via
`pnpm arch:check`) — the highest achievable for a source-graph invariant. This is what makes
the RC1 bug class dead: any future runtime `import('*.e2e*')` on any path fails the gate.

## Files changed

- `apps/web/src/lib/device-key-store-e2e-resolution.ts` (new) — pure build-time resolver.
- `apps/web/src/lib/device-key-store-e2e-resolution.test.ts` (new) — unit tests for it.
- `apps/web/vite.config.ts` — install the resolver plugin under `VITE_E2E==='true'`.
- `apps/web/src/lib/device-key-store.ts` — remove the 3 `env.isE2E` dynamic-import branches
  and the `env` import; update the module doc-comment to record the build-time swap.
- `apps/web/src/lib/device-key-store.test.ts` — drop the `env` mock and the `under env.isE2E`
  delegation describe (that behavior now lives entirely in the e2e module + its own test);
  keep + rename the IndexedDB never-writes-localStorage pin.
- `apps/web/src/lib/device-key-store.e2e.ts` — doc-comment now records it is reached via
  build-time resolution, not a runtime import gate. No behavior change.
- `packages/config/arch/rules/e2e-store-isolation.rule.ts` — forbid dynamic + static `*.e2e`
  references from production web code.
- `packages/config/arch/rules/e2e-store-isolation.rule.test.ts` — replace the
  "passes the gated dynamic import" case with cases pinning that dynamic `import()` of
  `*.e2e` is now flagged, plus non-literal/non-e2e negative cases and generalization beyond
  `device-key-store` to any `*.e2e` module.

## Tests added / changed (TDD)

- `e2e-store-isolation.rule.test.ts`: added `flags a runtime dynamic import() of the e2e
  store`, `flags a dynamic import() of any other *.e2e module`, `exempts test files that
  dynamically import`, `does not flag a dynamic import() of a non-e2e module`, `…non-literal
  argument`, `flags a static import of another *.e2e module`, `does not scan any *.e2e
  module file itself`. Covers AC4 (dynamic-import forbidden) + generalization.
- `device-key-store-e2e-resolution.test.ts`: 7 cases pinning remap of relative + `@/`
  specifiers, no-remap of unrelated/already-e2e/e2e-self-origin/lookalike specifiers, and
  remap when importer is undefined (entry resolution). Covers AC1 (build-time selection).
- `device-key-store.test.ts`: the IndexedDB path is now the sole path; the localStorage
  fallback delegation cases were removed because the production module no longer delegates
  (the e2e variant owns that, tested by `device-key-store.e2e.test.ts`).

TDD evidence:
- Arch rule: added the dynamic-import cases first, ran the suite → 3 failed (the old rule
  did not flag dynamic imports / other `*.e2e`), then rewrote the rule → 18/18 pass. After
  the rewrite, `pnpm arch:check` reported 3 violations at device-key-store.ts:75,100,131
  (the live dynamic imports) — the RED at repo scale — then went to
  `OK — 11 rule(s) over 1814 file(s)` once the branches were removed.
- Resolver: wrote `device-key-store-e2e-resolution.test.ts` first → RED "no tests / module
  missing", implemented the helper → 7/7 GREEN.

## Self-gate results

- `pnpm arch:check` — **pass** — `OK — 11 rule(s) over 1814 file(s)`.
- `npx eslint <owned web files>` (from apps/web) — **pass** — exit 0 (vite.config.ts is
  lint-ignored by config; a lint error in my resolver, prefer-optional-chain, was fixed).
- `npx eslint arch/rules/e2e-store-isolation.rule.{ts,test.ts}` (from packages/config) —
  **pass** — exit 0.
- `turbo typecheck --filter=@hushbox/web` — **pass**.
- `turbo lint --filter=@hushbox/web` — **fail, cause OUTSIDE ownership**: the only 2 errors
  are prettier/prettier in `apps/web/src/components/billing/payment-form.test.tsx:509,1710`
  (Task-05's file, already modified in the pre-run working tree). My owned files lint clean.
- `turbo test --filter=@hushbox/web` (full suite + 95% coverage gate) — **1 failed / 5839
  passed**. The single failure is `src/components/billing/payment-form.test.tsx:1545`
  (Task-05's file). All device-key-store + resolver + arch tests pass. (An earlier run of
  the same suite died on a coverage `.tmp/coverage-*.json` ENOENT — the known coverage-timing
  infra flake, not a test failure; the re-run reproduced only the billing failure.)
- Focused: `device-key-store.test.ts` + `device-key-store.e2e.test.ts` +
  `device-key-store-e2e-resolution.test.ts` + `auth-client.test.ts` (device-key consumer) —
  64/64 pass under `with-env`.
- `npx jscpd <changed paths>` — **pass** — 0 clones.
- **Prod-bundle exclusion** — a production `vite build --mode production` (VITE_E2E unset)
  then grep over `dist/`: `find … -name '*device-key-store*e2e*'` → 0 files;
  `grep -rl hushbox_e2e_device_key dist` → 0; `grep -rl hushbox_auth_kek dist/assets` → 1
  (the production IndexedDB store IS bundled). Confirms zero `.e2e` code ships to production.

## Acceptance criteria

1. Variant selected at build time (Vite resolver plugin gated on baked `VITE_E2E`); prod
   build contains zero `.e2e` code (no source reference; resolver absent unless
   `VITE_E2E==='true'`); `pnpm arch:check` green — **met**.
2. No runtime dynamic `import()` on the auth-bootstrap path for device-key code — **met**
   (all three branches removed; arch rule now forbids reintroduction).
3. TDD at closest layer, failing test first — **met** (arch rule RED then GREEN; resolver
   RED then GREEN; arch:check surfaced the live violations before removal).
4. Enforcement rung forbidding dynamic `import()` of `*.e2e` on the sync auth path — **met**
   (arch rule generalized to all `*.e2e`, static + dynamic, Rung 3).
5. Proof — **met structurally; e2e deferred to orchestrator consolidated run** (see below).

## Proof (RC1 fix)

Per-task e2e is deprecated in this run; the orchestrator verifies RC1 on the central
consolidated pass, checking for absence of the exact failure signatures
(`TypeError: Importing a module script failed`, CatchBoundary blank guest page). The fix is
proven structurally at the layers that own the invariant:

- **The RC1 mechanism is removed at the source.** `pnpm arch:check`, after the rule rewrite,
  surfaced the three live runtime dynamic imports as violations
  (`device-key-store.ts:75,100,131`) — that is the failing-at-repo-scale RED — and once the
  branches were removed reported `OK — 11 rule(s) over 1814 file(s)`. No `env.isE2E`-gated
  `import('./device-key-store.e2e.js')` remains on the auth-bootstrap path, so the
  cancellable chunk fetch that RC1 traced (15 aborted `GET .../device-key-store.e2e-*.js`)
  cannot occur.
- **The class is enforced, not just fixed.** The rewritten `e2e-store-isolation` arch rule
  forbids any source-level reference to a `*.e2e` module from production web code — static
  import/re-export AND dynamic `import()` with a literal specifier. Rung 3; 18/18 rule tests
  pass, including the new "flags a runtime dynamic import() of the e2e store" case. Any
  reintroduction of the RC1 pattern fails the gate.
- **The build-time swap is in place and unit-proven.** `resolveDeviceKeyStoreE2eVariant`
  (7/7 tests) is the pure resolver; the Vite `resolveId` plugin installs it only under baked
  `VITE_E2E==='true'` (the mode `build-web-bundle.ts --target=e2e` produces). The e2e build
  statically inlines the `.e2e` variant into the entry chunk; the production build never
  references it.
- **Prod bundle excludes `.e2e`.** Verified empirically — a production `vite build`
  (`VITE_E2E` unset) emits **zero** files matching `device-key-store.e2e` and the built JS
  contains no `hushbox_e2e_device_key` localStorage marker (grep over `dist/`); the e2e build
  behaviour is covered by the resolver unit tests + the plugin gate. (Command + counts in the
  self-gate log below.)
- **e2e line:** `pnpm e2e e2e/sharing/link-guest-chat.spec.ts e2e/sharing/link-guest-access.spec.ts`
  — **deferred to the orchestrator consolidated run** (per-task e2e deprecated this run).

## Deviations

- `device-key-store.test.ts` lost the `under env.isE2E` delegation describe block. This is
  not a coverage regression: those cases asserted the production module's runtime delegation
  to the localStorage fallback, a code path that no longer exists. The fallback behavior is
  fully covered by `device-key-store.e2e.test.ts`.

## Concerns / limitations

- The `VITE_E2E==='true'` guard in vite.config reads `loadEnv` output; the E2E build sets it
  via generated `.env.development` (build-web-bundle.ts `--target=e2e`). If a future build
  path baked `VITE_E2E` a different way, the guard would need to match — but env.ts already
  reads `import.meta.env['VITE_E2E']` identically, so the two are consistent.
- vite.config.ts is not lint-covered (config file, ESLint-ignored) — the plugin wiring is
  exercised only by the e2e build/run, not a unit test. The pure resolver it delegates to is
  unit-tested; the wiring is a 3-line pass-through.

## Confidence

High for the app + arch changes (self-gates green, RC1 mechanism directly removed). Proof-run
result determines final status.
