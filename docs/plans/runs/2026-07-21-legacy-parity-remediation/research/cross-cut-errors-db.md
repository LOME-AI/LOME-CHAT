# Cross-cut errors/DB research — R19, R20, R21

Grounding notes for legacy→new parity remediation. All file:line citations opened this
session; no source edited.

---

### R19 — idempotency-conflict wire-code override dropped in slices that bypass `domainWireCode`

**Shared helper** — `apps/api/src/lib/errors/domain-error.ts:60-62`:

```ts
export function domainWireCode(error: DomainError): ErrorCode {
  return error.wireCode ?? DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code];
}
```

Exported from `apps/api/src/lib/errors/index.ts:5` alongside the other error helpers.

**CURRENT — 8 direct-mapping sites** (each a locally-defined `respondDomainError` that
maps `DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]` directly, never calling
`domainWireCode()`, so any `error.wireCode` on the `DomainError` is silently discarded):

1. `apps/api/src/slices/account/routes.ts:42-47`
2. `apps/api/src/slices/identity/routes.ts:160-165`
3. `apps/api/src/slices/billing/routes.ts:120-125`
4. `apps/api/src/slices/models/routes.ts:21-26`
5. `apps/api/src/slices/announcements/routes.ts:43-48`
6. `apps/api/src/slices/admin/routes.ts:72-77`
7. `apps/api/src/slices/newsletter/routes.ts:61-66`
8. `apps/api/src/platform/dev/routes.ts:75-80`

All 8 share the identical body shape, e.g. billing (`apps/api/src/slices/billing/routes.ts:120-125`):

```ts
function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}
```

**Two slices already hand-roll the correct behavior instead of using `domainWireCode()`**
(functionally correct today, but a third divergent pattern, not the shared helper):

- `apps/api/src/slices/conversations/routes.ts:172-180` — checks `isIdempotencyConflict(error)` and returns `error.wireCode` at 409 before falling back to the generic map.
- `apps/api/src/slices/feedback/routes.ts:45-55` (`respondSubmitError`) — same `isIdempotencyConflict` check, plus its own `FEEDBACK_DUPLICATE` special case, before falling back to a feedback-specific wire code.

**Which sites are live-affected vs. latent**, verified by grepping every `idempotent.*`
wrapper call in each of the 8 slices and checking which wrapper implementations can ever
construct a `wireCode`-bearing `DomainError`:

- Only `idempotent.byKey` (`apps/api/src/lib/idempotency/by-key.ts:121`, backed by
  `claimKeyRow` in `apps/api/src/lib/idempotency/key-row.ts:119,141`) can produce
  `bodyMismatchError()` / `requestInProgressError()` (`apps/api/src/lib/idempotency/errors.ts:18-31`).
  `byUpsert`, `byTransition`, `byEventId`, `byExternalPreClaim` never construct these
  carrier errors (grepped `wireCode`/`ClaimConflict` across all four — no hits outside
  `by-key.ts`/`key-row.ts`).
- **Live today:**
  - **billing** — `POST /billing/login-link` calls `idempotent.byKey` at
    `apps/api/src/slices/billing/routes.ts:217`, whose failure is handled by the
    direct-mapping `respondDomainError` at `billing/routes.ts:120-125,206-228`.
  - **admin** — the op engine claims a `request`-kind key row itself (not through
    `idempotent.byKey`) at `apps/api/src/slices/admin/domain/engine.ts:412` (`claimKeyRow`
    call) and constructs `requestInProgressError()` directly on a lost fence at
    `admin/domain/engine.ts:467-469`; that `Result` flows up to the direct-mapping
    `respondDomainError` at `admin/routes.ts:72-77`.
- **Latent (no `byKey`/manual-claim path today, so no current codepath emits a
  `wireCode`-bearing error through the direct mapping — a landmine for a future
  `idempotent.byKey` addition):** account, identity, models, announcements, newsletter,
  platform/dev — confirmed each uses only `byUpsert`/`byTransition`/`byEventId` (grep
  output per slice):
  - identity: exclusively `idempotent.byEventId` / `idempotent.byUpsert`.
  - account: `idempotent.byUpsert` / `idempotent.byTransition`.
  - newsletter: `idempotent.byUpsert` / `idempotent.byEventId`.
  - announcements: `idempotent.byUpsert`.
  - models: no idempotent-wrapper mutation route at all (read-only catalog surface).
  - platform/dev: exclusively `idempotent.byUpsert`.

**Wire codes confirmed to exist** — `packages/shared/src/error-codes.ts:45-46`:
`IDEMPOTENCY_BODY_MISMATCH`, `REQUEST_IN_PROGRESS`, both in `ERROR_CODES`. Friendly
messages confirmed in the same file's `friendlyErrorMessage` map,
`packages/shared/src/error-codes.ts:168-169`:
`IDEMPOTENCY_BODY_MISMATCH: 'This request conflicts with an earlier one. Please try again.'`,
`REQUEST_IN_PROGRESS: 'This request is already being processed. Please wait a moment.'`.

**DELTA:** replace each of the 8 slices' local `respondDomainError` body
(`createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code])`) with
`createErrorResponse(domainWireCode(error))`, importing `domainWireCode` from
`../../lib/errors/index.js`. Once routed through `domainWireCode()`, the
conversations/feedback slices' bespoke `isIdempotencyConflict` short-circuit becomes
redundant (the generic path already yields the same `wireCode` at the same 409) and
could collapse into the shared helper too — worth flagging to whoever implements, since
it's the same "One Implementation, Shared" concern CODE-RULES.md calls out, though the
audit only requires routing "all slices" through `domainWireCode()`.

**NOTES:** `STATUS_BY_DOMAIN_CODE` (the `Record<DomainErrorCode, ContentfulStatusCode>`
literal, e.g. `billing/routes.ts:109-118`) is also independently re-declared per slice
with mostly-identical values (feedback's copy uses `timeout: 408` vs. billing/others'
`timeout: 504` — a genuine independent-authority case per CODE-RULES, not necessarily a
bug, but out of R19's scope; noted for awareness only, not part of this delta).

---

### R20 — Postgres unique-violation (23505) cause-chain walk re-implemented 4× with drift

**LEGACY** — single module `legacy/apps/api/src/legacy/lib/unique-violation.ts` (report
`legacy/LEGACY-BEHAVIOR-REPORT.md:5002-5015`, quoted):

> Detects Postgres unique-violation errors (SQLSTATE `23505`) as wrapped by Drizzle's
> `DrizzleQueryError`, which nests the original postgres-js/Neon driver error under
> `.cause`; the `constraint` and `code` fields live on that cause. The cause chain is
> walked (not just `.cause` once) specifically because "future Drizzle versions could add
> another wrapping layer."
>
> `getUniqueViolationConstraint(error: unknown): string | null` returns one of three
> outcomes:
> - **A constraint name** … when some layer in the chain has `code === '23505'` AND a
>   string `constraint` field.
> - **Empty string `''`** when a unique violation was detected but no specific constraint
>   name is available — either `code === '23505'` but `constraint` is missing/non-string,
>   or detection matched only via message-text pattern. Callers must treat `''` as
>   "unknown which constraint" and fall back to generic handling.
> - **`null`** when the error is not a unique violation at all.
>
> Message-text fallback patterns (`UNIQUE_VIOLATION_MESSAGE_PATTERNS`, matched via
> `.includes()` case-sensitively): `'duplicate key'`, `'unique constraint'`,
> `'conversation_forks_conv_name_idx'`. … some driver paths surface only the index name in
> the message with no structured `constraint` field.
>
> Traversal is capped at `MAX_CAUSE_DEPTH = 16` — a guard against a pathologically
> circular cause chain … Per iteration: if `code === '23505'`, either return the
> constraint (if a string) or mark `detectedWithoutConstraint = true` and continue; else
> if `message` matches one of the three text patterns, mark `detectedWithoutConstraint =
> true` and continue; else move to `.cause`. After the loop, returns `''` if
> `detectedWithoutConstraint` was ever set, else `null`.
>
> `isUniqueViolation(error): boolean` — `getUniqueViolationConstraint(error) !== null`.

The legacy source itself (`legacy/apps/api/src/legacy/lib/unique-violation.ts`, full file
read) confirms the report: `MAX_CAUSE_DEPTH = 16` const, `UNIQUE_VIOLATION_MESSAGE_PATTERNS`
array of the three strings, `getUniqueViolationConstraint` returning `string | null` per
the three-outcome contract, `isUniqueViolation` as the thin boolean wrapper.

**CURRENT — the four copies, quoted verbatim:**

1. `apps/api/src/slices/conversations/adapters/stores.ts:36-54`:

```ts
const FORK_NAME_UNIQUE = 'conversation_forks_conversation_name_unique';

/** Postgres unique-violation (23505) on the named constraint, chain-walked. */
function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return (
        candidate.constraint === constraintName ||
        (candidate.constraint === undefined &&
          current instanceof Error &&
          current.message.includes(constraintName))
      );
    }
    current = candidate.cause;
  }
  return false;
}
```

   Behavior: boolean-per-named-constraint (not a generic constraint-name extractor);
   constraint-match OR message-includes(constraintName) fallback when `constraint` is
   `undefined`; **no depth cap** (plain `while`, unbounded).

2. `apps/api/src/slices/identity/adapters/stores.ts:44-58`:

```ts
/**
 * Walks an insert rejection (drivers nest the Postgres error under `cause`)
 * for a unique violation (SQLSTATE 23505) and returns the constraint name.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && typeof candidate.constraint === 'string') {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return null;
}
```

   Behavior: returns the constraint name or `null`. **Drops the message-text fallback
   entirely** — if `code === '23505'` but `constraint` isn't a string, the loop just
   continues to `.cause` instead of remembering "unique violation, unknown constraint"
   (the legacy `''` outcome is unreachable here — a caller can't distinguish
   "definitely not a unique violation" from "was one, but no structured constraint field
   yet"). **No depth cap.**

3. `apps/api/src/slices/chat/domain/user-message.ts:77-88`:

```ts
/** Postgres unique-violation (SQLSTATE 23505), chain-walked. Any unique hit on
 * this write path — the messages PK or the (conversation, sequence) backstop —
 * means the send already exists in some form: converge, never re-insert. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}
```

   Behavior: **ignores constraint matching entirely** — any `23505` anywhere in the chain
   is treated as a hit (deliberate per its comment, since this call site only ever cares
   "did some unique constraint fire"). No message-text fallback (not needed — it never
   inspects `constraint` at all). No depth cap.

4. `apps/api/src/slices/admin/adapters/stores.ts:7-27`:

```ts
const UNDOES_UNIQUE_CONSTRAINT = 'admin_audit_undoes_unique';

/** Postgres unique-violation (23505) on the undoes claim, chain-walked.
 * Exported for its own unit tests (the arms are hard to force through a
 * live database). */
export function isUndoUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return (
        candidate.constraint === UNDOES_UNIQUE_CONSTRAINT ||
        (candidate.constraint === undefined &&
          current instanceof Error &&
          current.message.includes(UNDOES_UNIQUE_CONSTRAINT))
      );
    }
    current = candidate.cause;
  }
  return false;
}
```

   Behavior: structurally identical to (1) — boolean-per-named-constraint with the same
   message-fallback shape. No depth cap.

**Drift summary** (matches the audit's claim, verified): identity (2) drops the
message-text fallback; chat (3) ignores constraint matching entirely; conversations (1)
and admin (4) are mutually consistent (constraint-match-or-message-fallback) but neither
provides a generic constraint-name-returning API — both are hardcoded to one constraint.
None of the four carry the legacy `MAX_CAUSE_DEPTH` cap; per the audit this is
defensive-only (Drizzle wraps exactly once in practice) but the shared helper should
still carry it since legacy did and it's cheap.

**DELTA / shared-helper home:** all four callers are adapters inside `apps/api` slices
(`conversations`, `identity`, `chat`, `admin`) — the sync-contract violation is entirely
within `apps/api`, not crossing into `packages/`. All four already import from
`apps/api/src/lib/errors/index.ts` (e.g. `unavailableError`) for the exact same "infra
rejection → DomainError" concern, and that directory already holds
`domain-error.ts`/`error-response.ts` as the general error-handling home for the whole
Worker. A new module here — e.g. `apps/api/src/lib/errors/unique-violation.ts` — is the
correct narrowest-scope-covering-all-callers home per CODE-RULES "One Implementation,
Shared" (adapters are permitted to import `lib/errors` today; this doesn't cross the
adapter/domain infra-library boundary since it's not `drizzle-orm` etc., just error
shape inspection).

**Union of behaviors the shared helper must support** (so no caller loses a feature):

- `MAX_CAUSE_DEPTH = 16` traversal cap (legacy's value, currently absent everywhere).
- A generic `getUniqueViolationConstraint(error): string | null` (or equivalent) that
  returns the **constraint name** when structurally present, distinguishes "hit but no
  structured constraint" (legacy's `''`) from "not a unique violation" (`null`) — needed
  to preserve identity's currently-broken distinction and to let callers optionally match
  a specific expected constraint (conversations' `FORK_NAME_UNIQUE`, admin's
  `UNDOES_UNIQUE_CONSTRAINT`) or accept any unique hit (chat's use case).
- The message-text fallback list, generalized: legacy's two generic patterns
  (`'duplicate key'`, `'unique constraint'`) plus each current caller's own
  constraint-name-as-substring fallback (`conversation_forks_conversation_name_unique`,
  `admin_audit_undoes_unique`) — a caller passing a specific constraint name should get
  the same `constraint === name OR (constraint undefined && message.includes(name))`
  fallback conversations/admin rely on today.
- A boolean convenience wrapper (`isUniqueViolation`) for chat's "any 23505" use, and a
  boolean-for-named-constraint wrapper for conversations/admin's use — both derivable
  from the one generic constraint-extractor so the four call sites keep their current
  call shapes with one implementation underneath.

---

### R21 — `content_items` CHECK/partial-unique constraints no longer proven against real Postgres

**LEGACY** — `legacy/LEGACY-BEHAVIOR-REPORT.md:4141-4149` (quoted):

> **Integration-test-confirmed Postgres constraints** (real DB, not just Zod):
> - **CHECK constraint `content_items_type_consistency`**: rejects (a) a `text` row with
>   `storageKey` set, (b) an `image` row with `encryptedBlob` set, (c) an `image` row
>   missing `storageKey`, `mimeType`, or `sizeBytes` (all three null simultaneously).
> - **Partial unique index `content_items_storage_key_idx`**: rejects two rows sharing the
>   same non-`NULL` `storageKey`; allows arbitrarily many `text` rows with `NULL`
>   `storageKey` to coexist for the same `messageId` (confirmed with 3
>   concurrently-inserted rows at `position` 10/11/12, all with `storageKey: null`).

The underlying legacy integration test:
`legacy/packages/db/src/factories/legacy_factories.integration.test.ts:228-282`
(`describe('content_items_type_consistency CHECK constraint', …)`, 3 `it`s using a
`captureInsertError` + `findConstraintName` helper pair) and
`legacy/packages/db/src/factories/legacy_factories.integration.test.ts:284-335`
(`describe('content_items_storage_key_idx partial unique index', …)`, 2 `it`s: shared-key
rejection and NULL-coexistence).

**CURRENT:**

- `packages/db/src/schema/shape-tables.test.ts:445-447` — only asserts the constraint
  *name* exists, no DB interaction:

```ts
it('keeps the text-vs-media column consistency check', () => {
  expect(checkNames(schema.contentItems)).toContain('content_items_type_consistency');
});
```

  No shape-tables assertion at all for the partial unique index.

- `packages/db/src/schema/schema.integration.test.ts` has the real-DB rejection harness
  in active use for sibling constraints (single top-level `describe('migrations against
  local Postgres', …)` at line 133, nested `describe('row behavior', …)` at line 261,
  flat `it`s below it through line 713) — but **no `content_items` CHECK or partial-unique
  case** anywhere in the file (grepped; the only `content_items` insert in the file is an
  incidental valid row at lines 648-655, used to set up a `usage_records` FK-severing
  test, not a constraint-violation test).

**The `expectDbError` harness**, `packages/db/src/schema/schema.integration.test.ts:106-121`:

```ts
async function expectDbError(action: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the statement to be rejected').toBeInstanceOf(Error);
  const chain: string[] = [];
  let current: unknown = caught;
  while (current instanceof Error) {
    chain.push(current.message);
    current = current.cause;
  }
  expect(chain.join(' | ')).toMatch(pattern);
}
```

  Signature: `(action: Promise<unknown>, pattern: RegExp) => Promise<void>` — awaits the
  action, asserts it rejected, walks the `Error.cause` chain joining every message with
  `' | '`, and matches the joined string against `pattern`.

  A directly analogous sibling CHECK-constraint case to mirror,
  `schema.integration.test.ts:575-585`:

```ts
it('rejects a leg naming neither a wallet nor a house account', async () => {
  await expectDbError(
    db.insert(ledgerEntries).values({
      transactionId: randomUUID(),
      kind: 'promo',
      amountNanoUsd: 0n,
      idempotencyKey: `${suffix}-bad-${randomUUID()}`,
    }),
    /ledger_entries_one_account/
  );
});
```

  A sibling **unique-constraint** case to mirror,
  `schema.integration.test.ts:601-620` (`enforces UNIQUE(conversation_id,
  sequence_number) on messages`) — insert once, insert a conflicting row, assert
  `expectDbError(..., /messages_conversation_sequence_unique/)`.

**Exact constraint definitions to prove**, `packages/db/src/schema/content-items.ts:51-72`:

```ts
(table) => [
  index('content_items_message_id_position_idx').on(table.messageId, table.position),
  uniqueIndex('content_items_storage_key_unique')
    .on(table.storageKey)
    .where(isNotNull(table.storageKey)),
  index('content_items_model_id_idx').on(table.modelId).where(isNotNull(table.modelId)),
  check(
    'content_items_type_consistency',
    sql`
      (${table.contentType} = 'text'
        AND ${table.encryptedBlob} IS NOT NULL
        AND ${table.storageKey} IS NULL
        AND ${table.mimeType} IS NULL
        AND ${table.sizeBytes} IS NULL)
      OR (${table.contentType} IN ('image', 'audio', 'video')
        AND ${table.storageKey} IS NOT NULL
        AND ${table.mimeType} IS NOT NULL
        AND ${table.sizeBytes} IS NOT NULL
        AND ${table.encryptedBlob} IS NULL)
    `
  ),
]
```

  **Naming drift to account for:** the audit prose (and legacy) call the partial unique
  index `content_items_storage_key_idx`; the current schema names it
  `content_items_storage_key_unique` (`content-items.ts:53`). Any new test must match
  against `content_items_storage_key_unique`, not the legacy/audit name.

**DELTA — where new cases slot in:** `packages/db/src/schema/schema.integration.test.ts`,
inside the existing flat `it` sequence under `describe('row behavior', …)`. The natural
seam is right after the `messages` composite-FK test and before the existing
`content_items`-touching `usage_records` test — i.e. between lines 633 and 635 (`it('rejects
a message whose epoch row does not exist (composite FK)')` ends at 633; `it('severs
usage_records.content_item_id on content deletion, keeping the charge row')`, which
already builds a valid `contentItems` insert for reference, starts at 635). Mirror the two
sibling patterns above: one `it` per CHECK arm (text-with-storageKey,
image-with-encryptedBlob, image-missing-any-of-storageKey/mimeType/sizeBytes) each via
`expectDbError(insert, /content_items_type_consistency/)`, and one `it` pair for the
partial unique index (`expectDbError(second insert, /content_items_storage_key_unique/)`
plus a NULL-coexistence positive case, no `expectDbError`, mirroring the legacy 3-row
`position` 10/11/12 case).
