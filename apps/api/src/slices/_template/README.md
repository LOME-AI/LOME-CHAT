# Slice template

Canonical skeleton for a vertical slice. Copy this directory to
`src/slices/<your-slice>/`, rename the example files, and delete what you do
not need. The template itself is scaffolding, not code: lint, knip, coverage,
jscpd, and the arch harness all ignore it. It IS included in the package
tsconfig, so `routes.ts` compiles against the real manifest contract
(`defineSliceManifest`, `routeClass`, `AppEnv` from
`src/middleware/pipeline-manifest.ts`) — contract drift in the template fails
`typecheck` even without tests.

## Layout and layer rules

```
<slice>/
├── index.ts      # the BARREL — the slice's only public surface
├── routes.ts     # HTTP wiring as ONE slice manifest, no business logic
├── domain/       # business logic
│   ├── index.ts  # the domain barrel routes import from
│   └── *.ts
├── ports/        # interfaces for infra this slice's domain depends on
│   └── *.ts
└── adapters/     # implementations of ports; the ONLY layer touching infra
    └── *.ts
```

Enforced by `eslint-plugin-boundaries` (see
`packages/config/eslint-extensions/boundaries.config.mjs`) and the
ts-morph harness (`packages/config/arch/`):

- **Cross-slice:** another slice may import this slice ONLY via `index.ts`.
  Reaching into `domain/`, `ports/`, `adapters/`, or `routes.ts` from outside
  fails lint. Cross-slice writes go through published barrel APIs inside the
  orchestrating slice's transaction (single-writer-per-table).
- **routes.ts** imports only this slice's `domain/index.ts`, the middleware
  (`src/middleware/pipeline*`), and externals such as `hono`/`zod`/
  `@hushbox/shared`. It exposes the slice's HTTP surface as one
  `defineSliceManifest` entry whose every route declares a class via
  `routeClass(…)` — the pipeline default-denies undeclared routes. Routes
  hold no business logic and never import repositories or domain internals.
- **domain/** imports only this slice's `ports/` and other domain files, other
  slices' barrels, and the lib dirs
  (`src/lib/{result,errors,resilience,idempotency,jobs,telemetry}`). Never
  this slice's `adapters/`, never infra libraries (`@neondatabase/*`,
  `@upstash/*`, `drizzle-orm`, …).
- **adapters/** is the only layer that imports infra libraries. True external
  seams (gateway, payments, email, push) live here — and they are the only
  modules tests may `vi.mock`. Internal slices are never mocked; tests call
  the real barrel.
- **Wiring** happens at composition time: the `app.ts` assembly calls the
  slice's manifest factory with its adapters and mounts the result with one
  chained `.route(manifest.basePath, manifest.routes)` line, so routes never
  construct adapters themselves. The health slice in `app.ts` is the living
  example.
- New code never imports legacy files — an import that resolves outside the
  slice/lib/middleware trees fails lint as an unknown local.

## Tests

Colocate `*.test.ts` next to the code. Integration-first: tests run against
real local infra and the real barrels of other slices. The 95% coverage gate
applies to `src/slices/**`.
