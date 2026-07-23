# Task 01 — impl-report-1

## Objective

Make the native optional OTA update surface the existing blocking `UpgradeRequiredModal` and
wait for a tap (stop silent auto-apply); make the modal's verb platform-aware
(native `Update` / web `Refresh`); retire the now-dead `otaInProgress` flag.

## Files changed

- `apps/web/src/stores/app-version.ts` — removed `otaInProgress` field and `setOtaInProgress`
  action from both the `AppVersionState` interface and the store implementation (plus their
  now-inapplicable doc comment). `upgradeRequired`/`currentVersion`/`updateUrl`/`setUpgradeRequired`
  unchanged.
- `apps/web/src/stores/app-version.test.ts` — dropped the two `otaInProgress`/`setOtaInProgress`
  tests and the `otaInProgress` key from `beforeEach`'s `setState`; added one assertion that the
  store no longer exposes those keys. All other store-behavior tests retained.
- `apps/web/src/capacitor/hooks/use-live-update.ts` — replaced `checkAndApply` (which set
  `otaInProgress` and called `applyUpdate`) with `checkForOptionalUpdate`, which on
  `updateAvailable` calls `setUpgradeRequired(true)` (no details) and never applies. Removed the
  `applyUpdate` import. Guarded `onResume` with `isNative()` so non-native stays a no-op. Doc
  comments now state it *surfaces the blocking modal*.
- `apps/web/src/capacitor/hooks/use-live-update.test.ts` — rewrote assertions to the new behavior
  (native+updateAvailable ⇒ `upgradeRequired` true and `applyUpdate` not called; native+no-update ⇒
  `upgradeRequired` untouched; resume re-checks and surfaces; web no-op on mount and resume). No
  `otaInProgress` assertions remain.
- `apps/web/src/components/shared/upgrade-required-modal.tsx` — render guard is now
  `if (!upgradeRequired) return null;` (removed the `|| otaInProgress` term and the store read).
  Description text and idle button label are platform-aware via the already-imported `isNative()`.
  `handleRefresh`'s native-vs-web branch is unchanged.
- `apps/web/src/components/shared/upgrade-required-modal.test.tsx` — dropped the `otaInProgress`
  keys from `setState` calls, removed the "stays hidden while OTA in progress" suppression test,
  and split the copy tests into web (`Refresh` + "Please refresh to continue.") and native
  (`Update` + "Please update to continue.") assertions with `isNative()` mocked accordingly.

## Tests added / changed

- `app-version.test.ts` — `does not expose otaInProgress state or a setOtaInProgress action`
  (covers the store-surface removal — criterion 1).
- `use-live-update.test.ts` — `surfaces the upgrade modal on mount when an update is available,
  without applying`; `leaves upgradeRequired untouched on mount when no update is available`;
  `surfaces the upgrade modal on resume when an update is available`; `does not check for updates
  on resume when web` (covers criterion 2, incl. the `onResume` non-native branch).
- `upgrade-required-modal.test.tsx` — `renders refresh copy on web`; `renders update copy on
  native` (covers criterion 3 platform-aware copy).

## Self-gate

- `pnpm exec vitest run` on the three test files — pass — 3 files, 31 tests.
- Coverage on the three source files (v8, include-scoped) — pass — 100% statements (37/37),
  100% branches (26/26), 100% functions (11/11), 100% lines (32/32). Aggregate is 100% across
  exactly the three included files ⟹ each file is 100% on all four metrics. (The three `*.test.ts`
  files are the tests themselves and are not coverage-measured source.)
- `eslint` on all six owned files, run last from `apps/web` after the final edit — exit 0.
  (One prior run flagged a needless `async` on the web-resume test — `@typescript-eslint/require-await`
  — fixed by removing `async`, then re-ran to exit 0.)
- `jscpd --threshold 2` on the six paths — pass — 0 clones (0% duplicated).
- `turbo typecheck lint --filter=@hushbox/web --force` — **typecheck FAILED**, but on a file
  outside this task's ownership and unrelated to this change:
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): error TS2304: Cannot find name
  'ExecutionContext'.` That api file is unmodified in the working tree (`git status` clean on it),
  the error is a Cloudflare-Workers-types resolution issue in `@hushbox/api`, and `tsgo` reported
  no error in any `apps/web` file. Attribution: pre-existing/cross-package, not caused by this
  task. The `lint` task in the same turbo run reported `ELIFECYCLE Command failed` with no eslint
  diagnostics printed — consistent with turbo aborting the parallel task on the typecheck failure;
  the standalone `eslint` gate on the owned files passes (exit 0).

## Acceptance criteria

1. Store field removed — **met.** `otaInProgress`/`setOtaInProgress` gone from interface and
   implementation; other store behavior unchanged and still tested; absence pinned by a new test.
2. Hook surfaces modal, never applies — **met.** `checkForOptionalUpdate` calls
   `setUpgradeRequired(true)` only on `updateAvailable`, no `details`; `applyUpdate` import removed;
   no `otaInProgress` reference; non-native no-op on both mount and resume; no-update leaves
   `upgradeRequired` untouched; doc comments updated.
3. Modal platform-aware copy — **met.** Guard is `if (!upgradeRequired) return null;`; native
   renders `Update` + "A new version is available. Please update to continue."; web renders
   `Refresh` + "A new version is available. Please refresh to continue."; title stays `Update
   Required`; `Updating...` spinner unchanged; `handleRefresh` branch unchanged; all
   `TEST_IDS.upgradeRequired*` preserved.
4. Tests updated for all three source files — **met** (see Tests above).
5. Scoped gates green + TDD (RED observed before GREEN) + ≥95% per-file coverage — **met for the
   in-scope gates** (test, coverage, jscpd, eslint on owned files). The turbo typecheck gate fails
   only on the out-of-ownership `@hushbox/api` file described above.

## RED observed (evidence)

- Store field removed — `AssertionError: expected [ 'upgradeRequired', …(5) ] to not include
  'otaInProgress'` (app-version.test.ts:20) before removing the field.
- Hook sets `upgradeRequired`, not apply — hook test RED against the old impl:
  `TypeError: setOtaInProgress is not a function` at use-live-update.ts (old `checkAndApply`), and
  the new `upgradeRequired`/`applyUpdate`-not-called assertions failed because the old path applied
  instead of surfacing the modal (5 failed / 3 passed).
- Platform-aware copy — `expect(element).toHaveTextContent()` Expected `Update`, Received
  `Refresh` (upgrade-required-modal.test.tsx:74) before making the copy platform-aware.

## Deviations

- Added an `if (!isNative()) return;` guard to the hook's `onResume` (the old `onResume` called the
  check unconditionally). Required to satisfy criterion 2's "on non-native it remains a no-op" for
  the resume path; covered by a new web-resume test.

## Concerns and limitations

- `turbo typecheck --filter=@hushbox/web` cannot go green while `@hushbox/api`'s
  `pipeline-bindings.ts` has the `ExecutionContext` type error (web's typecheck pulls the api file
  via project references). This is outside this task's file ownership; an auditor running the full
  turbo typecheck gate will see it fail for that pre-existing reason.
- `handleRefresh` now calls `isNative()` a second time (render also computes `native`); left as-is
  because the plan requires `handleRefresh` unchanged.

## Confidence

High — all in-scope behaviors are test-driven (RED→GREEN observed), owned-file eslint is exit 0,
per-file coverage is 100%, and the only failing gate is attributable with evidence to an
unmodified file in another package.
