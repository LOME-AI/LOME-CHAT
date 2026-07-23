# identity/routes.integration.test.ts — split plan (approved: shared-setup extraction)

Source: `apps/api/src/slices/identity/routes.integration.test.ts` (3307 lines, 158 tests, 28 flat top-level
describes). Full structure map: see the codebase-explorer report summarized in ledger context. Goal: convert the
single-file pole into 8 sibling files + 1 shared setup module, ZERO behavior change, coverage identical.

## Shared setup module — `apps/api/src/slices/identity/routes.integration.setup.ts` (NEW)
Extract ONCE, export for import by all split files. Everything currently at module scope + interleaved helpers:
- Imports; env reads + fail-fast guard; `SECRET`, `testEnv`, `db = createDb(...)`, `redis = new Redis(...)`.
- ALL email/eviction port doubles + their `sent*` arrays + toggle flags (`emailPortShouldFail`,
  `disabledEmailShouldFail`, etc.); `billingStores`; `PREFIX`/`counter`/`uniqueAccount`; `reclaimRegistry`;
  `deletionPurge`; `manifestDeps`/`IdentityRouteDeps`; `createApp(deps?)`; `post/get/expectStatus`;
  `KEY_BYTES`/`KEY_BLOBS`; `registerInit`/`registerAccount`; and the interleaved helper clusters
  (`loginInit`, `sessionCookieOf`, `markVerified`, `login`, `fullSessionCookie`, `pendingSessionCookie`,
  `billingSessionCookie`, `unsealClaims`, `registerLoginFull`, `enrolledFullCookie`, `enrollTotp`, `wrongCode`,
  `stepUpKe3`, `deleteInit`/`deleteFinish`, etc.).
- The `afterAll` PREFIX-scoped bulk cleanup + DB close: register it from the shared module so EACH importing
  file runs its own PREFIX-scoped cleanup (each test file is an isolated vitest module graph → its own PREFIX,
  its own afterAll, its own client). Confirm this mechanic works (afterAll registered at setup-module top-level
  runs in the importing file's suite context).

## Split files (describe → file). All `*.integration.test.ts`, colocated, importing the setup module.
1. **routes-registration**: registration · input hardening · registration provisioning (wallets+welcome) · registration verification email (D2)
2. **routes-login-session**: login · logout · billing-only session lifecycle · revocation matrix (it.each) · /me bootstrap · principal guards · billing-portal token login
3. **routes-2fa**: TOTP enrollment · 2FA disable · TOTP-verify lockout · step-up duplicate · login 2FA verify principal gate
4. **routes-recovery-password**: password change · recovery · recovery/save
5. **routes-deletion**: account-deletion request (17)
6. **routes-email-verification**: email verification · email-verify login gate (D1) · security notification emails (D3)
7. **routes-edge**: enumeration timing · edge states for coverage · more edge states · store-outcome and decode edges
8. **routes-redis-unavailable**: "Redis unavailability fails closed" (9) — KEEP SEPARATE (Option B target later)

## Invariants / risks (acceptance-critical)
- All 158 tests survive with identical names/behavior; the original file is REMOVED once every describe is
  relocated (no empty stub, no v2 name).
- **Shared-mutable-state risk (the one real hazard):** `sent*` arrays + toggle flags are module-scoped. Splitting
  gives each file its own instance (better isolation), which is SAFE only if no test asserts on an array
  accumulated by a test in a DIFFERENT describe. The map found no evidence of cross-describe accumulation, but
  it is UNVERIFIED. So: after splitting, ALL tests must pass. If any fails because two describes shared
  accumulated state, KEEP those describes in the same file and report the regrouping — do not paper over it.
- `enumeration timing` (block 13) uses real `performance.now()` sampling — keep intact; do not alter its logic.
- Coverage on identity `routes.ts` must be UNCHANGED (same tests exercise the same handlers). Verify via
  `pnpm test:api` coverage on the identity slice.
- No production code touched. Durable orthodox names, no v2/tmp. One shared implementation of setup (no
  duplication across the 8 files) — CODE-RULES One-Implementation-Shared.
- SENSITIVE (auth/OPAQUE/TOTP/recovery/deletion) → 3-lens audit panel (correctness, security, conventions).

## Folded-in fix (human-approved): email='' test-isolation defect
- Two tests currently write a globally-unique `users.email=''` row with NO cleanup, escaping the PREFIX-scoped
  `afterAll` → orphan row causes cross-run `23505` unique-violation poisoning. In the source file they sit at
  ~:1380 (a 2FA-disable-area test → lands in routes-2fa) and ~:3263 (security-notification-emails → lands in
  routes-email-verification).
- As part of the split, give these two tests proper cleanup so no orphan `email=''` row survives: prefer making
  the row PREFIX-scoped like every other row (so the shared `afterAll` reclaims it), or add an explicit
  per-test/afterEach delete of the exact row. The two split files that receive them must leave zero orphan rows.
- Verification: run each of the two receiving files TWICE back-to-back (same process) — the second run must NOT
  hit 23505. This is the acceptance proof for the folded-in fix.
