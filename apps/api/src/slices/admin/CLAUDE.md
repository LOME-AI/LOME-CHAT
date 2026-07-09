# Admin slice

The operations registry and Customer-360 read surface for the admin plane. This slice
owns exactly one table — `admin_audit` — and composes every other effect through
published slice barrels. Architecture shape: `docs/ARCHITECTURE.md` §Admin plane.
Implementation plan (task briefs, op inventory, UI spec): `docs/plans/ADMIN-PLANE.md`
(archives to `docs/history/` once built; this file is the permanent normative home for
the rules below).

---

## The Charter

Each value names its enforcement — a rule without a mechanism is a suggestion.

1. **The Reversibility Iron Law** (formalized below): every admin mutation has a
   registered inverse; no irreversible admin operation exists. _Enforce:_ the registry
   rejects a mutation op without a registered inverse; the interleaving battery.
2. **Invariant-preserving by construction:** every write composes published slice
   barrels inside one settlement transaction; never a raw table write. _Enforce:_ this
   slice owns only `admin_audit`; arch rule bans raw Drizzle writes in op bodies.
3. **Atomic total auditability:** the audit row commits in the same transaction as the
   effect — effect-without-audit and audit-without-effect are both structurally
   impossible. Sensitive reads are audited too. _Enforce:_ the engine writes the row
   inside the op transaction; the audit role is INSERT/SELECT-only with an
   update/delete-raising trigger.
4. **Preview that cannot lie:** preview is execute inside a rolled-back transaction —
   the same code path, never a parallel implementation. _Enforce:_ one engine code path
   with a rollback sentinel; the preview≡execute test.
5. **Exactly-once:** every op runs under `runMutation` + `idempotent.byKey`;
   double-click/retry never double-applies. _Enforce:_ the shared idempotency machinery;
   the idempotency trio per op.
6. **Reason-required:** every mutation's input schema includes `reason`; it lands in the
   audit row. _Enforce:_ contract-shape check in the registry exhaustiveness test.
7. **Guardrails as data:** per-op caps (`maxAmountNanoUsd`, `maxTargets`, rate-limit
   keys); exceeding refuses, and the refusal is audited. _Enforce:_ engine checks before
   execute; a guardrail-trip test per op.
8. **One definition, many surfaces:** an op is defined once and automatically becomes a
   UI form, a CLI command, and an API endpoint hitting the same audited engine.
   _Enforce:_ generic routes + generic form + generic CLI runner; no bespoke per-op
   wiring exists to drift.
9. **Recovery paths are authentication paths:** every way in — enrollment, recovery,
   break-glass — is pre-staged at a physical ceremony and at least as strong as the
   primary path. No email, IdP, or online tool is a trust root; the fail strength is the
   safe, not an inbox. _Enforce:_ no self-service enrollment or recovery route exists in
   code; break-glass is physical artifacts plus a tested runbook.
10. **Nothing in the repo can mint access:** no credential, enrollment store, break-glass
    flag, or access-granting policy in code, CI secrets, or any store deployable code can
    write. _Enforce:_ enforcement lives at the edge (Cloudflare dashboard config); no
    deploy-flag auth mode exists.
11. **Privacy by default:** content is unreadable by construction; metadata reads are
    scoped, audited, and volume-capped; exports are reason-gated ops. _Enforce:_
    read-audit rows + rate-limit registry entries on Customer-360 loads; the SQL panel
    role is SELECT-only.
12. **One pane of glass:** HushBox-owned data lives in the admin app; vendor internals
    (Sentry stack traces, raw Workers logs) deep-link out, never duplicate.

---

## The Reversibility Iron Law — formal statement

For every admin mutation `A` with registered inverse `A⁻¹`, any starting state `S`, and
any sequence of user/system actions `U₁…Uₙ` executable after `A`:

```
S → A → U₁…Uₙ → A⁻¹   ≡ₑ   S → U₁…Uₙ
```

where `≡ₑ` compares the **effective-state projection**: balances, lock state, session
validity, entitlements, quotas, catalog exposure, share validity. **Excluded from the
projection by design:** append-only trails (ledger legs, `admin_audit` rows) and
timestamps — the record of the act and its reversal is permanent; that is a feature, not
a violation.

Two precision rules, without which the test harness will be built wrong:

- **Feasibility divergence is accepted, not a violation.** If `A` _enabled_ a user
  action (a credit let admission pass), the control run blocks that action and the two
  runs cannot be literally identical. The testable invariant is: **the op's own delta
  nets to exactly zero across any interleaving** (credit +5 … clawback −5 ⇒ net 0, even
  if spent in between — the balance goes negative, and a negative balance is a legal
  state, consistent with billing's unguarded-settlement doctrine), and no other artifact
  of the op survives reversal.
- **Effect taxonomy.** Op effects are `durable` (rows, balances, flags) — must be
  exactly invertible — or `ephemeral` (Redis session keys, holds) — deletion is
  permitted because the user recreates them by acting (logging in again is
  inconvenience, not state). Ephemeral-class ops may declare `inverse: null`;
  durable-class mutations never may. A third clarification covers `job.redrive`: an op
  that merely **resumes an existing system obligation** (at-least-once work the system
  already owed) is ephemeral-class even though the resumed job has durable effects —
  those effects are the system's, not admin-originated state changes.

Consequences the Law forces — deliberate, do not "fix" them:

- **No admin card refunds.** A processor refund is irreversible external money movement.
  Real refunds happen in the Helcim dashboard; the ledger consequence is recorded via
  `wallet.clawback`.
- **No admin account deletion.** Deletion is irreversible by definition; it remains the
  user-initiated, step-up-gated flow. Lock the account meanwhile if needed.
- **No external calls in op bodies** (also what makes preview's rollback total).
- `job.discard` is a restorable marker, never a delete.

---

## Op anatomy

Three pieces per operation, no more:

1. **Contract** in `packages/shared/src/admin/` — name (`'wallet.credit'`), title, kind
   (`mutation`/`read`), a **flat** Zod input schema (mutations always include
   `reason: z.string().min(1)`), `inverse`, `effectClass`, optional guardrails. Flat
   means flat: the moment an op wants nested or conditional inputs, the complexity moves
   into the op body, not the schema — the generic form renderer depends on it.
2. **Implementation** in `domain/operations/<name>.ts` — an `execute(ctx, input)` that
   composes other slices' published `*WithinTx` helpers on the engine-owned
   `SettlementTx` and returns typed `effects` (rendered by preview) plus `inverseInput`
   (stored in the audit row; consumed by undo). No `fetch`, no adapter imports, no raw
   Drizzle, no `Date.now`/random. **Inverse snapshot semantics:** `inverseInput` is
   captured from pre-state at execute time, never recomputed at undo time — e.g.
   `user.unlock` records the original `lockReason` so its undo restores `chargeback`,
   not a default `admin`. An inverse that applies defaults instead of restoring
   snapshots fails the interleaving battery.
3. **Registration** in `domain/registry.ts` — both directions of an inverse pair. The
   registry fail-fasts on a durable mutation without a registered inverse.

The engine (`domain/engine.ts`) owns everything else: transaction, guardrails,
idempotency, the audit row in the same transaction, the preview-rollback sentinel, and
undo. Ops never open transactions, never write audit, never check auth.

---

## The mandatory test battery

Every op ships `describeAdminOp(op)` — the registry exhaustiveness test fails the build
for any op without it:

1. **Interleaving invariance** (the Iron Law test): seeded property test — factory
   state → op → generated user-action sequence → inverse → effective-state projection
   equals the control run; the op's delta nets to zero even when interleavings consumed
   it. Mandated seeds + replay artifacts.
2. **Preview ≡ execute** — preview's effects equal the committed diff.
3. **Audit atomicity** — exactly one audit row per execute; injected mid-op failure
   rolls back effect and audit together.
4. **Idempotency trio** — duplicate delivery, retry-after-crash, concurrent race (money
   ops add the settlement races). Undo included: two concurrent undos of the same audit
   row commit exactly one — the undo's audit insert claims the `undoes` unique column.
5. **Conservation post-condition** (money ops) — `runConservationAudit` clean after
   execute and after undo.
6. **Authz denial** — no/invalid JWT or non-allowlisted email ⇒ refused, zero effect.
7. **Guardrail trip** — over-cap refuses; the refusal is audited.
8. **Reason + input validation** — missing reason refused at the boundary.

Integration-first against real local Postgres/Redis; never mock internal slices.
