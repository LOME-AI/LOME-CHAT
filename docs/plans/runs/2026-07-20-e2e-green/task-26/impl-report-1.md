# Task-26 — Phase-4 e2e/config cleanup — impl-report-1

## Objective

Clear the remaining non-e2e gate failures and stale markers so pre-push is green:
knip unused exports in the idempotent-request wrappers, two stale
`CONVERSATION_NOT_FOUND` opt-outs, and verification that the staged
`vitest.config.ts` change is benign.

## Files changed

- `e2e/helpers/idempotent-request.ts` — removed the unused `idempotentPatch`
  and `idempotentDelete` exports (Task-06 added them; nothing consumes them);
  narrowed the internal `mutate` method union from
  `'post' | 'put' | 'patch' | 'delete'` to `'post' | 'put'` to match the
  surviving surface.
- `e2e/helpers/member-actions.ts` — removed the stale
  `/"code":"CONVERSATION_NOT_FOUND"/` opt-out entry; updated the doc comment
  prose `404 CONVERSATION_NOT_FOUND` → `404 NOT_FOUND` to stay truthful.
- `e2e/sharing/inbox-decline-invite.spec.ts` — same stale opt-out entry removed;
  same comment prose corrected.

`packages/config/vitest.config.ts` — NOT edited (read-only verify; benign).

## Tests added

None. This is a test/harness cleanup task: it removes dead exports and dead
allowlist entries. No production behavior changes, so there is no new behavior
to pin with a test. Proof is the gate commands (knip / eslint / typecheck)
returning exit 0.

## Decisions

### Criterion 1 — knip: trim vs wire (completeness principle)

Decision: **trim to the used set (POST/PUT)**. Evidence gathered:

- Wrapper consumers across `e2e/`: only `idempotentPost` and `idempotentPut`
  are imported/called (banner.ts, budget.ts, billing.spec.ts, feedback.ts).
  `idempotentPatch` / `idempotentDelete` had zero call sites.
- Raw PATCH call sites in `e2e/`: **none**.
- Raw DELETE call sites in `e2e/`: `helpers/auth.ts` (`/dev/auth-rate-limits`,
  `/dev/usage-rate-limits`, `/dev/totp-replay`) and `chat/trial-chat.spec.ts`
  (`/dev/trial-usage`). Every one of these routes is registered
  `idempotencyExempt('naturally-idempotent')` in
  `apps/api/src/platform/dev/routes.ts` (lines ~480–524), so the idempotency
  middleware (`apps/api/src/lib/idempotency/middleware.ts` — gates only
  non-exempt mutating routes) does not require an `Idempotency-Key` for them.
  They therefore legitimately must NOT route through the wrapper (the wrapper
  mints a key; these routes want none). Wiring them would be wrong.

Because no mutating call site should adopt PATCH/DELETE wrappers, trimming is
the correct resolution.

### Criterion 2 — stale opt-out removal is runtime-safe

Matcher semantics (`e2e/fixtures.ts:630`):
`captured.filter((line) => !allowed.some((pattern) => pattern.test(line)))` —
a captured API-error line is allowed if it matches ANY pattern. Each captured
line is a single string combining status + method + URL + body
(`attachApiErrors`, fixtures.ts:181–192). The surviving URL-shaped pattern
(`/404 Not Found GET .*\/(budgets|conversations|keys|links|members)\/…/` and
the inbox-decline equivalent) already matches the whole 404 line regardless of
body, so it alone allows every deliberate 404 the test provokes. The
`"code":"CONVERSATION_NOT_FOUND"` pattern was redundant belt-and-suspenders and
is now dead: per Task-19 the app emits `NOT_FOUND`, so no captured body contains
`CONVERSATION_NOT_FOUND`.

Removal cannot unmask a real failure: a `NOT_FOUND`-body 404 line is either
already covered by the URL pattern (allowed, as before) or already NOT covered
(in which case it was already failing regardless of the removed body pattern —
the body pattern never matched `NOT_FOUND`). No new failure surface is created
by the removal at any layer.

Runtime confirmation (that the two flows still emit only the allowlisted 404s)
is an e2e-observable fact; per Global Constraints it is deferred to the
orchestrator's centralized `pnpm e2e` run. Nothing in the removal is expected to
change that run's outcome.

### Criterion 3 — vitest.config.ts staged change is benign

`git diff --staged -- packages/config/vitest.config.ts` is a single hunk, single
line:

```
-      poolOptions: { forks: { execArgv: ['--max-old-space-size=2048'] } },
+      poolOptions: { forks: { execArgv: ['--max-old-space-size=8192'] } },
```

It is a Node old-space memory bump only, and it lives inside the
`coverageForkCap` object which is applied only when `process.argv` includes
`--coverage`. It does NOT alter test roots, include/exclude globs, `legacy/`
inclusion, the coverage provider, thresholds, or any gate behavior. Benign —
confirmed, not edited.

## Self-gate

- `pnpm lint:unused` (knip) — **pass** — exit 0, no unused exports reported.
- e2e eslint (`pnpm exec eslint .` from `e2e/`) — **pass** — exit 0, clean.
- e2e typecheck (`pnpm typecheck` → `tsgo --noEmit` from `e2e/`) — **pass** —
  exit 0.
- jscpd (`pnpm lint:duplication`) — not run; edits only delete lines, which
  cannot increase duplication.

## Acceptance criteria

1. knip 2 unused exports resolved — **met** — trimmed `idempotentPatch`/
   `idempotentDelete`; `pnpm lint:unused` exit 0. Decision documented above
   (trim, not wire; dev DELETE routes are `naturally-idempotent`-exempt).
2. Two stale `CONVERSATION_NOT_FOUND` opt-outs removed — **met** —
   member-actions.ts and inbox-decline-invite.spec.ts; runtime-safety reasoned
   above (redundant under ANY-match; URL pattern still covers the line).
3. vitest.config.ts benign-verify — **met** — memory bump only, `--coverage`-
   gated; no test-root/coverage-gate change. Not edited.
4. Proof: knip pass + e2e eslint/typecheck exit 0 — **met**.

## Deviations

- Also corrected the doc-comment prose (`CONVERSATION_NOT_FOUND` → `NOT_FOUND`)
  in both opt-out files. Not strictly listed, but a comment left describing the
  removed/old code would be a wrong comment (worse than none); surgical and
  within file ownership.

## Concerns and limitations

- The two opt-out removals' runtime effect is only fully provable at the e2e
  layer, deferred to the orchestrator's consolidated `pnpm e2e` run per Global
  Constraints. Static analysis (matcher semantics + capture format) shows the
  removal is safe; if the app has NOT fully migrated a given prefetch to
  `NOT_FOUND` and still emits `CONVERSATION_NOT_FOUND` on a URL the surviving
  pattern does not cover, that flow would fail — but that is Task-19's contract,
  not this task's, and would be a real (correct) failure to surface, not
  something to re-mask.

## Confidence

high — all three gates pass at exit 0; the trim decision is grounded in
verified exemption registrations and a full call-site sweep; the opt-out removal
safety is grounded in the read matcher semantics and capture format.
