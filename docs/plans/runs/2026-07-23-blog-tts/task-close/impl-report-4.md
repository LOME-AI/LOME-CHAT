# impl-report-4 — CLOSE FIX CYCLE 2, ninth instance (one clause, one file)

## Objective

Delete the universal-reach clause at `scripts/build-admin-bundle.ts:19-21`, keeping only the
grounded part. Add nothing: no replacement claim, no qualification, no explanation of the
deletion. Single-clause deletion in a single file; no behaviour change, no test change.

## Files changed

- `scripts/build-admin-bundle.ts` — deleted the "the guard belongs where every admin build
  passes through it, including" clause from the module docblock. Nothing else in the file
  changed.

## Old and new text

**Old (lines 16-21):**

```
 * origin with no marketing content. Admin's own security headers (CSP +
 * `X-Frame-Options` + HSTS) are emitted by the admin Vite build's dist-finalize
 * plugin (`apps/admin/vite.config.ts`), not assembled here — and so is the
 * bundle guard, which is why this script does not run one: the guard belongs
 * where every admin build passes through it, including the deployed
 * `admin-dist` that never comes near this file.
```

**New (lines 16-20):**

```
 * origin with no marketing content. Admin's own security headers (CSP +
 * `X-Frame-Options` + HSTS) are emitted by the admin Vite build's dist-finalize
 * plugin (`apps/admin/vite.config.ts`), not assembled here — and so is the
 * bundle guard, which is why this script does not run one: the deployed
 * `admin-dist` never comes near this file.
```

The removed string is exactly `the guard belongs where every admin build passes through it,
including ` plus the `that` of `that never comes near this file`, rewrapped. Every surviving
word is verbatim from the old text.

## Grounding for the clause that was kept

"the deployed `admin-dist` never comes near this file" — the `admin-dist` artifact is
produced by the `Build` step's `pnpm build` (`.github/workflows/ci.yml:284-285`) and uploaded
from `apps/admin/dist` (`ci.yml:324-328`, `name: admin-dist`); the deploy job downloads that
same artifact (`ci.yml:890-893`). Neither step invokes `scripts/build-admin-bundle.ts`, and
that script's only public entry (`buildAdminBundle`) is reached from `pnpm build:e2e:admin`,
not from `pnpm build`. `release.yml` has no admin path at all (`grep -n admin
.github/workflows/release.yml` → no matches). The clause names one artifact and one negative
about this file; it asserts nothing about reach in general.

## Confirmation: no new assertion of any kind

The edit is a pure deletion plus rewrap. No word in the new text is absent from the old text.
No replacement reach claim, no qualifier ("most", "the production path", "today"), no
explanatory note about why the clause went, no plan/run/task reference.

## Confirmation: nothing else changed

- Exactly one `Edit` call was made this task, on `scripts/build-admin-bundle.ts`.
- `ls --time-style=+%H:%M:%S scripts/build-admin-bundle*.ts` → `build-admin-bundle.ts 12:29:21`
  (my edit), `build-admin-bundle.test.ts 00:48:57` (untouched, predates this task).
- The `git diff` for this file against HEAD also shows X5a's earlier code removal (the
  `verify`/`appBundleOptions` import, dep field, call, and its comment). That is prior work
  already in the tree at task start, not this task's; my delta is the docblock clause above.
- No test file, workflow, config, or other source file was opened for writing.

## Tests added

None. Comment-only deletion — nothing executable changed, so there is no behaviour to pin.
This matches the precedent set for the eight prior instances of this class in this run
(`impl-report-3.md` §"Tests added"); guarding a comment with a mechanism would be the second
mechanism CODE-RULES forbids.

## Self-gate

All run from `scripts/` (the package directory), after the last edit:

| command | result |
| --- | --- |
| `npx eslint build-admin-bundle.ts` | pass — exit 0, no output |
| `npx prettier --check build-admin-bundle.ts` | pass — "All matched files use Prettier code style!" |
| `npx tsgo --noEmit` (the package's `typecheck` script) | pass — exit 0, zero output lines |
| `npx vitest run build-admin-bundle.test.ts --root .` | pass — exit 0, 1 file / 5 tests passed |

No failures to attribute. The foreign `TS6133 'pinned'` at
`apps/api/src/slices/models/domain/smart-model-candidates.ts:190` named in the brief no
longer reproduces: that file (mtime 12:24, before my 12:29 edit) now declares the parameter
as `_pinned` at line 194, so another workstream fixed it. Not mine either way, and the
`@hushbox/scripts` typecheck above is green regardless.

Per the brief, `pnpm install`, `pnpm generate:env` and any `node_modules/.vite` clearing were
not run, and the two `scripts/` test files that fail at module load for a foreign reason were
not invoked — the single test file in this task's path was run directly by name.

## Acceptance criteria

1. **The universal clause at `scripts/build-admin-bundle.ts:19-21` is deleted** — MET. Old
   and new text above; the words "every admin build passes through it" no longer appear in
   the file (`grep -c "every admin build" scripts/build-admin-bundle.ts` → 0 by inspection of
   the new text).
2. **Only the grounded part kept; nothing added** — MET. Surviving clause names the deployed
   `admin-dist` and is grounded at `ci.yml:284-285` / `:324-328`; every surviving word is
   verbatim from the old text.
3. **Single-file, single-clause, no behaviour change** — MET. One file, one docblock hunk,
   no code, no test, no other file.

## Deviations

None.

## Concerns and limitations

- The kept clause is still a statement about this file's relation to a build path, and it
  can go stale if a future workflow ever routes the deployed admin build through
  `build:e2e:admin`. It is grounded by file:line today and asserts no universal, which is
  what the deletion rule requires; nothing pins it, because comments are not testable.
- This is the ninth instance of the class. Per the plan's own escalation, the systemic
  question — whether comments asserting where a guard runs should be written at all — is with
  the founder; this report does not attempt to answer it.

## Confidence

High — a pure deletion with no new words, all four scoped checks green from the package
directory after the last edit, and the surviving clause grounded at named workflow lines.
