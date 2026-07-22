# T04 — R12: restore link/guest display-name cap 200 → 100 · impl-report-1

## Objective
Restore the link/guest display-name cap from 200 back to the legacy value of 100, documented as the deliberate legacy-matched limit. All three same-file consumers must honor it.

## Files changed
- `apps/api/src/slices/conversations/domain/schemas.ts` — `SHARE_DISPLAY_NAME_MAX_LENGTH` changed `200 → 100`; added a one-line durable comment marking 100 as the deliberate legacy-parity cap.
- `apps/api/src/slices/conversations/domain/schemas.test.ts` — added two boundary tests to the `createLinkBodySchema` describe (accepts 100, rejects 101).

## Tests added
- `createLinkBodySchema > accepts a display name at the 100-char cap` — boundary: 100 chars valid. Covers acceptance criterion (accepts 100).
- `createLinkBodySchema > rejects a display name over the 100-char cap` — boundary: 101 chars rejected. Covers acceptance criterion (rejects 101). This is the RED test: it failed before the constant change (cap was 200, so 101 parsed successfully) and passes after.

TDD: ran the file with cap still at 200 → `rejects … over the 100-char cap` failed for the right reason (101 accepted), `accepts … at the 100-char cap` already green. Changed constant to 100 → all 39 tests green.

## Self-gate
- `pnpm test:watch src/slices/conversations/domain/schemas.test.ts` (from apps/api) — pass — 39 passed (39).
- `npx eslint src/…/schemas.ts src/…/schemas.test.ts` (from apps/api, after last edit) — pass — exit 0.
- `pnpm --filter @hushbox/api typecheck` — pass — exit 0, no errors.
- `pnpm typecheck` (workspace) — fail — one error in `@hushbox/admin` typechecking `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name 'ExecutionContext'`. Attributed outside this task (see below).

## Acceptance criteria
- Restore cap 200 → 100 as deliberate legacy value — **met**. `schemas.ts:32` now `= 100` with durable comment at `:31`.
- All three same-file consumers honor the new value — **met**. Repo-wide grep (source only, `.wrangler`/`dist` excluded) returns exactly the declaration plus three consumers, all in `schemas.ts`: `createLinkBodySchema.displayName` (`:186`, `.optional()`), `changeLinkNameBodySchema.displayName` (`:239`), `setMyNameBodySchema.displayName` (`:244`) — all reference `SHARE_DISPLAY_NAME_MAX_LENGTH`, so the single edit propagates to all three. No external consumer exists → NEEDS_CONTEXT trigger not fired.
- Test rejects 101 / accepts 100 — **met** (see Tests added; RED→GREEN verified).

## Legacy anchor (G1)
`legacy/LEGACY-BEHAVIOR-REPORT.md:935-936` (create-link body): optional `displayName` (`min(1).max(100)`). Report cross-references L994 (admin rename link) and L1002 (third display-name site) as the same `min(1).max(100)` cap across all three legacy display-name fields. New code reproduces 100 across all three current consumers.

## Deviations
None.

## Concerns and limitations
- Workspace `pnpm typecheck` fails in `@hushbox/admin` on `apps/api/src/middleware/pipeline-bindings.ts:59` (`Cannot find name 'ExecutionContext'`). That file is unmodified (absent from `git status`), and a numeric-constant change cannot introduce a missing-Workers-type error. `pnpm --filter @hushbox/api typecheck` is clean. Pre-existing or concurrent-workstream; raised, not fixed (outside file ownership).

## Confidence
High — single-constant restoration, exact legacy anchor confirmed, RED-then-GREEN observed, all three consumers verified to reference the shared constant with no external consumer.
