# Task-02 — Dispatch device-key-store on `env.isE2E`

## Objective

Route `device-key-store.ts`'s three exported functions to the Task-01 E2E fallback module
(`device-key-store.e2e.ts`) when `env.isE2E` is true, via a gated **dynamic** `import()`;
keep the production IndexedDB path byte-for-byte unchanged for the non-E2E path.

## Files changed

- `apps/web/src/lib/device-key-store.ts` — added `import { env } from '@/lib/env';` and, at
  the top of each of the three exported functions, an `env.isE2E` gate that dynamically
  imports the e2e module and delegates. No other line touched (IndexedDB internals,
  constants, `ProtectedExportKey` type all unchanged — GC2).
- `apps/web/src/lib/device-key-store.test.ts` — added a hoisted mutable `envMock` +
  `vi.mock('@/lib/env', …)`; added a stateful `localStorage` fake helper (global test-setup
  mock is a no-op); converted the fake IndexedDB `open` into a tracked `vi.fn` (`openSpy`)
  so tests can assert it is/ isn't called; set `envMock.isE2E = false` in the outer
  `beforeEach`; added one non-E2E assertion + a nested `under env.isE2E` block of four
  delegation tests.

## Gate code added (each of the three functions)

```ts
if (env.isE2E) {
  const e2e = await import('./device-key-store.e2e.js');
  return e2e.storeExportKeyProtected(exportKey, userId); // loadExportKeyProtected() / clearDeviceKeyStore() in the others
}
```

`await import('./device-key-store.e2e.js')` is an `ImportExpression` (dynamic), never a
static top-of-file `ImportDeclaration` — satisfies GC4 and does not trip Task-03's rule.

## Env-mock test setup

```ts
const { envMock } = vi.hoisted(() => ({ envMock: { isE2E: false } }));
vi.mock('@/lib/env', () => ({ env: envMock }));
```

`envMock.isE2E` is reset to `false` in the outer `beforeEach` and flipped to `true` in the
nested block's `beforeEach`. The mock exposes only `env.isE2E` (the sole field
`device-key-store.ts` reads). A stateful `localStorage` fake is installed via `vi.stubGlobal`
in the E2E tests (and in the non-E2E no-write test) because the global test-setup mock's
`getItem` always returns `null` and cannot round-trip.

## Tests added

- `takes the IndexedDB path and never writes localStorage when not in E2E` — isE2E=false →
  `openSpy` called, namespaced localStorage key absent. (criterion: both-directions, prod side)
- `under env.isE2E > delegates store … without opening IndexedDB` — isE2E=true → `openSpy`
  not called, key present in localStorage.
- `under env.isE2E > round-trips the export key through localStorage` — identical bytes +
  userId returned via the fallback; IndexedDB never opened.
- `under env.isE2E > returns null from the fallback when nothing is stored`.
- `under env.isE2E > clears the fallback entry without opening IndexedDB`.

All seven pre-existing IndexedDB tests remain and pass under the default `isE2E=false`.

## RED observed

Before adding the gate, with the four E2E-path tests present, the run reported
`4 failed | 8 passed (12)`; failures were "expected vi.fn() to not be called at all, but
actually been called" — i.e. the code still opened IndexedDB because no gate existed. Correct
reason. After adding the gate: `12 passed`.

## Self-gate

- `vitest run src/lib/device-key-store.test.ts` — pass (12/12).
- Per-file coverage: `--coverage` perFile run emits **no** ERROR line for
  `src/lib/device-key-store.ts` → meets 95% lines/branches/functions/statements.
- `eslint src/lib/device-key-store.ts src/lib/device-key-store.test.ts` — exit 0 (run after
  the last edit).
- `turbo typecheck --filter=@hushbox/web` — pass.
- `pnpm arch:check` — OK, 11 rules over 1811 files.

## Deviations

1. **Gate uses a two-line `const e2e = await import(...)` then `return e2e.fn(...)` instead of
   the plan's one-liner `return (await import(...)).fn(...)`.** The one-liner tripped
   `unicorn/no-await-expression-member` ("Do not access a member directly from an await
   expression"). The two-line form is semantically identical, still a dynamic `import()`
   expression (GC4 / Task-03 unaffected), and lint-clean. This is the only way to satisfy both
   the dynamic-import requirement and the lint gate.

## Concerns and limitations

- Running **only** this test file with `--coverage` reports `device-key-store.e2e.ts`
  (Task-01's file, not mine) at 87.5% because my tests don't exercise its JSON-parse
  corruption branch. That branch is covered by Task-01's own e2e test; in the full `pnpm
  test:web` run coverage merges and the file is fully covered. My owned file
  (`device-key-store.ts`) meets the gate.
- `arch:check` currently shows 11 rules — Task-03's isolation rule has not landed yet. The
  dynamic import is written to pass it by construction regardless.

## Confidence

high — all five self-gates pass; production path is untouched except the three gate blocks;
both directions unit-proven.
