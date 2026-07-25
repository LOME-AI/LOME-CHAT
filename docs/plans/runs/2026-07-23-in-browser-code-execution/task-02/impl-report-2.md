# Task T2 — Bridge contract + web renderer — impl report 2 (FIX pass)

## Objective

Fix two validated findings on T2:
1. The public renderer bundle (`apps/sandbox/public/render.js`) embedded the backend
   env-config registry because `bootstrap.ts` imported the bridge from the top-level
   `@hushbox/shared` barrel, which `export *`s the env registry and esbuild cannot
   tree-shake. Add a narrow `@hushbox/shared/documents` subpath export, import from it,
   regenerate the bundle, and pin the fix with a bundle-content assertion test.
2. A test name in `specifier.test.ts` used the word "artifact" — rename to "specifier".

## Files changed

- `packages/shared/package.json` — added the `"./documents": "./src/documents/index.ts"`
  subpath export. The barrel `.` still re-exports documents, so existing consumers are
  unaffected; the renderer now imports the narrow path.
- `apps/sandbox/src/render/bootstrap.ts` — bridge import changed from `@hushbox/shared` to
  `@hushbox/shared/documents`; added a durable comment stating why (barrel would inline the
  backend env-config registry into this credential-free public bundle).
- `apps/sandbox/public/render.js` — regenerated via `build:render`. 606026 → 539025 bytes
  (~67 KB smaller); the env registry is gone.
- `apps/sandbox/src/render/build-bundle.test.ts` — added a bundle-content assertion:
  the built bundle must contain none of `DATABASE_URL`, `OPAQUE_MASTER_SECRET`,
  `CF_ACCESS`, `ADMIN_SQL_PANEL_DATABASE_URL`, `VAPID_PRIVATE_KEY`, `IRON_SESSION_SECRET`,
  or the registry marker `to:["backend"]`.
- `apps/sandbox/src/render/specifier.test.ts` — renamed the test
  `pin where the artifact names one` → `pin where the specifier names one`.

## Tests added

- `build-bundle.test.ts` › `embeds no backend env-config registry names, values, or
  markers` — builds the renderer bundle and asserts none of the seven forbidden backend
  env markers appear. Covers finding 1.

## RED verification

- Reverted the import to the barrel, rebuilt the bundle, ran the new assertion:
  **FAILED** — `expected [ 'DATABASE_URL', …(6) ] to deeply equal []` (all seven markers
  present). Restored the narrow import + rebuilt: **GREEN**. The test provably catches the
  pre-fix bundle.

## Self-gate

- `pnpm test:shared` — pass (100% shared coverage).
- `pnpm --filter @hushbox/sandbox test` — pass (10 files, 89 tests; 100% stmts/branch/funcs/lines).
- `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/sandbox` — pass (4/4 tasks).
- `eslint` on owned files (from each package dir, after last edit) — exit 0.
- `jscpd apps/sandbox/src/render packages/shared/src/documents` — 0 clones.

## Findings addressed

- **Finding 1 (env registry leak) — fixed.** Narrow subpath export added; renderer imports
  it; regenerated bundle is 67 KB smaller and contains zero backend env names/values and no
  `to:["backend"]` marker (grep-confirmed: all seven markers count 0). Assertion test pins
  it, RED-verified. Barrel still re-exports documents, so other consumers unaffected
  (shared suite green).
- **Finding 2 (durable naming) — fixed.** No "artifact" in the renamed test; grep of owned
  render/ files confirms no remaining "artifact" in shipped code/tests.

## Deviations

None.

## Concerns and limitations

- Bundle is still 539 KB minified (Sucrase + zod inlined) — one-time cached, unchanged
  concern from report 1, not blocking.

## Confidence

High. The leak is provably closed (before/after grep + RED-verified assertion), the fix is
narrow (one import path + one package.json export line), and all scoped gates are green.
