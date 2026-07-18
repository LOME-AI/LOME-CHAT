# Admin Plane — Design & Implementation Plan

> **Status:** Backend, SPA, AND E2E COMPLETE (e2e spec suite built and audited
> 2026-07-16). A1–A7 (backend), A8–A9 (the SPA — shell, dev auth,
> OpModal/OpForm/DiffList/palette, and all seven screens), and A10 (the admin e2e suite —
> ten specs + harness over the `admin` Playwright project) are built and audited clean;
> see the 2026-07-14/15 backend amendments, the **2026-07-16 SPA-build amendment**, and
> the **2026-07-16 e2e-suite amendment** at the end. **Remaining scope: the A11
> founder-physical checklist** (launch-gate); the CI e2e job itself stays `if: false`
> until the Phase-4 transport swap re-lights it. Design locked (founder rulings
> 2026-07-05); task plan re-cut 2026-07-12; §15 is the plan of record, read together with
> the amendments, which supersede it where they conflict. Implementation is Phase 5 of the
> backend rewrite — this document supersedes §14 (Admin plane) and the Phase-5 task block
> of `docs/history/BACKEND-REDESIGN.md` (tombstoned there; original text in git history).
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
   the op transaction; `admin_audit` is append-only via UPDATE/DELETE/TRUNCATE-raising
   triggers (the separate INSERT-only role was ruled out at build time — §10;
   owner-level bypass accepted, off-vendor Kopia→B2 copy is the backstop).
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
   UI form and an API endpoint hitting the same audited engine.
   *Enforce:* generic routes + generic `<OpForm>`; no bespoke
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
                                  #   by the engine and SPA alike
apps/admin/                       # Vite React SPA (§13); + CLAUDE.md at T5.3
```

Integration points (small, named edits):

| File | Change |
|---|---|
| `apps/api/src/lib/context/route-class.ts` | add `'admin'` to `ROUTE_CLASSES`; the exhaustive `match` in `authorizeAccess` forces the new arm |
| `apps/api/src/middleware/` | new pipeline stage: on `'admin'`-classed routes, verify `Cf-Access-Jwt-Assertion` (jose + remote JWKS, issuer + AUD + email allowlist, fail-closed) and set an `admin-actor` principal — the one `Principal`-union extension |
| `apps/api/src/app.ts` | mount `adminManifest` in the chained `.route(…)` list (AppType flows to the SPA) |
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
- **The Single Auth Path Law:** hardware-security-key MFA through Cloudflare Access is the
  *only* production authentication path. No second credential class exists — no service
  tokens, no API keys, no bearer secrets, no non-interactive path. The Access application
  policy carries **only** the email-allowlist + hardware-key rule and **no Service-Auth
  rule**. This is enforced in code as well as config: the JWT stage requires a non-empty
  **allowlisted `email` claim**, so a service-token assertion (which carries a
  `common_name`, not an `email`) fails the allowlist check and 401s even if the Access app
  is ever misconfigured to admit one — fail-closed by construction, pinned by test. The
  only production admin surface is the GUI; break-glass is the physical ladder (§6), never
  a code path.
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
// packages/shared/src/admin/ops.ts — contracts only; the SPA and engine both import this
export interface AdminOpContract<In extends z.ZodType> {
  name: `${string}.${string}`;            // 'wallet.credit'
  title: string;                          // 'Credit wallet'
  kind: 'mutation' | 'read';
  input: In;                              // FLAT Zod object (scalars, plus repeatable
                                          //   groups of flat scalars); mutations always
                                          //   include reason: z.string().min(1)
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
  builds itself), `POST /api/ops/:name/preview`,
  `POST /api/ops/:name/execute`, plus bespoke reads (`GET /api/users/:id/overview`,
  dashboard, jobs queue, audit search). **Adding an op touches zero route or SPA
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
| `user.lock` | `user.unlock` | durable | new identity barrel helpers `lockUserWithinTx`/`unlockUserWithinTx` over `users.lockedAt` + `lockReason` (columns exist; the `user_lock_reason` enum already carries `'admin'`; `users` is identity's table — single-writer). Unlock's `inverseInput` snapshots the original `lockReason` so undo restores `chargeback`, never a default. **Lock auto-revokes sessions, durably** (founder rulings 2026-07-12 / 2026-07-14): the live-session cutoff must never degrade to best-effort. The op **enqueues the must-happen session-revocation job inside its settlement transaction** (atomic with the audit row; rolls back in preview) — the same durable job the chargeback flow uses, generalized from `chargeback.revoke.v1` to a trigger-neutral `session.revoke.v1` so both callers share one mechanism; its handler bumps the `passwordChangedAt` watermark (the sole cutoff for already-live sessions) and evicts sockets, retried until it succeeds. A post-commit best-effort socket eviction still fires for promptness, but correctness no longer rests on it — matching the "auth never degrades" principle. One op is full containment; a locked user must not keep a working session |
| `user.unlock` | `user.lock` | durable | same. Unlock does not restore sessions (session loss is ephemeral-class — the user logs in again); the Iron Law holds on the effective-state projection |
| `sessions.revokeAll` | — | ephemeral | new identity barrel helper `revokeAllSessions(userId)`: bump the `passwordChangedAt` watermark (the existing in-mechanism primitive) |
| `job.redrive` | — | ephemeral (resumes an existing system obligation — the job's effect is the system's at-least-once work, not an admin-originated state change) | dead→pending status flip, attempts reset |
| `job.discard` | `job.restore` | durable | restorable `discardedAt` marker; discarded rows prune on retention (2026-07-03 amendment semantics) |
| `model.disable` | `model.enable` | durable | **needs `model_catalog.admin_disabled_at`** (§10) — no exposure flag exists today. Enforced at **both** `listDescriptors` exposure and turn-time model resolution (typed refusal) — hiding alone leaves direct API selection open. Verified 2026-07-12: the catalog refresh upsert touches only the `descriptor` column, so the flag survives refresh |
| `share.revoke` | `share.unrevoke` | durable | `shared_links.revokedAt` (column exists). **Authorization-only revocation** (founder ruling 2026-07-12): flips `revokedAt` (read paths enforce lazily), marks the guest member left, evicts sockets — **no epoch rotation** (admins hold no key material; member-initiated revoke remains the cryptographic path). Deliberate v1 limitation — record it as a load-bearing comment and a line in the admin slice `CLAUDE.md`. Needs a new conversations barrel write: the existing `revokeSharedLink` is not barrel-exported and demands member privilege + a client rotation body |
| `banner.set` | `banner.set` (self-inverse) | durable | announcements barrel: `readForUpdateWithinTx` (FOR UPDATE prior-state snapshot → `inverseInput`, salvage→strict narrowing: text/variant/linkText always restored, strict-invalid legacy hrefs dropped, `id` dropped) + `setWithinTx` (update-newest-else-insert). `enabled ⇒ ≥1 message` enforced in the op body; zero messages legal (disabled state and undo-of-first-set) |

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
   race-safe and append-only-compatible); add the append-only hardening — `BEFORE
   UPDATE OR DELETE` **and `BEFORE TRUNCATE`** triggers that raise. **Amended
   2026-07-13 (build-time ruling): the separate INSERT-only audit-writing role is not
   built.** The audit row commits inside the same settlement transaction that writes
   the op's other tables (wallets, jobs, …), so an audit-only connection role can never
   run that transaction — and role grants cannot bind the owner role the Worker
   actually connects as. The role would be decorative. The enforced mechanism is the
   trigger pair (defends against every role except table owner/superuser); the
   owner-level bypass is accepted, with the Kopia→B2 daily copy as the off-vendor
   record — matching the threat-model row as re-worded in §11.
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
| DB-credentialed attacker | Audit history not silently rewritable below owner level (UPDATE/DELETE/TRUNCATE-raising triggers; the separate INSERT-only role was ruled out at build time — §10); owner-level bypass accepted; off-vendor daily copy via Kopia→B2 |
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

> **Re-cut 2026-07-12 (founder-approved orchestration pass; the T5.x block this replaces
> is in git history).** Two structural changes: (1) T5.2 bundled routes + JWT + reads +
> cron + seed + ceremony + runbook into one oversized task — it is now A5/A6/A7
> plus the founder-physical checklist (A11); (2) barrel gap-fills in the composed slices
> (verified missing — see the 2026-07-12 amendment) are their own parallel tasks (A2a–e)
> instead of riders on the op task. The launch gate carries forward unchanged in spirit.

**Launch gate:** the audited intervention lever is the GUI (the Single Auth Path Law — §6
— makes the GUI the sole production admin surface), so the pre-launch set is the backend
plane **and** the SPA: A1–A7 (contracts, engine, every §9 op, HTTP surface, reads) plus
A8–A9 (the SPA) plus A10 (admin e2e) must complete before any public launch — no public
users without a hardware-key-gated, audited way to intervene. There is no interim
non-GUI lever.

- **A1 Contracts + migrations + factories** ⚠️ — the op-contract module
  (`packages/shared/src/admin/`: `AdminOpContract`, all §9 op contracts — flat Zod
  inputs with `reason`, inverse, effectClass, guardrails); the §10 migrations (audit
  indexes + `undoes uuid UNIQUE` + the update/delete/truncate-raising triggers — the
  INSERT-only audit role was ruled out at build time, see §10;
  `model_catalog.admin_disabled_at`; restorable job discard (`discardedAt`);
  the SQL-panel SELECT-only role, created in-chain, **with plaintext-credential
  carve-outs** — `verification_tokens` unreadable, `users.opaque_registration`
  column-revoked); the **first non-legacy fishery
  factories** in `packages/db/src/factories/` (all current factories are `legacy_` —
  the battery needs user/wallet/job/shared-link at minimum). *Acc:* migrations
  shape-tested; UPDATE/DELETE/TRUNCATE on `admin_audit` raise (test); a write attempt
  through the SQL-panel role is refused and the credential carve-outs hold (test);
  factories build valid rows; contracts
  typecheck with the exhaustiveness test ready to consume them. *Owns:*
  `packages/shared/src/admin/**`, `packages/db/**`.
- **A2a identity barrel helpers** ⚠️ — `lockUserWithinTx`/`unlockUserWithinTx`
  (reason-parameterized; the only existing lock write is chargeback-specific and
  unexported, and **no unlock exists anywhere**), barrel-exported for the admin slice
  (`users` is identity's table — single-writer; `revokeAllSessions` +
  `evictUserBestEffort` are already exported). *Acc:* lock/unlock round-trip tests incl.
  the paired-null check constraint; barrel exports typed. *Owns:* `slices/identity/**`.
- **A2b conversations admin share revoke/unrevoke** ⚠️ — a published
  authorization-only revoke/unrevoke write per the §9 ruling (flip `revokedAt`, mark the
  guest member left, expose the eviction hook; no rotation, no member-privilege gate) —
  the existing `revokeSharedLink` is unexported and demands member privilege + a client
  rotation body. *Acc:* revoked link refused at the public read (lazy enforcement
  verified); unrevoke restores; the deviation documented as a load-bearing comment.
  *Owns:* `slices/conversations/**`.
- **A2c jobs redrive/discard/restore** — `lib/jobs` helpers implementing the documented
  redrive contract (dead→pending **with** `claims`/`failures`/`nextAttemptAt` reset
  together — `claim.ts` documents this; no helper exists), discard/restore over the new
  `discardedAt` marker, and the discarded-rows retention-prune entry (2026-07-03
  amendment semantics). *Acc:* redrive of a dead row re-executes exactly once;
  status-only redrive is impossible through the helper; discarded rows prune on
  retention, undischarged dead rows never do. *Owns:* `lib/jobs/**`,
  `apps/api/src/jobs/retention-entries*`. (dep A1)
- **A2d models disable gating** — `admin_disabled_at` honored by `listDescriptors`
  **and at turn-time model resolution** (typed refusal — hiding alone leaves direct API
  selection open); a refresh non-clobber test (verified: the upsert touches only
  `descriptor`). *Acc:* a disabled model is invisible in listings AND refused at turn
  admission with a typed error; refresh preserves the flag. *Owns:* `slices/models/**`.
  (dep A1)
- **A2e notifications templates** — the admin op-notification email template + the
  daily-digest template (compose-with-`EmailSender.send` pattern; no one-shot sender
  exists). *Acc:* templates render; send path is best-effort (a failed Result is logged,
  never thrown). *Owns:* `slices/notifications/**`.
- **A3 Ops engine + registry + harness** ⚠️ — the registry (the Iron Law gate: a durable
  mutation without a registered inverse is rejected at registration), the engine
  (engine-owned `SettlementTx` via the shared `lib/idempotency` helper, audit-in-tx,
  `PreviewRollback` sentinel, guardrails, `idempotent.byKey`, **and a post-commit
  ephemeral-effects hook** — op bodies stay Postgres-only inside the transaction; Redis
  watermark bumps and best-effort socket eviction run after commit, per the §9
  `user.lock` ruling), the `describeAdminOp` harness + registry exhaustiveness test, the
  arch rule + lint extension (no external calls and no raw Drizzle in op bodies; ops
  imported only by the registry). *Acc:* registry rejects an inverse-less durable
  mutation (test); preview≡execute and audit-atomicity hold for a fixture op under
  injected failure; a second undo of the same audit row fails the `undoes` unique claim
  (test); ephemeral effects demonstrably run only after commit (test); the harness runs
  the full §12 battery against the fixture op. *Owns:* `slices/admin/**` (minus
  `domain/operations/`), `packages/config` extension + arch-rule files. (dep A1)
- **A4a Money ops** ⚠️ — `wallet.credit`/`wallet.clawback` composing the `BillingStores`
  within-tx methods (they are port methods, not free exports: `lockWalletWithinTx`,
  `insertLedgerLegsIfAbsentWithinTx` — promo/clawback kinds and the `promo` house
  account already exist) + `writeThroughSnapshot`. *Acc:* full §12 battery incl.
  interleaving invariance; conservation clean after execute+undo
  (`runConservationAudit`); snapshot write-through verified. *Owns:*
  `slices/admin/domain/operations/**`. (dep A3)
- **A4b Remaining ops** ⚠️ — `user.lock`/`user.unlock` (auto-revoke per §9),
  `sessions.revokeAll`, `job.redrive`, `job.discard`/`job.restore`,
  `model.disable`/`model.enable`, `share.revoke`/`share.unrevoke`, each on the A2
  helpers. *Acc:* full §12 battery green for every op; a locked user's live session is
  dead at the next request (watermark verified). *Owns:*
  `slices/admin/domain/operations/**` (serialized after A4a — shared registry wiring).
  (dep A4a, A2a–e)
- **A5 HTTP surface** ⚠️ — the `'admin'` route class (the exhaustive `match` in
  `authorizeAccess` forces the new arm) + admin-actor principal, the JWT pipeline stage
  (jose + remote JWKS, issuer + AUD + exact-match email allowlist, fail-closed;
  test-JWKS seam for dev/e2e), env registry entries (`CF_ACCESS_TEAM_DOMAIN`,
  `CF_ACCESS_AUD`, the dev JWKS key — production carries no dev signing key), the §18
  dev-admin mint route (`dev-only` class), the generic ops routes (`GET /ops`,
  `POST /ops/:name/preview|execute`), the `app.ts` mount + wrangler hostname route, and
  the `jose` dependency. *Acc:* §12 authz-denial battery (no/invalid/wrong-AUD/
  non-allowlisted JWT ⇒ 401, zero effect); the fixture op reachable end-to-end over HTTP
  with real jose validation in the loop; dev mint works in dev and 404s in production.
  *Owns:* `slices/admin/routes.ts`, `lib/context/route-class.ts` + `principal*`,
  `middleware/pipeline-admin*`, `app.ts`, `apps/api/wrangler.toml`,
  `packages/shared/src/env.config.ts`, `apps/api/package.json` (jose). (dep A3)
- **A6 Reads: Customer-360 + dashboard + jobs queue + audit search + SQL panel** ⚠️ —
  `domain/customer-360.ts` assembly (indexed queries per §8), dashboard reads, the
  jobs-queue read, audit search (`undoes`/`undone-by` threading), read-audit rows (one
  coarse row per 360 view), read rate-limit entries + volume caps, and the SQL-panel
  backend on the SELECT-only role (second connection string; every query text audited;
  counts toward the same read-volume caps). *Acc:* a 360 view writes a read-audit row;
  the read rate limit trips (test); a write through the SQL panel is refused (test);
  panel queries hit the §10 indexes. *Owns:* `slices/admin/domain/customer-360*`,
  `slices/admin/routes.ts` (read routes; serialized after A5), the admin rate-limit
  adapter. (dep A5)
- **A7 Seed + notify + Access-log cron** — the single-seed op-target states (dead job,
  chargeback-locked user, negative-balance wallet, revoked share, discarded job — none
  exist in the seed today), so every op is exercisable end-to-end from the SPA and e2e;
  best-effort mutation notification + daily digest wiring (A2e templates); the
  **Access-log pull cron** (~6-hourly per §5; behind a port with a fake adapter — the
  real Cloudflare API client is not locally exercisable, per §18's honest boundary; adds
  a Cloudflare API token env entry). *Acc:* every op's target state exists after
  `db:seed`; digest renders from seeded audit rows; the cron entry registers on its
  cadence with the fake adapter covered by tests. *Owns:* `scripts/seed*`, root
  `package.json` scripts, `apps/api/src/jobs/**` + `scheduled.ts`. (dep A5)
- **A8 SPA shell + op surfaces** *(follow-up run)* — scaffold `apps/admin` (Vite,
  TanStack Router/Query, `hc<AppType>` client, `TEST_IDS`, the dev fetch wrapper
  attaching the dev-mint JWT, **joins `pnpm dev`** — §18); the assets-only Worker +
  route config (`workers_dev = false`); the OpModal (form → preview → execute / undo),
  generic `<OpForm>`, `<DiffList>`, the ⌘K palette, the auto-generated ops catalog.
  *Acc:* every §9 op executable end-to-end with preview and undo from the UI; in-modal
  retry reuses the minted `Idempotency-Key` (test); palette reaches any op and screen.
  *Owns:* `apps/admin/**`, the admin assets wrangler config. (dep A5, A6)
- **A9 SPA screens** *(follow-up run)* — Dashboard (health strip + recent-actions feed
  with undo), Customer 360 (independent panels per §8), jobs queue, audit trail
  (`undoes`/`undone-by` threading), models, read-only SQL panel; `docs/DESIGN.md`
  §Admin-app compliance pass via the frontend-design / design-review loop. *Acc:*
  per-panel failure isolation (test); palette reaches any user by email/id; audit trail
  filters by actor/action/target/date. *Owns:* `apps/admin/**` (screens; serialized
  after A8). (dep A8)
- **A10 Admin e2e** *(follow-up run)* — own Playwright project: Access faked at the real
  JWKS seam (the suite mints JWTs so the actual validation code runs); preview →
  execute → audit-row → undo → audit-thread assertions; denied-op and guardrail-trip
  specs; the accessibility checks the existing suite applies. *Acc:* suite green in CI.
  *Owns:* the admin e2e project under `e2e/**`. (dep A9)
- **A11 Founder runbook + ceremony checklist** (docs) — the enrollment-ceremony
  writeup, break-glass runbook, drill schedule, and the founder-physical checklist:
  create the Access app + AAGUID restriction with a policy carrying **only** the
  email-allowlist + hardware-key rule and **no Service-Auth rule** (the config side of
  the Single Auth Path Law — §6), enroll 2× YubiKeys, mint the Neon SQL-panel role
  password + Cloudflare secrets. The physical performance of the ceremony and drills is
  the founder's, never an agent's. *Owns:* runbook artifacts under `docs/plans/`.

Wave order: **A1 → (A2a–e ∥ A3) → (A4a → A4b ∥ A5) → (A6 ∥ A7)**, then in a follow-up
run **A8 → A9 → A10**; A11 anytime. Runs after T4.5, ∥ T4.9 (no glob collision — legacy
deletion, T4.7, runs last as Phase 6, after Phase 5). Tasks sharing a dir serialize
(A4a→A4b; A6 after A5 on `routes.ts`; A8→A9); everything else in a wave is parallel.

---

## 16. Deltas from BACKEND-REDESIGN §14 / Phase 5

The why-it-changed record. Original text in git history (tombstoned 2026-07-05).

| Dimension | Superseded §14 / Phase 5 | This design | Why |
|---|---|---|---|
| Workers | Separate `apps/admin-api` + service-binding RPC | One product Worker, admin slice + `'admin'` route class | The RPC isolated a near-empty doorman; creds/power lived product-side either way; Access-at-edge + JWT is the same wall minus a deploy target and a net-new RPC pattern |
| Step-up auth | Bespoke in-app WebAuthn (separate registration) | Access Independent MFA (YubiKey, AAGUID-pinned, every login) | Deletes the largest zero-basis build; hardware-bound beats synced platform passkeys; enrollment locked after ceremony |
| Safety model | Four tiers of delay-and-notify (2 m/10 m/30 m/24 h) + cancellable jobs + notify-all | **Reversibility Iron Law**: instant execute + preview + perfect undo; no irreversible ops exist | Founder ruling. Deletes `admin.executeAction.v1`/`admin.notify.v1` and the pending-queue machinery; fixes the 30-minute support-credit UX; undo > delay for everything reversible |
| Irreversible actions | 24 h-delayed deletion; step-up refunds | None. Deletion stays user-initiated; card refunds via the Helcim dashboard + a ledger op | Iron Law consequence; GDPR-coherent |
| Audit | `admin_audit` + daily WORM R2 export + per-batch SHA-256 | `admin_audit` + update/delete/truncate-raising triggers (INSERT-only role ruled out at build time — §10); off-vendor copy = existing Kopia→B2 | The WORM export was a second delivery path for what backups already cover; re-entry: SOC 2 or first non-founder admin |
| Break-glass | `BREAK_GLASS` deploy-flag auth mode | Physical ladder (backup key → dashboard → offline creds) + drills | A deploy-flag break-glass is exactly what a GitHub attacker can trigger |
| Action shape | Hand-enumerated RPC methods, tiers keyed by method name | Typed op registry: define once → UI + API + audit + tests | Keeps §14's best idea (server-side-keyed authority), generalizes it; the DevEx keystone |
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
  admin SPA's fetch wrapper attaches it as `Cf-Access-Jwt-Assertion` in dev mode, and the
  e2e suite mints the same way (so the tests exercise the real server validation path).
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

---

## Amendment — 2026-07-12: pre-implementation verification + founder rulings + task re-cut

Founder-directed, recorded after a full orchestration planning pass (design doc verified
line-by-line against the as-built tree). §15 above is edited in place to the A-task plan
of record; the §9 table carries the ruling deltas inline. This amendment holds the
verification findings and the rulings' rationale.

### Founder rulings

1. **Timing:** the plan is approved; implementation dispatch is deliberately deferred to
   a later session (at ruling time the repo was mid-rebase and the CI e2e transport swap
   — the last open T4.5 item — was still `if: false` in `ci.yml`). T4.5's gate is a
   launch gate for Phase 5's output, not a build gate; starting admin work before the CI
   e2e swap completes is acceptable once the rebase resolves.
2. **Scope of the first implementation run: backend-first A1–A7.** The SPA (A8–A9) and
   admin e2e (A10) build in a later run — but they are part of the launch-gate scope, not
   optional follow-ups: the GUI is the sole production admin surface (§6), so there is no
   pre-launch shortcut around it.
3. **`share.revoke` is authorization-only** (no epoch rotation — admins hold no key
   material; the member-initiated revoke remains the cryptographic path). Deliberate v1
   limitation, documented in code and the admin slice `CLAUDE.md`.
4. **`user.lock` auto-revokes sessions.** Locking alone never cut live sessions (only
   the `passwordChangedAt` watermark does — the chargeback flow already pairs them), so
   a lock without revocation left a locked user with a working session.
   `user.unlock` does not restore sessions (ephemeral class — the user logs in again).
   This forces one engine feature: a **post-commit ephemeral-effects hook** (A3) — op
   bodies stay Postgres-only inside the settlement transaction; Redis/DO effects run
   only after commit.

   **Amended 2026-07-14 (durability):** the A4b audit showed a best-effort post-commit
   watermark bump can be lost on a transient Redis failure, leaving a locked user's
   live sessions alive until natural expiry — strictly weaker than the chargeback
   flow's guarantee and than "auth never degrades." Founder ruling: the watermark bump
   for **both `user.lock` and `sessions.revokeAll`** goes through the durable
   must-happen job (the existing `chargeback.revoke.v1` handler, renamed to the
   trigger-neutral **`session.revoke.v1`** and shared by all three callers), enqueued
   **inside the settlement transaction** so it is atomic with the audit row and rolls
   back in preview. The post-commit ephemeral remains only for prompt socket eviction;
   the revocation cutoff is now durable and retried, not best-effort.

### Verification findings (2026-07-12, against the as-built tree)

What this plan assumed correctly — confirmed present: `users.lockedAt`/`lockReason`
(paired-null check; the `user_lock_reason` enum already carries `'admin'`),
`shared_links.revokedAt`, `jobs.cancelRequested` (wired), ledger kinds
`promo`/`clawback` + the `promo` house account, `revokeAllSessions` +
`evictUserBestEffort` on the identity barrel, `SettlementTx` minted in shared
`lib/idempotency` (so the admin engine can legally open one), the `dev-only` route class
404-in-production mechanism, and both nested `CLAUDE.md` files.

Confirmed missing — each now owned by a named task:

- The §10 migrations in full (`admin_audit` indexes/`undoes`/append-only triggers;
  `jobs` restorable discard; `model_catalog.admin_disabled_at`; the SQL-panel
  SELECT-only role) — **A1**.
- **No non-legacy fishery factory exists anywhere** in `packages/db` (all are
  `legacy_`-prefixed) — the battery's factories are net-new — **A1**.
- `jose` is not a dependency — **A5**.
- Identity has **no general lock/unlock helper** (the only lock write is
  chargeback-specific and unexported; no unlock exists at all) — **A2a**.
- Conversations' `revokeSharedLink` is not on the public barrel and demands member
  privilege + a client rotation body — unusable for an admin-force revoke — **A2b**.
- `lib/jobs` has **no redrive helper** — only the documented contract (dead→pending must
  reset `claims`/`failures`/`nextAttemptAt` together) — **A2c**.
- The billing primitives the §7 op sketch names (`lockWalletWithinTx`,
  `insertLedgerLegsIfAbsentWithinTx`, `updateWalletBalanceWithinTx`) are
  **`BillingStores` port methods, not free barrel exports** — the ops compose a stores
  instance + `SettlementTx`, no billing changes needed — **A4a**.
- `model.disable` needs enforcement at **turn-time model resolution**, not only
  `listDescriptors` (hiding alone leaves direct API selection open); the catalog-refresh
  upsert touches only the `descriptor` column, so the new flag survives refresh —
  **A2d**.
- Notifications has templates + `EmailSender.send` but no admin templates — **A2e**.
- The seed contains none of the op-target states (no dead job, locked user,
  negative-balance wallet, revoked share, discarded job) — **A7**.
- The Access-log pull cron needs a Cloudflare API token env entry this plan had not
  listed, and its real client is not locally exercisable — it lives behind a port with a
  fake adapter (§18's honest boundary) — **A7**.
- The SQL panel's SELECT-only role needs a **second connection string** for the Worker;
  the role is created in-chain (works locally and on Neon), but the production password
  mint + Cloudflare secret are founder-physical — **A11 checklist**.

## Amendment — 2026-07-14: as-built rulings and deviations from the A6/A7 wave

Founder-ruled and orchestrator-recorded at the close of the backend build (A1–A7 all
audited clean). These supersede the body text where they conflict.

- **`admin_audit.target_id` is `text`, not uuid** (founder ruling). Model ops target
  string model ids; audit search needs one uniform indexed target path, so the column
  widened in-chain (`0051_admin-plane-groundwork.sql`) rather than special-casing a
  JSON-details search. `model.disable`/`model.enable` now write
  `target {type:'model', id}` and are searchable by target. The
  `(target_type, target_id)` index is the search access path.
- **The SQL panel is `GET /admin/sql?query=`, not POST.** A POST would require an
  Idempotency-Key exemption class whose arch evidence (an `idempotent.*` wrapper) a
  pure read cannot honestly show. No log sink captures the URL: request-log records
  only the matched route template, and Workers observability is off (`wrangler.toml` —
  flipping it on would capture query URLs; recorded there as a tripwire comment). The
  audit row is the sole record of query text, written and awaited **before** execution
  (fail-closed: a failed audit insert blocks the read).
- **Audit search is volume-capped but not itself read-audited.** It reads admin
  actions, not customer metadata; the audited read set is closed and enumerated in
  `domain/read-audit.ts` (one coarse row per Customer-360 view, one per SQL-panel
  query). Deliberate scope, not an omission.
- **The Single Auth Path Law is pinned by test:** a validly-signed Access JWT carrying
  `common_name` and no `email` (service-token shape) ⇒ 401 through the real jose path
  (`middleware/pipeline-admin.test.ts`), alongside the empty-email variant.
- **The `admin-engine` idempotency exemption is structurally enforced:** valid only on
  a registration carrying `routeClass('admin')` whose terminal handler contains an
  actual `runAdminOp(...)` call expression — a substring/comment mention no longer
  counts. The flat-input gate fails closed on `z.lazy` and recurses
  intersections/unions/pipes; `ZodMap`/`ZodSet` are always-nested.
- **Access-log cron ships fail-fast pending founder config:** the real Cloudflare
  adapter binds `CLOUDFLARE_ACCESS_LOG_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (env
  registry entries exist; production secret values are founder-physical, with the
  Access app itself). Until set, the production cron raises a named, Sentry-visible
  error rather than silently auditing nothing. Dev/CI runs the fake adapter.
- **Two dashboard reads deferred:** billing-auditor results and failed-payment count
  (no published billing read API yet); the jobs-touching-user panel is payload-based
  and LIMIT-bounded, with an index as the documented re-entry when it gets hot.

## Amendment — 2026-07-15: backend build complete — verification record

The backend admin plane is done. Every task ended on a clean audit; sensitive tasks
(A1, A4a, A4b, A6, plus the chat gate and money-adjacent work) took three-lens panels
or the mandated multi-lens review; the fix→audit loop never exceeded its cap.

**Complete and audited:** A1 (contracts, migrations, factories), A2a–e (slice write
helpers), the chat `MODEL_DISABLED` gate, A3 (ops engine + registry + `describeAdminOp`
battery + purity arch rule), A4a (`wallet.credit`/`wallet.clawback`), A4b (all remaining
§9 ops, with `user.lock`/`sessions.revokeAll` revoking durably via the `session.revoke.v1`
job enqueued inside the settlement transaction), A5 (HTTP surface), A6 (reads:
Customer-360, dashboard, jobs queue, audit search with undo threading, SQL panel on the
SELECT-only role), A7 (seed op-target states, best-effort op notifications + daily
digest, Access-log pull cron behind a port with a fake adapter, discarded-jobs prune
wiring). Follow-ups, also audited clean: the Single Auth Path Law pin test; the
`target_id`→text groundwork migration; the enforcement hardening (`admin-engine`
exemption structural + route-class-bound; flat-input gate fail-closed on
`z.lazy`/intersection/map/set); a 13-item ledger sweep (naming, plan-citation comments,
task-ID fixture prefixes, SQL-panel `statement_timeout` + server-side LIMIT,
ensure-stack loopback guard, composed-app rate-limit mount pin, `CLOUDFLARE_ACCOUNT_ID`
env entry, subtree exemption tests); and two test-reliability fixes outside the admin
slice that the close pass surfaced (stale radix-100 versionCode expectations in the
scripts suite; two chat-slice suites seeding `model_catalog` without the shared
catalog lock, which intermittently broke the dev-routes no-text-model test).

**Verification state at close (2026-07-14/15):** `pnpm typecheck`, `pnpm lint`,
`pnpm arch:check`, `pnpm lint:duplication`, and `pnpm lint:unused` all green;
`pnpm test` green across all packages except one known pre-existing cross-suite Redis
flake (`app-share-read-rate-limit` — passes in isolation, fails intermittently in full
runs; unowned by this build, worth its own diagnose-and-fix pass).

**Outstanding before launch:** A8–A9 (the SPA), A10 (admin e2e), and the A11
founder-physical checklist — the Access app + AAGUID-restricted policy (email allowlist
+ hardware key only, no Service-Auth rule), the two-YubiKey enrollment ceremony and
drills, the Neon `admin_sql_panel` LOGIN password, and the production secrets
(`ADMIN_SQL_PANEL_DATABASE_URL`, `CLOUDFLARE_ACCESS_LOG_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`). Until those secrets exist the production Access-log cron
fail-fasts with a named, Sentry-visible error — deliberate, not a defect.

## Amendment — 2026-07-16: SPA build complete (A8–A9) + design gate closed

The admin SPA is built, audited, and design-gated. Every task landed through the
subagent-driven-dev loop (implement → audit; sensitive tasks through a three-lens
correctness/security/conventions panel), and the full unscoped close pass is green:
`pnpm typecheck`, `pnpm lint`, `pnpm arch:check`, `pnpm lint:duplication`,
`pnpm lint:unused`, and `pnpm test` (all packages).

**What shipped (all audited clean):**

- **Op registry wired live.** The composition root (`apps/api/src/app.ts`) now composes
  the twelve op implementations with real slice deps (`adapters/admin-op-bindings.ts`);
  `GET /admin/ops` lists the full registered set and preview/execute/undo run end-to-end
  over HTTP. The must-happen `session.revoke.v1` enqueue stays in-transaction (fail-fast on
  misconfig); only post-commit promptness (DO wake, socket eviction) degrades.
- **Production `/api/admin/*` path alias.** A Hono `getPath` hook rewrites `/api/admin/...`
  → `/admin/...` before routing, so the `admin.hushbox.ai/api/*` wrangler route reaches the
  slice; every pipeline stage, rate-limit mount, and the authorizer see the canonical path.
  Fail-closed (encoded-traversal pinned to 404; unauth alias → 401).
- **CSRF admits the admin origin.** `ADMIN_URL` joined the CSRF Origin allowlist (env
  registry, all five modes explicit, exact-origin match, fail-closed). Load-bearing because
  Cloudflare Access authenticates by cookie at the edge, so Origin checking is the admin
  plane's real CSRF defense, not redundancy.
- **Read surface completed.** Customer-360 gained account facts (createdAt, lockReason),
  wallet identity (id/type/balance, for op prefill), and a devices panel (platform tallies,
  **never** the push-token value — excluded at the SQL projection); the no-sessions-panel
  impossibility (stateless iron-session, no enumerable store) is a durable comment.
  `GET /admin/models` is a new models-slice published read that sees through the exposure
  gate (disabled + unexposed models, corrupt descriptors kept-but-nulled).
- **Device-token SQL-panel carve-out.** Migration `0052` column-scopes the `admin_sql_panel`
  role's read on `device_tokens` so `token` (push credential material) is unreadable through
  the panel — closing a gap against the `packages/db/CLAUDE.md` credential-material doctrine
  (the existing `verification_tokens` / `users.opaque_registration` carve-outs are the
  precedent).
- **The SPA (`apps/admin`).** A second Vite/React app mirroring `apps/web` (TanStack
  Router/Query, `hc<AppType>` client, `@hushbox/ui`, shared Tailwind tokens, 95% per-file
  coverage). Joins `pnpm dev` on its own port (`BASE_PORTS.admin = 7000`, worktree-offset;
  `HB_ADMIN_PORT`/`VITE_ADMIN_URL` generated); calls the API through a relative `/api` dev
  proxy (production topology). Dev auth is a memory-only dev-JWT fetch wrapper with an actor
  switcher; production attaches nothing (Access at the edge). A dev-only Admin link sits in
  the web app's sidebar `DevMenuItems`. An assets-only `apps/admin/wrangler.toml`
  (`workers_dev = false`) plus the CI deploy step ship the build.
- **Interaction machinery + screens.** The OpModal (form → preview `<DiffList>` →
  execute/undo, consequence-labeled button, Idempotency-Key per submission), the one generic
  `<OpForm>` rendered from the wire contract catalog, the ⌘K palette (no new dependency),
  and all seven screens: Dashboard, Customer 360, Jobs (dead-as-inbox, row-expand attempt
  history, redrive/discard/restore), Audit trail (URL-owned filters, row drawer with undo
  threading), Models (type-to-filter, disable/enable), SQL panel (read-only, honest
  truncation chip, query history), Ops catalog. Every read re-validates against a shared Zod
  wire schema (`packages/shared/src/admin/wire.ts`); every mutation flows through the
  OpModal; execute-success invalidates the `['admin']` query root.

**Design gate (frontend-design skill).** Detector clean; two live browser-driven review
passes; every real finding fixed and code-audited. Notable outcomes: error-red tokens
darkened minimally (hue-preserved) so error text meets AA (≥4.5:1) on card surfaces in both
themes — a token change shared with `apps/web`, which had the same failing pairing; page
tables wrap in their own `overflow-x` containers (no page-level horizontal scroll at any
breakpoint); the sidebar collapses to an icon rail below 900px; brand-red headings bumped to
weight 700 / ≥19px for AA. The two "blocker"-severity review findings (a ⌘K crash, a
flapping dev server) were confirmed to be **dev-server HMR/process artifacts**, not code
defects — reproduced only on a stale server, gone on a clean restart, and structurally
impossible in a production bundle (single module graph).

**Deviations from §15's sketch, recorded:**

- §15 listed A5 (HTTP surface) and the reads as backend-only; in practice the op registry
  was still composed empty at backend close (`GET /admin/ops` answered 404), so wiring it
  live was a distinct SPA-wave task. The read surface also needed three additive backend
  tasks the original op inventory did not name: the Customer-360 field extension, the
  `GET /admin/models` read, and the device-token carve-out.
- The SPA calls the API same-origin via a dev proxy (relative `/api`), not the web app's
  cross-origin `VITE_API_URL` — chosen to mirror production (`admin.hushbox.ai/api/*`) and
  avoid a CORS carve-out for the Access header.
- Two app-to-app mirrors are accepted (apps cannot import apps, no shared home exists): the
  admin `env`/`fetchJson` helpers echo `apps/web`'s. A follow-up could promote
  `fetchJson`/`ApiError` to a shared package now that two apps carry them.

**Remaining after this amendment:** A10 (admin e2e — superseded by the 2026-07-16 e2e-suite
amendment below, which built it) and A11 — the founder-physical checklist (Access app +
AAGUID policy, the two-YubiKey ceremony and drills, the Neon `admin_sql_panel` LOGIN
password, and the production secrets: `ADMIN_SQL_PANEL_DATABASE_URL`,
`CLOUDFLARE_ACCESS_LOG_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
No production deploy runs until A11 is performed; **A1→A10 are the pre-launch gate**
(the GUI is the only production admin surface).

---

## Amendment — 2026-07-16: A10 admin e2e suite built; seeding unified

The full admin e2e spec suite is built and audited clean (subagent-driven run, every task
implement→audit; auth-boundary work under a three-lens panel). The `ADMIN-E2E-PLAN.md`
working artifact is retired per its own header now that the suite ships.

**Support changes, as landed (two founder rulings executed, one superseded):**

- **Seeding unified (founder, 2026-07-16) — supersedes the "seed into `--profile e2e`"
  ruling.** The seed-profile system was removed entirely: one `runSeed()` seeds everything
  the old profiles produced (test personas + dev personas + mallory + wallet balances +
  dev conversations + billing history + admin op-targets), matching the legacy
  single-seed design. `pnpm db:seed` takes no flags (any argument fail-fasts);
  `pnpm dev` now seeds automatically; `e2e:prepare` and CI seed unflagged.
- **SPA dev-auth enabled under E2E** — the gate is `(isLocalDev || isE2E) && !isProduction`
  (single computed flag in `apps/admin/src/lib/env.ts`), leak-guard-tested at three layers
  including the flags-leaked-into-a-production-build shape. Production remains
  attach-nothing, with the server side unchanged (dev-only mint route, no prod signing key).
- **Per-test target minting** — `POST /dev/admin-targets` (dev-only class) mints fresh
  locked-user / dead-job / discarded-job / revoked-share rows with unique ids per call, so
  `fullyParallel` specs never race over the fixed seeded targets. Minted users are
  deliberately not OPAQUE-loginable (op targets only).

**The suite** (`e2e/admin/`, `admin` Playwright project, 21 tests): `harness-smoke` (SPA →
dev-JWT → proxied Worker → DB, dashboard tiles) · `op-lifecycle` (the flagship
credit→preview→execute→undo journey with mid-flow preview-commits-nothing and doubly-linked
audit-trail assertions) · `guardrails` (over-cap audited refusal, exactly-once undo via the
UNIQUE `undoes` claim, idempotency replay + body-hash 409) · `user-lock` (two-effect lock
with session revocation, snapshot lockReason restore on undo, ephemeral revokeAll) · `jobs`
(redrive/discard/restore + conflicts, restore-never-redrives) · `audit-trail` (filters,
pagination over a self-seeded 52-row trail, drawer + undo-pair jumps) · `customer-360`
(four screen states, independent panels, token-free devices panel, audited reads) ·
`sql-panel` (200-row truncation, write refusal, credential carve-outs, audit-before-execution)
· `auth-boundary` (the Single Auth Path Law live: absent/garbage/non-allowlisted 401s,
auth-precedes-validation, `/api/admin/*` alias parity + near-miss 404) · `models`
(kill-switch round-trip with restore-on-failure) · `palette` (⌘K keyboard flows, actor
switcher with per-actor audit attribution).

**Suite facts a future spec author must know** (also in helper doc comments): the admin
read limiters (Customer-360 120/hr, audit 240/hr, SQL 120/hr per actor) have **no dev
reset** — specs budget reads and spread actors; the sanctioned local unblock during
iteration is clearing the `admin:read:*` keys in the docker Redis, never from spec code.
UI-provoked 4xx needs BOTH `expectApiErrors` and `expectConsoleErrors` (the browser logs a
paired console line). `adminPage` is fully instrumented (console/API/network guardrails).
Wallet-adjustment ledger identity is (op, wallet, amount, reason) — vary `reason`. The
e2e-critical model ids are single-sourced in `scripts/lib/e2e-model-ids.ts` (import-free,
shared by the catalog gate and the kill-switch spec's exclusion set).

**CI:** the `admin` matrix leg exists; the whole e2e job remains `if: false` until the
Phase-4 transport swap re-lights it — unchanged by this work.
