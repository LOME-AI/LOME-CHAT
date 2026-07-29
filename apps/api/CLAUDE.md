# Product Worker (apps/api)

The Hono product Worker — vertical slices under `src/slices/`, shared machinery under
`src/lib/`. System map and doctrine: `docs/ARCHITECTURE.md` + `docs/CODE-RULES.md`.
The rules below are the working knowledge specific to this tree.

## Routes

- Every route declares exactly one **route class** as its **first handler** via
  `routeClass(…)`: `public` · `session` · `pending-2fa` · `billing-token` · `dev-only`.
  An undeclared route is default-denied (403). `dev-only` routes 404 in production.
  Link-guest and trial-session principals are refused at HTTP for all classes — they
  are authorized only at the realtime and media seams.
- `routes.ts` is one `defineSliceManifest({ basePath, routes })`. **The manifest's
  return type must stay inferred** — annotating it `Hono<AppEnv>` widens routes to
  `BlankSchema` and silently erases the slice from `AppType`, blinding the typed
  client. The `zValidator` hook context is typed with hono's base `Env`, not `AppEnv`
  (contravariance).
- Manifest factories receive their dependencies from the composition root (`app.ts`);
  slices never construct adapters.
- Route order per handler: `routeClass(…)` → `zValidator(…)` → handler.

## Slice layout and boundaries (lint-enforced)

- A slice's `index.ts` barrel is its only public surface. Routes import only their own
  slice's domain barrel + middleware; domain imports its own ports/domain plus other
  slices' barrels; **only adapters import infra libraries** (`drizzle-orm`,
  `@neondatabase/*`, `@upstash/*`, `resend`, `aws4fetch`, …).
  - Infra query operators (`eq`/`sql`/`inArray`/`and`/…) must not be laundered into
    domain by re-exporting them from an internal package barrel (`@hushbox/db`). The
    boundary is about the capability — raw query-building in domain — not the literal
    `drizzle-orm` specifier. Domain persistence uses the unwrapped `Database` handle's
    builder methods only (`.insert().onConflictDoUpdate()`, `.select().from()`);
    anything that needs operators goes in an adapter.
- New slice: copy `src/slices/_template/` (it compiles — contract drift fails
  typecheck — but is excluded from lint/coverage/arch gates).
- Durable Object classes are declared only in `packages/realtime`, never in slices
  (arch-enforced).

## Mutations and errors

- Mutations run through `runMutation` over one of the five `idempotent.*` wrappers
  (`byKey`, `byUpsert`, `byTransition`, `byEventId`, `byExternalPreClaim`);
  `runMutation` accepts only `Idempotent<T>`, and casting to the brand is lint-banned.
  Exempt routes declare `idempotencyExempt('<class>')` and the arch rule requires the
  matching wrapper lexically in the terminal handler.
- Domain code returns `Result` (a dropped `Result` fails lint); routes map errors via
  `respondDomainError`, which resolves the wire code through `domainWireCode(error)`
  (an error's own `wireCode` when carried, else `DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]`)
  paired with `STATUS_BY_DOMAIN_CODE`; malformed input → `createErrorResponse(ERROR_CODES.VALIDATION)`, 400.
- `cockatiel` is importable only inside `src/lib/resilience` — compose its exported
  retry/timeout policies everywhere else (lint-enforced).

## Engine and node purity (lint-enforced)

- Engine/node code uses `ctx.clock.now()` / `ctx.rng.random()` — never `Date.now()` /
  `Math.random()` — and never `fetch`, storage, or runtime slice-barrel imports
  (`import type` only).
- Capability node executions resolve only through the live execution registry — never
  imported or dispatched directly.

## OpenRouter calls

- Never inline `provider` / `extraBody.provider` literals — use
  `languageRoutingOptions()` / `mediaRoutingOptions()` from `@hushbox/shared`, which
  single-source the ZDR block (lint-enforced).

## Store raw, parse on demand

- Model text is stored exactly as returned — reasoning rides inline in the same text
  field, in the canonical format owned by `packages/shared/src/reasoning-format.ts`
  (the only code that may touch the delimiters). All presentation parses on demand.
- History replay strips embedded reasoning for both history sources — server rows and
  client-supplied arrays — at the `prepareStartRequest` seam.
- Workflow node values from reasoning-capable modelCalls carry the serialized form;
  future transform/fanIn consumers parse `.answer`.

## Tests

- Never `vi.mock` a slice barrel (lint-enforced) — internal slices are exercised for
  real; mocks exist only at true external seams.
- Integration tests run against real local Postgres/Redis/MinIO.
- Jobs integration tests share one table: only `pass.integration.test.ts` may commit
  claimable rows, and only on the `default` shard; every other jobs integration test
  runs its shard-wide `FOR UPDATE` operations against the literal `'bulk'` shard
  (arch-enforced).
- A test that mints a fake HTTP transport (`vi.fn`, `vi.mock`, `vi.spyOn`,
  `vi.stubGlobal('fetch', …)`) must not also write a `service_evidence` row: a row
  means a real call happened (arch-enforced). Evidence for fcm, webpush and resend
  belongs in a CI-gated test that made the real call, never in an adapter the factory
  mocks away in CI.
