# Architecture rules (ts-morph harness)

Structural rules that ESLint cannot express (idempotency wrapping, no raw
Drizzle in domain, ValueStore isolation, thin-shell Durable Objects, …). Run
via `pnpm arch:check` from the repo root; also a CI step. Scoped to the
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
