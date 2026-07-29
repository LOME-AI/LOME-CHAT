# Development

## Commands

All workflow commands go through pnpm scripts. If you repeatedly need a raw command,
propose a new pnpm script instead of running it directly.

- `pnpm dev` — full local stack. `pnpm dev:restart` recovers a wedged one.
- `pnpm test` — everything, and it runs the coverage gate (a per-file coverage
  shortfall fails `test`). `pnpm test:api|web|shared|db|crypto|ui|realtime|config`
  scopes to one package; `pnpm test:watch <path>` runs one file (coverage-free).
  A **pole** — a single test file over 50% of its package's test-work and ≥15s —
  also fails the run; the fix is to split the file into smaller test files.
- `pnpm db:generate` — writes a migration into `packages/db/drizzle/` from schema
  edits (the migration ships with the schema change; CI fails on drift).
  `pnpm db:migrate` applies; `pnpm db:reset` wipes; `pnpm db:seed`; `pnpm db:studio`.
- `pnpm lint` / `lint:fix` / `typecheck` / `format` — plus the standalone gates:
  `pnpm arch:check` (ts-morph structural rules), `pnpm lint:duplication` (jscpd),
  `pnpm lint:unused` (knip), `pnpm verify:bundle` (an already-built `apps/web`
  dist; name other dist directories as arguments).
- `pnpm e2e` (full) / `e2e:quick` / `e2e:<suite>` — read `e2e/CLAUDE.md` before
  writing or debugging E2E tests.

Scripts run through `scripts/with-env.ts` and `ensure-stack` automatically — the
first command of a session may start Docker containers; that is normal.

## Local stack

`pnpm dev` starts: Vite, Wrangler, the document sandbox origin (static server on
`HB_SANDBOX_PORT`, serving the runnable-document renderers under their real CSP),
Postgres (Docker), Neon Proxy (WebSocket → Postgres), Redis, Serverless Redis HTTP
(Upstash REST emulator), and MinIO (R2 emulator). External APIs are mocked locally;
no production credentials are ever needed.

Ports are computed per worktree; this checkout's actual values are in the
generated, git-ignored `.env.scripts` (the `HB_*_PORT` vars).

## CI

CI runs the same Docker Compose infrastructure as local development (`pnpm db:up`),
never service containers defined in workflow YAML — `docker-compose.yml` is the
single source of truth, so the test environment is identical locally and in CI.

Gates: lint + `arch:check` · typecheck + migration drift (an uncommitted
`packages/db/drizzle/` diff fails) · duplication (jscpd) · unused (knip) · gitleaks ·
test (AI calls replay from cassettes while the request is unchanged; a changed or
uncached request makes one real call and records it in the same run) · build +
bundle verification. Bundle verification is invoked, never ambient: `apps/admin` and
`apps/sandbox` verify themselves at build · the web dist is verified by workflow
steps — the merged bundle before upload, the pre-merge dist Android packages, the
three mobile OTA bundles. Presence in the guard's app map is a TTS declaration, not
coverage. Prettier runs as an ESLint rule, so formatting is covered by the lint gate
(CI and pre-push). Pre-commit regenerates derived files and re-stages them; pre-push
runs ESLint, typecheck, and tests (husky).

Real external services are exercised in CI with restricted credentials — OpenRouter
in the vitest test job (`OPENROUTER_API_KEY_RESTRICTED`, record-on-miss cassettes),
FCM in the same job (`FCM_PROJECT_ID_CI` / `FCM_SERVICE_ACCOUNT_JSON_CI`, one
`validate_only` send), Helcim sandbox in the e2e job (`HELCIM_API_TOKEN_SANDBOX`) — and
`pnpm verify:evidence` asserts a real call happened, not merely that the code path ran.
A mocked HTTP seam must never write a row; `arch:check` enforces that. OpenRouter is the
deliberate exception: a warm-cache cassette replay counts, because the cassette holds
bytes a real call produced.

## Environment

| File                   | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| **.env.development**   | Dev defaults, committed. No secrets.            |
| **.env.example**       | Production template, committed. Documents vars. |
| **Cloudflare Secrets** | Production secrets stored in Workers.           |
| **GitHub Secrets**     | Production secrets for workflows.               |

Local dev and CI use `.env.development`. Env files are generated and validated with
`pnpm generate:env` / `pnpm verify:env` (modes: `development`, `ciVitest`, `ciE2E`,
`production`). Env vars exist only as `env.config` registry entries (see CODE-RULES).

## README is generated

`README.md` is built from `README.template.md` via `pnpm generate:readme` — never
edit `README.md` directly.

## Doc index — read eagerly when the task touches it. Lazily point out stale information in these docs as you notice.

- `docs/DESIGN.md` — any UI, visual, or user-facing copy work
- `docs/PRODUCT.md` — brand, voice, and audience for any copy
- `docs/CI-CASSETTES.md` — recording or replaying AI-call cassettes
- `docs/DOCUMENTS.md` — runnable documents: document-panel rendering/execution, the
  sandbox origin, or the system prompt's document guidance
- `docs/NOTIFICATIONS.md` — any notification, push, or service-worker work
- `docs/BILLING.md` — billing domain work
- `docs/CONTRIBUTING.md` — human onboarding and setup
