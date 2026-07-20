# Task-01 impl report — E2E device-key store (localStorage variant)

## Objective

Implement the export-key store's E2E variant backed by localStorage, with signatures
identical to `device-key-store.ts` (GC3), reusing the `ProtectedExportKey` type from that
module so the shape can never drift. Storage must be a single namespaced localStorage entry
that Playwright `storageState` can capture (GC5). No IndexedDB, no `crypto.subtle`.

## Files changed

- `apps/web/src/lib/device-key-store.e2e.ts` — new module. Three exports with signatures
  identical to `device-key-store.ts`; imports `ProtectedExportKey` as a type-only import
  (`import type { ProtectedExportKey } from './device-key-store.js'`), does not redeclare it.
- `apps/web/src/lib/device-key-store.e2e.test.ts` — new colocated test with a stateful
  Map-backed localStorage fake (the global mock is a no-op).

## localStorage key + stored JSON shape

- Key constant: `hushbox_e2e_device_key`.
- Value: `JSON.stringify({ userId: string, exportKey: string })` where `exportKey` is the
  key bytes base64-encoded via `toBase64` from `@hushbox/shared` (URL-safe, unpadded).
- `store` overwrites (`setItem`); `load` decodes → `{ exportKey: Uint8Array, userId }` or
  `null` when absent OR when the value is unparseable/missing required fields; `clear`
  `removeItem`s the entry.
- Both `load`-null-on-corruption paths are covered: `JSON.parse` throw (try/catch) and a
  parsed object missing `userId`/`exportKey` (explicit shape guard).

## Tests added (each — behavior — criterion)

1. round-trips the export key and userId — round-trip identical bytes+userId — AC 2/4.
2. persists a non-null base64 string under the namespaced key — storageState-capturable
   property (raw `getItem` non-null string containing the base64) — AC 4 explicit assertion.
3. overwrites the previous entry on a second store — `store` overwrite semantics — AC 2.
4. returns null when nothing is stored — absent → null — AC 2/4.
5. clears the stored entry so subsequent load returns null — `clear` removes it — AC 2/4.
6. returns null when the stored value is not valid JSON — tolerant null-on-corruption
   (parse throw path) — AC 2.
7. returns null when the stored JSON is missing required fields — tolerant null-on-corruption
   (shape-guard path) — AC 2.

## TDD / RED observed

Before implementing `device-key-store.e2e.ts`, ran the test file: it failed at module
resolution ("Failed to resolve import ./device-key-store.e2e.js") — 1 file failed, no tests
ran. Confirmed RED for the right reason (module missing, not a typo). After adding the
module, all 7 tests pass GREEN.

## Self-gate

- `vitest run src/lib/device-key-store.e2e.test.ts` (env-wrapped) — pass — Test Files 1
  passed, Tests 7 passed.
- Coverage scoped to the module (`--coverage.include='src/lib/device-key-store.e2e.ts'`) —
  Statements 100% (16/16), Branches 100% (8/8), Functions 100% (3/3). Above the 95% floor.
- `npx eslint src/lib/device-key-store.e2e.ts src/lib/device-key-store.e2e.test.ts` (from
  apps/web, after last edit) — exit 0.
- `turbo typecheck --filter=@hushbox/web` — pass (1 successful).

## Acceptance criteria (plan §Task-01)

1. Own isolated module exporting the three functions, identical signatures, `ProtectedExportKey`
   imported not redeclared — met (type-only import; three exports match `device-key-store.ts`).
2. Single namespaced localStorage entry `{ userId, exportKey }`; store overwrites; load decodes
   or returns null when absent/unparseable; clear removes — met (tests 1–7).
3. Uses `toBase64`/`fromBase64` from `@hushbox/shared`; never raw byte arrays — met.
4. Stateful localStorage fake in beforeEach; round-trip, null, clear, corrupt, and explicit
   post-store `getItem` assertion — met.
5. No IndexedDB, no `crypto.subtle` — met (neither referenced).
6. Module safe to dynamic-import: no top-level side effects beyond declarations — met
   (only a const and an interface at module scope).

## Deviations

None. Note: functions return `Promise.resolve(...)` rather than being `async` (there is no
`await` needed) — this keeps the `Promise`-returning signatures identical while avoiding a
no-await async body. Behavior and types are unchanged.

## Concerns / limitations

- Coverage was measured with `--coverage.include` scoped to the module because a single-file
  run otherwise reports the whole repo's untested files; the scoped summary is the relevant
  per-file figure.
- Cross-task: Task-02 will dispatch to this module via a gated dynamic import; Task-03's arch
  rule keys on the module name `device-key-store.e2e` — the name is now fixed.

## Confidence

High — signatures verified against `device-key-store.ts`, 100% per-file coverage, all
self-gates green.
