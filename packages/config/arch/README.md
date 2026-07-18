# Architecture rules (ts-morph harness)

Structural rules that ESLint cannot express. This harness enforces idempotency
exemption-wrapper pairing, thin-shell Durable-Object placement, jobs-test
shard isolation, admin-op purity, and single-source `onError` placement
(`rules/*.rule.ts`). Related structural rules that ESLint CAN
express live in the eslint layer instead — no-raw-Drizzle-in-domain is
`eslint-plugin-boundaries` (`boundaries.config.mjs`) and ValueStore isolation
is the vendored `engine-node-purity` rule (`engine-purity.config.mjs`); one
mechanism per rule, never both. Run via `pnpm arch:check` from the repo root;
also a CI step. Scoped to the
backend source trees — the demoted legacy reference corpus (`legacy_*` files,
`legacy-*` dirs, `legacy/` trees) is exempt (see the glob list in `run.ts`).

## Layout

- `run.ts` — the CLI: builds one ts-morph project over the backend paths,
  loads all rules, exits non-zero on violations.
- `lib/harness.ts` — discovery/loading/running, independent of the rule set.
- `rules/*.rule.ts` — one rule per topic-named file, the extension slot.
- `types.ts` — the `ArchRule` contract.

## Contract for adding a rule

- Add **one new file** named `<topic>.rule.ts` under `rules/`. Each file owns
  exactly one rule; never edit the harness to add behavior.
- Default-export an `ArchRule` (`{ name, check(project) }` from `../types.js`).
  A malformed rule file fails the whole run loudly — there is no silent skip.
- Keep checks **syntactic** (no `getType()`) so the harness stays fast in CI.
- Rules receive every in-scope source file; filter paths inside `check` if the
  rule targets a subset (see `do-classes-live-in-realtime.rule.ts`).
- Ship a colocated `*.rule.test.ts` exercising the rule against in-memory
  ts-morph projects (violating and passing shapes) — written test-first.

## Current rules

- `do-classes-live-in-realtime` — seed of the thin-shell DO family:
  classes extending `DurableObject` must not be declared inside slices;
  `packages/realtime` owns the DO classes (platform glue). The family grows
  body-shape checks ("platform glue only") once the backend's own DO classes
  exist.
- `idempotency-exemption-wrappers` — `idempotencyExempt('<class>')` may appear
  only on a route registration or subtree `.use`, and the route's terminal
  handler must lexically reference an `idempotent.<wrapper>` from that class's
  allowed-wrapper map (a handler defined in another file fails; `.route()`
  sub-app mounts overlapping an exempt prefix are flagged). The
  `opaque-protocol` and `token-is-key` classes carry no wrapper requirement.
- `jobs-test-shard-isolation` — jobs integration tests share one table: only
  `pass.integration.test.ts` may commit claimable rows, and only on the
  `default` shard; every other jobs integration test must run shard-wide
  `FOR UPDATE` operations (`claimBatch`, `sweepCancelRequested`,
  `deadLetterExhausted`, `runPass`) against a literal `'bulk'` shard.
- `admin-op-purity` — admin op-body modules (`slices/admin/domain/operations/`,
  non-test) may not value-import infra libraries or adapter modules, reach into
  another slice's internals (barrel imports only), or call `fetch`; an op body
  composes published `*WithinTx` helpers and nothing else, which is what makes
  preview's rollback total. Op executions are importable only by the admin
  registry wiring under `slices/admin/domain/` (plus sibling ops and tests) —
  no other code can invoke an op around the engine's audit/guardrail path.
- `no-drizzle-operators-in-barrels` — no package barrel
  (`packages/*/src/index.ts`) may re-export Drizzle query operators
  (`eq, ne, gt, gte, lt, lte, and, or, not, inArray, notInArray, isNull,
isNotNull, like, ilike, between, sql, asc, desc`), by either route: an
  `export … from 'drizzle-orm'` re-export, or surfacing an operator symbol
  through any module (matched on the source name, so an alias can't hide it).
  Why: the ESLint `boundaries/dependencies` boundary forbids `domain/` from
  importing `drizzle-orm`, but it matches specifiers, not capabilities — a
  barrel re-export would let domain code obtain operators via `@hushbox/db` and
  pass the boundary in letter while defeating its intent. Remedy: operators
  belong in adapters, never on a published barrel. Syntactic only: it inspects a
  barrel's own export declarations and does not follow first-party
  `export *` (operators are never defined in a first-party module).
- `onerror-handler-only-in-app` — exactly one Hono `.onError()` handler exists
  in the app tree, and it lives in `app.ts`; a sub-router installing its own
  `onError` is flagged (it would fork error mapping and drop the assembly's
  telemetry). Both zero handlers and more than one in `app.ts` fail. Test files
  are exempt — they build throwaway apps with their own `onError`.
