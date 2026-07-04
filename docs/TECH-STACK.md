# Tech Stack

## Overview

This document defines the complete technology stack for the AI chat aggregator application. All choices optimize for: serverless architecture, local development parity, end-to-end type safety, minimal vendor lock-in, and cost efficiency. It describes the target of the backend rewrite; overtaken legacy code survives only as a renamed (`legacy_`-prefixed) compiling reference corpus until the cutover deletes it, and the design record lives in `docs/history/BACKEND-REDESIGN.md`.

---

## Core Values

**Serverless Architecture**
Pay for what you use. Zero idle costs.

**Local Development Parity**
Every production service runs locally. Developers never need production access. What works on your machine works in production.

**End-to-End Type Safety**
TypeScript everywhere. Shared schemas between frontend and backend. Change a type, get errors everywhere it breaks—before users do.

**Universal Idempotency**
Every operation is safe to retry. Network glitch? Just retry. No duplicate charges, no corrupted state.

**One Mechanism Per Task, Made Recoverable**
No backup mechanisms. Each task has a single mechanism that recovers itself — leases, TTLs, lazy checks. Auditors detect; humans repair.

**Crash Recovery by Construction**
Nothing commits mid-run, so a crash at any moment leaves nothing to clean up.

**Single Writer Per Table**
Every table has exactly one owning slice; everyone else goes through its published API.

**Configurability Over Rebuild**
Models, capabilities, and workflows are data. New behavior ships as registry entries and definitions, not deploys.

**Frequent Forever Backups**
Your data is backed up daily to geographically separate storage. Encrypted. Verified.

**Cost Efficiency**
Optimize for low costs.

**Developer Experience First**
One command starts everything. Clear errors. Fast iteration. If it's painful to develop, it's painful to maintain.

**Minimal Vendor Lock-in**
Standard tools, standard protocols.

**Accessibility Compliance**
Every feature works for everyone. WCAG compliance.

**No Security Through Obscurity**
Our security doesn't depend on hiding how things work. The source code is visible. Our architecture is documented. Security comes from good design, not secrets.

---

## Language

| Technology     | Purpose                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **TypeScript** | All code (frontend, backend, shared packages). Enables type safety across the entire stack with shared schemas. |

---

## Frontend

| Technology               | Purpose                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **React 19**             | UI framework. Largest ecosystem, best Capacitor support, excellent for text-heavy interfaces.                                  |
| **Vite**                 | Build tool and dev server. Fast HMR, simple config, no SSR complexity for SPA.                                                 |
| **rolldown-vite**        | Rust-based drop-in for Vite's bundler. Faster builds; applied workspace-wide via a pnpm override.                              |
| **TanStack Router**      | Routing. Fully type-safe routes, params, and search params. Compile-time errors for invalid routes.                            |
| **TanStack Query**       | Server state management. Caching, background refetching, request deduplication for all API calls.                              |
| **Zustand**              | Client state management. Lightweight, minimal boilerplate for UI state not tied to server.                                     |
| **shadcn/ui**            | Source of accessible primitives (Radix-based) in `packages/ui`. Copy-paste ownership; extended in-house with composites and domain features. |
| **Tailwind CSS**         | Styling. Utility-first, consistent design tokens, pairs with shadcn/ui.                                                        |
| **Sandpack** _(planned)_ | Browser code execution. Renders HTML/React/CSS in iframe sandbox for artifact previews.                                        |
| **input-otp**            | OTP input component. Accessible, mobile-friendly 6-digit code entry for 2FA verification.                                      |
| **react-qrcode-logo**    | QR code generation. Renders TOTP provisioning URIs for authenticator app setup.                                                |
| **Streamdown**           | Markdown rendering with plugin system. Plugins: `@streamdown/code` (Shiki), `@streamdown/mermaid`, `@streamdown/math` (KaTeX). |
| **Shiki**                | Syntax highlighting for code blocks (via `@streamdown/code`).                                                                  |
| **Framer Motion**        | Animation library for transitions and micro-interactions.                                                                      |
| **Lucide React**         | Icon library. SVG icons used throughout UI.                                                                                    |
| **React Virtuoso**       | Virtual scrolling for long message lists.                                                                                      |

---

## Marketing Site

| Technology | Purpose                                                                             |
| ---------- | ----------------------------------------------------------------------------------- |
| **Astro**  | Static site generator. SSG for SEO, partial hydration, deployed alongside main app. |

---

## Mobile

| Technology    | Purpose                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| **Capacitor** | Native wrapper. Same React codebase runs on iOS/Android with native API access. |

---

## Backend

| Technology              | Purpose                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Hono**                | API framework. Ultrafast, runs on Workers/Node/Bun, native streaming support.                                           |
| **Zod**                 | Schema validation. Runtime validation + TypeScript inference. Shared schemas between frontend/backend.                  |
| **@hono/zod-validator** | Input validation middleware. Zod schemas validate request body/params/query in Hono route chains.                       |
| **hono/client**         | Typed RPC client. `hc<AppType>()` infers types from Hono route chains. Ships with `hono`, zero additional dependencies. |
| **neverthrow**          | Typed `Result` error channel at service seams. Must-use enforced by a vendored lint rule.                               |
| **ts-pattern**          | Exhaustive matching (DomainError→code, node dispatch); compiler catches unhandled variants.                              |
| **cockatiel**           | Retry/timeout policies on external calls, built only via the policy factory. No in-isolate breakers.                    |
| **eslint-plugin-boundaries** | Enforces slice/package boundaries and intra-slice layers from the import graph.                                     |
| **ts-morph**            | Structural architecture tests lint can't express (idempotency wrapping, schema-object scoping).                         |
| **jose**                | Cloudflare Access JWT verification in the admin Worker.                                                                  |

---

## Database

| Technology  | Purpose                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| **Neon**    | Cloud PostgreSQL 18. Serverless, scales to zero, branching for previews. Native uuidv7(). |
| **Drizzle** | ORM. Type-safe, lightweight, identical queries on Neon and local Postgres.                |

---

## Cache

| Technology                | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Upstash Redis**         | Serverless Redis. OPAQUE challenge state, rate limiting, 2FA attempt tracking. |
| **Serverless Redis HTTP** | Local development proxy. Emulates Upstash REST API against local Redis.        |

---

## Hosting

| Technology                     | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| **Cloudflare Workers**         | API hosting: one product Worker + one admin Worker (service-binding RPC between them). |
| **Cloudflare Pages**           | Frontend hosting. Deploys Vite app, admin SPA, and Astro marketing site.     |
| **Cloudflare Durable Objects** | Two roles: ConversationRoom (realtime hub, stream coordination, in-process flow executor) and JobDispatcher (alarm-clocked job execution). |

---

## Storage

| Technology        | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| **Cloudflare R2** | Primary object storage. S3-compatible. User files, artifacts, exports.          |
| **Backblaze B2**  | Backup storage. Different vendor for disaster recovery. Receives Kopia backups. |
| **Kopia**         | Backup tool. Incremental, encrypted, deduplicated backups from R2 to B2.        |

---

## Code Execution

| Technology                      | Purpose                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Cloudflare Containers / Sandbox SDK** _(deferred)_ | Server-side heavy compute (transcode, code execution) when a feature forces it. Same vendor; behind the `TransformCompute` port. |
| **Sandpack** _(planned)_        | Client-side sandbox. Browser iframe for HTML/React/CSS preview. No server needed.                 |

---

## Authentication

| Technology                | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| **@cloudflare/opaque-ts** | OPAQUE PAKE protocol. Zero-knowledge password auth.                 |
| **iron-session**          | Encrypted session cookies. Stateless, no server-side session store. |
| **otplib**                | TOTP generation and verification for two-factor authentication.     |

---

## Cryptography

| Technology         | Purpose                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **@noble/ciphers** | XChaCha20-Poly1305 AEAD encryption for ECIES message blobs. Audited, zero deps.                       |
| **@noble/curves**  | X25519 ECDH for key exchange between client and recovery flows.                                       |
| **@noble/hashes**  | SHA-256, HKDF-SHA-256 for key derivation, epoch confirmation hashes, and content-addressable storage. |
| **@scure/bip39**   | BIP39 mnemonic generation for 12-word recovery phrases.                                               |
| **hash-wasm**      | Argon2id password hashing in WebAssembly.                                                             |
| **fflate**         | Raw deflate compression before encryption. Saves ~18 bytes per message vs gzip.                       |

---

## Email

| Technology | Purpose                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| **Resend** | Transactional email. HTTP API for verification emails. Test addresses for CI. |

---

## Payments

| Technology | Purpose                                     |
| ---------- | ------------------------------------------- |
| **Helcim** | Payment processing. Handles credit loading. |

---

## Analytics & Observability

| Technology              | Purpose                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| **Cloudflare Workers Logs**     | Structured logs, allowlisted fields; Logpush to R2 for retention.                  |
| **Workers Analytics Engine**    | App/business metrics. SQL API only; every metric has a named watcher.              |
| **Sentry**                      | Unexpected errors only, backend only. Scrubbed at the Telemetry port; `errorCode` fingerprints. |
| **Cloudflare OTel tracing**     | Vendor-neutral tracing (open beta; Sentry tracing is the fallback).                |
| **PostHog** _(deferred)_        | Product analytics, if ever: self-hosted, no autocapture, never session replay.     |

---

## AI / LLM

| Technology            | Purpose                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Vercel AI SDK**     | Provider-agnostic streaming inference for text, image, and video. The portability seam behind the `ModelProvider` port (OpenRouter via `@openrouter/ai-sdk-provider`). |
| **OpenRouter**        | The single gateway: 100+ models, queryable metadata + queryable ZDR (`/endpoints/zdr`, per-request `provider.zdr`), authoritative inline `usage.cost` as billing truth. Reached through the AI SDK. |

---

## Excluded Services

Each was evaluated and excluded; re-entry conditions live in `ARCHITECTURE.md`.

| Service                  | Why excluded                                                              |
| ------------------------ | ------------------------------------------------------------------------- |
| **Cloudflare Workflows** | Durable resume is exactly what fast-fail makes unwanted.                  |
| **Cloudflare Queues**    | A send can't be atomic with a Postgres commit; the jobs table can.        |
| **Hyperdrive**           | No PG18; caching isn't read-your-writes safe; pooling doesn't bind yet.   |
| **Fly.io**               | Second compute vendor for a deferred feature; Cloudflare Containers preferred. |
| **Axiom**                | Workers Logs covers it natively.                                          |
| **Effect-TS**            | Team fit and migration cost; would discard Drizzle/Zod inference.         |

---

## Development

| Technology          | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Turborepo**       | Monorepo orchestration. Parallel builds, caching, task dependencies.                 |
| **pnpm**            | Package manager.                                                                     |
| **Vitest**          | Unit/integration testing.                                                            |
| **Playwright**      | E2E testing. Cross-browser,.                                                         |
| **fishery**         | Test factories with traits, sequences, and async DB creation.                        |
| **@faker-js/faker** | Realistic fake data generation.                                                      |
| **MinIO**           | Local S3-compatible server. Emulates R2 for local dev and CI tests via `pnpm db:up`. |
| **Payment Mocks**   | Local mock for Helcim. No real API calls in local development.                       |
| **Helcim Sandbox**  | Helcim's test environment. Used in CI for real payment flow testing.                 |
| **execa**           | Subprocess execution. Clean API for running shell commands from TypeScript scripts.  |
| **tsx**             | TypeScript execution. Runs TypeScript directly without compilation step.             |

---

## CI/CD

| Technology         | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| **GitHub Actions** | CI/CD pipelines. Tests on PR, deploy on merge, scheduled backups. |

---

## CI/CD Infrastructure Principle

CI runs the same Docker Compose infrastructure as local development. GitHub Actions executes `pnpm db:up` (and future `pnpm storage:up`, etc.) rather than defining service containers in workflow YAML.

Benefits:

- Single source of truth: `docker-compose.yml`
- No duplication between workflow files and compose configuration
- Identical test environment locally and in CI

---

## Environment Management

| File                   | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| **.env.development**   | Dev defaults, committed. No secrets.            |
| **.env.example**       | Production template, committed. Documents vars. |
| **Cloudflare Secrets** | Production secrets stored in Workers.           |
| **Github Secrets**     | Production secrets for workflows.               |

Local dev and CI use `.env.development`. No secrets needed outside production.

---

## Licensing

| Item        | Choice                                                |
| ----------- | ----------------------------------------------------- |
| **License** | Proprietary (source-available, no rights granted).    |
| **CAA**     | Required for all contributions via CLA Assistant bot. |

---

## Monorepo Structure

```
/
├── apps/
│   ├── web/              # React + Vite (main application)
│   ├── marketing/        # Astro (marketing site)
│   ├── api/              # Product Worker — vertical slices (map in ARCHITECTURE.md)
│   ├── admin-api/        # Admin Worker — Access-gated, RPC into the product Worker
│   └── admin/            # Admin SPA (Pages)
│
├── packages/
│   ├── ui/               # Shared component library: primitives, composites, hooks, utilities
│   ├── shared/           # Zod schemas, types, constants, contracts
│   ├── db/               # Drizzle schema, migrations, client
│   ├── crypto/           # Encryption, key derivation, OPAQUE helpers
│   ├── realtime/         # Durable Objects: ConversationRoom + JobDispatcher
│   └── config/           # Shared ESLint, TypeScript configs, arch-test harness
│
├── e2e/                  # Playwright E2E tests
├── scripts/              # Dev tooling (seed, db-reset, generate-env)
├── docs/                 # Documentation (history/ holds archived plans)
│
├── .github/
│   └── workflows/
│       ├── ci.yml        # Test on PR
│       ├── deploy.yml    # Deploy on merge
│       └── backup.yml    # Daily backups
│
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## Data Flow

### Cloud Mode

```
Browser → API (Workers) → Neon Postgres / R2 / Redis
                       → ConversationRoom DO → OpenRouter (flows + streaming)
                       → JobDispatcher DO (async jobs)
```

## API Patterns

| Pattern          | Technology                                | Use Case                                                           |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Request/Response | Hono + Zod + `hc<AppType>()` typed client | CRUD, auth, billing, members, links; `POST /chat` returns a run handle |
| WebSocket        | ConversationRoom Durable Object           | The sole streaming transport: turn tokens, flow progress, presence, media events, replay/resume |
| Jobs             | `jobs` table + JobDispatcher DO           | All must-happen async work (exports, reclaim, admin actions) |

---

## Local Development

```bash
pnpm dev
```

Starts:

- Vite (frontend) on :5173
- Wrangler (Workers) on :8787
- Postgres (Docker) on :5432
- Neon Proxy (Docker) on :4444 (WebSocket → Postgres)
- Redis (Docker) on :6379
- Serverless Redis HTTP (Docker) on :8079 (Upstash REST API emulator)
- MinIO (S3-compatible R2 emulator) on :9000

External APIs are mocked locally. Real-API tests run on every PR in CI: OpenRouter via the test job (vitest integration tests with `OPENROUTER_API_KEY_RESTRICTED`); Helcim sandbox via the e2e job (Playwright payment flows with `HELCIM_API_TOKEN_SANDBOX`). The `verify:evidence` step asserts each real service was actually exercised. During the backend rewrite the e2e job and the legacy integration suites are dark — skipped in CI until Phase-4 re-pointing; test, typecheck, and lint stay green over the non-legacy tree plus the compiling `legacy_` reference corpus.
