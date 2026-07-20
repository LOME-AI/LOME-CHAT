# Plan — E2E device-key fallback + production-unreachability proof

**Tier:** 2 (4 tasks; crypto/auth-sensitive; adds a structural guardrail).
**Orchestrator writes no code.** Every task ends on an audit the orchestrator reads and agrees is clean.

## Problem (verified)

Commit `a4b4483d` moved the OPAQUE export key into a **non-extractable AES-GCM `CryptoKey` in IndexedDB** (`apps/web/src/lib/device-key-store.ts`). Playwright `storageState` — and the E2E fixture's `buildStorageInitScript` — capture cookies + Web Storage only, never IndexedDB. So authenticated E2E contexts restore with a valid session cookie + marker but no device key → `restoreSession()` → `loadExportKeyProtected()` returns null → `clearStoredAuth()` → logged out → chat routes redirect to `/login` (or drop to trial). ~80 of the 93 failures in run `2026-07-20T04-02-25` are this.

## Approach (recommended: structural isolation)

Add a **VITE_E2E-only fallback** that persists the export key in **localStorage** (Playwright-capturable), while production keeps the non-extractable IndexedDB path unchanged. The fallback lives in its **own isolated module** loaded ONLY via a gated dynamic `import()`, and a new **arch rule** (mirroring `demo-isolation.rule.ts`) forbids any production code from statically importing it. Proof that the branch never runs in production is threefold:

1. **Runtime gate** — the branch is behind `env.isE2E` (from `@/lib/env`), the repo's canonical env predicate. Unit-proven both directions (mirror `main.test.tsx`).
2. **Config impossibility** — `VITE_E2E` has no `production` key in the env registry, so a production build's `import.meta.env.VITE_E2E` is absent → `env.isE2E === false`. Pinned by a new `env.config.test.ts` block (mirror `VITE_CI`) + an explicit `env.test.ts` "production ⇒ isE2E false" assertion; already enforced at build by `verify-env.ts` (`exit(1)` on mismatch).
3. **Structural isolation** — the localStorage fallback is a separate module reachable only via a gated dynamic `import()`; an arch rule bans static imports of it from production `apps/web/src`, so the raw-key-in-localStorage code can never enter the production main chunk.

## Global Constraints (part of every task's criteria)

- **GC1 — Gate predicate:** the fallback activates iff `env.isE2E` (imported from `@/lib/env`). Never read `import.meta.env.VITE_E2E` directly; never gate on `NODE_ENV`/`CI`/env-var existence (CODE-RULES "Environment Detection").
- **GC2 — Production path unchanged:** the non-E2E path of `device-key-store.ts` keeps the exact IndexedDB / non-extractable-CryptoKey behavior. Every existing assertion in `device-key-store.test.ts` (round-trip; `ciphertext ≠ plaintext`; `iv` length 12; `deviceKey.extractable === false`; `exportKey('raw', deviceKey)` rejects; `failOpen`/`failRequest` reject) still passes on the production path.
- **GC3 — Identical external contract** across both paths: `storeExportKeyProtected(exportKey: Uint8Array, userId: string): Promise<void>`; `loadExportKeyProtected(): Promise<ProtectedExportKey | null>` (resolves `null` when no record is stored); `clearDeviceKeyStore(): Promise<void>`. `ProtectedExportKey = { exportKey: Uint8Array; userId: string }`.
- **GC4 — Isolation:** the fallback impl lives only in `apps/web/src/lib/device-key-store.e2e.ts`. The ONLY loader is a dynamic `import()` inside the `env.isE2E` branch of `device-key-store.ts`. No production module statically imports `device-key-store.e2e` (arch-enforced by Task-03).
- **GC5 — Fallback persistence is localStorage** (not sessionStorage, not IndexedDB): personas sign in with keepSignedIn=true so the marker lives in localStorage, and Playwright `storageState` captures localStorage. Store `{ userId, exportKey }` with the key bytes base64-encoded via `toBase64`/`fromBase64` from `@hushbox/shared` under a single, namespaced localStorage key.
- **GC6 — Conventions:** TDD (watch each test fail first); explicit return types; no `any`; kebab-case filenames; 95% per-file coverage; no committed `console.log`; run `eslint <owned files>` to exit-0 from the package dir after the LAST edit.

## Interfaces

- **Task-01 Produces** `apps/web/src/lib/device-key-store.e2e.ts` exporting the three functions with the GC3 signatures, backed by localStorage per GC5.
- **Task-02 Consumes** Task-01 via `await import('./device-key-store.e2e.js')` inside each function's `env.isE2E` branch. Produces the unchanged dispatcher `device-key-store.ts` (external contract identical; `auth-client.ts` untouched and unaware).
- **Task-03 Consumes** the module name `device-key-store.e2e` (string) only; independent of Task-01/02 internals.
- **Task-04** independent (packages/shared test-only additions).

## Tasks

### Task-01 — E2E localStorage fallback module  *(Sensitive: crypto/auth)*
- **Objective:** implement the export-key store's E2E variant backed by localStorage.
- **Files owned:** `apps/web/src/lib/device-key-store.e2e.ts`, `apps/web/src/lib/device-key-store.e2e.test.ts`.
- **Acceptance criteria:**
  1. Exports `storeExportKeyProtected`, `loadExportKeyProtected`, `clearDeviceKeyStore` with the exact GC3 signatures and `ProtectedExportKey` shape (import the type from `device-key-store.ts` or re-declare identically — no `any`).
  2. `store` writes a single localStorage entry under one namespaced key containing `{ userId, exportKey: base64 }`; overwrites on repeat. `load` returns `{ exportKey: Uint8Array, userId }` decoded from it, or `null` when the key is absent or unparseable. `clear` removes it.
  3. Uses `toBase64`/`fromBase64` from `@hushbox/shared` for the key bytes (never stores raw bytes as an array/JSON of numbers).
  4. Tests (install a **stateful** localStorage fake in `beforeEach` — the global mock is a no-op): round-trip returns identical bytes + userId; `load` → `null` when nothing stored; `clear` removes it (subsequent `load` → `null`); and an explicit assertion that after `store`, the value is present in `localStorage` under the namespaced key (this is the property that makes Playwright `storageState` capture it).
  5. No IndexedDB, no `crypto.subtle` device-key generation in this module — it is deliberately the storageState-capturable variant.
- **Scoped checks:** `pnpm test:web`; `turbo typecheck lint --filter=@hushbox/web`; `jscpd --threshold 2` on the two files.

### Task-02 — Dispatch device-key-store on `env.isE2E`  *(Sensitive: crypto/auth; depends on Task-01)*
- **Objective:** route `device-key-store.ts`'s three functions to the Task-01 module under E2E; keep the IndexedDB path for production.
- **Files owned:** `apps/web/src/lib/device-key-store.ts`, `apps/web/src/lib/device-key-store.test.ts`.
- **Acceptance criteria:**
  1. Each of the three exported functions begins with `if (env.isE2E) { return (await import('./device-key-store.e2e.js')).<fn>(...args); }` (dynamic import, not static — GC4), then the existing IndexedDB code for the non-E2E path. `env` imported from `@/lib/env`.
  2. GC2 holds: with `env.isE2E === false`, behavior is byte-for-byte the current IndexedDB implementation; all pre-existing `device-key-store.test.ts` assertions still pass.
  3. Tests use a hoisted mutable env mock (`vi.mock('@/lib/env', () => ({ env: envMock }))`, `envMock.isE2E` flipped per test — mirror `main.test.tsx`). Prove BOTH directions:
     - `isE2E === false` → the IndexedDB path runs (existing security assertions retained: non-extractable deviceKey, `exportKey('raw')` rejects, ciphertext ≠ plaintext, failOpen/failRequest reject) and the e2e module is NOT used (no localStorage write).
     - `isE2E === true` → delegates to the e2e module: the key round-trips through localStorage and IndexedDB is never opened.
  4. `auth-client.ts` is not modified and its contract is unchanged (verified by existing `auth-client.test.ts` still passing).
- **Scoped checks:** `pnpm test:web`; `turbo typecheck lint --filter=@hushbox/web`; `jscpd --threshold 2` on the two files; `pnpm arch:check` (must stay green — the dynamic import must not trip Task-03's rule).

### Task-03 — Arch rule: e2e-store isolation  *(depends on Task-01 for the module name)*
- **Objective:** structurally forbid production code from statically importing the E2E fallback module.
- **Files owned:** `packages/config/arch/rules/e2e-store-isolation.rule.ts`, `packages/config/arch/rules/e2e-store-isolation.rule.test.ts`.
- **Acceptance criteria:**
  1. Rule (mirror `demo-isolation.rule.ts`; `ArchRule { name, check(project) }` per `packages/config/arch/types.ts`; syntactic only, no `getType()`): over production web sources (`apps/web/src/**`, excluding `*.test.ts(x)` and the module itself), flag any **static** `ImportDeclaration` whose module specifier resolves to `device-key-store.e2e`. A dynamic `import('...device-key-store.e2e...')` (`ImportExpression`) is NOT flagged (by construction — this is what lets Task-02's gated loader pass).
  2. Violation message names the file:line and states the isolation invariant.
  3. Co-located `.rule.test.ts` (mirror `demo-isolation.rule.test.ts`, in-memory ts-morph project): a static import of the e2e module from a production file IS flagged; the gated dynamic import is NOT flagged; a test-file static import is NOT flagged.
  4. Default-exported so the harness discovers it; `pnpm arch:check` passes against the real repo (Task-02's dynamic import and Task-01's own test static-import do not trip it).
- **Scoped checks:** `pnpm test:config`; `turbo typecheck lint --filter=@hushbox/config`; `pnpm arch:check`.

### Task-04 — Env-registry "never in production" proof
- **Objective:** pin that `VITE_E2E` cannot be present/true in production, making `env.isE2E` provably false there.
- **Files owned:** `packages/shared/src/env.config.test.ts`, `packages/shared/src/env.test.ts`.
- **Acceptance criteria:**
  1. In `env.config.test.ts`, add a `VITE_E2E` block mirroring the existing `VITE_CI` block: `resolveRaw(envConfig.VITE_E2E, Mode.Production)` → `toBeUndefined()`; same for `Mode.Development` and `Mode.CiVitest`; `Mode.E2E` and `Mode.CiE2E` → `'true'`.
  2. In `env.test.ts`, add one explicit assertion that a production env context (`createEnvUtilities({ NODE_ENV: 'production' })`, no E2E key) yields `isE2E === false` (and `isProduction === true`) — the named "impossibility" test.
  3. Both additions are pure test additions; no production code changes; existing tests in both files unaffected.
- **Scoped checks:** `pnpm test:shared`; `turbo typecheck lint --filter=@hushbox/shared`.

## Dependency graph

- **Task-01** — ready now.
- **Task-04** — ready now (independent).
- **Task-02** — after Task-01 clean.
- **Task-03** — after Task-01 clean.

## Related E2E (run in Phase 4 close, scoped — NOT the full suite)

The fix's real proof is that authenticated tests restore sessions. Declared related E2E:
- `e2e/auth.setup.ts` (session creation must still pass), and
- one authenticated chat spec that previously login-redirected — `e2e/chat/chat-scroll.spec.ts`, and
- `e2e/billing/billing.spec.ts` (balance-display was a cascade symptom).

Run scoped (e.g. `--project=iphone-15` + `--grep` for these) with **no competing stack** (a concurrent stack sharing the Docker Postgres wiped the catalog last time — environmental, not app). No new E2E spec is required: existing authenticated specs are the guard for this bug class.

## Out of scope (do not touch this run)

- The `delete/finish` 200-vs-204 test mismatch (awaiting a separate founder ruling).
- The catalog-refresh concurrency race (environmental).
- The already-landed `signOutAndClearCache({ reload })` fix (done, verified).

## Amendments

(none yet)
