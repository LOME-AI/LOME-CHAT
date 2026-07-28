# Close-fix report 3 — pin the ciVitest FCM credential emission

## Objective

Close the one validated close-out finding: `scripts/generate-env.test.ts` seeded
`FCM_PROJECT_ID_CI` / `FCM_SERVICE_ACCOUNT_JSON_CI` only to keep the LINEAR assertion
deterministic, and asserted nothing about (a) their being **required** in `ciVitest` or
(b) their being **emitted to `Destination.Backend`** (i.e. landing in `apps/api/.dev.vars`)
— the only route by which `push-fcm-live.integration.test.ts` can see the credential,
since turbo's strict env mode passes through only `HB_TEST_SCOPE`.

## Files changed

- `scripts/generate-env.test.ts` — four tests added inside the existing `ciVitest mode`
  describe (two for requiredness, two for backend emission) plus a `parseDevVariables`
  helper local to that describe. No production file touched; `packages/shared/src/env.config.ts`
  is untouched (`git diff --stat` on it shows only the pre-existing +18 lines from Task 18).

## Tests added

| Test | Behavior | Finding item |
| --- | --- | --- |
| `throws when the required ciVitest secret FCM_PROJECT_ID_CI is missing` | omitting the var makes `generateEnvFiles(…, 'ciVitest')` throw naming it | (a) |
| `throws when the required ciVitest secret FCM_SERVICE_ACCOUNT_JSON_CI is missing` | same for the service-account JSON | (a) |
| `emits FCM_PROJECT_ID_CI into the backend .dev.vars` | the generated `apps/api/.dev.vars` parses to the seeded project id | (b) |
| `emits FCM_SERVICE_ACCOUNT_JSON_CI into the backend .dev.vars` | the generated `apps/api/.dev.vars` parses to the seeded JSON, verbatim through dotenv quoting | (b) |

## The (b) assertion, and why it is not vacuous

```ts
const parseDevVariables = async (): Promise<Record<string, string>> => {
  const { parse } = await import('dotenv');
  return parse(readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8'));
};
…
const devVariables = await parseDevVariables();
expect(devVariables['FCM_PROJECT_ID_CI']).toBe('test-fcm-project');
```

It reads the generated file the way the consumer does — dotenv-parsing `apps/api/.dev.vars`
and comparing the **value** to what `beforeEach` put in `process.env`. A broken emission
(registry entry re-pointed away from `Destination.Backend`, or its `CiVitest` entry dropped)
makes the key absent from that file, so the parse yields `undefined` and the test fails; it
cannot pass by reading a value from anywhere but the generated backend file, and it cannot
pass on a key that merely exists with some other value. The JSON variant additionally pins
that dotenv round-trips the quoting, which is the shape `FCM_SERVICE_ACCOUNT_JSON_CI` has.

## RED evidence

These are pinning tests over already-correct registry behavior, so they pass on the current
tree by construction. To prove they are not vacuous I ran each new assertion against a
**mutated registry**, using a temporary probe file (`scripts/red-probe.test.ts`) that
`vi.mock`ed `../packages/shared/src/env.config.js` with one field changed. No source file
was edited: the probe and its fixture dir were deleted immediately after (verified — the
path no longer exists, and `git status` lists exactly the same modified files as the
pre-edit snapshot).

**Mutation 1 — `to: [Destination.Backend]` → `[Destination.Scripts]` on both FCM vars**
(i.e. the vars stay required but stop reaching `.dev.vars`; both emission tests fail, and
the requiredness tests would still pass — which is precisely the gap the critic named):

```
FAIL  |scripts| red-probe.test.ts > ciVitest mode > emits FCM_PROJECT_ID_CI into the backend .dev.vars
AssertionError: expected undefined to be 'test-fcm-project' // Object.is equality
- Expected: "test-fcm-project"
+ Received: undefined
 ❯ red-probe.test.ts:64:42
     64|     expect(devVars['FCM_PROJECT_ID_CI']).toBe('test-fcm-project');

FAIL  |scripts| red-probe.test.ts > ciVitest mode > emits FCM_SERVICE_ACCOUNT_JSON_CI into the backend .dev.vars
AssertionError: expected undefined to be '{"client_email":"t","private_key":"k"}' // Object.is equality
- Expected: "{\"client_email\":\"t\",\"private_key\":\"k\"}"
+ Received: undefined
 ❯ red-probe.test.ts:71:52

 Test Files  1 failed (1)
      Tests  2 failed (2)
```

Reason for failure: with the vars no longer Backend-destined, `apps/api/.dev.vars` contains
no such key, so the dotenv parse returns `undefined` — exactly the production failure mode
(live suite silently skips, `verify:evidence --require=push-fcm` fails as if unprovisioned).

**Mutation 2 — the `[Mode.CiVitest]: secret(...)` entry removed from both vars** (they are
no longer required):

```
FAIL  |scripts| red-probe.test.ts > ciVitest mode > throws when the required ciVitest secret FCM_PROJECT_ID_CI is missing
AssertionError: expected [Function] to throw an error
- Expected: null
+ Received: undefined
 ❯ red-probe.test.ts:62:8

FAIL  |scripts| red-probe.test.ts > ciVitest mode > throws when the required ciVitest secret FCM_SERVICE_ACCOUNT_JSON_CI is missing
AssertionError: expected [Function] to throw an error
- Expected: null
+ Received: undefined
 ❯ red-probe.test.ts:70:8

 Test Files  1 failed (1)
      Tests  2 failed (2)
```

Reason for failure: with no `CiVitest` secret entry, `generateEnvFiles` collects no missing
secret and returns normally, so the expected `Missing required secrets in process.env: …`
throw never happens.

## GREEN evidence

`scripts/generate-env.test.ts` alone, before the change:

```
 Test Files  1 passed (1)
      Tests  113 passed (113)
```

after the change:

```
 Test Files  1 passed (1)
      Tests  117 passed (117)
```

Total for the file: **113 → 117** (four new tests, no existing test modified).

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo lint typecheck --filter=@hushbox/scripts --force` | **pass** — 2 successful, 2 total (first attempt failed on three `unicorn/prevent-abbreviations` errors for `parseDevVars`/`devVars`; renamed to `parseDevVariables`/`devVariables` and reformatted with prettier, then green) |
| `npx turbo test --filter=@hushbox/scripts --force` | **fail (foreign)** — `Tests 1873 passed (1873)`, zero test failures; `Test Files 2 failed | 88 passed (90)` — `seed-run.test.ts` and `refresh-catalog-run.test.ts` fail at **collection** |
| `npx vitest run generate-env.test.ts` (owned file) | **pass** — 117/117 |

Failure excerpt for the two foreign files (identical for both):

```
Error: [vitest] There was an error when mocking a module. …
 ❯ seed.ts:33:1
     33| import { LOCAL_NEON_DEV_CONFIG, createDb, wallets, type Database } fro…
Caused by: Error: Cannot find module '…/scripts/node_modules/.vite/vitest/16728…/deps_ssr/@hushbox_db.js&v=8a56db6e'
Serialized Error: { code: 'ERR_MODULE_NOT_FOUND', url: 'file:///…/deps_ssr/@hushbox_db.js&v=8a56db6e' }
```

Attribution — not mine, on four independent grounds:

1. Both files `vi.mock('@hushbox/db')`; neither imports `scripts/generate-env.ts` or its
   test. My change is test-only and confined to one file.
2. It reproduces running those two files **alone** (`npx vitest run seed-run.test.ts`), a run
   in which my file is never collected.
3. The optimized-dep bundle `deps_ssr/@hushbox_db.js` exists and its `_metadata.json`
   `browserHash` is `8a56db6e` — matching the URL; the resolver is appending the `&v=` query
   to the filesystem path. It is a vitest/rolldown-vite optimized-dep resolution defect, not
   missing code.
4. It survives wiping `scripts/node_modules/.vite`, so it is not a stale-cache race, and no
   other vitest/turbo process was running (`ps` clean) — so it is not concurrent-run churn
   either.

`packages/db/src/evidence.ts` carries a one-line uncommitted deletion (this run's Task 22)
and `packages/db` typechecks clean, so a broken `@hushbox/db` source is ruled out as the
cause. Whatever the trigger, `seed-run.test.ts` and `refresh-catalog-run.test.ts` are
unmodified in the working tree and outside this fix's ownership.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| (a) omitting either new var makes `generateEnvFiles(…, 'ciVitest')` throw naming it | **met** | two tests, green; RED under mutation 2 above |
| (b) both vars are emitted to `Destination.Backend`, landing in `apps/api/.dev.vars` | **met** | two tests parsing the generated `.dev.vars`, green; RED under mutation 1 above |
| test written first and watched fail for the right reason | **met, by mutation** | see RED evidence — a pin over already-correct behavior cannot fail on the unmutated tree; both mutations produce the exact production failure modes |
| existing file structure and assertion style followed, no restructuring | **met** | tests added inside the existing `ciVitest mode` describe; `dotenv.parse` matches the file's existing round-trip assertion style |
| `packages/shared/src/env.config.ts` untouched | **met** | `git diff --stat` shows only the pre-existing Task 18 +18 lines |

## Deviations

- The brief asked to watch each test fail before making it pass. Both items pin behavior the
  registry already has correct, and the brief simultaneously forbids editing `env.config.ts`
  — so a literal RED on the unmutated tree is impossible. Rather than accept a
  passes-immediately test, I proved non-vacuity by mutating the registry **through
  `vi.mock` in a temporary probe file**, which touches no source file and leaves no residue.
  Reporting this per the brief's "say so in your report" instruction.
- Local variable names deviate from the obvious `devVars` because
  `unicorn/prevent-abbreviations` rejects it (lint output quoted above).

## Concerns and limitations

- These tests pin the **emission**, not the consumption: nothing here proves that the api
  test process actually loads `apps/api/.dev.vars`. That link (wrangler/vitest env loading)
  remains unpinned, and a change to how the api suite sources env would still break the live
  FCM test silently. Closing it would need a test in `@hushbox/api`, out of this task's scope.
- The seeded values are fixtures; a real-credential shape mismatch (e.g. a service-account
  JSON containing a single quote, which `escapeEnvValue` refuses) is not exercised here.
  `escapeEnvValue`'s own tests cover that refusal.

## Confidence

**High** — the pinned behavior is exercised end-to-end through the real generator into a real
generated file, both directions of each assertion were demonstrated (green on the correct
registry, red on a mutated one), and the package lint/typecheck gate is green with the only
test reds attributable to two unrelated, unmodified files.
