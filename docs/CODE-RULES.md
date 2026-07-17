# Code Rules

---

## Core Principles

### 95% Test Coverage

- 95% line, branch, and function coverage
- No exceptions
- Tests written before or with implementation
- No skipped or commented tests
- Coverage is part of `pnpm test` — a shortfall is a test failure
- Coverage checked on every push

### Type Safety

- Explicit return types on all functions
- No `any` types without documented justification
- Rely on Drizzle and Zod inference for generated types
- Never manually duplicate inferred types

### Fail Fast

- Validate preconditions immediately
- Never defer errors with fallback values
- Missing config = immediate crash with clear message
- Invalid input = reject at boundary, not deep in logic

### Never Hide Problems

- No `|| true` to hide command failures
- No `2>/dev/null` to suppress errors
- No `@ts-ignore` without explanation
- No `eslint-disable` without justification
- No `--force` or `--legacy-peer-deps`
- No `console.log` or `debugger` in committed code
- Fix root causes, don't mask symptoms

---

## Error Handling

- Never swallow errors silently
- Use custom error classes with context
- Log with sufficient detail for debugging
- Graceful degradation where appropriate
- Every external call wrapped in try/catch

---

## Patterns

### Single Source of Truth

- Drizzle schema defines database types
- Zod schemas define API contracts
- Types flow from these sources, never duplicated

### Environment Detection

- Always use `envUtils` (from `createEnvUtilities()`) for environment branching
- Never check `NODE_ENV`, `CI`, or `E2E` directly
- Never branch on the existence of an environment variable, instead branch on the environment we are in
- Never use `??` fallback defaults for environment variables. `envConfig` defines values for every mode
- If a variable is missing at runtime, fail-fast with a clear error
- Backend middleware: use `c.get('envUtils')` (set by `envMiddleware()`)
- Middleware running before `envMiddleware()`: call `createEnvUtilities(c.env)` directly
- Service factories: accept `EnvContext` and call `createEnvUtilities()` internally

### Idempotency

- Every operation safe to retry; every mutating route requires `Idempotency-Key` (five
  declared exemption classes, each backed by an internal wrapper)
- Every mutation passes through one of the five `idempotent.*` wrappers (`byKey`,
  `byUpsert`, `byTransition`, `byEventId`, `byExternalPreClaim`); `runMutation` accepts
  only `Idempotent<T>`
- Never check-then-act: atomic conditional updates (`UPDATE … WHERE expected_state`),
  assert rows affected; on 0 rows, read the actual state — already-done is a no-op,
  illegal-state is a defect
- Storage keys are uuid, never content-addressed

### Direct Resource Access

- No gatekeeper services
- Type-safe wrappers for all external resources
- Packages provide safety without network hops

### API Client

- `apps/web/src/lib/api-client.ts` is the single source for all typed API calls
- All server state management uses TanStack Query hooks wrapping the typed client
- Never use raw `fetch()` for API endpoints covered by the typed client
- Hono route definitions are the single source of API types (via `AppType` export)

### Error Responses

- API errors return `{ code: string, details?: object }`, with no message field
- `code` is a machine-readable constant exported from `packages/shared/src/schemas/api/error.ts`
- Frontend maps `code` to user-facing message via `friendlyErrorMessage()` from `@hushbox/shared`
- All user-facing error messages live in `packages/shared/src/error-messages.ts`
- New error codes need: (1) constant in shared error schema, (2) entry in `friendlyErrorMessage` map
- Budget/billing notifications use `generateNotifications()` (separate system, already user-friendly)
- Use `createErrorResponse(code, details?)` for all API error responses; never `c.json({ error: ... })`

### Serverless Mindset

- Handle cold starts gracefully
- No persistent in-memory state
- State lives in database or Redis only

---

## Backend Doctrine

The backend's binding rules, grouped by principle. Mechanisms are described in
`ARCHITECTURE.md`; these are the constraints on code you write.

### Money & Settlement

- Nothing commits mid-run; all money and content commit in the one `settle()` transaction,
  entered only with the branded `SettlementTx` handle
- The ledger is double-entry: signed legs per `transactionId` summing to zero — violating
  writes must fail at commit
- Money is nano-USD `bigint`; serialize as `NanoUSD` strings at JSON boundaries; never
  `Number()`-coerce money; intermediate markup math in `numeric`
- Round half-even, once, inside `settle()`
- Settlement is never balance-guarded — admission is the only gate; negative balances are
  legal states
- Money is never Redis-only; holds and snapshots are advisory, the ledger is truth
- Budgets and allowances are period-keyed rows written at settlement — never reset jobs

### Jobs & Async

- Every must-happen async task is a `jobs` row inserted in the caller's transaction,
  registered with a payload schema and a mandatory idempotency class
- Cron hosts only pollers, retention deletes, and read-only auditors — never delivery
- No message queues, no DLQs; dead jobs are rows, redriven or discarded explicitly
- Every job must be able to succeed for every legal payload; already-done is success (the
  idempotent no-op). Execution is at-least-once. A job that cannot reach success is a code
  defect, never an operational state — the enqueuer, handler, or schema is wrong
- Malformed payloads are rejected at enqueue (Zod, inside the caller's transaction) — they
  fail the enqueuing operation, never create a doomed row
- A dead row has exactly two dispositions: fix the cause and redrive, or discard by audited
  admin action; discarded rows prune on retention. An unresolved dead row is never
  auto-deleted

### Crash Recovery

- Recovery is in-mechanism: leases, TTLs, and lazy checks; read paths never depend on a
  purge or cleaner having run
- Auditors detect and page; repair is explicit redrive; never add a backup mechanism or a
  silent self-healing sweep
- Retry and timeout policies only; no in-isolate circuit breakers

### Boundaries

- One writer per table; cross-slice writes only through published barrel APIs inside the
  orchestrator's transaction
- Slice code references only its own slice's schema objects
- Routes hold no business logic and never import repositories; domain imports only its
  slice's ports

### Telemetry

- Log only through the typed `SafeLogFields` logger; `msg` accepts compile-time literals
  only
- Never logged, anywhere: message content, prompts, outputs, keys, ciphertext, PII,
  request/response bodies
- Errors carry codes, never content; domain code returns `Result`, adapters translate
  throws at ports, an exception reaching a route is a defect (500 + Sentry)
- No client-side error/analytics SDKs
- Every metric names its watcher (auditor, dashboard, or alert) or doesn't ship

### Registries

- Env vars exist only as `env.config` registry entries (per-mode values, Zod, no fallbacks)
- Redis keys exist only as typed key-registry entries (schema + TTL + buildKey)
- Model metadata (capabilities, pricing, ParamSpecs, ZDR-reachability) is auto-discovered
  from OpenRouter's live catalog + `/endpoints/zdr`; unrepresentable data (unknown pricing
  unit or model type) is excluded with an alert

### Crypto

- Every blob is versioned; AAD binds the full location tuple including `senderId`
- Keys are branded types; wraps are domain-separated; nonces are fresh per chunk
- Decompression aborts mid-stream at an absolute byte cap; it is a client-side defense —
  the server takes plaintext for inference and never inflates client bytes

### Admin Operations

- Every admin mutation is a registered operation with a registered inverse — no
  irreversible admin operation exists (the Reversibility Iron Law; formalized in the
  admin slice's `CLAUDE.md`)
- The `admin_audit` row commits in the same transaction as the operation's effect —
  effect-without-audit and audit-without-effect are both structurally impossible
- Preview is execute inside a rolled-back transaction — the same code path, never a
  parallel implementation
- Operations compose published slice barrels inside one settlement transaction; the
  admin slice owns no table but `admin_audit`, and op bodies contain no external calls
- Every mutation input includes a required `reason`; op inputs stay flat — complexity
  goes in the op body, not its schema
- No credential, enrollment store, or break-glass path exists in code, CI secrets, or
  any store deployable code can write
- **The Single Auth Path Law:** hardware-security-key MFA through Cloudflare Access is
  the only production authentication path to the admin plane — no service tokens, no API
  keys, no bearer secrets, no non-interactive path, no second credential class. The GUI
  is the only production admin surface (no CLI); break-glass is the physical ladder, never
  a code path. Enforced in code, not only in Access config: the `admin` JWT stage requires
  a non-empty **allowlisted `email` claim**, so any assertion lacking one — a Cloudflare
  service token carries a `common_name`, not an `email` — fails closed with a 401 even if
  the Access app is ever misconfigured to admit it. A test pins this; the dev-admin JWT
  mint is `dev-only`-classed and carries no production signing key

### Changing the Architecture

- Before adopting an excluded service or reversing a deliberate limit, consult
  `ARCHITECTURE.md` — the re-entry conditions are the decision

---

## Accessibility-friendly Conventions

These conventions keep the accessibility widget's CSS overrides effective as the codebase grows. Lint rules in `packages/config/eslint.config.js` enforce them automatically.

### Use Tailwind classes or CSS variables, never inline color/font styles

- ❌ `<div style={{ color: '#ff0000', fontSize: 14 }} />`
- ✅ `<div className="text-destructive text-sm" />`

Inline `style` props for `color`, `backgroundColor`, `borderColor`, `fontFamily`, `fontSize`, `fill`, `stroke` are banned by ESLint. The widget's contrast and font-scaling toggles can't override values that were hardcoded inline.

**Exemptions:** native-asset generators (splash-screen, app-icon) that render to PNG. Use `eslint-disable-next-line no-restricted-syntax` with a comment explaining the exemption.

### Use `<Img>` for content images and `<Logo>` for decorative branding — never raw `<img>`

- ❌ `<img src="/photo.jpg" alt="..." />`
- ✅ `<Img src="/photo.jpg" alt="..." />` (content image — auto-inverts in inverted-color mode)
- ✅ `<Logo />` (decorative brand mark — exempt from inversion)

Both are exported from `@hushbox/ui`. The `Img` wrapper requires `alt`, defaults to `loading="lazy"`, and supports a `decorative` prop that adds `data-no-invert`. Raw `<img>` in `.tsx` is banned by ESLint.

### Use `useAnimationFrame` instead of `window.requestAnimationFrame`

- ❌ `const id = window.requestAnimationFrame(tick)`
- ✅ `useAnimationFrame((timestamp) => { /* tick */ })`

The wrapper from `@hushbox/ui` respects `prefers-reduced-motion` and the user's "stop animations" toggle. Raw `requestAnimationFrame` is banned by ESLint.

JS animation libraries (`gsap`, `anime`, `motion-one`) are also banned via `no-restricted-imports`. Use Framer Motion (already in the stack) or CSS animations.

### Prefer semantic HTML over ARIA roles

- ❌ `<div role="main">`, `<div role="navigation">`, `<div onClick={...}>`
- ✅ `<main>`, `<nav>`, `<button onClick={...}>`

Semantic tags imply roles, support keyboard interactions natively, and integrate with the page-structure landmarks navigator without configuration.

Tag chrome wrappers (sidebar, header, footer, panels surrounding main content) with `data-chrome=""` for future opt-out behaviors (e.g. focus-mode toggles).

---

## Code Organization

### Naming

- Filenames: `kebab-case` (e.g. `two-factor-setup.tsx`, `use-delete-account.ts`)
- Component symbols: `PascalCase` (the export name, not the filename)
- Hook/utility symbols: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types: `PascalCase`
- Tests: `*.test.ts`

### Durable Naming

- Code lands at its final, orthodox paths with final names from day one
- No version suffixes (`v2`) in file names, dirs, exports, pg objects, pnpm scripts, or config keys
- No task IDs or plan-section references in code, comments, or test names
- Demoted legacy code carries the `legacy_` prefix (`legacy-` or `src/legacy/` for dirs) and is excluded from test gates
- `legacy_` renaming is only for files completely unused by the new system — a pure reference corpus
- New code never imports from a `legacy_` path (lint-enforced)
- If new work is additive to an existing file or the file's role survives into the new system, evolve it in place — never rename it `legacy_`
- A wrong or transitional name is treated like a wrong comment — worse than none

### Structure

- Colocate tests with source
- Shared code in `packages/`, never copy-pasted
- One component/function per file
- `index.ts` for exports only

### Imports

1. External dependencies
2. Internal packages (`@/packages/*`)
3. Relative imports
4. Type imports last

---

## Testing

### Requirements

- Unit tests for all business logic
- Integration tests for database and API operations
- E2E tests for critical user flows
- Integration-first: tests run against real local infra; mocks exist only at true external
  seams (gateway, payments, email, push) — never for internal slices
- CI's hot path is 100% cassette hits for AI calls — zero charged real calls; a cassette
  miss is a failure, not a recording (recording happens out-of-band)
- Tests must not depend on execution order
- No hardcoded dates (use time mocking)
- Test behavior, not implementation

### What to Test

- Happy paths
- Error conditions
- Edge cases and boundaries
- Idempotency
- Input validation

---

## Security

- Validate all external input with Zod
- Never trust client-provided IDs
- Never interpolate user input in queries
- Never hardcode or log secrets
- Rate limit auth endpoints. Limiters come in two classes: secret-guessing surfaces
  (login, TOTP, recovery) use atomic attempt-reservation (increment-before-verify,
  cleared on verified success — exactly `maxAttempts` admitted under any concurrency);
  abuse throttles (registration, resend) may be advisory fixed windows

---

## Performance

- Measure before optimizing
- Add indexes for common queries
- Cache expensive computations
- Paginate list endpoints
- Stream large responses
- Use workers for tasks >5 seconds

---

## Documentation

### When to Comment

Comment durable facts that a future reader with no context cannot derive from the code, names, types, or tests, when the information is load-bearing on correctness or future modification and survives the current task.

Examples:

- Non-obvious business or domain logic
- Source-of-truth designations
- Hidden coupling between files or modules
- Race conditions and ordering constraints
- Security or regulatory requirements the code enforces but doesn't explain
- Performance traps
- Library, browser, or external API quirks
- Rejected alternatives with the reason for rejection
- Code that looks removable but isn't
- Exceptions to established rules
- Subtle edge cases

A wrong comment is worse than no comment. If you can't state the durable fact precisely, leave it out.

### When Not to Comment

- Obvious operations
- Self-explanatory names
- Standard patterns
- What code does (code shows this)
- Code you didn't change

### Never Include

- Specific file paths that may move
- Hardcoded version numbers
- Specific timing estimates
- Ephemeral values (container IDs, hashes)
- TODO and FIXME

### Doc Lifecycle

Every doc in the repo is exactly one of three things:

1. **Loaded** — lives in or is imported by a `CLAUDE.md` (the root chain, or a nested
   `CLAUDE.md` that loads when working in its directory). Must describe the current
   system.
2. **On-demand** — listed in `docs/DEVELOPMENT.md`'s doc index with the trigger for
   reading it. Must describe the current system.
3. **History** — lives in `docs/history/`. Never updated, never cited as current.

A doc that fits none of these is deleted. When a change supersedes documented
behavior, the same change updates every affected doc — loaded or not; if a doc cannot
be brought current in that change, it moves to `docs/history/` instead of staying
stale in place. A stale doc presented as current is a wrong comment at file scale —
worse than none.

---

## Enforcement

- Pre-commit: Prettier, basic lint
- Pre-push: ESLint, typecheck, tests
- CI: Full test suite, coverage check
- Custom rules live in `packages/config`: `eslint-extensions/` (vendored ESLint rules)
  and `arch/` (ts-morph structural rules, `pnpm arch:check`) — each has a README
- Review: Human judgment on patterns and quality

No exceptions.
