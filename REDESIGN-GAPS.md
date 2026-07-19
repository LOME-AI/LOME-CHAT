# Redesign → implementation gaps: single-writer enforcement & ValueStore ingress metering

Two features that `docs/plans/BACKEND-REDESIGN.md` promised but the implementation only partially built. Each section is self-contained and implementation-ready for a developer with no prior context: what the design wanted, what actually shipped (with `file:line`), whether to build it, and a step-by-step implementation guide.

- **#3** — the single-writer-per-table arch rule (never built as an enforced gate).
- **#7** — ValueStore byte-metering at model-adapter ingress (metered only at the engine, too late).

---

## #3 — Single-writer-per-table arch rule

### What the design wanted

`docs/ARCHITECTURE.md:49` states the invariant: **"Ownership is single-writer-per-table."** Every table is written (insert / update / delete) by exactly **one** owning slice; every other slice goes through that slice's published barrel API instead of touching the table. `BACKEND-REDESIGN.md` §6 promised this as a dedicated **ts-morph arch rule** ("one more ts-morph rule keeps the handle honest") — a build-time gate proving that slice code references only its own slice's schema objects for writes.

### What we implemented

The invariant **holds today** — the audit's manual §6.4 pass mapped every insert/update in `apps/api/src/slices/**` and found no table written by more than one slice — but **nothing enforces it**. The registered arch rules are:

```
packages/config/arch/rules/
  admin-op-purity.rule.ts
  do-classes-live-in-realtime.rule.ts
  idempotency-exemption-wrappers.rule.ts
  jobs-test-shard-isolation.rule.ts
  mutating-routes-prove-idempotency.rule.ts
  no-drizzle-operators-in-barrels.rule.ts
  no-external-call-in-transaction.rule.ts
  onerror-handler-only-in-app.rule.ts
```

None maps slices → owned tables. And because every table is defined centrally in `packages/db/src/schema/*` and every slice legitimately imports tables via `@hushbox/db`, the boundary lint (`eslint-plugin-boundaries`) **cannot** catch a slice writing another slice's table — the import is always legal. So single-writer is held by discipline and code review, not a gate.

### Should we implement it?

**Yes.** It is the exact "enforcement gap in an otherwise-strong wall" class the audit repeatedly flags. Single-writer-per-table is a load-bearing architectural invariant — it is what makes "one slice owns each table's transaction" safe — and leaving it to convention means a future PR can silently write another slice's table and pass CI. The SSOT-driven completeness check (step 2 below) is what makes the rule **durable**: the table list is derived from the schema, so the ownership map can never fall silently behind.

### Implementation guide

Add `packages/config/arch/rules/single-writer-per-table.rule.ts`, following the exact shape of the existing `no-external-call-in-transaction.rule.ts` (export an `ArchRule` whose `check` walks source files with ts-morph and returns `ArchViolation[]`), and register it in the arch rule index so `pnpm arch:check` runs it in CI and pre-push.

**1. Ownership map.** Define an explicit map — one owning slice per table:

```ts
const TABLE_OWNER: Record<string, SliceName> = {
  users: 'identity',
  wallets: 'billing',
  ledgerEntries: 'billing',
  usageRecords: 'billing',
  messages: 'chat',
  contentItems: 'chat',
  conversations: 'conversations',
  conversationMembers: 'conversations',
  epochs: 'conversations',
  modelCatalog: 'models',
  jobs: 'platform',
  adminAudit: 'admin',
  // …one entry per table
};
```

Source the canonical assignments from `ARCHITECTURE.md`'s slice list and the audit §6.4 single-writer analysis.

**2. Completeness via the single source of truth — the key step.** The SSOT for *all tables* is **`packages/db/src/schema/index.ts`**, which `export`s every Drizzle table by name (`users`, `wallets`, `ledgerEntries`, … ~36 tables). The rule must, at check time:

- **Enumerate every table exported from that barrel** — parse `schema/index.ts` with ts-morph and collect each `export { X } from './…'` whose target resolves to a `pgTable` (i.e. exclude the enum exports at the top of the file).
- **Assert every enumerated table has an entry in `TABLE_OWNER`.** A table present in the schema but absent from the map is a **build failure**: `"table 'banner_config' has no owning slice — add it to TABLE_OWNER"`.
- **Assert the reverse** — a `TABLE_OWNER` key that no longer exists in the schema fails too (catches renames/deletes so the map cannot rot).

This is the durable part: the schema barrel drives coverage, so adding a table forces assigning an owner, and the map is provably 100% complete forever.

**3. Detect writes and attribute them to a slice.** Walk backend source under `apps/api/src/slices/**` (exclude `*.test.ts` and the `_template` slice — per `apps/api/CLAUDE.md`, the template is excluded from arch gates). For each file, its slice = the path segment immediately after `slices/`. Find every write with ts-morph: `CallExpression`s whose callee is a property access `.insert` / `.update` / `.delete` (on either `db` or a transaction handle `tx`), and read the first argument's identifier, resolving it to the schema export name. Mirror how `no-drizzle-operators-in-barrels.rule.ts` walks call chains and how `no-external-call-in-transaction.rule.ts` matches callee names.

**4. Flag violations.** For each detected write of table `T` in slice `S`, if `TABLE_OWNER[T] !== S`, emit an `ArchViolation`: `"slice 'S' writes table 'T', owned by 'TABLE_OWNER[T]' — go through its published barrel API"`. Adapters count as their own slice.

**5. Legitimate exceptions.**
- The composition root (`app.ts`), migrations, and the seed live outside `slices/`, so they are not scanned — they may write anything.
- `idempotency_keys` is genuinely dual-role (billing / platform). Model shared tables as an explicit allowlist of multiple owners in the map (`idempotencyKeys: ['billing', 'platform']`) so a multi-writer table is a deliberate, reviewed exception, never a silent one.

**6. Register + test.** Add the rule to the arch index (`ArchRule`/`ArchViolation` types), so `pnpm arch:check` runs it. Add a rule test with a fixture that (a) writes a foreign table from the wrong slice → violation, (b) adds a schema-only table with no map entry → violation, and (c) a correct owner-write → passes.

**Acceptance**
- A slice writing another slice's table fails `arch:check`.
- A new table added to `schema/index.ts` with no `TABLE_OWNER` entry fails `arch:check`.
- A `TABLE_OWNER` entry for a nonexistent table fails `arch:check`.
- All current code passes (the invariant already holds).

---

## #7 — ValueStore byte-metering at model-adapter ingress

### What the design wanted

`BACKEND-REDESIGN.md` §11.4 specified the in-memory `ValueStore` is byte-metered (≤ 20 MB, assuming a ≥3× real-memory multiplier over counted bytes) at **both `store()` and at adapter ingress**. The adapter-ingress metering is the important half: as a model adapter streams a large media artifact in, the bytes are counted and the run aborts the **moment** the cumulative size would exceed the budget — **before** the whole artifact materializes in isolate memory. Large video "rejects at validation."

### What we implemented

Metering exists **only at the engine's `ValueStore.store()`** — `packages/.../engine/value-store.ts:94-101`, called from the interpreter at ingest (`interpreter.ts:330`) and commit (`interpreter.ts:641`). The model adapters accumulate the **entire** media blob first: `nodes/model-call-execution.ts:190-213` plus `absorb()` (~l.463-490) build a local `CallAccumulator` and return the whole value, with **no metering during accumulation** (the adapters comment that media "lands via the engine's ValueStore seam" — i.e. the adapter returns it and the engine stores/meters it afterward). Consequence: a large artifact is fully resident in memory before `store()` can reject it.

### Should we implement it?

**Yes — moderate priority.** It is a real OOM exposure. The Durable Object isolate is ~128 MB; the ValueStore budget is 20 MB *assuming* a 3× multiplier — but a single large video or image accumulating in the adapter *before* `store()` runs can transiently blow past that. Text is unaffected; video and large images are the exposure. The fix bounds memory where it actually accumulates.

### Implementation guide

**1. Thread a running byte-meter into `absorb()`.** As each chunk/part arrives in the `CallAccumulator`, add its `byteLength` to a running total and check it against a per-call ceiling **before** appending the chunk. On exceed, throw immediately — reuse the same typed error the engine's `store()` raises (`byte-budget-exceeded` → `inputs-invalid`) — and do **not** finish materializing the artifact.

**2. Source the ceiling from the same budget `store()` uses.** Use `VALUE_STORE_BYTE_BUDGET_BYTES` (20 MB) or, better, a per-call sub-budget equal to the ValueStore's *remaining* budget at that point in the run. The engine already knows the remaining budget when it dispatches the model-call node; pass it into the adapter via the node's execution context.

**3. Handle streaming vs whole-response providers.**
- Streaming providers (video, large image): check the running total per chunk as the SDK yields.
- Whole-response providers: check the declared `content-length` / the returned `byteLength` **before** copying the bytes into the accumulator.

**4. Keep the existing `store()` metering** as the second checkpoint — the design says "at `store()` **and** at adapter ingress," so this is defense in depth. The ingress meter is the new part; `store()` stays as the backstop.

**5. Pair with a pre-admission size gate (recommended companion).** The "reject large video at validation" promise also isn't a *pre-run* gate today: a declared-oversize video is not rejected at admission before the run starts. A fuller fix rejects a declared-oversize artifact at **admission** (before any provider call), so you never begin a run whose declared output you cannot hold — the cheapest possible bound for the known-large case.

**Acceptance**
- A large synthetic media artifact aborts **during** accumulation (memory never exceeds the budget), asserted via the typed `byte-budget-exceeded`/`inputs-invalid` error.
- The existing `store()` metering still runs as the second checkpoint.
- Normal-size media generations are unaffected.
- (If step 5 is included) a declared-oversize video is rejected at admission before any provider call.

---

*Source: derived from the 2026-07-18 codebase audit's redesign→implementation review. Companion detail on `settle()` (built as a TypeScript transaction rather than the specified pl/pgsql function — deliberately kept, since the TS half-even rounding is more correct than the design's proposed `PG round()`) is recorded as a documented divergence, not a fix.*
