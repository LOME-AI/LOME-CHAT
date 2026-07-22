# Collapse the seed-crypto per-entry file cache into one file

**Tier:** 1 (single concern — storage seam; 2 tasks, sequential dependency).

## Problem

`scripts/.cache/seed-crypto/` holds one committed JSON file per OPAQUE crypto fixture
(558 on disk / 408 tracked / 2.2 MB). Keys embed the `cryptoFingerprint`, so every crypto
edit or `CACHE_VERSION` bump re-keys every entry and orphans the old files — nothing prunes
them (394 distinct personas but 558 files). Result: hundreds of churned tiny files in
`git status` and PR diffs.

Collapse into a single committed file `scripts/.cache/seed-crypto.json` while preserving
every feature of the cache and adding wholesale invalidation (the clobber-safe form of
pruning) on a fingerprint/version change.

## Founder rulings (already given)

- One-time git churn OK; fingerprint-bump wholesale rewrite OK.
- Concurrent-seed last-write-wins is acceptable (note it in code).
- Pruning via wholesale invalidation approved.
- Update the tests.

## New file shape (`scripts/.cache/seed-crypto.json`)

```json
{
  "schemaVersion": 1,
  "cacheVersion": "1",
  "cryptoFingerprint": "<64-hex sha256 over packages/crypto/src>",
  "entries": {
    "<cacheKey>": {
      "key": "<cacheKey>",
      "credentialIdentifier": "…",
      "opaqueRegistration": "…base64…",
      "publicKey": "…base64…",
      "passwordWrappedPrivateKey": "…base64…",
      "recoveryWrappedPrivateKey": "…base64…"
    }
  }
}
```

- `entries` is keyed by `cacheKey`. Each value is an unchanged `CachedPersonaCrypto`
  (retains its own `key` field — redundant with the map key on purpose, so load can
  re-validate `entry.key === mapKey`).
- Keys emitted **sorted ascending**; 2-space pretty-print; trailing newline — reviewable,
  byte-stable diffs.
- `schemaVersion` is a new module constant for the on-disk container shape (distinct from
  `CACHE_VERSION`, which is the crypto-invalidation escape hatch and is NOT changed).

## Behavior contract (must be preserved / added)

1. **Content-addressed lookup** — `cacheKey(...)` unchanged; lookup is an in-memory map hit.
2. **Self-invalidation** — key still embeds `cryptoFingerprint`; `CACHE_VERSION` escape hatch
   unchanged.
3. **Wholesale invalidation (new pruning)** — on load, if the file's stored
   `(cacheVersion, cryptoFingerprint)` ≠ the current run's, the effective starting map is
   **empty** (all stale entries dropped). If they match, the loaded map is used as-is, so the
   two `warmPersonaCrypto` calls in one run (test then dev) **accumulate, never clobber**.
4. **Committed for CI/dev hits** — one committed file instead of a dir.
5. **Atomic write** — whole-file temp+`rename`; temp name carries `pid` + timestamp. Pinned
   by a test asserting no `.tmp` remains.
6. **Reviewable diffs** — sorted keys + pretty-print + trailing newline.
7. **Corruption/shape tolerance** — missing file, bad JSON, wrong top-level shape → empty
   effective map (full miss). Per-entry: drop any entry failing `isCachedPersonaCrypto` or
   `entry.key !== mapKey`.
8. **No write on a pure-hit run** — if `misses.length === 0`, return without rewriting the
   file (unchanged early return).
9. **Merge semantics** — the rewritten file = the post-invalidation loaded map (which may
   contain the *other* call's still-valid entries) plus this call's new entries. Never write
   only this call's request keys.
10. **Concurrent-seed** — two seed processes racing the same file are last-write-wins (a lost
    entry just recomputes next run). Documented in a code comment; not defended against.

## Unchanged public API (do NOT touch)

`cacheKey`, `computeCryptoFingerprint`, `encodePersonaCrypto`, `decodePersonaCrypto`,
`CACHE_VERSION`, `CachedPersonaCrypto` / `CryptoBytes` / `CacheKeyInput` shapes,
`ensurePersonaCrypto`'s persona-request semantics, and `seed.ts`'s `warmPersonaCrypto`
logic / two-call structure.

## Global Constraints

- TypeScript strict; explicit return types; no `any` without justification (CODE-RULES).
- Fail-fast: bad input rejected at the boundary; no silent fallback values beyond the
  documented corruption→empty-map tolerance.
- 95% line/branch/function coverage for `@hushbox/scripts` is part of `pnpm test` — keep it.
- No `console.log`, no `eslint-disable`/`@ts-ignore` without justification.
- Match existing file style (the current `seed-crypto-cache.ts` idiom).

## Related E2E

None. This is dev/CI seed-cache plumbing with no user-facing flow. The seed path is
exercised by the existing E2E run (auth.setup seeds personas); correctness here is covered by
`@hushbox/scripts` unit tests + a real seed run. No new E2E per CODE-RULES "When to Write an
E2E Test" (no UI flow, no critical-path change).

---

## Task 01 — Rewrite the storage seam (code + unit tests)

**Objective:** Replace the per-file cache read/write with whole-file map read/write plus
wholesale invalidation, updating the pool to use the in-memory map. Behavior contract above.

**File ownership (may edit only these):**
- `scripts/lib/seed-crypto-cache.ts`
- `scripts/lib/seed-crypto-cache.test.ts`
- `scripts/lib/seed-crypto-pool.ts`
- `scripts/lib/seed-crypto-pool.test.ts`
- `scripts/seed.ts` — **2 lines only**: rename the `CACHE_DIR` constant (line ~84) to a
  `CACHE_FILE` pointing at `scripts/.cache/seed-crypto.json`, and the `cacheDir:` option key
  at the `ensurePersonaCrypto` call (line ~286) to the new option name. No other change to
  `seed.ts` — `warmPersonaCrypto` logic, the two-call structure, imports of `CACHE_VERSION` /
  `computeCryptoFingerprint` / `ensurePersonaCrypto` all stay.
- `scripts/seed-run.test.ts` — **only if** its module mock breaks (it spreads
  `seed-crypto-cache.js` and whole-module-mocks `seed-crypto-pool.js`; expected to stay green
  with no edit). If an edit is needed, keep it minimal and explain it in the report.

**Interfaces:**
- Produces (cache module):
  - `SCHEMA_VERSION` const (number).
  - `readCache(cacheFile: string): Promise<{ cacheVersion: string | null; cryptoFingerprint: string | null; entries: Map<string, CachedPersonaCrypto> }>` — never throws; on any failure returns `{ cacheVersion: null, cryptoFingerprint: null, entries: new Map() }`; drops entries failing shape or `key` mismatch.
  - `writeCache(cacheFile: string, data: { cacheVersion: string; cryptoFingerprint: string; entries: Map<string, CachedPersonaCrypto> }): Promise<void>` — atomic temp+rename, sorted keys, 2-space pretty-print, trailing newline, `mkdir -p` the parent.
  - Remove `readCacheEntry`, `writeCacheEntry`, `cacheFilePath` (no external consumer besides the pool + these two test files — verified this session).
- Consumes (pool → cache): `readCache` / `writeCache`; keeps `cacheKey`, `encode/decodePersonaCrypto`.
- `PoolOptions`: rename `cacheDir: string` → `cacheFile: string` (the single file path).

**Acceptance criteria (exact, testable):**
- New file shape exactly as specified above; a written-then-read round-trip is lossless.
- `writeCache` output is deterministic for a given map regardless of insertion order (keys
  sorted); pinned by a test that inserts keys in two different orders and asserts identical
  file bytes.
- `writeCache` leaves no `.tmp` file (atomicity test carried over from the old suite).
- `readCache` returns an empty map + null metadata for: missing file, non-JSON, JSON `null`,
  wrong top-level shape.
- `readCache` drops an individual entry whose shape is invalid or whose `key` ≠ its map key,
  while keeping the valid siblings.
- Pool: with a file whose stored `(cacheVersion, cryptoFingerprint)` matches the request,
  matching keys are hits and only misses run `runChunk`.
- Pool: with a file whose stored `cryptoFingerprint` (or `cacheVersion`) differs, ALL requests
  miss (wholesale invalidation) and the rewritten file's metadata is the current values.
- Pool: two sequential `ensurePersonaCrypto` calls against the same file with the same
  metadata accumulate — the second call's write still contains the first call's entries
  (no clobber). Pinned by a test.
- Pool: a pure-hit call performs no write (assert `writeCache` / fs not called, or mtime
  unchanged).
- Pool: the rewritten file preserves pre-existing valid entries that were not part of this
  call's requests (merge, not replace).
- `chunkRequests`, `runChunk` fan-out, and the `keyByCredId` mapping behavior are unchanged.
- Concurrent-seed last-write-wins tradeoff documented in a comment on `writeCache`.
- `scripts/seed.ts` compiles and `seed-run.test.ts` passes.

**Scoped checks:**
- `cd scripts && pnpm test` (vitest run with coverage — 95% gate).  Alternatively
  `tsx scripts/with-env.ts turbo test --filter=@hushbox/scripts`.
- `pnpm turbo typecheck lint --filter=@hushbox/scripts`
- `npx jscpd --threshold 2 scripts/lib/seed-crypto-cache.ts scripts/lib/seed-crypto-pool.ts`
- Re-run `eslint .` inside `scripts/` after the LAST edit (exit 0) — prettier errors ship
  green under vitest otherwise (known SDD failure mode).

**Sensitive?** No (dev/CI seed-cache plumbing; not auth/authz/payments/user-data path — it
generates *fixtures*, does not gate anything). Single auditor.

---

## Task 02 — Delete old dir, swap .gitignore, repopulate via the real seed

**Depends on:** Task 01 (the new `readCache`/`writeCache` must be landed; repopulation runs
the real seed which writes the file through them, and validation loads it through `readCache`).

**Founder ruling:** delete the old bytes outright — do **not** migrate/transcribe them, do
**not** write any bespoke migration code ("no handling"). The seed's own cache system
repopulates `scripts/.cache/seed-crypto.json` with only the live roster on a real run.
Regenerated OPAQUE bytes differ from the deleted ones — that is fine (nothing external pins
them; the seed generates each persona's registration + wrapped keys consistently).

**Objective:** Old directory gone, `.gitignore` re-pointed, and `seed-crypto.json`
regenerated by a real `pnpm db:seed` containing exactly the live test+dev roster under the
current fingerprint.

**File ownership (may edit only these):**
- `scripts/.cache/seed-crypto/` — deleted (all files, working-tree deletion; no git command).
- `.gitignore` — swap the `!scripts/.cache/seed-crypto/` re-include for
  `!scripts/.cache/seed-crypto.json`; keep the `scripts/.cache/*` ignore and the
  `scripts/.cache/local/` ignore; update the explanatory comment block to describe the single
  committed file (a fingerprint-keyed map, wholesale-invalidated on crypto/version change).
- `scripts/.cache/seed-crypto.json` — created, but **only** as the byproduct of running
  `pnpm db:seed`; never hand-authored.

**Method (no bespoke code):**
1. Update `.gitignore`.
2. Delete `scripts/.cache/seed-crypto/`.
3. Run `pnpm db:seed` (brings up the stack via `ensure-stack`). With the old dir gone and the
   new file absent, `readCache` → empty → every persona misses → the seed generates + writes
   `scripts/.cache/seed-crypto.json` with the live roster under the current fingerprint.
4. Validate the produced file.

If the local stack cannot start / `db:seed` cannot complete, report **BLOCKED** with the exact
failure — do not fabricate the file by hand. (Escalation path: founder runs `pnpm db:seed`
once and commits the result.)

**Acceptance criteria:**
- `scripts/.cache/seed-crypto/` no longer exists.
- `scripts/.cache/seed-crypto.json` exists, parses, and loads through `readCache` with a
  non-empty `entries` map; report `entries.size` (expected ≈ the live roster: TEST_PERSONAS +
  MOBILE_TEST_PERSONA + per-worker pooled variants + DEV_PERSONAS + ADMIN_TARGET_PERSONA).
- Top-level `schemaVersion === SCHEMA_VERSION`, `cacheVersion === CACHE_VERSION`,
  `cryptoFingerprint` === `computeCryptoFingerprint(packages/crypto/src)`.
- A second `pnpm db:seed` immediately after is a **pure-hit run** — it does not rewrite the
  file (assert unchanged bytes / mtime). This proves warm-cache reuse end-to-end.
- `.gitignore`: `git check-ignore scripts/.cache/seed-crypto.json` exits non-zero (NOT
  ignored); `git check-ignore scripts/.cache/local/x` still ignores; report both exit codes.
- No bespoke migration/repopulation script left anywhere in the repo tree.

**Scoped checks:**
- The `git check-ignore` assertions above (report exit codes).
- `git status --short scripts/.cache/ .gitignore` shows the dir deletions + the one new file +
  the `.gitignore` edit, and nothing unrelated.

**Sensitive?** No. Single auditor.

---

## Dependency graph

`Task 01 → Task 02` (sequential). No parallelism.

## Close phase

1. Full unscoped: `pnpm turbo typecheck lint --filter=@hushbox/scripts`, `cd scripts && pnpm test`,
   `npx jscpd --threshold 2` on the changed lib files, `pnpm lint:unused` (attribute only
   this run's findings). No web/api/etc. suites — nothing else changed.
2. Batch any validated close findings to one fixer; re-audit.
3. Related E2E: none declared. (Optional confidence check, human's call: a real `pnpm db:seed`
   against the local stack should be all-hits — but that needs the stack up and is not gated
   here.)
4. Completeness critic pass.
5. Doc proposals: the `.gitignore` comment block is updated in Task 02; check whether any
   doc references the seed-crypto cache dir (none found this session) and propose fixes if so.
