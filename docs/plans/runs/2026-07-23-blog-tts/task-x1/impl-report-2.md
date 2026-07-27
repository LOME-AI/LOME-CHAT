# X1 — impl report 2 (fix cycle 1)

## Objective

Fix the one validated audit finding: the comment above the verification call in
`scripts/build-admin-bundle.ts` falsely asserted that every admin build passes through
this script, so this call is "the single gate". Comment-only correction. Nothing else in
scope — in particular, no build path is wired (that is the blocked follow-up task).

## Files changed

- `scripts/build-admin-bundle.ts` — the three-line comment above `deps.verify(...)`
  replaced with an accurate four-line one. No code change; `git diff` for this cycle
  touches only those comment lines.

## The comment: old → new

Old (lines 52–54 as audited):

```
  // Every admin build — CI, preview, local — comes through here, so this is the
  // single gate. Admin is declared TTS-free, and only the built artifact can
  // show whether that still holds.
```

New:

```
  // Admin is declared TTS-free, and only the built artifact can show whether
  // that still holds. This gate covers the e2e admin bundle only: the deployed
  // `admin-dist` artifact is produced by `pnpm build` (turbo → the admin app's
  // own `vite build`) and never passes through this script.
```

The false clause ("Every admin build — CI, preview, local — comes through here, so this
is the single gate") is deleted; the surviving clause (why the check exists at all) is
kept verbatim; the replacement states the true scope. Nothing in the new text asserts
anything about what *should* happen, and it carries no task, plan, or run reference.

### Evidence for each factual claim in the new text

| Claim | Evidence |
| --- | --- |
| "This gate covers the e2e admin bundle only" | `buildAdminBundle` has exactly one entry: the `build:e2e:admin` script (`package.json:16` → `tsx scripts/build-admin-bundle.ts`). Repo-wide search for `build:e2e:admin` outside `docs/` and `node_modules` returns exactly three hits: `package.json:16`, `.github/workflows/ci.yml:415` (step "Build e2e admin bundle"), `playwright.config.ts:123` (preview-server command). Verified this session by `grep -rn`. |
| the deployed artifact is `admin-dist` | `ci.yml:318-322` uploads artifact `admin-dist` from `apps/admin/dist`; `ci.yml:886-890` downloads `admin-dist` into `apps/admin/dist` in the deploy job. |
| it "is produced by `pnpm build`" | The build step that precedes that upload is `ci.yml:285-286` `run: pnpm build`; the release workflow does the same (`release.yml:124-125`). No step between them invokes this script. |
| "(turbo → the admin app's own `vite build`)" | `package.json:13` `"build": "turbo build"`; `apps/admin/package.json:8` `"build": "vite build"`. |
| "never passes through this script" | Follows from the two rows above — the only caller chain of `buildAdminBundle` is `build:e2e:admin`, which appears in no deploy path. `ci.yml:410-412`'s own comment says the e2e admin bundle is "Distinct from the deploy job's production `admin-dist` artifact — different build". |

## Tests added

None. This cycle changes a comment; no behaviour exists to drive RED. The finding was a
false statement in prose, not a missing or wrong behaviour, so there is no test that could
have failed before it and passed after.

## No behaviour changed

- `vitest run build-admin-bundle.test.ts verify-web-bundle.test.ts build-web-bundle.test.ts`
  → 3 files, **56 tests passed** — identical to cycle 1's count, with no test edited.
- The admin verification call still throws the same two violations against the real
  checked-in `apps/admin/dist` (exercised as the build exercises it,
  `verifyWebBundle(appBundleOptions(repoRoot, 'apps/admin'))`):

```
Web bundle verification failed (…/apps/admin/dist):
  - TTS artifact in a bundle declared TTS-free: assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm (21596019 B) — …
  - TTS artifact in a bundle declared TTS-free: assets/tts.worker-DGv4QGFc.js (2320009 B) — …
```

Byte-for-byte the same two lines and the same sizes as report 1 recorded.

## Self-gate

| Command (run from `scripts/`, after the last edit) | Result |
| --- | --- |
| `pnpm exec eslint build-admin-bundle.ts` | **pass — exit 0** |
| `pnpm exec tsgo --noEmit` | **pass — exit 0** |
| `vitest run build-admin-bundle.test.ts verify-web-bundle.test.ts build-web-bundle.test.ts` | pass — 3 files, 56 tests |

The package-suite failures attributed to concurrent work in report 1 were not re-run:
this cycle changes no executable line, and the three files owning the changed module all
pass.

## Acceptance criteria

The task's criteria 1–7 were met in cycle 1 and none of their evidence is affected by a
comment edit (same 56 tests, same real-dist violations — see above). The fix-cycle
criterion:

- **The validated finding — met.** The false assertion is gone; the replacement states
  only claims grounded in the evidence table above.

## Deviations

None.

## Concerns and limitations

- The new comment describes the current split between the e2e build path and the deploy
  build path. If the deploy path is ever routed through a verification step, this comment
  is the thing that must change with it — it is a scope statement, so it goes stale
  exactly when the scope changes, which is the intended failure mode rather than a silent
  one.
- The naming debt flagged in report 1 (`verify-web-bundle.ts` / "Web bundle verification
  failed" now covering admin too) is unchanged and still out of scope.

## Confidence

**High.** Every clause of the new comment is backed by a file:line read this session, the
diff is comment-only, and both the test count and the real-artifact failure output are
unchanged from cycle 1.
