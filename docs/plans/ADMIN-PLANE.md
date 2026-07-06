# Admin Plane — Design & Implementation Plan

> **Status:** Design locked (founder rulings 2026-07-05); implementation is Phase 5 of the
> backend rewrite — after T4.7, per the unchanged wave order. This document supersedes
> §14 (Admin plane) and the Phase-5 task block of `docs/history/BACKEND-REDESIGN.md`
> (tombstoned there; original text in git history). **When Phase 5 begins, read this plan
> in full first.**
>
> **What lives where:** the durable rules distilled from this plan live in
> `ARCHITECTURE.md` (§Admin plane), `CODE-RULES.md` (§Admin Operations), and
> `docs/DESIGN.md` (§Admin app). This plan holds everything with a shelf life — task
> briefs, op inventory, migrations, ceremonies, UI spec, threat model — and moves to
> `docs/history/` when Phase 5 completes. The two nested `CLAUDE.md` files (§14 below)
> ship with their code and carry the scope-loaded durable detail.

---

## 1. Purpose & non-goals

The admin plane is an **ops-and-billing-remediation console over metadata** for 1–3
founder-admins: credit/clawback wallets, lock/unlock accounts, revoke sessions, redrive
and discard jobs, disable models, revoke shares, inspect everything about a user in one
place, and audit every one of those acts. E2E encryption makes content structurally
unreadable — there is no content surface, no impersonation, no "view as user."

**Non-goals (v1):** card refunds through the panel (irreversible external effect — use
the Helcim dashboard + a `wallet.clawback` op to record the ledger consequence);
admin-initiated account deletion (irreversible — deletion remains the user-initiated,
step-up-gated flow); WAE dashboards (Postgres covers v1 metrics; deep-link to
Sentry/Cloudflare for vendor internals); multi-admin approval workflows (revisit at >3
admins); charts, bulk-select tables, saved views, mobile layout.

---

## 2. The Charter

Each value names its enforcement — a rule without a mechanism is a suggestion.

1. **The Reversibility Iron Law** (founder ruling, 2026-07-05 — full formalization in
   §3): every admin mutation has a registered inverse; no irreversible admin operation
   exists. *Enforce:* registry rejects a mutation op without a registered inverse; the
   §12 interleaving battery.
2. **Invariant-preserving by construction:** every write composes published slice
   barrels inside one settlement transaction; never a raw table write. *Enforce:* admin
   slice owns only `admin_audit`; arch rule bans raw Drizzle writes in the slice.
3. **Atomic total auditability:** the audit row commits in the same transaction as the
   effect — effect-without-audit and audit-without-effect are both structurally
   impossible. Sensitive reads audited too. *Enforce:* the engine writes the row inside
   the op transaction; audit role is INSERT/SELECT-only with an update/delete-raising
   trigger.
4. **Preview that cannot lie:** preview is execute inside a rolled-back transaction —
   the same code path, never a parallel implementation. *Enforce:* one engine code path
   with a rollback sentinel; the preview≡execute test.
5. **Exactly-once:** every op runs under `runMutation` + `idempotent.byKey`;
   double-click/retry never double-applies. *Enforce:* existing idempotency machinery;
   the §12 idempotency trio.
6. **Reason-required:** every mutation's input schema includes `reason`; it lands in the
   audit row. *Enforce:* contract-shape check in the registry exhaustiveness test.
7. **Guardrails as data:** per-op caps (`maxAmountNanoUsd`, `maxTargets`, rate-limit
   keys); exceeding refuses, and the refusal is audited. *Enforce:* engine checks before
   execute; guardrail-trip test per op.
8. **One definition, many surfaces:** an op is defined once and automatically becomes a
   UI form, a CLI command, and an API endpoint hitting the same audited engine.
   *Enforce:* generic routes + generic `<OpForm>` + generic CLI runner; no bespoke
   per-op wiring exists to drift.
9. **Recovery paths are authentication paths:** every way in — enrollment, recovery,
   break-glass — is pre-staged at a physical ceremony and at least as strong as the
   primary path. No email, IdP, or online tool is a trust root; the fail strength is the
   safe, not an inbox. *Enforce:* no self-service enrollment or recovery route exists in
   code; §6's ladder is physical artifacts + a tested runbook.
10. **Nothing in the repo can mint access:** no credential, enrollment store, break-glass
    flag, or access-granting policy in code, CI secrets, or any store deployable code can
    write. *Enforce:* enforcement lives at the edge (Cloudflare dashboard config); no
    `BREAK_GLASS`-style deploy flag exists.
11. **Privacy by default:** content unreadable by construction; metadata reads scoped,
    audited, and volume-capped; exports are reason-gated ops. *Enforce:* read-audit rows
    + rate-limit registry entries on 360 loads; SQL panel role is SELECT-only.
12. **One pane of glass:** HushBox-owned data lives in the admin app; vendor internals
    (Sentry stack traces, raw Workers logs) deep-link out, never duplicate.

---

## 3. The Reversibility Iron Law — formal statement

> This section becomes the core of `apps/api/src/slices/admin/CLAUDE.md` at T5.1 (§14).

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

- **Feasibility divergence is accepted, not a violation.** If `A` *enabled* a user
  action (a credit let admission pass), the control run blocks that action and the two
  runs cannot be literally identical. The testable invariant is: **the op's own delta
  nets to exactly zero across any interleaving** (credit +5 … clawback −5 ⇒ net 0, even
  if spent in between — the balance goes negative, and a negative balance is a legal
  state, consistent with billing's existing unguarded-settlement doctrine), and no other
  artifact of the op survives reversal.
- **Effect taxonomy.** Op effects are `durable` (rows, balances, flags) — must be
  exactly invertible — or `ephemeral` (Redis session keys, holds) — deletion permitted
  because the user recreates them by acting (logging in again is inconvenience, not
  state). Without this class, `sessions.revokeAll` would be illegal and the Law
  unusable. Ephemeral-class ops may have `inverse: null`; durable-class mutations never
  may.

Consequences the Law forces (deliberate, not gaps): no admin card refunds (§1), no
admin account deletion (§1), and `job.discard` must be a restorable marker rather than a
delete (§9).

---

## 4. Architecture

### Topology

```
Admin's browser ──► Cloudflare Access (edge: email allowlist + YubiKey WebAuthn MFA)
                        │  ONE Access app covering admin.hushbox.ai/*
                        ▼
        admin.hushbox.ai/*                admin.hushbox.ai/api/*
        (static SPA assets:          ──►  (hostname route → the ONE product Worker)
         assets-only Worker config,             │  'admin' route class: jose JWT verify
         zero code, zero credentials)           │  → adminActor principal
                                                ▼
                                     slices/admin  (ops engine + Customer-360 reads)
                                                │  composes slice barrels in one tx
                                                ▼
                                     Neon PG · Redis · DOs (evict, jobs)

CLI (scripts/admin) ── Access service token headers ──► the same /api/* endpoints
```

- **One product Worker.** No separate admin Worker, no service-binding RPC. The admin
  slice mounts like every other slice; a hostname route sends `admin.hushbox.ai/api/*`
  to it. The §14 two-Worker isolation defended a near-empty doorman — credentials and
  power lived product-side in both designs; Access-at-edge + in-Worker JWT is the same
  wall with one fewer deploy target and no net-new RPC pattern.
- **SPA hosting:** an assets-only Worker (configuration only — no code, no bindings, no
  credentials) serves `apps/admin`'s build on `admin.hushbox.ai`, chosen over Pages to
  avoid the documented Pages/Access coverage gap (production `*.pages.dev` host and the
  custom domain each need their own Access app — a three-app checklist). One hostname,
  one Access app, covers SPA and API. `workers_dev = false` in both Worker configs.

### Codebase layout (final paths, durable names)

```
apps/api/src/slices/admin/
├── index.ts                      # barrel: createAdminManifest + op-contract re-exports
├── routes.ts                     # createAdminManifest(deps): routeClass('admin') on every
│                                 #   route; generic ops routes + 360/dashboard reads
├── domain/
│   ├── index.ts
│   ├── engine.ts                 # run(op, input, actor, mode) — tx, audit-in-tx,
│   │                             #   PreviewRollback sentinel, guardrails, idempotency
│   ├── registry.ts               # createAdminOpRegistry() — fail-fast: mutation without
│   │                             #   a registered inverse is rejected (the Iron Law gate)
│   ├── customer-360.ts           # read assembly (indexed queries, §8)
│   └── operations/*.ts           # one op per file
├── ports/index.ts                # AdminStores: audit insert, 360 queries, job-queue reads
├── adapters/stores.ts            # the only Drizzle-touching layer
└── CLAUDE.md                     # ships with T5.1 (§14)

packages/shared/src/admin/        # op contracts (names, Zod inputs, metadata) — imported
                                  #   by engine, SPA, and CLI alike
apps/admin/                       # Vite React SPA (§13); + CLAUDE.md at T5.3
scripts/admin/run.ts              # generic CLI: pnpm admin:run <op> --key=value [--preview]
```

Integration points (small, named edits):

| File | Change |
|---|---|
| `apps/api/src/lib/context/route-class.ts` | add `'admin'` to `ROUTE_CLASSES`; the exhaustive `match` in `authorizeAccess` forces the new arm |
| `apps/api/src/middleware/` | new pipeline stage: on `'admin'`-classed routes, verify `Cf-Access-Jwt-Assertion` (jose + remote JWKS, issuer + AUD + email allowlist, fail-closed) and set an `admin-actor` principal — the one `Principal`-union extension |
| `apps/api/src/app.ts` | mount `adminManifest` in the chained `.route(…)` list (AppType flows to the SPA/CLI) |
| `apps/api/wrangler.toml` | `admin.hushbox.ai/api/*` route |
| `packages/shared/src/env.config.ts` | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` registry entries (per-mode, no fallbacks) |
| `packages/config/eslint-extensions/admin.config.mjs` | op modules importable only by the registry |
| `packages/config/arch/rules/` | `admin-op-registry.rule.ts`: every op registered; mutation ⇒ inverse present; audit insert inside the op tx; no `fetch`/adapter imports in op bodies |
| `apps/api/package.json` | add `jose` (not currently a dependency) |

The eslint-boundaries `slices/(*)` capture and the arch-test globs pick the new slice up
with zero configuration changes. Local dev and e2e fake Access at the real seam: a test
JWKS mints JWTs so the actual jose validation code runs (dev-mode JWKS via envUtils —
never a bypass branch).

---

## 5. Authentication

The doctrine-pure path — mTLS client certificates from an offline CA — is closed on
non-Enterprise Cloudflare (Access-integrated mTLS is Enterprise-only and excludes Pages
custom domains; verified 2026-07-05). It is the recorded upgrade if HushBox ever goes
Enterprise. The design of record:

- **Access app on `admin.hushbox.ai`:** built-in one-time-PIN IdP over an exact-match
  email allowlist (1–3 entries; never a domain-wide rule), **plus Independent MFA
  requiring a WebAuthn security key** (GA 2026-04-15), **AAGUID-restricted** so only the
  approved YubiKey models can ever enroll. App session short enough that the key is
  tapped every working session.
- **The enrollment ceremony** (Access has no admin-side pre-enrollment — this is the
  closest achievable approximation of Charter #9): create the Access app with the AAGUID
  restriction already on → each admin immediately enrolls **two YubiKeys** (one carried,
  one in the safe) → thereafter, adding/removing an authenticator requires asserting an
  existing one, so a compromised inbox gets factor 1 (OTP) and nothing else: it cannot
  pass MFA and cannot enroll its own key. The residual window exists only before first
  enrollment — hence ceremony-at-creation, and the Access-log pull cron alerts on every
  enrollment event. **Pull cadence is ~6-hourly, and that is load-bearing:** free-tier
  Access retains its logs for only 24 hours, so a once-daily pull that fails once loses
  that window permanently; sub-daily gives multiple retries inside the retention window.
  (The cron ships with T5.2 — the Access app does not exist before it.)
- **In-Worker validation:** the `'admin'` route class verifies the Access JWT (jose +
  remote JWKS handles the ~6-week key rotation; issuer + AUD + allowlist; fail-closed —
  missing/invalid ⇒ 401, no effect). This is the belt; the edge wall is the suspenders.
- **CLI:** an Access **service token** (`CF-Access-Client-Id/Secret` headers) under a
  Service-Auth policy on the same app; the JWT path validates identically; `actor` = the
  token name. Expiry alert a week out.
- **Roots above the app, hardened first:** the Cloudflare account (it holds the Access
  policy — hardware keys + paper backup codes), the domain registrar, the allowlisted
  inboxes. Whoever controls the dashboard controls the plane.

**No TOTP fallback anywhere** — an attacker authenticates with the weakest enrolled
factor; the second YubiKey is the fallback.

---

## 6. Break-glass ladder

All rungs physical, none in code (Charter #9/#10). No deploy-flag auth mode exists — a
break-glass reachable by deploying code is exactly what a GitHub attacker can trigger.

| Rung | Scenario | Path |
|---|---|---|
| 1 | Primary YubiKey lost | Backup YubiKey from the safe — already enrolled, identical strength |
| 2 | All admin keys lost | Cloudflare dashboard (its own hardware key / paper backup codes) → re-run the ceremony: enroll new keys, delete old authenticators |
| 3 | Cloudflare account lost | Offline Neon owner + R2 credentials on paper in the safe + written runbook — read/repair per procedure, bypassing the plane entirely |

Rung 3 bypasses every invariant (raw SQL, no `settle()`, no audit middleware): the
runbook restricts it to reading and emergency repair per written procedure, and every
use is manually logged into `admin_audit` after the fact.

**Drills:** quarterly ten-minute rung-1 drill (backup key logs in); annual rung-3
walkthrough against a branch database. An untested break-glass is a fire extinguisher
with no pressure. **After any real use of rung 2 or 3: rotate what was touched.**

GitHub/deploy compromise, stated honestly: an attacker who achieves a malicious deploy
owns the product Worker (it holds DB credentials) regardless of any admin-plane design.
The plane's obligation is not to add to that surface (it doesn't: no admin credential or
enrollment store is code-reachable; the Access wall is edge config). The deploy path is
its own hardening track: hardware-key 2FA on GitHub accounts, branch protection +
required review, a Cloudflare deploy token scoped to the one Worker.

---

## 7. The operations layer

### The contract

```ts
// packages/shared/src/admin/ops.ts — contracts only; SPA, CLI, and engine all import this
export interface AdminOpContract<In extends z.ZodType> {
  name: `${string}.${string}`;            // 'wallet.credit'
  title: string;                          // 'Credit wallet'
  kind: 'mutation' | 'read';
  input: In;                              // FLAT Zod object; mutations always include
                                          //   reason: z.string().min(1)
  inverse: `${string}.${string}` | null;  // null only for kind:'read' and ephemeral ops
  effectClass: 'durable' | 'ephemeral';   // §3 taxonomy
  guardrails?: {
    maxAmountNanoUsd?: bigint;
    maxTargets?: number;
    rateLimitKey?: string;                // typed rate-limit registry entry
  };
}
```

```ts
// apps/api/src/slices/admin/domain/operations/wallet-credit.ts
export const walletCredit = defineAdminOp(walletCreditContract, {
  async execute(ctx, input): Promise<OpOutcome> {
    // ctx.tx is a SettlementTx the ENGINE opened. Compose billing's published barrel:
    // lockWalletWithinTx → insertLedgerLegsIfAbsentWithinTx (promo kind, zero-sum pair,
    // idempotencyKey derived from ctx.opKey) → updateWalletBalanceWithinTx →
    // writeThroughSnapshot. No fetch, no adapters, no raw Drizzle — arch-rule-enforced.
    return {
      effects: [/* typed descriptions rendered by preview: balance before/after, legs */],
      inverseInput: { transactionId, walletId, amountNanoUsd, reason: `undo of ${ctx.auditId}` },
    };
  },
});
```

### The engine — one code path, two modes

```
run(op, input, actor, mode: 'preview' | 'execute', idempotencyKey)
  1. Zod-validate input · check guardrails · consume rate-limit entry
  2. runMutation(() => idempotent.byKey({ scope: (actor, op.name), body: input,
       execute: tx => {
         const outcome = await op.execute(asSettlementTx(tx), input)  // engine owns the tx
         insertAdminAuditRow(tx, { actor, action: op.name, target, details:
           { input, effects, inverseInput, requestId, ip } })          // SAME transaction
         if (mode === 'preview') throw new PreviewRollback(outcome)    // rollback; effects
         return outcome                                                //   become the plan
       }}))
```

- **Preview = execute + rollback.** One code path; divergence is impossible by
  construction and verified by test. External side-effects cannot exist inside op bodies
  (arch rule), so the rollback is total.
- **Undo = executing the inverse op** with `inverseInput` read from the original audit
  row — itself a normal op run: previewed, idempotent, audited, linked via the `undoes`
  column (whose UNIQUE constraint makes undo exactly-once: two concurrent undos of the
  same row cannot both commit). Undo is not special machinery, which is why it inherits
  every guarantee for free. **Inverse snapshot semantics:** `inverseInput` is captured
  from pre-state at execute time (e.g. `user.unlock` records the original `lockReason`
  so its undo restores `chargeback`, not a default `admin`), never recomputed at undo
  time.
- **Reads** skip the tx machinery but write coarse audit rows (one per 360 view) and
  pass read-rate-limit entries.
- **Generic routes — the DevEx keystone:** `GET /api/ops` (registry listing; the SPA nav
  and CLI help build themselves), `POST /api/ops/:name/preview`,
  `POST /api/ops/:name/execute`, plus bespoke reads (`GET /api/users/:id/overview`,
  dashboard, jobs queue, audit search). **Adding an op touches zero route, SPA, or CLI
  code.**
- **Notification (telemetry, never a control):** each executed mutation fires a
  best-effort email via the notifications barrel plus a daily audit digest. Nothing
  blocks on delivery. This is the remaining tripwire against a compromised-but-valid
  session; removable by founder call, revisit at >3 admins.

---

## 8. Reads — Customer 360 and governance

One search box → one page, assembled by `domain/customer-360.ts`. Index audit (verified
against `packages/db/src/schema/`):

| Panel | Source | Index | Inline ops |
|---|---|---|---|
| Identity & sessions | `users` (lockedAt/lockReason exist) | PK | `user.lock`/`user.unlock`, `sessions.revokeAll` |
| Money | `wallets` ✅ · `payments` ✅ · `ledger_entries` (per-wallet index → join through wallets) | ✅ | `wallet.credit`/`wallet.clawback` |
| Usage | `usage_records` ✅ (partial) | ✅ | — |
| Conversations (metadata) | `conversations` ✅ · `conversation_members` ✅ · `shared_links` (per-conversation → join) | ✅/join | `share.revoke` |
| Devices | `device_tokens` ✅ | ✅ | — |
| Admin history | `admin_audit` | **needs the §10 index** | undo buttons |

Global surfaces: **Dashboard** (job backlog + dead-row counts — net-new read queries over
`jobs`; conservation / snapshot-drift / payment-reconciliation auditor results — already
published from the billing barrel; failed-payment count), **Jobs queue** (redrive/discard
inline — `cancelRequested` is a built-but-unwired seam awaiting exactly this), **Models**
(catalog + disable/enable), **Audit viewer** (filter by actor/action/target/date;
undo affordances; `undoes`/`undone-by` threading).

**Read governance** (the crown-jewel gap in the old §14): 360 views audited; a
read-volume rate-limit entry on 360 loads; any export is a mutation-classed op requiring
a reason. **Power feature:** a read-only SQL panel backed by a dedicated Postgres role
with SELECT-only grants — psql-grade power, structurally write-proof, every query text
audited, and its queries count toward the same read-volume caps as 360 views (the panel
must not be the cap bypass).

`jobs` has no user dimension (payload-embedded ids only) — accepted for v1; a
`targetUserId` column is the fix if that panel is ever hot. WAE SQL-API read-back is
deferred; v1 dashboard metrics come from Postgres.

---

## 9. v1 op inventory

| Op | Inverse | Class | Composes |
|---|---|---|---|
| `wallet.credit` | `wallet.clawback` | durable | billing barrel: `lockWalletWithinTx` + `insertLedgerLegsIfAbsentWithinTx` (promo/clawback kinds, zero-sum pairs) + snapshot write-through |
| `wallet.clawback` | `wallet.credit` | durable | same primitives |
| `user.lock` | `user.unlock` | durable | new identity barrel helpers `lockUserWithinTx`/`unlockUserWithinTx` over `users.lockedAt` + `lockReason` (columns exist; `users` is identity's table — single-writer). Unlock's `inverseInput` snapshots the original `lockReason` so undo restores `chargeback`, never a default |
| `user.unlock` | `user.lock` | durable | same |
| `sessions.revokeAll` | — | ephemeral | new identity barrel helper `revokeAllSessions(userId)`: bump the `passwordChangedAt` watermark (the existing in-mechanism primitive) |
| `job.redrive` | — | ephemeral (resumes an existing system obligation — the job's effect is the system's at-least-once work, not an admin-originated state change) | dead→pending status flip, attempts reset |
| `job.discard` | `job.restore` | durable | restorable `discardedAt` marker; discarded rows prune on retention (2026-07-03 amendment semantics) |
| `model.disable` | `model.enable` | durable | **needs `model_catalog.admin_disabled_at`** (§10) — no exposure flag exists today |
| `share.revoke` | `share.unrevoke` | durable | `shared_links.revokedAt` (column exists) |

The two catches the Iron Law forces, recorded so nobody "fixes" them: **card refunds**
(irreversible external money movement) and **account deletion** (irreversible by
definition) are excluded — see §1 non-goals for the operational answer to each. An
erasure request arriving by email has no admin lever; the answer is "log in and delete"
(lock the account meanwhile if needed). Revisit with counsel before an EU launch.

---

## 10. Data changes (in-chain migrations)

1. `admin_audit`: add indexes `(target_type, target_id)` and `(actor, created_at)`; add
   a nullable **`undoes uuid UNIQUE`** column (the undo's own audit insert is the
   exactly-once claim — a second undo of the same row fails the unique constraint,
   race-safe and append-only-compatible); add the append-only hardening — audit-writing
   role gets INSERT/SELECT only, plus a `BEFORE UPDATE OR DELETE` trigger that raises.
2. `model_catalog`: add nullable `admin_disabled_at timestamptz` (the `model.disable`
   flag; catalog refresh never touches it).
3. `jobs`: add restorable-discard support per the 2026-07-03 amendment semantics if not
   already shaped that way at implementation time.
4. The SQL panel's **SELECT-only Postgres role**, created in-chain so local provisioning
   (`db:up` + migrations) carries the identical role — write-proofness is tested (§18),
   never merely asserted.

No WORM R2 export and no hash chain: the existing Kopia→B2 daily encrypted backup
already carries `admin_audit` off-vendor (a second export path would violate the
one-mechanism rule). Re-entry trigger: SOC 2 / compliance demanding demonstrable
immutability, or the first non-founder admin.

---

## 11. Threat model

| Threat | Defense |
|---|---|
| Random attacker | Access edge wall (allowlist + OTP + hardware key); JWT re-verified in-Worker |
| Compromised admin inbox | OTP alone cannot pass MFA and cannot enroll a key (device changes require an existing device); enrollment events alerted |
| Stolen YubiKey | Useless without the inbox factor — and vice versa |
| Phishing | WebAuthn is origin-bound — phishing-resistant at the protocol level |
| Compromised live admin session | Guardrail caps + rate limits bound blast radius; every act is audited **and reversible** — the Iron Law doubles as incident response: any malicious sequence can be exactly undone from the audit trail |
| GitHub / deploy compromise | Nothing deployable can mint access (§6); residual product-wide deploy risk is its own hardening track |
| DB-credentialed attacker | Audit history not silently rewritable (INSERT-only role + trigger); off-vendor daily copy via Kopia→B2 |
| Bulk metadata exfiltration | 360 reads audited + volume-capped; exports reason-gated; SQL panel read-only + query-audited |
| Access / Cloudflare outage | Break-glass rungs 2–3, physically staged, drilled |

---

## 12. Testing

**The per-op battery** — a registry-driven parameterized suite (`describeAdminOp(op)`)
so an op cannot ship without it:

1. **Interleaving invariance** (the Iron Law test): seeded property test — factory-built
   account in a random state → op → generated user-action sequence (spend/settle,
   top-up, login, message growth) → inverse → assert the effective-state projection
   equals the control run (same seed, no op), and the op's delta nets to zero even when
   interleavings consumed it (negative balance = pass). Mandated seeds + replay
   artifacts, per the existing randomized-test convention.
2. **Preview ≡ execute:** preview's effects equal the committed diff.
3. **Audit atomicity:** exactly one audit row per execute; an injected mid-op failure
   rolls back effect and audit together.
4. **Idempotency trio:** duplicate delivery, retry-after-crash, concurrent race (money
   ops add the settlement races). Undo included: two concurrent undos of the same audit
   row commit exactly one (the `undoes` unique claim).
5. **Conservation post-condition** (money ops): `runConservationAudit` clean after
   execute and after undo.
6. **Authz denial:** no JWT / wrong AUD / non-allowlisted email ⇒ refused, zero effect.
7. **Guardrail trip:** over-cap refuses; the refusal is audited.
8. **Reason + input validation:** missing reason refused at the boundary.

**Suite-level:** registry exhaustiveness (every mutation has a registered inverse that is
itself registered; contract fields complete); integration-first against real local
Postgres/Redis (never mock internal slices); new fishery factories in
`packages/db/src/factories/` (the non-legacy tree has none — all current factories are
`legacy_`); e2e admin project with Access faked at the real JWKS seam. 95% coverage from
the first task.

---

## 13. UI specification (the T5.3 brief)

Design identity: inherits `docs/DESIGN.md` with the §Admin-app deltas (density over
whitespace, tables over cards, monospace ids, function over expression). Audited by the
same frontend-design / design-review loop as the product.

### The signature interaction: one universal OpModal

Every mutation in the app runs through a single three-step modal:

1. **Form** — generated from the op's shared Zod contract by one generic `<OpForm>`
   (`reason` always last). No hand-built op forms, ever.
2. **Preview** — the engine's dry-run rendered as a change list by `<DiffList>`
   (`wallet balance $10.00 → $15.00 · +2 ledger legs (promo) · lock: none → admin`).
   Guardrail violations surface here as blocking errors, before anything commits.
3. **Execute → result** — success state with the audit-row link and an **Undo** button;
   Undo opens the same modal running the inverse op, whose preview shows the reverse
   diff. The modal mints the `Idempotency-Key` at form-submit, so in-modal retries are
   safe.

### Information architecture

- **Home = Dashboard:** health strip (auditor statuses, job backlog, dead rows, failed
  payments), recent-admin-actions feed with inline Undo, user search front and center.
- **Customer 360** (the centerpiece): header (email · id · created · lock badge ·
  balance) over independently-loading panels per §8, each with its ops inline. Per-panel
  loading and per-panel errors — one broken query never blanks the page.
- **Ops catalog:** auto-generated from `GET /api/ops`; the escape surface for any op not
  inlined anywhere; new ops appear with zero UI work.
- **Jobs queue:** filterable table (status/shard/type), row-expand to payload + error
  history, redrive/discard inline.
- **Audit trail:** filterable table; reversible rows carry Undo; `undoes`/`undone-by`
  links thread act and reversal.
- **Models:** catalog table + disable/enable. **SQL panel:** read-only editor + results
  grid + query history.

### The speed layer

**⌘K command palette as primary navigation:** type an email → that user's 360; type an
op name → its modal; type a screen name → go. Dense everywhere: monospace ids with copy
buttons, tables over cards, counts over charts.

**Deliberately not in v1:** charts, WAE visualizations, bulk-select tables, saved views,
mobile layout. Add each when its absence hurts.

Components live in `apps/admin/src/components/` (OpModal, DiffList, palette, dense
table) — admin-specific until a second consumer actually appears; only then promote to
`packages/ui`.

---

## 14. Nested CLAUDE.md files (pre-staged 2026-07-05)

Both files were written at design time — they are the **permanent normative homes** for
the scope-loaded rules, and they already exist:

**`apps/api/src/slices/admin/CLAUDE.md`** — the full §2 Charter (all twelve values with
enforcement), the §3 formal Iron Law + effect taxonomy, op-file anatomy, the mandatory
`describeAdminOp` battery, and the catch-rules. T5.1 builds to it and keeps it current.

**`apps/admin/CLAUDE.md`** — the UI conventions: one generic `<OpForm>`, flat inputs,
OpModal as the only mutation surface, per-panel failure isolation, palette-first
navigation, vendor deep-links, `TEST_IDS`. T5.3 builds to it and keeps it current.

(The directories contain only these files until their tasks land code beside them —
inert to lint, arch globs, coverage, and workspace resolution.)

---

## 15. Task plan

Task briefs follow the §20 BACKEND-REDESIGN conventions: objective · acceptance
(testable) · owns (paths); ⚠️ tasks get the three-lens review panel (correctness /
security / conventions); chained sub-tasks share their dir and serialize.
**Behavioral-spec sections: none — the admin plane is greenfield** (no legacy behavior
to preserve); the spec sources are this plan and the slice `CLAUDE.md`'s battery.

**Launch gate (unchanged in spirit from the superseded Phase 5):** T5.1a → T5.2 must
complete before any public launch — no public users without an audited intervention
lever. T5.3 (the SPA) may follow launch; the CLI covers the gap.

- **T5.1a Ops core: contracts + registry + engine** ⚠️ — the op-contract module, the
  registry (the Iron Law gate: a durable mutation without a registered inverse is
  rejected at registration), the engine (engine-owned `SettlementTx`, audit-in-tx,
  `PreviewRollback`, guardrails, `idempotent.byKey`), the `describeAdminOp` harness +
  registry exhaustiveness test, the arch rule + lint extension, and the §10 migrations
  (audit indexes + INSERT-only role + update/delete trigger;
  `model_catalog.admin_disabled_at`; restorable job discard). *Acc:* registry rejects an
  inverse-less durable mutation (test); preview≡execute and audit-atomicity hold for a
  fixture op under injected failure; a second undo of the same audit row fails the
  `undoes` unique claim (test); migrations shape-tested; the harness runs the full
  §12 battery against the fixture op. *Owns:* `packages/shared/src/admin/**`,
  `slices/admin/**` (minus `domain/operations/`), `packages/db` (the migrations **and
  the new non-legacy fishery factories the battery needs — none exist yet**),
  `packages/config` extension + arch-rule files.
- **T5.1b The v1 ops + CLI** ⚠️ — the §9 inventory: four durable inverse pairs
  (`wallet.credit`/`wallet.clawback`, `user.lock`/`user.unlock`,
  `job.discard`/`job.restore`, `model.disable`/`model.enable`,
  `share.revoke`/`share.unrevoke`) and the ephemeral ops (`sessions.revokeAll` and
  `job.redrive`), plus the new identity barrel helpers they compose
  (`lockUserWithinTx`/`unlockUserWithinTx`, `revokeAllSessions(userId)` — `users` is
  identity's table, single-writer). *Acc:* full §12 battery green
  for **every** op (interleaving invariance included); conservation clean after
  execute+undo on the money pair. *Owns:* `slices/admin/domain/operations/**`,
  `slices/identity/**` (the new barrel helpers). (dep T5.1a)
- **T5.2 Auth + reads + CLI** ⚠️ — the `'admin'` route class + JWT pipeline stage (jose,
  remote JWKS, test-JWKS seam for dev/e2e), env registry entries
  (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`), the `app.ts` mount + wrangler hostname
  route, the Access app + enrollment ceremony (performed and written up as a runbook),
  the Customer-360 / dashboard / jobs-queue / audit-search read routes with read-audit
  rows + read rate-limit entries, the generic CLI (`scripts/admin/run.ts` +
  `pnpm admin:run`, authenticating via an Access service token — the CLI lands here,
  not T5.1b, because it calls these routes), the **Access-log pull cron** (~6-hourly —
  §5's retention rationale; it is the enrollment-alert mechanism), the §18 dev-admin
  mint route + the single-seed op-target states, best-effort mutation notification +
  daily digest, break-glass runbook + rung-1 drill performed. *Acc:* §12 authz-denial battery
  (no/invalid/wrong-AUD JWT ⇒ 401, zero effect); a 360 view writes a read-audit row; the
  read rate limit trips (test); every §9 op reachable end-to-end over HTTP with real JWT
  validation in the loop; CLI preview/execute round-trips against the local stack;
  ceremony + runbook artifacts exist. *Owns:* `slices/admin/routes.ts` +
  `domain/customer-360*`, `lib/context/route-class.ts`, `middleware/pipeline-admin*`,
  `app.ts`, `apps/api/wrangler.toml`, `packages/shared/src/env.config.ts`,
  `apps/api/package.json` (jose), `scripts/admin/**`, root `package.json` scripts.
  (dep T5.1b)
- **T5.3a SPA shell + the op surfaces** — scaffold `apps/admin` (Vite, TanStack
  Router/Query, `hc<AppType>` client, `TEST_IDS`, dev Access-fake seam, **joins
  `pnpm dev`** — §18); the assets-only
  Worker + route config (`workers_dev = false`); the OpModal (form → preview → execute /
  undo), generic `<OpForm>`, `<DiffList>`, the ⌘K palette, and the auto-generated ops
  catalog. *Acc:* every §9 op executable end-to-end with preview and undo from the UI;
  in-modal retry reuses the minted `Idempotency-Key` (test); palette reaches any op and
  screen. *Owns:* `apps/admin/**`, the admin assets wrangler config. (dep T5.2)
- **T5.3b SPA screens** — Dashboard (health strip + recent-actions feed with undo),
  Customer 360 (independent panels per §8), jobs queue, audit trail
  (`undoes`/`undone-by` threading), models, read-only SQL panel; `docs/DESIGN.md`
  §Admin-app compliance pass. *Acc:* per-panel failure isolation (test); palette reaches
  any user by email/id; audit trail filters by actor/action/target/date; SQL panel role
  is SELECT-only (asserted). *Owns:* `apps/admin/**` (screens; serialized after T5.3a).
  (dep T5.3a)
- **T5.4 Admin e2e** — own Playwright project: Access faked at the real JWKS seam (the
  suite mints JWTs so the actual validation code runs); preview → execute → audit-row →
  undo → audit-thread assertions; denied-op and guardrail-trip specs; the accessibility
  checks the existing suite applies. *Acc:* suite green in CI. *Owns:* the admin e2e
  project under `e2e/**`. (dep T5.3b)

Wave order: **T5.1a → T5.1b → T5.2 → T5.3a → T5.3b → T5.4**, after T4.7, ∥ T4.9 (no
glob collision — the admin slice did not exist during the tree collapse). The chain is
fully serialized: every task shares the slice or app dir with its predecessor.

---

## 16. Deltas from BACKEND-REDESIGN §14 / Phase 5

The why-it-changed record. Original text in git history (tombstoned 2026-07-05).

| Dimension | Superseded §14 / Phase 5 | This design | Why |
|---|---|---|---|
| Workers | Separate `apps/admin-api` + service-binding RPC | One product Worker, admin slice + `'admin'` route class | The RPC isolated a near-empty doorman; creds/power lived product-side either way; Access-at-edge + JWT is the same wall minus a deploy target and a net-new RPC pattern |
| Step-up auth | Bespoke in-app WebAuthn (separate registration) | Access Independent MFA (YubiKey, AAGUID-pinned, every login) | Deletes the largest zero-basis build; hardware-bound beats synced platform passkeys; enrollment locked after ceremony |
| Safety model | Four tiers of delay-and-notify (2 m/10 m/30 m/24 h) + cancellable jobs + notify-all | **Reversibility Iron Law**: instant execute + preview + perfect undo; no irreversible ops exist | Founder ruling. Deletes `admin.executeAction.v1`/`admin.notify.v1` and the pending-queue machinery; fixes the 30-minute support-credit UX; undo > delay for everything reversible |
| Irreversible actions | 24 h-delayed deletion; step-up refunds | None. Deletion stays user-initiated; card refunds via the Helcim dashboard + a ledger op | Iron Law consequence; GDPR-coherent |
| Audit | `admin_audit` + daily WORM R2 export + per-batch SHA-256 | `admin_audit` + INSERT-only role + update/delete trigger; off-vendor copy = existing Kopia→B2 | The WORM export was a second delivery path for what backups already cover; re-entry: SOC 2 or first non-founder admin |
| Break-glass | `BREAK_GLASS` deploy-flag auth mode | Physical ladder (backup key → dashboard → offline creds) + drills | A deploy-flag break-glass is exactly what a GitHub attacker can trigger |
| Action shape | Hand-enumerated RPC methods, tiers keyed by method name | Typed op registry: define once → UI + CLI + API + audit + tests | Keeps §14's best idea (server-side-keyed authority), generalizes it; the DevEx keystone |
| Reads | Scoped SELECT + audit only | + volume caps, reason-gated exports, audited read-only SQL panel | The privacy crown jewel got §14's weakest treatment |
| UI scope | Panels incl. `modelOverrides` CRUD + ZDR aging | Customer-360-centric; those panels are dead (OpenRouter migration deleted the tables) | §14 predates the OpenRouter amendment |
| Notification | Blocking control (a Resend outage froze mutations) | Best-effort email + daily digest, never a control | Controls cannot hang on email delivery |
| Unchanged | Access-gated · in-Worker jose JWT · audit written by the credential-holder on execution · authority keyed server-side · admins are not product users · no impersonation · no content access · the T5.1→T5.2 launch gate | — | §14's right ideas all survive |

---

## 17. Verify-at-implementation ledger

- **Independent MFA plan availability** — founder-verified on the Zero Trust free tier
  (2026-06); absent from any official plan matrix. Re-verify at T5.2; if it regresses to
  a paid gate, the fallback conversation is a paid Zero Trust seat vs. a self-hosted
  WebAuthn-first IdP (both currently rejected).
- **Access app-session minimum granularity** — docs say immediate-timeout…one-month;
  confirm the practical per-session key-tap configuration at T5.2.
- **Assets-only Worker + hostname route split** (`admin.hushbox.ai/*` assets,
  `/api/*` → product Worker) — confirm mechanics at T5.3; Pages + the three-Access-app
  checklist is the fallback.
- **jose on Workers** — known-good pattern; pin the version at T5.2.

**Re-entry triggers:** Enterprise mTLS (offline-CA client certs) if HushBox ever holds
an Enterprise plan — the doctrine-pure auth upgrade · WORM/hash-chained audit on SOC 2
or the first non-founder admin · multi-admin approval (four-eyes) at >3 admins ·
`jobs.targetUserId` index when the 360 jobs panel is hot · WAE SQL read-back when
Postgres metrics stop sufficing.

---

## 18. DevEx & testability

The plane must be 100% controllable and testable locally (founder requirement). Three
earlier rulings already deliver most of it **by construction**:

- **Zero external dependencies in the mutation surface.** The Iron Law's
  no-external-calls rule (and the exclusion of card refunds) makes every op
  Postgres + Redis only — both fully local. The plane needs **no cassettes, no sandbox
  accounts, no mock providers**; its only faked seams are Resend (best-effort notify,
  already mocked) and Access (faked at the JWKS seam, below).
- **Preview = execute-in-a-rolled-back-transaction** lets any test dry-run any op
  against real state and assert exact effects with no cleanup.
- **The registry-enforced battery** (`describeAdminOp` + exhaustiveness test) makes an
  untested op a build failure, not a review finding.

What completes the 100%:

- **Becoming an admin locally — the dev-admin mint.** A `dev-only`-classed route mints
  an Access-shaped JWT signed by a dev JWKS key for a **chosen allowlisted email**; the
  admin SPA's fetch wrapper attaches it as `Cf-Access-Jwt-Assertion` in dev mode, and
  the CLI uses the same mint locally (so CLI and SPA exercise identical server paths).
  Choosing the email gives **actor switching** — audit attribution and
  admin-B-undoes-admin-A are testable. The JWT validation code path **always runs** in
  every mode; only the JWKS source varies via the env registry — never a bypass branch.
  Production is safe by construction: the `dev-only` route class 404s in production and
  the production env registry carries no dev signing key. E2E fakes Access at the same
  seam: the Playwright suite mints real JWTs against the test JWKS so the actual jose
  validation is in the loop.
- **One seed carries every op-target state** (founder ruling: the single seed does
  everything — no scenario system). The seed gains: a dead job, a chargeback-locked
  user, a negative-balance wallet, a revoked share, a discarded job, and any future
  op's target state, so every op is exercisable locally and by tests the moment the
  stack is up.
- **The SQL panel's SELECT-only role exists locally** (§10 migration) with a test that
  attempts a write through it and expects refusal — write-proofness proven, not
  asserted.
- **The admin SPA joins `pnpm dev`** — a second Vite dev server beside the product's,
  against the same local Wrangler where the admin slice is mounted. One command, whole
  plane.

**The honest boundary — config-class risk is not locally testable, by design.** The
Access application config, email allowlist, AAGUID restriction, and the key-enrollment
ceremony are dashboard configuration, not code — the same risk class as
`wrangler.toml`. No local or CI test can exercise them, and none should pretend to:
their verification mechanism is the runbook + the quarterly drill (§6). Do not build a
fake-Access integration test that proves nothing.
