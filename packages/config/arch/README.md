# Architecture rules (ts-morph harness)

Structural rules that ESLint cannot express. This harness enforces idempotency
exemption-wrapper pairing, non-exempt mutation idempotency coverage, the
no-external-call-in-transaction constraint, thin-shell Durable-Object
placement, jobs-test shard isolation, admin-op purity, and single-source
`onError` placement (`rules/*.rule.ts`). Related structural rules that ESLint CAN
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
  exactly one rule; never edit the harness to add behavior. **"Behavior" means
  rule logic** — a rule implemented as a special case inside the runner instead
  of as a file. Widening `run.ts`'s glob list changes _which files the rules
  see_, not what any rule does, and is the sanctioned way to change scope: this
  README already names that list as the statement of scope, and rules are
  contracted to receive every in-scope file and filter inside `check`. Measure
  the blast radius when you widen it — every rule gains the new files at once.
- Default-export an `ArchRule` (`{ name, check(project) }` from `../types.js`).
  A malformed rule file fails the whole run loudly — there is no silent skip.
- Keep checks **syntactic** (no `getType()`) so the harness stays fast in CI.
- Rules receive every in-scope source file; filter paths inside `check` if the
  rule targets a subset (see `do-classes-live-in-realtime.rule.ts`).
- Ship a colocated `*.rule.test.ts` exercising the rule against in-memory
  ts-morph projects (violating and passing shapes) — written test-first.

## Current rules

This list is **illustrative, not exhaustive** — it has lagged the rule set more
than once. `pnpm arch:check` prints the authoritative count; `rules/` is the
authoritative list.

- `money-internals-owners-only` — the affordability module's internals are
  reachable only from **price owners** (code that _produces_ prices), never from
  consumers. Two named path lists: `PRICE_OWNERS` (permanent) and
  `PENDING_CONSUMER_CLOSURES` (annotated debt, capped and non-increasing, with a
  duplicate guard so a repeated path cannot hide under the cap). The wall the
  export map draws is over _paths_; this rule draws the one the export map
  structurally cannot — over _importers_.
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
- `mutating-routes-prove-idempotency` — the complement of the exemption rule:
  every mutating route (`.post/.put/.patch/.delete` with a `/`-prefixed literal
  path) that is NOT declared exempt must statically route its write through the
  idempotency seam. Proof is one of three sanctioned mechanisms visible in the
  terminal handler: `runMutation`/`idempotent.<wrapper>` (or a same-file wrapper
  helper resolved by fix-point, e.g. conversations' `runByKey`), or the
  ConversationRoom DO run-control seam (`.startRun`/`.stopRun`) whose referee is
  the run-claim idempotency-key row, not an HTTP wrapper. A handler imported from
  another file cannot be proven at the route seam and is flagged. Closes the
  blind spot where a bare `db.insert(...)` route could ship un-idempotent.
- `no-external-call-in-transaction` — no external call (`fetch`, bare or
  `globalThis/self/window.fetch`) may appear lexically inside a
  `.transaction(callback)` in backend source. A plain transaction commits domain
  state and admits no external calls; pattern D keeps the external effect outside
  the tx by construction (`byExternalPreClaim` runs pre-claim → external →
  finalize as separate steps), so a correct card charge is never flagged.
  `fetch` is the same syntactic definition of "external call" the admin-op-purity
  rule uses — every provider/storage/payment/email port bottoms out in it.
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
- `demo-isolation` — production web code (`apps/web/src/**`, excluding
  `apps/web/src/demo/**` and test files) may not statically `import … from
'…/demo/…'`. The interactive demo fakes a logged-in session plus a global
  fetch shim and is code-split out of the main chunk by `main.tsx`'s
  `isDemoPath`-gated dynamic `import('./demo/bootstrap')`; a static import would
  silently bundle the fake-auth bypass into production. Dynamic imports are
  `ImportExpression`s, not `ImportDeclaration`s, so the gated demo entry is
  passed by construction; demo-internal (demo→demo) imports and tests are
  exempt. A specifier targets the demo tree only when a whole path segment is
  exactly `demo`, so the `@/lib/is-demo-path` helper is never flagged. Requires
  `apps/web/src/**/*.{ts,tsx}` in `run.ts`'s `SOURCE_GLOBS` to run against real
  web code.
- `no-evidence-from-mocked-seam` — no backend file may both fake the HTTP
  transport and enable a `service_evidence` write. Flagged shapes: a
  `fetch`-named property holding a vitest mock in the same options object as a
  hardcoded `isCI: true`, or any `recordServiceEvidence` call in a file that
  fakes fetch at all (including `vi.stubGlobal('fetch', …)`). Indirection is
  followed syntactically — a mock reached through a variable, a reassignment, or
  a local factory function still counts.

  **The invariant, and why fcm/webpush/resend differ from helcim/r2.** An
  evidence row is what `pnpm verify:evidence --require=<svc>` treats as proof
  that a real call to a real external service happened; a missing row hard-fails
  CI, which is the only thing standing between an integration going silently
  dark and a red build. So an adapter may record evidence **only where its real
  implementation actually executes in CI**. That holds for helcim (a real
  sandbox charge), hookdeck, and openrouter (a real, cassette-backed catalog
  fetch), and those adapters record it themselves. r2 records its own row after a
  real S3 PUT, but in CI that PUT lands on local MinIO (`R2_S3_ENDPOINT` is
  `http://localhost:9000` for `ciVitest`) — the write is real, the external
  service is not, and no CI step requires `r2-storage`. It
  does **not** hold for fcm, webpush and resend: `push-sender-factory.ts` and
  `email-sender-factory.ts` deliberately return mock senders whenever
  `isLocalDev || isCI`, because FCM has no sandbox, a real adapter would fire
  real sends at the junk tokens every E2E notification path seeds, and the
  `/dev/push` capture surface depends on the mock. **Those factories are correct
  and must not be "fixed"** — the defect this rule guards was evidence-writing
  code sitting in an adapter the factory mocks away, which made "a real call
  happened" and "`isCI`" mutually exclusive. `push-fcm` and `resend` both landed
  rows from a `vi.fn()` fetch, so `verify:evidence` was green while nothing had
  ever reached Google or Resend. Evidence for those three belongs in a separate
  CI-gated test that makes the real call itself
  (`push-fcm-live.integration.test.ts` is the pattern).

  What made those two files harmful, precisely, is that the faked transport sat
  next to a **real database connection** (`createDb`): a real `service_evidence`
  row landed from a call that never left the process. A test that fakes the
  transport but hands the adapter a spy or fake db — `payment-helcim.test.ts`
  does exactly this — cannot write a real row at all, so it is harmless. The
  rule keys on the shape (fake transport + open evidence gate) because that is
  what is statically visible; the harm it exists to prevent is the narrower
  fake-transport-plus-real-db combination.

  **Separating a fake from a real-delegating wrapper** is the rule's whole
  difficulty. The live FCM test hands the adapter a `fetchImpl` too, but its
  wrapper awaits the real global `fetch` and only clones the response; the
  cassette transport likewise closes over `globalThis.fetch`. Keying on the
  presence of a `fetchImpl` would flag the one file in the repo that does this
  correctly. The discriminator is vitest's mocking surface: a `vi.fn`,
  `vi.mock`, `vi.doMock` or `vi.stubGlobal` value has no socket behind it, and a
  wrapper that delegates never needs one. `vi.spyOn` is in the set for a
  different reason — it is the entry point to `mockImplementation`, the shape a
  fake takes when it replaces an existing function. A bare
  `vi.spyOn(globalThis, 'fetch')` with no `mockImplementation` **does** call
  through to the real `fetch`, so a capture-and-delegate spy passed alongside
  `isCI: true` is flagged even though its transport is real: a known, accepted
  over-fire, and not a reason to drop `spyOn` (dropping it would let every
  `spyOn(...).mockImplementation(...)` fake through).

  **What it does not prove:** that an evidence write in a passing file followed a
  genuine network call. No static rule can. It catches the mocked-seam shape —
  the shape both historical defects had — and nothing more.

  **Verified escapes — do not read the guard as total.** Each of these passes the
  rule today:

  - An in-file hand-written fake that touches no `vi.*` at all, such as an
    `async () => Response.json({ name: 'x' })` bound to `fetchImpl`. This is the
    repo's own prevailing style (`payment-helcim-fixtures.ts`'s
    `createFixtureFetch`, `gateway-metadata.test.ts`), so it is the likeliest
    escape, not a contrived one.
  - `isCI` passed as a shorthand or a variable rather than a `true` literal — a
    one-token mutation of the actual `push-fcm` violator.
  - `globalThis.fetch = vi.fn()` / `global.fetch = vi.fn()` assignment (only
    `vi.stubGlobal('fetch', …)` is recognized).
  - msw's `setupServer` and module-level `vi.mock('./transport.js')`, which fake
    the transport without ever naming a `fetch` slot.

  **Coverage limit:** `run.ts`'s `SOURCE_GLOBS` do not include
  `apps/api/src/adapters/**`, `apps/api/src/platform/**`, `apps/api/src/jobs/**`
  or `scripts/**`, so real `recordServiceEvidence` callers living there
  (`linear-real.integration.test.ts` is one) are never seen by this rule.
  `adapters/**` is the composition root — the likeliest home for a future
  violation. Widening the globs changes the input to every rule in the directory,
  so it is a deliberate decision, not a tidy-up.
