# Native OTA update: confirm-before-apply + platform-aware copy

Tier 1. One task, one implementer, one auditor. Not sensitive (no auth/payments/crypto/user-data;
purely client update-flow UX).

## Problem

On the native app, `useLiveUpdate` silently downloads and applies an OTA bundle on startup and
on every resume (no user confirmation — the JS context is destroyed and the app reloads out from
under the user). The user wants the update to **wait for a tap**. The user chose a **blocking**
surface: reuse the existing non-dismissable `UpgradeRequiredModal`.

Separately, that modal's copy says "refresh" on all platforms; on the native app it should say
"update" (an OTA update, not a browser refresh), while on web it keeps "refresh" (web genuinely
does `location.reload()`).

Because the silent auto-apply is the *only* thing that ever set `otaInProgress`, that store flag
(and the modal's `|| otaInProgress` suppression branch) becomes dead once auto-apply is removed —
so it is retired in the same change. The server-426 path (`api-client.ts` → `setUpgradeRequired`)
already surfaces the modal and never used `otaInProgress`, so the reactive path is unaffected.

## Global Constraints

- TDD: every behavior change lands test-first (RED observed) per AGENT-RULES. 95% per-file
  line/branch/function coverage maintained on all six edited files.
- No new user-facing error copy; wording follows PRODUCT.md voice (calm, direct, no hype). The
  native strings mirror the existing web strings exactly except the verb.
- Platform detection uses the existing `isNative()` from `@/capacitor/platform` — do not invent a
  new detection path.
- `apps/web/src/capacitor/live-update.ts` and its test are OUT OF SCOPE and must not change
  (`checkForUpdate` / `applyUpdate` / `getAppVersion` are unchanged and reused as-is).

## Task 01 — Confirm-before-apply, retire otaInProgress, platform-aware modal copy

**Objective:** The native optional OTA update surfaces the blocking modal and waits for a tap
instead of auto-applying; the modal's verb is platform-aware; the dead `otaInProgress` flag is
removed.

**File ownership (may edit only these):**
- `apps/web/src/stores/app-version.ts`
- `apps/web/src/stores/app-version.test.ts`
- `apps/web/src/capacitor/hooks/use-live-update.ts`
- `apps/web/src/capacitor/hooks/use-live-update.test.ts`
- `apps/web/src/components/shared/upgrade-required-modal.tsx`
- `apps/web/src/components/shared/upgrade-required-modal.test.tsx`

**Acceptance criteria (exact, testable):**

1. **Store — `app-version.ts`:** the `otaInProgress: boolean` field and `setOtaInProgress` action
   are removed from both the `AppVersionState` interface and the store implementation. Nothing else
   in the store changes (`upgradeRequired`, `currentVersion`, `updateUrl`, `setUpgradeRequired`
   keep their exact current behavior, including the `details`-vs-no-`details` branches).

2. **Hook — `use-live-update.ts`:** on startup (mount) and on resume (`useAppLifecycle.onResume`),
   when `isNative()`, it calls `checkForUpdate()` and, **only if** the result is
   `updateAvailable === true`, calls `useAppVersionStore.getState().setUpgradeRequired(true)`
   (no `details` argument). It NEVER calls `applyUpdate` (remove that import). It NEVER references
   `otaInProgress`/`setOtaInProgress`. On non-native it remains a no-op. When no update is
   available it must not touch `upgradeRequired`. The `applyUpdate` import is removed; the file's
   doc comments are updated to state it *surfaces the blocking modal* (no longer "downloads and
   applies … destroys JS context").

3. **Modal — `upgrade-required-modal.tsx`:** the render guard becomes `if (!upgradeRequired) return
   null;` (the `|| otaInProgress` term and the `otaInProgress` store read are removed). Copy is
   platform-aware via the already-imported `isNative()`:
   - **native (`isNative() === true`):** description text is exactly `A new version is available.
     Please update to continue.` and the idle button label is exactly `Update`.
   - **web (`isNative() === false`):** description is exactly `A new version is available. Please
     refresh to continue.` and the idle button label is exactly `Refresh` (unchanged from today).
   - The title stays exactly `Update Required` on both platforms. The updating spinner label stays
     `Updating...` (only reachable on native, since web `handleRefresh` calls `location.reload()`
     and returns). `handleRefresh`'s existing native (checkForUpdate+applyUpdate) vs web
     (location.reload) branch is unchanged. All existing `data-testid`s
     (`TEST_IDS.upgradeRequired*`) are preserved.

4. **Tests updated for all three source files:**
   - `use-live-update.test.ts`: native + updateAvailable ⇒ `setUpgradeRequired(true)` called and
     `applyUpdate` NOT called; native + no update ⇒ `upgradeRequired` untouched; non-native ⇒
     no-op; resume re-checks. No `otaInProgress` assertions remain.
   - `upgrade-required-modal.test.tsx`: with `isNative()` mocked true ⇒ renders `Update` + "Please
     update to continue."; mocked false ⇒ renders `Refresh` + "Please refresh to continue.";
     hidden when `!upgradeRequired`; existing tap-behavior tests (native apply path, web reload
     path) preserved. Any test asserting the `otaInProgress` suppression branch is removed.
   - `app-version.test.ts`: `otaInProgress`/`setOtaInProgress` tests removed; remaining store
     behavior still covered.

5. **Scoped gates green** (below), TDD honored (RED observed before GREEN for each new behavior),
   and per-file coverage ≥95% on all six files. Re-run `eslint` on the owned files after the final
   edit (from `apps/web`) and confirm exit 0.

**Design context:** The user reported the native app auto-refreshing without consent; they
explicitly chose a blocking (non-dismissable) confirmation over a dismissable one. Reusing the
existing forced-upgrade modal (rather than a new component) keeps one update surface for both the
proactive check and the reactive server-426 path. `otaInProgress` is removed rather than left inert
because a flag set nowhere is a wrong/transitional artifact and its unreachable modal branch would
drop branch coverage below the gate.

**Interfaces:**
- Consumes: `checkForUpdate()`/`applyUpdate()` from `../live-update` (unchanged); `isNative()` from
  `@/capacitor/platform`; `useAppVersionStore.getState().setUpgradeRequired(required, details?)`
  (unchanged).
- Produces: nothing new exported. Store surface shrinks by `otaInProgress`/`setOtaInProgress`.

**Scoped checks:**
- Test: `pnpm test:web` (or `pnpm test:watch` on the three test files during the loop).
- Typecheck + lint: `turbo typecheck lint --filter=@hushbox/web`.
- Duplication: `jscpd --threshold 2` on the six changed paths.

## Amendments

- **A1 (pre-existing, attribute-around):** `turbo typecheck --filter=@hushbox/web` fails on
  `apps/api/src/middleware/pipeline-bindings.ts:59` — `TS2304: Cannot find name
  'ExecutionContext'` (a Cloudflare-Workers-types config issue in `@hushbox/api`, surfaced in
  web's typecheck via TS project references). Verified unmodified in the working tree
  (absent from `git status`); NOT caused by this run and out of every task's ownership. Auditors
  must treat this specific error as pre-existing and not attribute it to Task 01. Task 01's own
  typecheck of its six files is otherwise clean.

## Related E2E

None. The native OTA path (Capacitor `CapacitorUpdater`) is not reachable by the Playwright web
suite, and no existing E2E references the upgrade modal (grep-confirmed). Web modal behavior is
unchanged (still "Refresh" + `location.reload`). Behavior is fully covered at unit level.
