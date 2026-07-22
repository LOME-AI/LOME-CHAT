# T09 impl report — R6: fork-tip / epoch-wrap settlement conflicts return `{code}`, not INTERNAL+Sentry

## Objective

Make ordinary settlement concurrency conflicts (fork tip moved, fork gone mid-run,
epoch wrapped) surface as a friendly domain outcome `{code}` with NO Sentry event,
while the genuine fork-tip CAS-zero-row defect still routes to `INTERNAL` + Sentry.

## Throw-site classification (before → after)

The conflated `ForkTipConflict` class (settlement.ts) mixed an expected throw
(`resolveForkTip` fork-gone) with a genuine defect (`advanceForkTip` CAS zero-row).
The split now tracks classification, not the shared class:

| Site (settlement.ts) | Legacy/anchor status | New classification | Wire code |
|---|---|---|---|
| `resolveWrapKey` — sender-key resolve err (`:334`) | epoch-wrap, expected (`wrap-epoch.ts:25-26`: "every failure is an expected domain Result error, never a defect") | `SettlementConflictError` → `settlement-conflict` | `CONFLICT` |
| `resolveWrapKey` — sender no longer member (`:338-340`) | epoch-wrap, expected | `SettlementConflictError` | `CONFLICT` |
| `resolveWrapKey` — epoch assertion err (`:347`) | epoch-wrap, expected | `SettlementConflictError` | `CONFLICT` |
| `resolveForkTip` — fork gone at settlement (`:969`) | expected (`fork-tip.ts:18`: "A fork absent at settlement (deleted mid-run) is an expected `not_found`") | `SettlementConflictError` | `FORK_TIP_CONFLICT` |
| `assertObservedForkTip` — regenerate TOCTOU (`:789`) | ordinary race (research L192-195) | `SettlementConflictError` | `FORK_TIP_CONFLICT` |
| `advanceForkTip` — CAS zero-row (`:992`) | **genuine defect** (`fork-tip.ts:58-59`: "a zero-row outcome is a genuine concurrency defect … unreachable under correct locking") | plain `Error` → `defect` | `INTERNAL` + Sentry |

Legacy anchor matched (research/legacy-chat.md R6): the legacy dispatcher
`legacy/apps/api/src/legacy/lib/classify-stream-error.ts:83-102` discriminated
`ForkTipConflictError` by name into its own `ERROR_CODE_FORK_TIP_CONFLICT` wire code,
folding only truly-unclassified errors into a generic code. New code now restores that
distinction at the engine `settle()` seam.

## Design

Engine sentinels the interpreter discriminates must live engine-side (the engine may
not runtime-import the chat slice) — mirroring the existing `AllBranchesFailedError` /
`StorageUnavailableError` pattern in `failures.ts`. So:

- New engine sentinel `SettlementConflictError` in `failures.ts`, carrying the
  underlying `DomainError`; exported through the workflows barrel; thrown by chat
  settlement.
- New `RunFailure` kind `{ kind: 'settlement-conflict'; code: ErrorCode }`;
  `runFailureCode` passes its `code` through (never `INTERNAL`).
- `interpreter.ts` `settle()` catch adds an `instanceof SettlementConflictError`
  branch **before** the defect fallback, projecting the carried DomainError via
  `domainWireCode()` and returning `{ kind: 'settlement-conflict', code }` — no
  `captureError`.
- Chat `settlement.ts` stamps the chat-specific wire code as a `DomainError.wireCode`
  override (the mechanism at domain-error.ts:28-40,60-62) via a local
  `settlementConflict(domainError, wireCode, message)` helper, then throws the sentinel.
  The `advanceForkTip` CAS site throws a plain `Error` (defect), keeping its
  v8-ignore since it is unreachable under the fork-row lock.

Messages are preserved byte-for-byte at each throw site (single-sourced as
`WRAP_EPOCH_CONFLICT_MESSAGE` / `FORK_TIP_GONE_MESSAGE` / `FORK_TIP_MOVED_MESSAGE`), so
the existing `.rejects.toThrow(/wrap-epoch/)` and `/fork tip/i` integration assertions
stay valid.

## Epoch-wrap wire-code decision (NEEDS_CONTEXT trigger — resolved, no minting)

No `EPOCH_WRAP_CONFLICT` code exists. I did NOT mint one. Reused the existing generic
`CONFLICT` (`error-codes.ts:22`, message at `:138`) for all epoch-wrap sites, exactly
as plan §T09 AC #1 directs ("epoch-wrap → its existing conflict code") and
research NOTE 2b endorses. Because the override is stamped explicitly, the membership
`forbidden` sub-error and the `not_found` sub-error also project to `CONFLICT` (not
their generic `FORBIDDEN` / `NOT_FOUND`), giving a deterministic epoch-wrap code.

## Files changed

- `apps/api/src/slices/workflows/engine/failures.ts` — new `SettlementConflictError`
  sentinel + `settlement-conflict` RunFailure kind + `runFailureCode` mapping.
- `apps/api/src/slices/workflows/index.ts` — export `SettlementConflictError`.
- `apps/api/src/slices/workflows/engine/interpreter.ts` — `settle()` discriminates the
  sentinel, projects via `domainWireCode`, no Sentry; runtime import of `domainWireCode`.
- `apps/api/src/slices/chat/domain/settlement.ts` — removed the three conflated conflict
  classes (`EpochWrapConflict` / `ForkTipConflict` / `ForkTipMovedConflict`, all
  export-unused outside this file); added `settlementConflict` helper + message
  constants; converted the five expected throw sites to `SettlementConflictError`; the
  `advanceForkTip` CAS defect throws a plain `Error`; fixed a stale `EpochWrapConflict`
  doc reference.
- `apps/api/src/slices/workflows/engine/failures.test.ts` — tests for the new kind +
  sentinel shape.
- `apps/api/src/slices/workflows/engine/interpreter.test.ts` — routing tests (a) and (b).
- `apps/api/src/slices/chat/domain/settlement.integration.test.ts` — strengthened three
  scenarios (epoch-rotated, fork-gone, fork-tip-moved) to assert the thrown
  `SettlementConflictError` projects to the friendly code; added `expectSettlementConflict`
  helper.

**Owned files intentionally NOT changed:** `conversations/domain/fork-tip.ts` and
`conversations/domain/wrap-epoch.ts`. The split lives entirely at the chat-settlement
throw seam + the engine catch; these primitives already return correctly-typed
`DomainError`s (`not_found` / `conflict` / `forbidden`) and their docstrings remain
accurate (resolve = expected `not_found`; advance = genuine defect; wrap = every failure
expected). Stamping the chat-specific `FORK_TIP_CONFLICT`/`CONFLICT` wire code inside
them would wrongly leak a chat wire code into a generic conversations primitive.

## Tests added / changed (behavior — criterion covered)

- `failures.test.ts` — `runFailureCode({kind:'settlement-conflict', code})` passes the
  code through (crit #2). `SettlementConflictError` is an Error subclass, carries `name`
  + `domainError` (engine discrimination + projection).
- `interpreter.test.ts` — (a) settle rejecting `SettlementConflictError(not_found,
  wireCode=FORK_TIP_CONFLICT)` → `{outcome:'failed', code:FORK_TIP_CONFLICT}` and
  `captureError` NOT called; (a) settle rejecting `SettlementConflictError(forbidden,
  wireCode=CONFLICT)` → `{code:CONFLICT}`, no capture (proves the override beats the
  generic FORBIDDEN mapping); (b) settle rejecting a plain `Error` → `{code:INTERNAL}` +
  `captureError('workflow_settlement_defect')` — the CAS-zero-row defect path.
- `settlement.integration.test.ts` — epoch-rotated → `CONFLICT`; fork-vanished →
  `FORK_TIP_CONFLICT`; fork-tip-moved → `FORK_TIP_CONFLICT`; each asserts the thrown
  sentinel + no persistence (crit (a), #2, at the chat boundary).

## Self-gate

- `pnpm test:watch failures.test.ts interpreter.test.ts` — pass (109). ✓
- `pnpm test:watch settlement.integration.test.ts` — pass (57, incl. 3 strengthened). ✓
- `pnpm test:watch settlement.fuzz + trial-settlement + fork-tip + wrap-epoch` — pass (17). ✓
- `pnpm test:watch settlement-storage.test.ts` — pass. ✓
- Coverage (scoped to settlement.ts across its 3 suites): 99.11% stmts / 97.12% branch /
  100% funcs / 99.52% lines — all ≥95%; the CAS defect branch is v8-ignored. (line 421
  uncovered is pre-existing, exercised by another suite.)
- ESLint on all 7 edited files, from `apps/api` (after last edit): exit 0, no messages. ✓
- `turbo typecheck --filter=@hushbox/api --force`: **fails**, but every error is in
  concurrent-work files I never touched — `chat/domain/user-message.integration.test.ts`
  (4× `forkId` not in `SaveUserOnlyMessageArgs` — T08's in-flight R4 threading) and
  `media/domain/gc.ts` (`SweepContext` unused). Both are `M` in git status by other
  implementers. My own package typecheck was clean at task start with my failures/
  interpreter changes in; zero errors reference any of my seven files. See RAISED.

## Acceptance criteria

1. **Split conflated `ForkTipConflict`; expected sites → `{code}` via `DomainError.wireCode`,
   no Sentry; CAS-zero-row → `workflowSettlementDefect`** — MET. See classification table;
   interpreter routing tests (a)/(b); integration assertions. Epoch-wrap → `CONFLICT`,
   fork-tip → `FORK_TIP_CONFLICT`, both via the wireCode override + `domainWireCode`
   projection; `advanceForkTip` CAS throws a plain `Error` → defect + Sentry.
2. **No expected-conflict path produces `code: INTERNAL`** — MET. `runFailureCode`
   maps `settlement-conflict` to the carried code; only `defect` → `INTERNAL`, reachable
   only from the plain-Error CAS site. Interpreter + integration tests assert
   FORK_TIP_CONFLICT / CONFLICT, never INTERNAL.
3. **Tests: expected conflict → `{code}` + no Sentry; CAS-defect → defect path** — MET.
   Interpreter tests assert both directions incl. `captureError` (not) called; three
   integration scenarios assert the projected code + no persistence.

## Deviations

- Test files colocated with owned source (`failures.test.ts`, `interpreter.test.ts`,
  `settlement.integration.test.ts`) were edited though the plan §T09 Files list names
  only source files — TDD (G2) and the `test:api` check are unsatisfiable otherwise;
  these test the changes to owned source, not another task's surface.
- `advanceForkTip` v8-ignore widened from `next` to `next 4` because the single-line
  `if (…) throw` became a block (the plain-`Error` throw with a `cause` is longer).
  Coverage confirms no new gap.

## Concerns and limitations

- The `advanceForkTip` CAS-zero-row defect is genuinely unreachable under the fork-row
  lock (documented, v8-ignored), so criterion (b)'s "CAS-defect → defect path" is proven
  structurally: the site throws a plain `Error` (not the sentinel), and the interpreter
  test proves any non-sentinel settlement throw → `INTERNAL` + Sentry. It cannot be
  exercised end-to-end without breaking the lock invariant.

## Confidence

High — the change mirrors the established `AllBranchesFailedError`/`StorageUnavailableError`
engine-sentinel pattern exactly; all behavioral suites + scoped coverage + owned-file lint
are green; the only red gate is concurrent-work typecheck breakage in files outside my
ownership.
