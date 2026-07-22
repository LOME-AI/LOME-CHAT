# Task 01 — Rewrite storage seam (impl report 1)

## Objective

Replace the per-entry file cache (`scripts/.cache/seed-crypto/<key>.json`) with a single
whole-file map cache (`scripts/.cache/seed-crypto.json`): new `readCache`/`writeCache` +
`SCHEMA_VERSION` on the cache module, wholesale invalidation on `(cacheVersion,
cryptoFingerprint)` mismatch in the pool, merge/accumulate on match, no write on pure-hit.
`cacheKey`/`computeCryptoFingerprint`/`encode`/`decode`/`CACHE_VERSION` behavior untouched.

## Files changed

- `scripts/lib/seed-crypto-cache.ts` — added `export const SCHEMA_VERSION = 1` (numeric,
  distinct from string `CACHE_VERSION`); removed `cacheFilePath`, `readCacheEntry`,
  `writeCacheEntry`; added `readCache(cacheFile)` and `writeCache(cacheFile, data)` plus the
  exported `CacheContents` interface. Added internal helpers `emptyCache`, `isPlainObject`,
  `parseContainer` (container-shape validation, extracted to keep `readCache` under the
  complexity cap). `cacheKey`, `computeCryptoFingerprint`, `encode/decodePersonaCrypto`,
  `isCachedPersonaCrypto` (still internal), and all types are byte-for-byte unchanged.
- `scripts/lib/seed-crypto-cache.test.ts` — kept the `cacheKey` / `computeCryptoFingerprint`
  / `encode`/`decode` suites intact; replaced the `cacheFilePath` + `readCacheEntry/writeCacheEntry`
  suites with `SCHEMA_VERSION`, `writeCache/readCache` round-trip, determinism, corruption
  tolerance, and per-entry validation suites.
- `scripts/lib/seed-crypto-pool.ts` — `PoolOptions.cacheDir` → `cacheFile`; import
  `readCache`/`writeCache`/`CacheContents` instead of the per-entry fns. `ensurePersonaCrypto`
  now: `readCache` once → `selectEffectiveEntries` (wholesale invalidation) → `splitByCache`
  against the in-memory map → run chunks for misses → `addResult` folds each result into the
  effective map → single `writeCache` at the end. Extracted `selectEffectiveEntries`,
  `splitByCache`, `addResult` helpers (the old `splitByCache`/`persistResult` per-key helpers
  no longer applied) to keep `ensurePersonaCrypto` under the ESLint complexity/cognitive caps.
  `chunkRequests`, `defaultRunChunk`, `getSharedOpaqueServer`, `generateOne`, and the
  `/* v8 ignore */` pragmas are unchanged.
- `scripts/seed.ts` — exactly 2 lines: `CACHE_DIR` → `CACHE_FILE` (…/`seed-crypto.json`),
  and the call-site option `cacheDir: CACHE_DIR` → `cacheFile: CACHE_FILE`. Confirmed by
  `git diff --stat`: `2 insertions(+), 2 deletions(-)`.
- `scripts/lib/seed-crypto-pool.test.ts` — rewritten to the whole-file API (seeds fixtures
  via `writeCache`, asserts via `readCache`).

## New public surface of the cache module

Unchanged/kept: `CACHE_VERSION` (string `'1'`), `CacheKeyInput`, `CryptoBytes`,
`CachedPersonaCrypto`, `cacheKey`, `computeCryptoFingerprint`, `encodePersonaCrypto`,
`decodePersonaCrypto`.

Added:
- `export const SCHEMA_VERSION = 1` — numeric on-disk container-shape version.
- `export interface CacheContents { cacheVersion: string | null; cryptoFingerprint: string | null; entries: Map<string, CachedPersonaCrypto> }`
- `export async function readCache(cacheFile: string): Promise<CacheContents>` — never throws.
- `export async function writeCache(cacheFile, { cacheVersion, cryptoFingerprint, entries }): Promise<void>` — mkdir -p, sorted keys, pretty-print + trailing newline, temp+rename atomic write.

Removed: `cacheFilePath`, `readCacheEntry`, `writeCacheEntry`. `isCachedPersonaCrypto` stays
internal (the pool needs no entry validator — `readCache` validates on load).

## Acceptance criteria → evidence (test names)

Cache module (`seed-crypto-cache.test.ts`):
- `SCHEMA_VERSION` numeric, distinct from `CACHE_VERSION` → `SCHEMA_VERSION > is the numeric container-shape version (distinct from CACHE_VERSION)`.
- Round-trip metadata + entries → `writeCache / readCache round-trip > round-trips metadata and entries through disk`.
- mkdir -p parent → `... > creates the parent directory if it does not exist`.
- Atomicity (no `.tmp`) → `... > leaves no .tmp file behind (atomic rename)`.
- Deterministic byte-identical regardless of insertion order + keys sorted ascending →
  `writeCache determinism > emits entry keys sorted ascending regardless of insertion order`;
  schemaVersion + pretty-print + trailing newline → `... > serializes container with schemaVersion, pretty-print, and trailing newline`.
- Corruption tolerance (missing file / bad JSON / literal null / non-object / missing+mismatched
  schemaVersion / missing+non-object entries / non-string metadata → empty map + null metadata)
  → the eight `readCache corruption tolerance > ...` cases.
- Per-entry drop on shape mismatch / key≠mapKey while keeping valid siblings →
  `readCache per-entry validation > drops an entry whose shape is invalid while keeping a valid sibling`
  and `... > drops an entry whose internal key disagrees with its map key`.
- `cacheKey` / `computeCryptoFingerprint` / `encode`/`decode` unchanged → their original suites still pass.

Pool (`seed-crypto-pool.test.ts`):
- Matching metadata → hits from file, only misses run `runChunk` → `reads from cache when entry exists`, `handles mixed hits and misses`, `does not call runChunk when every request is satisfied from cache`.
- Persist to whole-file cache → `dispatches misses to runChunk and persists results to the whole-file cache` (asserts `readCache` metadata + both entries).
- Wholesale invalidation on fingerprint mismatch (all miss + rewritten metadata current, stale key gone) → `wholesale-invalidates when the stored cryptoFingerprint differs ...`; and on cacheVersion mismatch → `wholesale-invalidates when the stored cacheVersion differs`.
- Two sequential calls accumulate, no clobber → `accumulates across two sequential calls with matching metadata (no clobber)` (second call recomputes only cred-b; file ends with both).
- Merge preserves non-requested valid entries → `merges: rewritten file preserves pre-existing valid entries not part of this call`.
- No write on pure-hit (file bytes unchanged) → `performs no write on a pure-hit run (file bytes unchanged)`.
- `chunkRequests` / worker fan-out / error propagation / empty input unchanged → their original suites still pass.
- `seed.ts` compiles + `seed-run.test.ts` passes → typecheck green; `seed-run.test.ts` needed no edit and passes in-suite.

## TDD verification

- Cache: wrote the new `SCHEMA_VERSION`/`readCache`/`writeCache` suites first, ran
  `vitest run lib/seed-crypto-cache.test.ts` → RED: 17 new tests failed with
  `TypeError: readCache is not a function`, the 19 unchanged tests passed. Implemented the
  module → GREEN 36/36.
- Pool: rewrote the pool test to the whole-file API first, ran it against the old pool → RED:
  12 failed with `TypeError: readCacheEntry is not a function` (5 pure-`chunkRequests` tests
  passed). Rewrote `ensurePersonaCrypto` → GREEN 17/17.
- Refactors after green (helper extraction for complexity, `localeCompare` for the sort
  branch) kept tests green: cache+pool re-run 53/53.

## Self-gate (commands run)

- `cd scripts && npx vitest run lib/seed-crypto-cache.test.ts` → RED then GREEN (36 pass).
- `cd scripts && npx vitest run lib/seed-crypto-pool.test.ts` → RED then GREEN (17 pass).
- `cd scripts && pnpm test` (full suite, vitest run --coverage) → **1 failed | 1693 passed**.
  The single failure is `seed.test.ts > e2e re-exports > exposes the base and cross-product
  persona rosters` (`expected length 11 but got 44`). This is **outside my ownership and
  pre-existing**: `scripts/seed.test.ts` and `scripts/lib/seed-personas.ts` show no git
  modification (only `seed.ts` is `M`), and the same failure was present in an earlier full
  run taken *before* I edited `seed.ts`. It is a committed test-vs-roster-data mismatch
  unrelated to the cache seam. **Zero coverage-threshold ERRORs** in the full run → every
  file including mine meets the 95% per-file gate.
- `npx turbo typecheck --filter=@hushbox/scripts --force` → pass.
- `npx eslint <5 owned files>` (from `scripts/`, after the LAST edit) → exit 0.
- `npx jscpd --threshold 2 scripts/lib/seed-crypto-cache.ts scripts/lib/seed-crypto-pool.ts`
  → Found 0 clones (0%).

## Coverage (touched files)

Full-suite run emitted no coverage ERROR for any file, so `seed-crypto-cache.ts`,
`seed-crypto-pool.ts`, and `seed.ts` all meet the 95% line/branch/function/statement per-file
gate. (A subset run of only the two lib tests initially showed `seed-crypto-cache.ts` branches
at 93.47% because the `return 0` arm of a key comparator was unreachable — Map keys are
unique; I removed that helper in favor of `String.localeCompare`, matching the existing
`computeCryptoFingerprint` sort, which eliminated the dead branch.)

## seed-run.test.ts

No edit needed — as predicted. It whole-module-mocks `./lib/seed-crypto-pool.js` (uses only
`ensurePersonaCrypto`) and spreads the real `./lib/seed-crypto-cache.js` while overriding only
`computeCryptoFingerprint`. Neither removed symbol is referenced. It passes in the full suite.

## Deviations

- `ensurePersonaCrypto` was restructured into `selectEffectiveEntries` / `splitByCache` /
  `addResult` helpers rather than a single inlined body. Required to satisfy the package's
  ESLint `complexity` (≤10) and `sonarjs/cognitive-complexity` (≤10) caps once the per-key
  read/write helpers were removed. Behavior is exactly the contract; the old per-entry
  `persistResult` helper is gone because per-entry writes no longer exist.

## Concerns and limitations

- The pre-existing `seed.test.ts` roster failure will keep the scoped `pnpm test` red at the
  process level until whoever owns the roster/personas reconciles the committed test (expects
  11) with the committed data (44). It is independent of this task; flagged for the
  orchestrator, not fixed here (outside ownership; another workstream's concern).
- Real end-to-end population of `scripts/.cache/seed-crypto.json` is Task 02 (needs the local
  stack); this task is code + unit coverage only.

## Confidence

High — every acceptance criterion has a dedicated test proven RED-first; all owned checks
(typecheck, lint, jscpd, per-file coverage) pass; the only red is a pre-existing, out-of-scope
test in a file I did not touch.
