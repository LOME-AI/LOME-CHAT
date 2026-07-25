# Task 12 — impl report 2 (fix round)

## Objective

Address the single Minor audit finding on the passed Task 12 work: the relaunch comment in
`mobile-tests/flows/07-push-notification-prompt.yaml` overstated an app-wide limitation
("the session does not survive a process restart on this build") when the behavior is
specific to the default login path. Narrow it to the accurate, durable fact. Change
nothing else.

## Files changed

| File                                                  | Why                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `mobile-tests/flows/07-push-notification-prompt.yaml` | One comment block narrowed to the default ("Keep me signed in" unchecked) path |

No other file touched, in `mobile-tests/` or anywhere else. No YAML step, selector,
assertion, or flow structure changed; flow 15 untouched.

## The comment — before → after

Before:

```yaml
# The session does not survive a process restart on this build, so signing in
# again is part of the relaunch — which also proves the answer is device-local
# rather than something a new session resets. Reaching the authenticated shell
# is what keeps the assertions below non-vacuous: a signed-out app would hide
# the offer for the wrong reason.
```

After:

```yaml
# This login leaves "Keep me signed in" unchecked (the default), which keeps the
# session marker in sessionStorage — the WebView process restart above clears it,
# so signing in again is part of the relaunch. That also proves the answer is
# device-local rather than something a new session resets. Reaching the
# authenticated shell is what keeps the assertions below non-vacuous: a
# signed-out app would hide the offer for the wrong reason.
```

The claim is now scoped to what this flow actually does (it never taps the checkbox), and
it names the mechanism rather than asserting a build-wide property.

### Grounding for the new wording (verified this round, not taken from the finding)

- `apps/web/src/routes/_auth/login.tsx:337` — `const [keepSignedIn, setKeepSignedIn] =
useState(false)`: unchecked is the default.
- `apps/web/src/routes/_auth/login.tsx:505-510` — a `CheckboxField id="keep-signed-in"`
  labelled "Keep me signed in" is offered, so the app is not limited to one behavior.
- `apps/web/src/lib/auth-client.ts:71-76` (`persistExportKey`) — `keepSignedIn` false writes
  the marker to `sessionStorage`; true writes it to `localStorage`. The doc comment above it
  (lines 57-61) states the same split, so the narrowed comment agrees with the source of
  truth rather than restating a symptom.
- The flow's login blocks never tap `keep-signed-in`, so the default (sessionStorage) path
  is the one this relaunch exercises.

No cross-file sync contract is created: the comment describes why this flow logs in twice,
it does not duplicate the auth-client rule.

G11: the new text carries no task number, plan-section reference, or run bookkeeping, and
narrates the app's behavior rather than the edit ("added", "updated", "now handles" are
absent).

## Self-gate

| Command                                                                            | Result                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npx prettier --check mobile-tests/flows/07-…yaml mobile-tests/flows/15-…yaml`      | pass — "All matched files use Prettier code style", exit 0 |
| js-yaml `loadAll` of flow 07                                                       | pass — 2 documents, header name intact, 43 steps parsed   |
| `pnpm gitleaks detect --no-git --source mobile-tests/flows --config .gitleaks.toml` | pass — "no leaks found", exit 0, ~21.3 KB scanned         |
| `git status --porcelain mobile-tests/`                                             | only flow 07 modified; 14 + 15 untracked, byte-unchanged  |

The js-yaml parse resolved the module by absolute path inside `node_modules/.pnpm/…` — the
alias symlinks from round 1 were removed by the orchestrator and were **not** recreated.

### Change-isolation evidence

`git diff -- mobile-tests/` against HEAD necessarily shows the whole Task-12 rewrite, since
the file is uncommitted. To prove this round changed only the comment, the pre-fix content
was reconstructed by reverse-substituting the edit and diffed against the file on disk:

```
@@ -83,11 +83,12 @@
-# The session does not survive a process restart on this build, so signing in
-# again is part of the relaunch — which also proves the answer is device-local
…
+# This login leaves "Keep me signed in" unchecked (the default), which keeps the
…
hunks: 1
```

One hunk, comment lines only; the surrounding `launchApp`/`extendedWaitUntil` context lines
are unchanged. Against HEAD the rest of the flow-07 diff is byte-identical to what impl
report 1 recorded.

No emulator run: per the fix brief the flows already ran green twice and were not to be
re-run. Nothing executable changed, so a re-run could not have produced new information.

## Acceptance criteria

The task's own criteria were met in round 1 and are untouched by this edit (no step,
selector, or assertion changed). The fix-round criterion:

- **Minor finding addressed — met.** The comment no longer states an app-wide limitation;
  it states the default-path mechanism (sessionStorage marker cleared by the process
  restart), which is verified against `login.tsx` and `auth-client.ts`. It stays terse and
  matches the file's comment style (leading `#` block above the steps it explains, prose
  explaining why the steps exist).
- **Nothing else changed — met.** Single-hunk diff; flow 15 and every other file in
  `mobile-tests/` untouched.

## Deviations

None.

## Concerns and limitations

- If `keepSignedIn` ever becomes default-true, this flow's second login block becomes dead
  weight and the comment goes stale with it. The comment names the checkbox and the storage
  split, so the staleness would be visible at the point of change rather than silent.
- Noted for the orchestrator, not acted on: the enable prompt now renders in flows 10, 11,
  12, and 14, which were not re-run; and the login block duplicated across flows 07, 10, 14,
  and 15 is a harness-convention question for the human.

## Confidence

High — a comment-only edit whose every factual claim was read out of the cited source files
this round, with a single-hunk diff, prettier, YAML-parse, and gitleaks all green.
