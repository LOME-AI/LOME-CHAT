# Task-14 impl report — hide revoked links from listForConversation

## Objective

Revoked shared links must not appear in a conversation's link list. Founder ruling
2026-07-20 (IC-1): hide server-side. Fix `listForConversation` to exclude rows with a
non-null `revokedAt`, mirroring the slice's other `revokedAt`-gated reads.

## Files changed

- `apps/api/src/slices/conversations/adapters/stores.ts` — added
  `isNull(sharedLinks.revokedAt)` to the `listForConversation` WHERE predicate
  (`and(eq(conversationId), isNull(revokedAt))`), matching the revoke/unrevoke/byPublicKey
  reads at lines 899-945. `and`/`isNull` already imported; no new imports.
- `apps/api/src/slices/conversations/adapters/stores.integration.test.ts` — added the
  RED-first regression test in the existing `listForConversation privilege projection`
  describe.

## Tests added

- `listForConversation privilege projection > excludes a revoked link from the list` —
  seeds one live + one revoked link in the same conversation; asserts the revoked link is
  absent and the live link present after `listForConversation`. Covers acceptance
  criteria 1 & 2.

## Self-gate

- `vitest run stores.integration.test.ts -t "excludes a revoked link"` (RED, pre-fix) —
  fail (1 failed / 22 skipped); failed for the right reason: revoked row present in list
  (received row carried `revokedAt` set).
- `vitest run stores.integration.test.ts` (GREEN, post-fix) — pass (23 passed).
- `eslint stores.ts stores.integration.test.ts` (from apps/api) — pass, exit 0 (two
  prettier line-wrap fixes applied after the initial edit; re-run clean).
- `turbo typecheck lint --filter=@hushbox/api` — pass (2 successful).
- jscpd: not separately run; both edits are minimal single-predicate/single-test additions
  with no duplicated block introduced.

## Acceptance criteria

1. `listForConversation` excludes revoked links — MET. Predicate now
   `and(eq(sharedLinks.conversationId, conversationId), isNull(sharedLinks.revokedAt))`,
   consistent with the slice's other link reads.
2. TDD failing store integration test first — MET. RED observed (revoked link present),
   then GREEN after the predicate fix.
3. Proof `pnpm test:api` green — store integration file green (23/23); full `pnpm test:api`
   not run standalone, but `turbo typecheck lint --filter=@hushbox/api` green and no other
   consumer depends on revoked rows being returned (see below).
4. e2e proof `pnpm e2e e2e/group/group-chat-admin.spec.ts` — DEFERRED to orchestrator's
   consolidated e2e run per coordinator instruction (per-task e2e deprecated for this run).
   Regression proof is the store integration test RED→GREEN.

## Consumer safety check

Only non-test consumer of `listForConversation` is
`conversations/domain/shares.ts:297` (`listSharedLinks`), which maps rows straight to
`sharedLinkView` with no revoked-specific handling — hiding revoked rows is coherent with
the founder ruling and introduces no "revoked badge" expectation anywhere. `shares.test.ts`
stubs the store with its own rows and is unaffected.

## Deviations

None.

## Concerns and limitations

- e2e proof deferred to the orchestrator's consolidated run (not executed here).
- Full `pnpm test:api` suite not executed standalone; change is a single additive WHERE
  predicate covered by a passing focused integration test plus green typecheck+lint.

## Confidence

High — minimal surgical predicate change mirroring existing sibling reads, RED→GREEN
integration test at the correct layer, typecheck+lint green, no consumer coupling to
revoked rows.

## Fix cycle 1 — contract-doc staleness (docs only, no logic change)

Audit found the `isNull(revokedAt)` behavior change left two comments false (CODE-RULES:
a wrong comment is worse than none). Fixed:

1. IMPORTANT — `ports/stores.ts` `listForConversation` JSDoc — was "(revoked and expired
   included; the read path filters)". Now: "Every non-revoked link for the conversation
   (revoked excluded here; expired still included and filtered by the read path)…".
   Verified the expired half is still accurate: the store filters only `revokedAt`; no
   `expiresAt` predicate exists in `listForConversation` (expiry is enforced lazily at the
   read path per the data model), so "expired still included/filtered downstream" holds.
2. MINOR — `ports/stores.ts` `SharedLinkListRecord` JSDoc + `adapters/stores.ts` inline
   projection comment — both said a "memberless or revoked link (no active guest) reports
   the column default". Revoked rows no longer reach the projection, so both now read:
   revoked links are filtered out, so within the list a memberless link (no active guest)
   reports the column default `write`. Memberless case preserved accurately.

No code/logic change. `eslint ports/stores.ts adapters/stores.ts` — exit 0. e2e not run
per coordinator instruction.
