# Legacy→New grounding — identity slice (R1, R10, R20 identity copy)

Source audit: `docs/history/2026-07-21-legacy-parity-audit.md` R1 (lines 32-48), R10
(lines 193-200), R20 identity copy (lines 282-288).

---

### R1 — Delete-account 24h hard-lock off-by-one

**LEGACY** `legacy/apps/api/src/legacy/lib/rate-limit.ts:180-193` (the lockout-trigger
arithmetic inside `recordFailedAttempt`):

```ts
  if (isLockoutKey && data.count >= config.maxAttempts) {
    const lockoutEntry = REDIS_REGISTRY[lockoutKeyName as LockoutKeyName];
    const lockoutUntil = Date.now() + lockoutEntry.ttl * 1000;
    await redisSet(
      redis,
      lockoutKeyName as LockoutKeyName,
      String(lockoutUntil),
      ...(buildArgs as Parameters<(typeof REDIS_REGISTRY)[LockoutKeyName]['buildKey']>)
    );
    return { lockoutTriggered: true };
  }

  return { lockoutTriggered: false };
```

Config: `legacy/apps/api/src/legacy/lib/redis-registry.ts:85-90` —
`deleteAccountUserRateLimit: { ttl: 3600, buildKey: userId, rateLimitConfig: { maxAttempts: 3,
windowSeconds: 3600 } }`; hard lock `legacy/apps/api/src/legacy/lib/redis-registry.ts:219-223`
— `deleteAccountLockout: { ttl: 24*60*60, buildKey: userId }`.

Behavior/value: the gate is `data.count >= config.maxAttempts` where `data.count` is the
value *after* incrementing for the current failure — so the 3rd failed attempt (count
becomes 3, `maxAttempts` is 3) satisfies `3 >= 3` and `lockoutTriggered: true` fires on that
very call, in the same request that recorded the failure.

Caller path, `legacy/apps/api/src/legacy/routes/delete-account.ts:180-183` (OPAQUE gate) and
`:206-208` (TOTP gate), each immediately turning `lockoutTriggered` into the 403 response:

```ts
  const failure = await recordDeleteAccountFailure(args.redis, args.userId);
  if (failure.lockoutTriggered) return lockoutGateFail(failure.retryAfterSeconds);
  return { ok: false, code: ERROR_CODE_INCORRECT_PASSWORD, status: 400 };
```

`lockoutGateFail` (`legacy/apps/api/src/legacy/routes/delete-account.ts:104-111`):

```ts
function lockoutGateFail(retryAfterSeconds: number): GateFail {
  return {
    ok: false,
    code: ERROR_CODE_DELETE_ACCOUNT_LOCKED,
    status: 403,
    details: { retryAfterSeconds },
  };
}
```

So legacy semantics: attempts 1 and 2 fail with `400 INCORRECT_PASSWORD` /
`400 INVALID_TOTP_CODE`; the 3rd failure's own response is `403 DELETE_ACCOUNT_LOCKED` with
`retryAfterSeconds` for the 24h window — confirmed by legacy's own test name/comment,
`legacy/apps/api/src/legacy/routes/delete-account.test.ts:570-595` ("the triggering failed
attempt itself surfaces DELETE_ACCOUNT_LOCKED with retryAfterSeconds" / "The 3rd failure
triggers the lockout, so it should surface DELETE_ACCOUNT_LOCKED").

**CURRENT** `apps/api/src/slices/identity/domain/lockout.ts:33-44` (`evaluateLockout`):

```ts
export function evaluateLockout(
  count: number,
  remainingSeconds: number | null,
  config: RateLimitConfig
): LockoutDecision {
  if (count <= config.maxAttempts) return { lockedOut: false };
  return {
    lockedOut: true,
    retryAfterSeconds: remainingSeconds ?? config.windowSeconds,
    justTriggered: count === config.maxAttempts + 1,
  };
}
```

`count` here is the post-increment value from an atomic **attempt-reservation** increment
that fires *before* verification runs (docstring at `lockout.ts:23-32`: "the atomic increment
is itself the gate"). Gate is `count <= maxAttempts` → not locked, i.e. `count > maxAttempts`
→ locked. With `maxAttempts: 3` (`apps/api/src/slices/identity/domain/keys.ts:220-224`):

```ts
  deleteAccountLockout: defineRateLimitKey({
    schema: lockoutCounterSchema,
    ttlSeconds: 3600,
    buildKey: (userId: string) => `delete-account:lockout:${userId}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
```

counts 1, 2, 3 are all `<= 3` → admitted to verification and answered `bad-proof` /
`invalid-totp`; only count 4 (`4 > 3`) is locked out. The reservation-and-engage call site,
`apps/api/src/slices/identity/domain/deletion.ts:171-189`:

```ts
    // Reserve one attempt on the tight 1-hour guessing gate before the step-up
    // verdict: the atomic increment is the gate and the failure record at once
    // (a success clears the counter). Exhausting the gate — 3 failures inside
    // the hour — engages the separate 24-hour hard lock, so a short fumble
    // never freezes deletion for a full day but sustained abuse does.
    return reserveAttempt(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId).andThen(
      (decision) => {
        if (decision.lockedOut) {
          return engageDeleteAccountHardLock(args.redis, args.userId).map(
            (): DeleteAccountOutcome => ({
              kind: 'locked',
              retryAfterSeconds: IDENTITY_KEYS.deleteAccountHardLock.ttlSeconds,
            })
          );
        }
        return resolveVerdict(args, pending);
      }
    );
  });
```

The comment at `deletion.ts:174-175` ("Exhausting the gate — 3 failures inside the hour —
engages the separate 24-hour hard lock") asserts the legacy semantics, but the code above it
implements `count > maxAttempts` (4th attempt), not `count >= maxAttempts` (3rd attempt) —
the comment is currently wrong about which attempt engages the lock.

Locked response wire shape, `apps/api/src/slices/identity/routes.ts:915` (delete-account
finish route) and `:183-185`:

```ts
              .with({ kind: 'locked' }, (o) => tooManyAttemptsResponse(c, o.retryAfterSeconds))
```
```ts
function tooManyAttemptsResponse(c: Context<AppEnv>, retryAfterSeconds: number): Response {
  return c.json(createErrorResponse(ERROR_CODES.TOO_MANY_ATTEMPTS, { retryAfterSeconds }), 429);
}
```

So current locked responses are `429 TOO_MANY_ATTEMPTS` with `{ retryAfterSeconds }`, never
`403 DELETE_ACCOUNT_LOCKED`. `DELETE_ACCOUNT_LOCKED` is still defined,
`packages/shared/src/error-codes.ts:117` (inside a block whose comment,
`error-codes.ts:111-113`, explicitly documents it as client-only: "Client-emitted UI-state
codes: surfaced only from the web client's own guard/catch branches (media load failure,
account-deletion password + lockout + expired session), never on the wire."):

```ts
  DELETE_ACCOUNT_LOCKED: 'DELETE_ACCOUNT_LOCKED',
```

Client workaround, `apps/web/src/components/settings/delete-account-modal.tsx:52-60`:

```tsx
// Returns a duration-aware lockout message when the server included
// retryAfterSeconds. The deletion guessing gate reports lockout as
// TOO_MANY_ATTEMPTS + retryAfterSeconds, so key on the detail rather than a
// specific code — no DELETE_ACCOUNT_LOCKED code is ever emitted by the API.
function messageFor(code: string, details?: Record<string, unknown>): UserFacingMessage {
  if (typeof details?.['retryAfterSeconds'] === 'number') {
    return formatLockoutMessage(details['retryAfterSeconds']);
  }
  return friendlyErrorMessage(code);
}
```

The client does not switch on `code === 'DELETE_ACCOUNT_LOCKED'` at all — it detects lockout
generically by the presence of a numeric `retryAfterSeconds` in the error `details`, regardless
of which `code` carried it.

**DELTA**: to reach legacy parity, two independent changes:
1. Threshold: flip the effective admission count from `maxAttempts` (3) to `maxAttempts - 1`
   (2) so the 3rd reserved attempt (`count === maxAttempts`) is the one that locks — i.e. the
   gate becomes `count >= maxAttempts` again (mirroring legacy), not `count > maxAttempts`. This
   is a behavior change to `evaluateLockout`'s comparison (`lockout.ts:38`) and/or the
   `maxAttempts` value fed to it, and needs care because `evaluateLockout` is presumably shared
   by other lockout call sites (`twoFactorLockout` etc. — not confirmed in this pass) that may
   rely on the current "admit exactly maxAttempts" semantics being correct for THEM. Any
   change must be scoped to delete-account only unless the other three lockouts are also
   verified to want the off-by-one flip.
2. Wire shape: emit `403 DELETE_ACCOUNT_LOCKED` (with `retryAfterSeconds` in `details`) instead
   of `429 TOO_MANY_ATTEMPTS` on the `{ kind: 'locked' }` arm at `routes.ts:915` (and any other
   `.with({ kind: 'locked' }, ...)` arm that serves this same finish flow — `518`/`575` are
   different flows, not delete-account, and must not be touched here). Reconciling the client:
   `delete-account-modal.tsx`'s `messageFor` already keys off `retryAfterSeconds` presence, not
   the code, so it degrades gracefully either way — but its stale comment ("no
   DELETE_ACCOUNT_LOCKED code is ever emitted") would need updating if the code starts being
   emitted, and `friendlyErrorMessage()` must have a `DELETE_ACCOUNT_LOCKED` entry (unverified
   in this pass — check `packages/shared/src/error-messages.ts`).

**NOTES**: `apps/api/src/slices/identity/routes.ts:518` and `:575` also match
`.with({ kind: 'locked' }, (o) => tooManyAttemptsResponse(...))` — these are other identity
step-up flows (login 2FA / password-change or similar, not verified which in this pass) and
are out of scope for an R1 fix scoped to delete-account; do not blanket-edit all three call
sites. `routes.ts:380` uses a *different* arm, `ACCOUNT_LOCKED` at 403, for yet another flow —
a fourth locked-response pattern exists in the same file; an implementer should confirm which
line is truly the delete-account finish handler (this research confirmed `:915` sits inside the
delete-account finish handler by reading the surrounding block, `:895-925`).

---

### R10 — OPAQUE `ke1`/`ke3` 1024-element cap dropped

**LEGACY** `legacy/apps/api/src/legacy/routes/delete-account.ts:33-41`:

```ts
const MAX_CONFIRMATION_PHRASE_LENGTH = 200;
const MAX_KE_ARRAY_LENGTH = 1024;

const initSchema = z.object({
  ke1: z.array(z.number()).min(1).max(MAX_KE_ARRAY_LENGTH),
});

const finishSchema = z.object({
  ke3: z.array(z.number()).min(1).max(MAX_KE_ARRAY_LENGTH),
  ...
```

Value: `MAX_KE_ARRAY_LENGTH = 1024`, applied to both `ke1` and `ke3` as `.min(1).max(1024)`.
This is the only legacy location where the cap is defined as a named constant
(confirmed by `grep -rn "MAX_KE_ARRAY_LENGTH"` across all of `legacy/`: it appears only in
`delete-account.ts` and twice in `legacy/LEGACY-BEHAVIOR-REPORT.md` lines 571 and 740 — both
of which describe the delete-account route specifically, not login/password-change/2FA).

Legacy login/password-change/2FA-disable/recovery schemas,
`legacy/apps/api/src/legacy/routes/opaque-auth.ts:359-427`, all use uncapped
`z.array(z.number()).min(1)` for `ke1`/`ke3` (e.g. `:361` login init `ke1`, `:366` login
finish `ke3`, `:385` 2FA-disable init `ke1`, `:389` 2FA-disable finish `ke3`, `:406`
change-password init `ke1`, `:411` change-password finish `ke3`) — **no `.max()` anywhere in
this file**.

**CURRENT**:

`apps/api/src/slices/identity/domain/deletion.ts:32,36`:
```ts
export const deleteAccountInitBodySchema = z.object({
  ke1: z.array(z.number()).min(1),
});
...
export const deleteAccountFinishBodySchema = z.object({
  ke3: z.array(z.number()).min(1),
```

`apps/api/src/slices/identity/domain/login.ts:35,40`:
```ts
  ke1: z.array(z.number()).min(1),
...
  ke3: z.array(z.number()).min(1),
```

`apps/api/src/slices/identity/domain/two-factor-disable.ts:24,28`:
```ts
  ke1: z.array(z.number()).min(1),
...
  ke3: z.array(z.number()).min(1),
```

`apps/api/src/slices/identity/domain/password-change.ts:20,25`:
```ts
  ke1: z.array(z.number()).min(1),
...
  ke3: z.array(z.number()).min(1),
```

All four current schemas are `.min(1)` with no `.max(...)`.

**DELTA**: only `deletion.ts:32,36` is a true parity regression against a legacy cap that
existed (1024, from `delete-account.ts:34,37,41`) — restore `.max(1024)` there. For
`login.ts:35,40`, `two-factor-disable.ts:24,28`, and `password-change.ts:20,25`, the legacy
source (`opaque-auth.ts`) had **no cap at all** on those same fields — these three are not a
regression against verbatim legacy behavior; any cap added there would be a new hardening
choice, not a parity restoration. The 40 MiB body-limit-only mitigation applies equally to
all four routes today regardless.

**NOTES**: the audit finding (`docs/history/2026-07-21-legacy-parity-audit.md:195-200`) reads
"Legacy Zod-capped KE arrays at 1024 (L571, L740)... New schemas are `.min(1)` with no max in
deletion, login, password-change, and 2FA-disable" and calls it "Systemic, unruled" — this
research shows the *legacy* cap was systemic in name only: it lived solely in the
delete-account route. An implementer/auditor treating this as "restore the 1024 cap to all
four flows to match legacy" would be restoring something legacy itself did not do for three
of the four flows. Confirm with the founder whether the fix is (a) strict parity —
cap only `deletion.ts`, or (b) a deliberate uniform hardening — cap all four at 1024 (or some
other value) as a new decision, before implementing.

---

### R20 (identity copy only) — unique-violation (23505) cause-chain walk

**LEGACY** `legacy/apps/api/src/legacy/lib/unique-violation.ts:64-79` (full
`getUniqueViolationConstraint` + `isUniqueViolation`, with the depth cap and message-text
fallback machinery immediately above at `:28-62`):

```ts
const UNIQUE_VIOLATION_MESSAGE_PATTERNS = [
  'duplicate key',
  'unique constraint',
  'conversation_forks_conv_name_idx',
];

function hasUniqueViolationMessage(message: string): boolean {
  return UNIQUE_VIOLATION_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
}

// Cause chains in real wraps are 1-2 deep; the cap guards against a
// pathologically-circular cause chain without paying the cost of a Set.
const MAX_CAUSE_DEPTH = 16;

interface CauseLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
  message?: unknown;
}

type Inspection = { kind: 'constraint'; name: string } | { kind: 'unknown' } | { kind: 'none' };

function inspectOne(value: CauseLike): Inspection {
  if (value.code === '23505') {
    if (typeof value.constraint === 'string') {
      return { kind: 'constraint', name: value.constraint };
    }
    return { kind: 'unknown' };
  }
  if (typeof value.message === 'string' && hasUniqueViolationMessage(value.message)) {
    return { kind: 'unknown' };
  }
  return { kind: 'none' };
}

export function getUniqueViolationConstraint(error: unknown): string | null {
  let detectedWithoutConstraint = false;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') break;
    const inspection = inspectOne(current as CauseLike);
    if (inspection.kind === 'constraint') return inspection.name;
    if (inspection.kind === 'unknown') detectedWithoutConstraint = true;
    current = (current as CauseLike).cause;
  }
  return detectedWithoutConstraint ? '' : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return getUniqueViolationConstraint(error) !== null;
}
```

Behavior: depth-capped at 16 (`MAX_CAUSE_DEPTH`); on each layer, if `code === '23505'` returns
the `constraint` string when present, else marks `detectedWithoutConstraint`; else if
`message` matches one of three text patterns (`'duplicate key'`, `'unique constraint'`,
`'conversation_forks_conv_name_idx'`) also marks `detectedWithoutConstraint`; walks
`.cause` until depth cap or a non-object; returns `''` (detected, unknown constraint) vs
`null` (not a violation at all) as the two non-name outcomes.

**CURRENT** `apps/api/src/slices/identity/adapters/stores.ts:44-58`:

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

**DELTA**: (consolidation of the 4-way drift is handled elsewhere per the audit; this file
is one of the four copies.) The identity copy has no depth cap (`while` loop bounded only by
`typeof current === 'object'`, i.e. unbounded except by the actual cause chain — audit calls
the missing cap "defensive-only" since Drizzle wraps exactly once) and no message-text
fallback branch at all — it returns `null` for a unique violation that lacks a structured
`constraint` field even when the message text would identify it (e.g.
`'conversation_forks_conv_name_idx'` or generic `'duplicate key'`/`'unique constraint'`
text), where legacy would have returned `''` in that case.

**NOTES**: per the audit (`docs/history/2026-07-21-legacy-parity-audit.md:282-288`), this is
one of four independently-drifted copies (`conversations/adapters/stores.ts:38-51`,
`identity/adapters/stores.ts:44-58` — verified this session — `chat/domain/user-message.ts:78-88`,
`admin/adapters/stores.ts:10-25`); the other three were not opened in this pass. The prescribed
fix is to hoist one shared helper (matching legacy's `unique-violation.ts` shape — depth cap +
message fallback) rather than patch this copy in place.
