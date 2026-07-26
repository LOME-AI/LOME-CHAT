# B1 — Move the money math behind one barrel

## Objective

Relocate the closed money set into `packages/shared/src/affordability/`, add a narrow
exports-map subpath, split `constants.ts` into money and non-money halves, and demonstrate
behaviour identity. The export wall is B1b's; nothing here narrows the root barrel.

---

## Files changed

### New (the module)

| Path                                                | Why                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/affordability/index.ts`         | The module barrel. Named (not star) re-export of `money.ts` — see Deviations.                                    |
| `packages/shared/src/affordability/index.test.ts`    | Pins barrel⟺root-barrel binding identity for one symbol per relocated unit, and the exports-map entry.           |
| `packages/shared/src/affordability/constants.ts`      | The money half of the split. No re-export bridge.                                                               |
| `packages/shared/src/affordability/constants.test.ts` | The money half of the colocated test. The one permitted semantic test change.                                    |

### Relocated (68 files, 35 non-test, 11,557 lines)

Directory moves (interior relative specifiers unchanged — depth is preserved):

- `src/estimate/` → `src/affordability/estimate/` (26 files)
- `src/smart-model/` → `src/affordability/smart-model/` (10 files)
- `src/billing/` → `src/affordability/billing/` (6 files)

File moves (each with its colocated test):

`money.ts` · `nano-usd.ts` · `tiers.ts` · `budget.ts` · `fees.ts` · `pricing.ts` ·
`reasoning-effort.ts` · `model-descriptor.ts` · `modality.ts` · `param-spec.ts` ·
`utils/levenshtein.ts` → `affordability/levenshtein.ts`

Two interior specifiers needed repair (the only ones whose depth changed):

- `affordability/smart-model/resolve.ts` — `'../utils/levenshtein.js'` → `'../levenshtein.js'`
- `affordability/nano-usd.test.ts` — `'./__tests__/seeded-prng.js'` → `'../__tests__/seeded-prng.js'`

### Modified

| Path                                                       | One-line why                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/shared/package.json`                              | One-line exports-map addition: `"./affordability": "./src/affordability/index.ts"`.               |
| `packages/shared/src/index.ts`                              | Specifiers repointed; export **lists** untouched. Added `export * from './affordability/constants.js'` so the split does not drop the money constants from the root barrel (B1b removes them, not B1). |
| `packages/shared/src/constants.ts`                          | Non-money half retained; money constants removed (no bridge).                                    |
| `packages/shared/src/constants.test.ts`                     | Non-money half of the colocated test.                                                            |
| `packages/shared/src/admin/ops.ts`                          | Path repoint (`nano-usd`).                                                                       |
| `packages/shared/src/admin/wire.ts`                         | Path repoint (`model-descriptor`).                                                               |
| `packages/shared/src/content-value.ts`                      | Path repoint (`modality`).                                                                       |
| `packages/shared/src/flow-executor.ts`                      | Path repoint (`modality`, `nano-usd`).                                                           |
| `packages/shared/src/flow-executor.test.ts`                 | Path repoint (`nano-usd`).                                                                       |
| `packages/shared/src/formatting.ts`                         | Path repoint (`nano-usd`).                                                                       |
| `packages/shared/src/inference.ts`                          | Path repoint (`modality`).                                                                       |
| `packages/shared/src/mock-directives.ts`                    | Path repoint (`smart-model/effort-dimension`).                                                   |
| `packages/shared/src/schemas/api/models.ts`                 | Path repoint (`model-descriptor`).                                                               |
| `packages/shared/src/schemas/api/public-usage-stats.ts`     | Path repoint (`modality`).                                                                       |
| `packages/shared/src/type-tag.ts`                           | Path repoint (`modality`).                                                                       |
| `packages/shared/src/models/premium-check.ts`               | Path repoint only (`constants`, `money`, `nano-usd`, `estimate`) — it stays outside; see Decision. |
| `packages/shared/src/legal/terms-sections.ts`               | Import split across the two constants halves + `fees` repoint.                                   |
| `packages/shared/src/legal/legal.test.ts`                   | Same split (import-path only).                                                                   |
| `scripts/readme/generate-readme.ts`                         | Relative source-path imports repointed **and** the cache-input path list (`collectReadmeInputs`) — a stale hash input silently breaks README cache invalidation. |
| `scripts/readme/generate-readme.test.ts`                    | Path repoint.                                                                                    |
| `scripts/readme/generate-tables.ts`                         | Path repoint + cache-input path list.                                                            |
| `scripts/readme/generate-tables.test.ts`                    | Path repoint.                                                                                    |
| `packages/config/eslint-extensions/fee-seams.config.mjs`     | **Outside my ownership (G1's glob)** — the fee-seam allowlist names two files I moved. See Deviations. |
| `packages/config/eslint-extensions/rules/fee-seams.mjs`      | Same: a docblock citation of `money.ts`'s path.                                                   |
| `packages/config/eslint-extensions/rules/fee-seams.test.mjs` | Same: the allowlist-inventory pin and one positive-control path string.                          |

---

## Tests added

| Test                                                                                        | Behaviour                                                                                      | Criterion covered              |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `affordability barrel > exposes <symbol>` (×17)                                              | One symbol per relocated unit is present on the module barrel.                                  | "closed set relocated"         |
| `affordability barrel > hands back the same binding as the root barrel for <symbol>` (×17)   | Identity (`toBe`) against the root barrel's export — proves a *move*, not a copy or re-derivation. | behaviour identity             |
| `affordability subpath > is declared in the package exports map and points at an existing barrel` | The exports-map entry exists with the exact target and the target file is present.             | "new narrow subpath entry"     |

TDD: barrel stubbed as `export {}` and the test written first → **37 failures observed**
(`expected undefined to be './src/affordability/index.ts'`, and every symbol absent) → the
move made them pass. A later red (`applyMarkupCeil` absent) was a genuine finding, not a
test weakening — see Deviations.

---

## Self-gate

| Command                                                                    | Result                    | Notes                                                                              |
| -------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `npx turbo test --force --filter=@hushbox/shared` (baseline, pre-change)     | pass — 108 files          | Forced past the turbo cache to get a true baseline.                                |
| `npx turbo test --force --filter=@hushbox/shared`                            | **pass — 110 files**      | +2 files = the split money-half test + the new barrel test.                        |
| `npx turbo test --force --filter=@hushbox/config`                            | pass — 29 files           | Includes the fee-seams allowlist-inventory pin I updated.                          |
| `npx turbo test --force --filter=@hushbox/ui`                                | pass — 94 files           |                                                                                    |
| `npx turbo test --force --filter=@hushbox/crypto`                            | pass — 36 files           |                                                                                    |
| `npx turbo test --force --filter=@hushbox/db`                                | pass — 27 + 2 files       |                                                                                    |
| `npx turbo test --force --filter=@hushbox/realtime`                          | pass — 12 + 2 files       |                                                                                    |
| `npx turbo test --force --filter=@hushbox/web`                               | pass                      |                                                                                    |
| `npx turbo test --force --filter=@hushbox/marketing`                         | pass                      |                                                                                    |
| `npx turbo test --force --filter=@hushbox/admin`                             | pass                      |                                                                                    |
| `npx turbo test --force --filter=@hushbox/api`                               | **fail — 1 of 464**       | `notifications/.../template-html.test.ts` — pre-existing at HEAD, not mine (below). |
| `npx turbo test --force --filter=@hushbox/scripts`                           | **fail — 3 of 90**        | 2 on §Known Breakage, 1 the push workstream (below).                               |
| `npx turbo typecheck --force --continue` (repo-wide, 16 packages)            | **pass — 16/16**          | Green including `env.config`/notifications, which §Known Breakage warned might be red. |
| `npx turbo lint --force --continue` (repo-wide, 16 packages)                 | **pass — 16/16**          |                                                                                    |
| `npx eslint .` from `packages/shared`, `packages/config`, `scripts`          | **exit 0 each**           | Run **after** the final edit, from each package directory (Global Constraint 9).    |
| `pnpm arch:check`                                                            | pass — 11 rules, 1988 files |                                                                                    |
| `pnpm lint:unused` (knip)                                                    | **fail — 2 findings**     | Neither names a file I touched (below).                                            |

### Failure attribution

**`apps/api` — `notifications/domain/templates/template-html.test.ts` (7 snapshots).**
Not mine, and **not on §Known Breakage** — it fails at HEAD. Evidence: the diff is a removed
`<link href="https://fonts.googleapis.com/css2?family=Merriweather...">` in the email shell;
`fonts.googleapis` now appears **only** in the committed snapshot file and nowhere in source;
and both the shell (`apps/api/.../templates/base.ts`) and the snapshot are byte-identical to
HEAD (`git status --short` on both is empty). It fails for `password-changed` and
`two-factor-*` as well as `welcome`, so it is not money-related. **Raised as a new
§Known Breakage item.**

**`scripts` — `refresh-catalog-run.test.ts`, `seed-run.test.ts`.** Exactly §Known Breakage's
"`scripts` suite collection failure … SSR-optimized dependency URL under `vi.mock` +
`importOriginal`". Same `ERR_MODULE_NOT_FOUND` on a `deps_ssr/@hushbox_db.js&v=…` URL.

**`scripts` — `generate-env.test.ts > generates for loop with all backend secret keys`.**
The push/notifications workstream. The delta is exactly three secrets —
`VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY NOTIFICATION_TAG_SECRET` — generated but absent from the
test's expected string. `env.config.ts` imports nothing in the closed set (verified by grep)
and is unmodified vs HEAD. Note this test **writes** `.github/workflows/ci.yml`, which is why
that file flips modified/unmodified during a run.

**knip.** (1) `packages/config/vitest.package.config.ts` "unused" — it is referenced only by a
string in `packages/config/package.json`'s `test` script, a structural knip blindspot that a
shared-file move cannot introduce. (2) A `wrangler`/`apps/sandbox` `ignoreDependencies` hint —
`apps/sandbox` is uncommitted concurrent work. Neither finding names `packages/shared` or
`affordability`, and knip reported **no** unused exports for the new barrel or subpath.

---

## Acceptance criteria

### 1. The closed set relocated; a new narrow subpath entry in the exports map — **met**

68 files (35 non-test, 11,557 lines) under `packages/shared/src/affordability/`; the survey's
~35/~4,246 figure matches the non-test count exactly (4,479 non-test lines measured
pre-move).

`packages/shared/package.json` gained exactly one line. Verified resolvable **from outside the
package**, running from `apps/api`:

```
RESOLVED @hushbox/shared/affordability | export count = 145 | priceRequest: function
blocked: @hushbox/shared/estimate                    -> ERR_PACKAGE_PATH_NOT_EXPORTED
blocked: @hushbox/shared/affordability/money.js      -> ERR_PACKAGE_PATH_NOT_EXPORTED
blocked: @hushbox/shared/src/affordability/index.js  -> ERR_PACKAGE_PATH_NOT_EXPORTED
```

**No deep specifier was introduced.** The map has no wildcard, so nothing under the new
subpath resolves either — confirmed above rather than assumed. The only pre-existing
`@hushbox/shared/estimate` occurrences in the repo are two prose citations in
`apps/api/src/slices/models/domain/{estimate,smart-model-candidates}.ts` docblocks; that
subpath never existed, so those comments were already wrong. Left unedited (not importers, not
my ownership) — reported for the close phase's doc pass.

### 2. No cycle; the allowlist written down — **met**

Every import in the module that reaches outside it, mechanically enumerated over all 68 files
on the final tree:

**Production (non-test) — the enumerated allowlist, verbatim and copy-pasteable:**

```
zod
```

That is the whole list. **No non-money shared module is imported by any non-test file in the
module.**

**Test-only additions (the module's own tests):**

```
vitest
node:fs
node:url
../__tests__/seeded-prng.js      ← affordability/nano-usd.test.ts
../constants.js                  ← affordability/constants.test.ts   (MAX_VIDEO_DURATION_SECONDS)
../index.js                      ← affordability/index.test.ts       (root-barrel identity pin)
```

For G1 rule 5 and B1b: the production allowlist has **one** entry (`zod`, an external
dependency, not a shared module). If G1's rule is written over the whole tree rather than
production files, the three test-only relative entries above must be on it as well.

None of the six creates a cycle: `__tests__/seeded-prng.ts` has zero imports; `../constants.js`
(the non-money half) has zero imports; `../index.js` is the root barrel, imported only by a
test.

### 3. `constants.ts` split with no re-export bridge — **met**

No bridge exists in either direction: `src/constants.ts` does not import
`affordability/constants.ts` and vice versa. Verified by grep and by the fact that no money-half
constant derives from a non-money one (`TOTAL_FEE_RATE` ← the three fee rates;
`STORAGE_COST_PER_CHARACTER`/`STORAGE_COST_PER_1K_CHARS`/`MEDIA_STORAGE_COST_PER_BYTE` ← the
cost-model chain — all money-half).

The colocated test split with it. **This is the one permitted semantic test change** and it is
listed explicitly in §Touched tests below.

#### The split rules, applied in order

- **(a) Mechanical:** a constant lands in the money half iff at least one file **inside** the
  closed set imports it. This is the rule that actually does the work — it is what removes the
  module → non-money-shared edge, so it admits no exception.
- **(b) Derivation closure of (a).** A constant that an (a) constant is computed from moves with
  it; otherwise the non-money half would have to be imported by the money half.
- **(c) The storage cost-model chain.** `§Storage Fees` is a billing-spec section and G2 is
  chartered to make the float derive from the module's nano constant. Leaving the chain outside
  would force `src/constants.ts` onto G1's import-into allowlist for G2's benefit.
- **(d) Sibling cohesion.** A constant whose only companion is in the money half and which is
  meaningless apart from it moves with it (one case: `CAPACITY_YELLOW_THRESHOLD`).

Rule (a) was evaluated over the closed set's **test** files as well as its production files,
because those tests live inside the module directory; that is what pulls the three
`ESTIMATED_*_BYTES` reservation constants in.

#### Per-constant table (55 constants)

| Constant                             | Half      | Rule applied                                                               |
| ------------------------------------ | --------- | -------------------------------------------------------------------------- |
| `HUSHBOX_FEE_RATE`                   | money     | (a) `affordability/fees.ts`                                                |
| `CREDIT_CARD_FEE_RATE`               | money     | (a) `affordability/fees.ts`                                                |
| `PROVIDER_FEE_RATE`                  | money     | (a) `affordability/fees.ts`                                                |
| `TOTAL_FEE_RATE`                     | money     | (a) `affordability/pricing.ts`, `money.ts` · (b) closure of the three above |
| `EXPENSIVE_MODEL_THRESHOLD_PER_1K`   | money     | (a) `affordability/estimate/format.ts`                                     |
| `MINIMUM_OUTPUT_TOKENS`              | money     | (a) `estimate/{reducers,smart-model-affordability,pre-adapters}.ts`        |
| `LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD` | money     | (a) `affordability/budget.ts`                                              |
| `CAPACITY_RED_THRESHOLD`             | money     | (a) `affordability/budget.ts`                                              |
| `CAPACITY_YELLOW_THRESHOLD`          | money     | **(d)** — not imported by the module; boundary case, see below              |
| `CHARS_PER_TOKEN_CONSERVATIVE`       | money     | (a) `estimate/pre-adapters.ts`                                             |
| `CHARS_PER_TOKEN_STANDARD`           | money     | (a) `estimate/pre-adapters.ts`                                             |
| `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` | money     | (a) `estimate/pre-adapters.ts`                                             |
| `MAX_TRIAL_MESSAGE_COST_CENTS`       | money     | (a) `billing/client-billing.ts`, `estimate/pre-adapters.ts`                |
| `MAX_SEARCH_TOOL_CALLS`              | money     | (a) `estimate/search-reservation.ts`                                       |
| `SEARCH_COST_PER_CALL`               | money     | (a) `estimate/search-reservation.ts`                                       |
| `ESTIMATED_IMAGE_BYTES`              | money     | (a) via `estimate/{media-pricing,price-request}.test.ts`                   |
| `ESTIMATED_VIDEO_BYTES_PER_SECOND`   | money     | (a) via `estimate/media-pricing.test.ts`                                   |
| `ESTIMATED_AUDIO_BYTES_PER_SECOND`   | money     | (a) via `estimate/media-pricing.test.ts`                                   |
| `CHARACTERS_PER_KILOBYTE`            | money     | (c) storage cost model                                                      |
| `KILOBYTES_PER_GIGABYTE`             | money     | (c) storage cost model                                                      |
| `MONTHLY_COST_PER_GB`                | money     | (c) storage cost model                                                      |
| `MONTHS_PER_YEAR`                    | money     | (c) storage cost model (both derivations)                                   |
| `STORAGE_YEARS`                      | money     | (c) storage cost model                                                      |
| `STORAGE_COST_PER_CHARACTER`         | money     | (c) storage cost model                                                      |
| `STORAGE_COST_PER_1K_CHARS`          | money     | (c) storage cost model                                                      |
| `MEDIA_MONTHLY_COST_PER_GB`          | money     | (c) storage cost model                                                      |
| `MEDIA_STORAGE_COST_PER_BYTE`        | money     | (c) storage cost model                                                      |
| `TOUCH_QUERY`                        | non-money | UI media query                                                              |
| `DEV_PASSWORD`                       | non-money | dev/e2e persona                                                             |
| `DEV_EMAIL_DOMAIN`                   | non-money | dev persona                                                                 |
| `TEST_EMAIL_DOMAIN`                  | non-money | e2e persona                                                                 |
| `SMART_MODEL_ID`                     | non-money | model identity, not money — boundary case, see below                        |
| `PAYMENT_EXPIRATION_MS`              | non-money | payment-lifecycle timing — boundary case, see below                         |
| `MEDIA_DOWNLOAD_URL_TTL_SECONDS`     | non-money | presign TTL                                                                 |
| `MAX_MEDIA_OBJECT_BYTES`             | non-money | upload limit                                                                |
| `MIN_VIDEO_DURATION_SECONDS`         | non-money | request-schema bound — boundary case, see below                             |
| `MAX_VIDEO_DURATION_SECONDS`         | non-money | request-schema bound — boundary case, see below                             |
| `VIDEO_ASPECT_RATIOS`                | non-money | request-schema/picker domain                                                |
| `VIDEO_RESOLUTIONS`                  | non-money | request-schema/picker domain                                                |
| `IMAGE_ASPECT_RATIOS`                | non-money | request-schema/picker domain                                                |
| `MAX_AUDIO_DURATION_SECONDS`         | non-money | request-schema bound                                                        |
| `AUDIO_FORMATS`                      | non-money | request-schema/picker domain                                                |
| `FEATURE_FLAGS` (+ `FeatureFlags`)    | non-money | feature flags                                                               |
| `MAX_CONVERSATION_MEMBERS`           | non-money | membership limit                                                            |
| `MAX_FORKS_PER_CONVERSATION`         | non-money | fork limit                                                                  |
| `MAX_SELECTED_MODELS`                | non-money | cited by BILLING.md but not imported by the module — boundary case, see below |
| `STREAM_TIMEOUT_MS`                  | non-money | transport timing                                                            |
| `KEEPALIVE_INTERVAL_MS`              | non-money | transport timing                                                            |
| `PRIVACY_POLICY_EFFECTIVE_DATE`      | non-money | legal date                                                                  |
| `TERMS_OF_SERVICE_EFFECTIVE_DATE`    | non-money | legal date                                                                  |
| `BILLING_CONTACT_EMAIL`              | non-money | contact address (a string, not an amount)                                   |
| `PRIVACY_CONTACT_EMAIL`              | non-money | contact address                                                             |
| `DELETE_ACCOUNT_CONFIRMATION_PHRASE` | non-money | confirmation copy                                                           |
| `MIN_PASSWORD_LENGTH`                | non-money | auth policy                                                                 |
| `MIN_DEPOSIT_USD`                    | non-money | payment-form minimum — boundary case, see below                             |

#### The boundary cases and the rule that decided each

- **`CAPACITY_YELLOW_THRESHOLD` → money (rule d).** It is not imported by the module, but its
  only companion `CAPACITY_RED_THRESHOLD` is (rule a, `budget.ts`), and both are thresholds on
  the same context-capacity scale read together by
  `apps/web/.../layout/capacity-bar.tsx`. Splitting the pair guarantees drift. Note both are
  arguably **UI** thresholds that rule (a) drags into the money half because `budget.ts` uses
  one; I did not create an exception, because any exception to rule (a) reinstates the edge the
  split exists to remove.
- **`MIN_VIDEO_DURATION_SECONDS` / `MAX_VIDEO_DURATION_SECONDS` → non-money.** Rule (a) does not
  fire (only the `ESTIMATED_*_BYTES` reservation constants are used inside). They are request
  schema bounds consumed by `schemas/api/conversations.ts` and the media picker. Consequence:
  `affordability/constants.test.ts` imports `MAX_VIDEO_DURATION_SECONDS` across the split for
  the pre-existing "40MB for an 8-second clip" assertion. A **test** crossing the split is not
  a production-wall violation; if G1 writes rule 5 over the whole tree it needs the allowlist
  entry noted above.
- **`MAX_SELECTED_MODELS` → non-money.** BILLING.md §Multi-Model 1 cites it and the
  Configuration Reference lists it, but no module file imports it; its consumers are the request
  schema, api routes and the model-selector components. Moving it would put
  `schemas/api/conversations.ts` on the module's inbound edge for no gain.
- **`PAYMENT_EXPIRATION_MS` → non-money.** Billing-*slice* lifecycle timing, not money math;
  rule (a) does not fire.
- **`MIN_DEPOSIT_USD` → non-money.** A payment-form minimum in whole dollars; rule (a) does not
  fire and no rate arithmetic touches it.
- **`SMART_MODEL_ID` → non-money.** A model identifier, consumed by api routes and web stores.

### 4. The module imports no database or cache package — **met**

Verified by grep over all 68 files for `@hushbox/db`, `drizzle`, `@upstash`, `ioredis`, `redis`:
zero hits (the only textual matches were the word "redistribute"). This also follows from
criterion 2: the production allowlist is `zod` alone.

### 5. Behaviour identity demonstrated, not asserted — **met**

Four independent demonstrations:

1. **The root barrel's runtime export set is unchanged, name for name.** `git archive HEAD` of
   `packages/shared` into a scratch tree, then both barrels imported in one process and their
   key sets diffed:

   ```
   BEFORE count 543  AFTER count 543
   MISSING from new barrel: []
   ADDED to new barrel: []
   ```

   Re-run after the last edit with the same result. (Runtime exports only; type-only exports are
   covered by the green repo-wide typecheck.)

2. **Binding identity, not value equality.** `affordability/index.test.ts` asserts `toBe`
   between the module barrel and the root barrel for one symbol per relocated unit — a
   re-derived copy would fail.

3. **Every package suite passes** with the four exceptions attributed above, none of them
   money-related and none of them mine.

4. **No test file was semantically modified** beyond the `constants` split. Table below.

### 6. The `BILLING.md` path-diff, as a proposal — **met** (see next section)

---

## Touched tests — every one, with its nature

| Test file                                                        | Why touched                                                | Nature                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `src/constants.test.ts`                                          | Split: money describes removed, non-money kept verbatim.   | **SEMANTIC (the one permitted change)**             |
| `src/affordability/constants.test.ts`                            | Split: the money describes, moved verbatim.                | **SEMANTIC (the same permitted change)**            |
| `src/affordability/index.test.ts`                                | New test for this task.                                    | new                                                 |
| `src/affordability/nano-usd.test.ts`                             | Relocated; `../__tests__/seeded-prng.js` depth fix.        | import-path only                                    |
| `src/affordability/smart-model/resolve.test.ts`                   | Relocated with its subject.                                | none (specifier unchanged after the move)           |
| all other 30 relocated `*.test.ts`                               | Relocated with their subjects.                             | none — file moved, contents byte-identical          |
| `src/flow-executor.test.ts`                                      | `nano-usd` path repoint.                                   | import-path only                                    |
| `src/legal/legal.test.ts`                                        | Constants import split across the two halves + `fees` path. | import-path only                                    |
| `src/models/premium-check.test.ts`                               | —                                                          | **untouched** (imports only `./premium-check.js`)   |
| `scripts/readme/generate-readme.test.ts`                         | Relative source-path repoint.                              | import-path only                                    |
| `scripts/readme/generate-tables.test.ts`                         | Relative source-path repoint.                              | import-path only                                    |
| `packages/config/eslint-extensions/rules/fee-seams.test.mjs`     | Allowlist-inventory pin + one positive-control path string. | **data update** — the pinned inventory is the rule's contract; assertions unchanged |

The two `constants.test.ts` files together contain exactly the pre-move describe blocks, moved
not rewritten. Two pre-existing oddities were preserved rather than "fixed", to keep the change
a split: `MAX_CONVERSATION_MEMBERS` was nested inside `describe('Storage Fee Constants')` (it is
now a top-level describe in the non-money file, since its parent describe went to the money
half — the only structural consequence of the split), and `MIN_PASSWORD_LENGTH`/`MIN_DEPOSIT_USD`
remain nested inside `describe('DELETE_ACCOUNT_CONFIRMATION_PHRASE')`.

---

## Decision: `models/premium-check.ts` stays where it is

**Decision: it does NOT move into the module.** It remains at
`packages/shared/src/models/premium-check.ts`, with its four import paths repointed.

**The reasoning that drove it.** The criterion governing this whole task is the one the plan
states for the closed set: *leaving any behind creates a cycle*. For `premium-check.ts` the
implication runs the other way — **moving it in is what creates a cycle.**

```
premium-check.ts → models/types.ts   (type-only: RawModel)
models/types.ts  → schemas/api/models.ts   (type-only, for ProcessedModels)
schemas/api/models.ts → model-descriptor.ts   ← inside the money set
```

So admitting `premium-check.ts` requires putting `models/types.ts` on the import allowlist, and
`models/types.ts` transitively reaches back into the money set. My brief names that exact shape
as a stop condition ("a shared module that itself imports the money set … is a genuine cycle,
not an allowlist entry"). Left outside, `premium-check.ts` is a leaf consumer and the
production allowlist stays at a single external dependency (`zod`).

The counter-arguments are real and I record them rather than bury them: BILLING.md §The public
surface names "tier and premium classification" as one structural seam, and `tiers.ts` moved
while premium classification did not; and five of `premium-check.ts`'s six imports are the money
set. Both point at moving it — but neither dissolves the cycle, and B1's mandate is behaviour
identity, not signature redesign.

**What would reverse it — two triggers, in preference order:**

1. **B2's `PriceableModel` lands.** BILLING.md §Data Structures says the money layer consumes a
   narrow projection and "never sees a full catalog row" — yet `premium-check.ts` takes
   `RawModel`, a full raw catalog row. Re-signing `isPremiumModel`/`exceedsTrialBudget` onto
   `PriceableModel` (or an equally narrow structural parameter) deletes the `models/types.ts`
   edge, and the move becomes free. `RawModel` is structurally assignable to such a parameter,
   so no call site would change. **This is the natural moment; I recommend B2 or B8 take it.**
2. **G1 rule 4 cannot be written without an exception for it.** `isPremiumModel` computes
   `Number.parseFloat(pricing.prompt) + Number.parseFloat(pricing.completion)` and compares it
   to a percentile threshold — that **is** rate arithmetic, living outside the module. If G1
   would need an allowlisted carve-out to keep rule 4 honest, the wall is better served by
   moving the file (via trigger 1) than by punching a hole. **Raised to G1.**

The decision pulled **no** additional files into the closed set, so the enumerated set is
exactly the plan's list.

---

## PROPOSAL — `docs/BILLING.md` path-diff (not edited; `.md` is read-only to me)

The plan estimated "roughly fourteen". **The actual count is 19 lines carrying 24 distinct
old → new path pairs**, plus 3 lines that carry a `packages/shared/src/` citation which
correctly needs **no** change. Line numbers are against the current file.

| Line | Old                                                     | New                                                                     |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| 224  | `packages/shared/src/tiers.ts`                           | `packages/shared/src/affordability/tiers.ts`                            |
| 1014 | `packages/shared/src/billing/funding-decision.ts`        | `packages/shared/src/affordability/billing/funding-decision.ts`         |
| 1015 | `billing/client-billing.ts`                              | `affordability/billing/client-billing.ts`                               |
| 1275 | `packages/shared/src/constants.ts`                       | `packages/shared/src/affordability/constants.ts`                        |
| 1276 | `packages/shared/src/money.ts`                           | `packages/shared/src/affordability/money.ts`                            |
| 1276 | `packages/shared/src/pricing.ts`                         | `packages/shared/src/affordability/pricing.ts`                          |
| 1285 | `packages/shared/src/estimate/storage-rate.ts`           | `packages/shared/src/affordability/estimate/storage-rate.ts`            |
| 1350 | `packages/shared/src/tiers.ts`                           | `packages/shared/src/affordability/tiers.ts`                            |
| 1378 | `packages/shared/src/money.ts`                           | `packages/shared/src/affordability/money.ts`                            |
| 1379 | `packages/shared/src/estimate/`                          | `packages/shared/src/affordability/estimate/`                           |
| 1380 | `packages/shared/src/estimate/storage-rate.ts`           | `packages/shared/src/affordability/estimate/storage-rate.ts`            |
| 1380 | `packages/shared/src/constants.ts`                       | `packages/shared/src/affordability/constants.ts`                        |
| 1381 | `packages/shared/src/constants.ts`                       | `packages/shared/src/affordability/constants.ts`                        |
| 1382 | `packages/shared/src/constants.ts`                       | `packages/shared/src/affordability/constants.ts`                        |
| 1383 | `packages/shared/src/constants.ts`                       | `packages/shared/src/affordability/constants.ts`                        |
| 1384 | `packages/shared/src/tiers.ts`                           | `packages/shared/src/affordability/constants.ts` — **also a fact fix**   |
| 1387 | `packages/shared/src/tiers.ts`                           | `packages/shared/src/affordability/tiers.ts`                            |
| 1388 | `packages/shared/src/billing/funding-decision.ts`        | `packages/shared/src/affordability/billing/funding-decision.ts`         |
| 1388 | `billing/client-billing.ts`                              | `affordability/billing/client-billing.ts`                               |
| 1390 | `packages/shared/src/reasoning-effort.ts`                | `packages/shared/src/affordability/reasoning-effort.ts`                 |
| 1390 | `packages/shared/src/estimate/reasoning-plan.ts`         | `packages/shared/src/affordability/estimate/reasoning-plan.ts`          |
| 1391 | `packages/shared/src/param-spec.ts`                      | `packages/shared/src/affordability/param-spec.ts`                       |
| 1395 | `packages/shared/src/tiers.ts`                           | `packages/shared/src/affordability/tiers.ts`                            |
| 1395 | `packages/shared/src/constants.ts`                       | `packages/shared/src/affordability/constants.ts`                        |

**Correctly unchanged** (do not rewrite these): line 272 and line 1389
(`packages/shared/src/models/premium-check.ts` — the file stays put, per the decision above)
and line 1386 (`packages/shared/src/constants.ts` for `MAX_SELECTED_MODELS` — non-money half).

**Three factual defects found while producing the diff** — reported, not silently changed:

1. **Line 1384** says the cushion lives in `tiers.ts`. `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` was
   defined in `constants.ts` (now `affordability/constants.ts`) before this task and still is.
   Pre-existing error; the "new" column above already reflects the true home.
2. **Line 1383** (and line 32, §Math & Terms) names the markup constant `FEE_RATE`. No such
   export exists anywhere in the repo; the constant is `TOTAL_FEE_RATE` (= 0.15, the sum of the
   three component rates). Either the doc or the code is wrong on the name — a founder call.
3. **Line 1382** cites `OUTLIER_COST_MULTIPLE` = 20 as if it exists. It does not exist yet
   (grep-clean repo-wide); B5 owns it. When B5 adds it, rule (a) puts it in
   `affordability/constants.ts`, which is what the line above already says.

---

## Importer sweep (Global Constraint 10)

### Cross-workspace — 158 files, **zero edits required**

Files importing at least one symbol that is now in the affordability barrel's export set, from
`@hushbox/shared` or a `packages/shared/src/…` path:

| Workspace           | Money-symbol importer files | Disposition                                      |
| ------------------- | --------------------------- | ------------------------------------------------ |
| `apps/api`          | 104                         | no edit — root barrel, export set unchanged      |
| `apps/web`          | 32                          | no edit — root barrel                            |
| `scripts`           | 6 (+4 edited, below)        | 4 edited: relative source paths, not the barrel  |
| `apps/marketing`    | 5                           | no edit — root barrel                            |
| `packages/ui`       | 4                           | no edit — root barrel                            |
| `packages/db`       | 4                           | no edit — root barrel                            |
| `apps/admin`        | 1                           | no edit — root barrel                            |
| `packages/config`   | 1                           | edited: the fee-seam path allowlist (below)      |
| `e2e`               | 1                           | no edit — imports `DEV_PASSWORD`/`TEST_EMAIL_DOMAIN`, both non-money half |
| `apps/sandbox`      | 0                           | —                                                |
| `packages/realtime` | 0                           | —                                                |
| `packages/crypto`   | 0                           | —                                                |
| `ops`              | 0                           | —                                                |

The reason 158 files need no edit is criterion 5's first demonstration: the root barrel's export
set is name-for-name identical, so every consumer that goes through `@hushbox/shared` is
untouched by construction. That is also what makes B1b's job real rather than already-done.

`e2e` was checked specifically (Global Constraint 11): its four `packages/shared/src/constants.js`
imports all name non-money constants and required no change. No E2E code was executed.

### Intra-package (`packages/shared`) — 16 files repointed

`index.ts` · `admin/ops.ts` · `admin/wire.ts` · `content-value.ts` · `flow-executor.ts` ·
`flow-executor.test.ts` · `formatting.ts` · `inference.ts` · `mock-directives.ts` ·
`schemas/api/models.ts` · `schemas/api/public-usage-stats.ts` · `type-tag.ts` ·
`models/premium-check.ts` · `legal/terms-sections.ts` · `legal/legal.test.ts` ·
`constants.test.ts`

These were repointed to the **exact moved file paths**, not to `affordability/index.js`. That
keeps the import graph's shape byte-identical (no new eager module edges, no bundle-size change
in `apps/web`) and leaves G1 free to decide whether intra-package access must go through the
barrel. **This list is G1 rule 1's inbox** — the plan's own note says that rule "covers the
intra-package relative path, which is where the reach exists". Twelve of the sixteen reach in
only for a relocated general primitive (`Modality`, `NanoUSD`, `ModelDescriptor`, `ParamSpec`),
not for pricing.

### Relative source-path importers outside the package — 4 files edited

`scripts/readme/{generate-readme.ts, generate-readme.test.ts, generate-tables.ts,
generate-tables.test.ts}` import `constants.js`, `fees.js` and `tiers.js` by relative source
path rather than by package specifier. Both generators also carry **cache-input path lists**
(`collectReadmeInputs`, the tables equivalent) naming
`packages/shared/src/{constants,fees,tiers}.ts` — those are README-cache hash inputs, so a stale
entry would have silently stopped invalidating the generated README. Both lists were updated.

### Configuration that names moved paths — 3 files edited (out of ownership)

See Deviations.

---

## Deviations, with reasons

1. **I edited three files under `packages/config/eslint-extensions/` — G1's file glob.**
   `fee-seams.config.mjs` allowlists fee-application seams by repo-relative path, and two of the
   six entries name files I moved (`packages/shared/src/money.ts`,
   `packages/shared/src/estimate/search-reservation.ts`). Not updating them left `pnpm lint` red
   with a real error on `affordability/estimate/search-reservation.ts` **and** silently unhooked
   the fee-seam protection from `money.ts`. Changes made: the two allowlist strings, the two
   docblock citations of them (`fee-seams.config.mjs`, `rules/fee-seams.mjs`), and in
   `rules/fee-seams.test.mjs` the allowlist-inventory pin plus one positive-control path string.
   **Path renames only — no rule logic, no assertion, no new seam.** Raised so the orchestrator
   can tell G1.

2. **`affordability/index.ts` re-exports `money.ts` by name, not with `export *`.** The
   fee-seams rule flags star re-export of a `money` module as laundering, and its message
   prescribes the fix I applied: "Re-export the needed non-fee symbols by name instead". The
   barrel therefore publishes `MARKUP_BASIS_POINTS`, `roundHalfEvenDiv`, `usdToNanoUsd` and
   **not** `applyMarkup`/`applyMarkupCeil`; the root barrel remains the one sanctioned
   publication site for those two, exactly as today. **B8 should know this**: BILLING.md §The
   public surface lists "the two fee applications" among the barrel's structural seams, so B8
   must either add `affordability/index.ts` to the seam allowlist as a second publication site
   (the root barrel is already listed on exactly that basis) or leave the fee helpers published
   from the root barrel only. I did not decide it — a new publication site is a wall decision,
   not a relocation.

3. **`src/index.ts` gained one line** (`export * from './affordability/constants.js'`). Without
   it the constants split would have deleted 27 names from the root barrel — which is B1b's job,
   not B1's, and would have broken behaviour identity.

4. **The exports-map subpath's proof of external resolution is evidence, not a test.** The
   executable pin asserts the map entry and its target; resolution *from outside the package* was
   verified by running the import from `apps/api` (output quoted under criterion 1). A test that
   proved it would have to live in another workspace, which is scope B8 owns.

5. **One assertion in my own new test was changed after first red.** `applyMarkupCeil` was my
   sample symbol for `money.ts`; the fee-seams rule then proved it must not be on the barrel, so
   the sample became `usdToNanoUsd`. That is a corrected test premise, not a weakened
   assertion — the identity assertion itself is unchanged and 17 units are still covered.

---

## Concerns and limitations

1. **The relocation puts four general-purpose primitives behind the money barrel.**
   `modality.ts`, `nano-usd.ts`, `param-spec.ts` and `model-descriptor.ts` are on the plan's
   enumerated closed set, but unlike `estimate/`↔`smart-model/` (a genuine mutual cycle) they are
   **leaves** — leaving them behind would not have created a cycle. Moving them means
   `type-tag.ts`, `inference.ts`, `content-value.ts`, `flow-executor.ts`, `admin/*` and two
   `schemas/api/*` modules now reach into `affordability/` for `Modality`, `NanoUSD`,
   `ModelDescriptor` and `ParamSpec`. I followed the enumeration as normative. Consequences for
   downstream tasks: none of those four symbols is on §Where the Code Lives' not-exported list,
   so B1b must keep them reachable; and G1 rule 1 must decide whether a type-only reach for
   `Modality` counts as "access from outside the module". If it does, the honest fix is a
   `Modality`/`NanoUSD` re-home outside the money layer — an architecture question, not a lint
   exception.

2. **A pre-existing api test failure is not on §Known Breakage** (the email-template snapshots).
   Raised; it needs an owner outside this run, and it will otherwise be mis-attributed to
   whichever task next touches `apps/api`.

3. **`pnpm lint:unused` is red for two reasons I could not attribute to a commit.** Both name
   files outside my change set and neither mentions `packages/shared`, but I did not run knip
   against a pristine baseline, so my attribution is by content rather than by observation.

4. **`packages/shared/dist/` holds a stale pre-move build** (`dist/src/constants.js` still
   contains the money constants). It is gitignored and no source imports it; I left it alone. A
   stale `dist` can mislead a future grep.

5. **jscpd was not run.** `pnpm lint:duplication` is not in B1's scoped checks. The root barrel
   and the module barrel now carry two overlapping `export *` lists — deliberately, since they
   are two different surfaces with two different futures (B1b narrows one, B8 narrows the other)
   — but jscpd may see textual similarity at the close phase.

6. **`apps/api/src/slices/models/domain/{estimate,smart-model-candidates}.ts` cite
   `@hushbox/shared/estimate`** in docblocks. That subpath never resolved (verified), so the
   citations were already wrong; my move makes them doubly wrong. Not editable within my
   ownership (they are not importers) — for the close phase's doc pass.

---

## Confidence

**High.** The move is mechanical and every claim is executable: 543 → 543 root-barrel export
names with an empty diff both before and after the final edit; 110/110 shared tests (from a
forced, non-cached 108 baseline); repo-wide typecheck and lint 16/16; the production import
allowlist reduced to a single external dependency by enumeration over all 68 files; and the
subpath's external resolution plus deep-specifier refusal observed from `apps/api`. The two
judgment calls — the `premium-check.ts` decision and the constants split rule — are recorded
with the evidence that drove them and with explicit reversal triggers. Residual risk sits in
concern 1 (a plan-mandated relocation with a downstream wall consequence) rather than in the
mechanics.
