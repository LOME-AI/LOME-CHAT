# Task 07 — fix one Minor finding — impl-report-2

## Objective

Fix the single validated Minor audit finding: `pushManager.subscribe(...)` in
`apps/web/src/sw/handlers.ts` (the `pushsubscriptionchange` path) was an external
call not wrapped in try/catch, so a rejection surfaced as an unhandled `waitUntil`
rejection. Wrap it; on failure return cleanly so the documented G2 backstops
(next-app-start re-registration + server 404/410 pruning) carry it. Change nothing
else — the rest of the audit passed.

## Files changed

- `apps/web/src/sw/handlers.ts` — guarded the `pushManager.subscribe(...)` call in
  `handlePushSubscriptionChange` with try/catch; on rejection the handler returns
  cleanly (no client is notified). Added a comment recording the best-effort (G2)
  rationale and the two backstops.
- `apps/web/src/sw/handlers.test.ts` — added one test proving the handler resolves
  (does not reject) and notifies no client when `subscribe` rejects.

Both files are Task-07 untracked output (`apps/web/src/sw/` is a new, git-untracked
directory); no tracked file was modified.

## Before / after of the guarded call

Before (lines 170–173):

```ts
const subscription = await scope.registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey,
});
```

After:

```ts
// Re-subscribing can reject (permission revoked, push service unreachable). This
// path is best-effort (G2): drop it and let the backstops — the next authenticated
// app start re-registers, and the server prunes dead endpoints on 404/410 — carry
// it, rather than surfacing an unhandled rejection through `waitUntil`.
let subscription: PushSubscriptionLike;
try {
  subscription = await scope.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
} catch {
  return;
}
```

The `catch` does not swallow a real defect: a rejected re-subscribe is a legitimate
best-effort degradation (permission revoked, push service unreachable), and the two
named backstops re-establish the subscription. The failure is not logged (the SW has
no `SafeLogFields` logger and this is a routine, expected best-effort miss, not an
exception path).

## Adjacent external calls in the same path

`scope.clients.matchAll(...)` and `client.postMessage(...)` follow the subscribe. They
are same-origin Service Worker client-messaging surfaces, not the external
network/push-service call the finding flagged; the audit passed the rest of the
handler and they run only after a successful re-subscribe. Left unchanged to keep the
fix surgical to the validated finding. The subscribe guard alone removes the
unhandled-rejection surface that the finding named.

## Tests added

- `handlePushSubscriptionChange > resolves without rejecting and notifies no client
  when re-subscribe fails` — mocks `subscribe` to reject; asserts the handler promise
  `resolves.toBeUndefined()` and that `client.postMessage` was never called.
  Covers the finding's criterion (no unhandled rejection when subscribe throws).

TDD: written first, watched fail with `AssertionError: promise rejected "Error:
subscribe failed" instead of resolving` (the pre-fix behavior), then watched pass
after the guard.

## Self-gate (run from apps/web after the last edit)

- `vitest run src/sw` — pass (4 files, 22 tests).
- `vitest run src/sw/handlers.test.ts -t "re-subscribe fails"` — RED before fix
  (promise rejected instead of resolving), GREEN after.
- `eslint src/sw/handlers.ts src/sw/handlers.test.ts` — exit 0.
- Coverage: `vitest run src/sw src/lib/register-sw.test.ts --coverage` produces zero
  `ERROR: ... does not meet global threshold (95%)` lines for `src/sw/handlers.ts` or
  `src/lib/register-sw.ts` — both owned files remain ≥95% per-file. (The project
  coverage config measures the whole app; the many unrelated threshold ERRORs are for
  files this task neither owns nor runs.)

## Acceptance criteria

- External `subscribe` call wrapped in try/catch; returns cleanly on failure so the
  G2 backstops carry it — MET (see before/after).
- Unit test asserts the handler does not reject when subscribe throws — MET.
- Nothing else changed — MET (only the two `sw/` files; the tree's other modified
  files are pre-existing concurrent-workstream changes present at the start snapshot).
- Scoped checks green after the last edit — MET (vitest, eslint, per-file coverage).

## Deviations with reasons

None. Adjacent `matchAll`/`postMessage` left unguarded is a deliberate scope
decision, documented above, not a deviation from the finding.

## Concerns and limitations

None. The fix is a strict superset-safe guard on a best-effort path.

## Confidence

high — the finding was a precise one-line external-call guard; the reproduction test
failed for exactly the diagnosed reason (unhandled rejection) and passes after the
minimal guard, with no other code touched.
