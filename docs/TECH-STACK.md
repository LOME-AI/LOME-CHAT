# Tech Stack

## Overview

This document defines the complete technology stack for the AI chat aggregator application. All choices optimize for: serverless architecture, local development parity, end-to-end type safety, minimal vendor lock-in, and cost efficiency.

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

| Technology | Purpose |
|------------|---------|
| **TypeScript** | All code (frontend, backend, shared packages). Enables type safety across the entire stack with shared schemas. |

---

## Frontend

| Technology | Purpose |
|------------|---------|
| **React 19** | UI framework. Largest ecosystem, best Capacitor support, excellent for text-heavy interfaces. |
| **Vite** | Build tool and dev server. Fast HMR, simple config, no SSR complexity for SPA. |
| **TanStack Router** | Routing. Fully type-safe routes, params, and search params. Compile-time errors for invalid routes. |
| **TanStack Query** | Server state management. Caching, background refetching, request deduplication for all API calls. |
| **Zustand** | Client state management. Lightweight, minimal boilerplate for UI state not tied to server. |
| **shadcn/ui** | UI components. Accessible (Radix-based), customizable, copy-paste ownership. Favor existing components over custom. |
| **Tailwind CSS** | Styling. Utility-first, consistent design tokens, pairs with shadcn/ui. |
| **Sandpack** | Browser code execution. Renders HTML/React/CSS in iframe sandbox for artifact previews. |

---

## Marketing Site

| Technology | Purpose |
|------------|---------|
| **Astro** | Static site generator. SSG for SEO, partial hydration, deployed alongside main app. |

---

## Mobile

| Technology | Purpose |
|------------|---------|
| **Capacitor** | Native wrapper. Same React codebase runs on iOS/Android with native API access. |

---

## Backend

| Technology | Purpose |
|------------|---------|
| **Hono** | API framework. Ultrafast, runs on Workers/Node/Bun, native streaming support. |
| **Zod** | Schema validation. Runtime validation + TypeScript inference. Shared schemas between frontend/backend. |
| **OpenAPI** | API documentation. Auto-generated from Hono + Zod, enables non-TS clients if needed. |

---

## Database

| Technology | Purpose |
|------------|---------|
| **Neon** | Cloud Postgres. Serverless, scales to zero, branching for previews. Used for cloud mode. |
| **PGlite** | Browser Postgres. WASM Postgres in browser with IndexedDB persistence. Used for local-only mode. |
| **Drizzle** | ORM. Type-safe, lightweight, identical queries work on Neon and PGlite. Single schema for both modes. |

---

## Cache

| Technology | Purpose |
|------------|---------|
| **Upstash Redis** | Serverless Redis. Rate limiting, session cache, model metadata cache. Pay-per-request. |

---

## Hosting

| Technology | Purpose |
|------------|---------|
| **Cloudflare Workers** | API hosting. |
| **Cloudflare Pages** | Frontend hosting. Deploys Vite app and Astro marketing site together. |

---

## Storage

| Technology | Purpose |
|------------|---------|
| **Cloudflare R2** | Primary object storage. S3-compatible. User files, artifacts, exports. |
| **Backblaze B2** | Backup storage. Different vendor for disaster recovery. Receives Kopia backups. |
| **Kopia** | Backup tool. Incremental, encrypted, deduplicated backups from R2 to B2. |

---

## Code Execution

| Technology | Purpose |
|------------|---------|
| **Fly.io Machines** | Server-side sandbox. Full Linux VMs for Python/Node execution. Spin up on demand, pay per second. |
| **Sandpack** | Client-side sandbox. Browser iframe for HTML/React/CSS preview. No server needed. |

---

## Authentication

| Technology | Purpose |
|------------|---------|
| **Better Auth** | Auth library. Built-in OAuth, email/password, 2FA. Drizzle adapter, no vendor lock-in. |

---

## Payments

| Technology | Purpose |
|------------|---------|
| **Helcim** | Payment processing. Handles credit loading. |

---

## Analytics & Observability

| Technology | Purpose |
|------------|---------|
| **PostHog** | Product analytics. Events, funnels, feature flags, session replay. Self-hostable. |
| **Sentry** | Error tracking. Stack traces, source maps, error grouping. |
| **Axiom** | Logs. Serverless-friendly. |

---

## AI / LLM

| Technology | Purpose |
|------------|---------|
| **OpenRouter** | LLM gateway. Single API for GPT, Claude, Gemini, Grok, others. Model metadata API for auto-discovery. |

---

## Development

| Technology | Purpose |
|------------|---------|
| **Turborepo** | Monorepo orchestration. Parallel builds, caching, task dependencies. |
| **pnpm** | Package manager. |
| **Vitest** | Unit/integration testing. |
| **Playwright** | E2E testing. Cross-browser,. |
| **MinIO** | Local S3 mock. Emulates R2 for local development. |
| **Payment Mocks** | Local mock for Helcim. No real API calls in local development. |
| **Helcim Sandbox** | Helcim's test environment. Used in CI for real payment flow testing. |

---

## CI/CD

| Technology | Purpose |
|------------|---------|
| **GitHub Actions** | CI/CD pipelines. Tests on PR, deploy on merge, scheduled backups. |

---

## Environment Management

| File | Purpose |
|------|---------|
| **.env.example** | Template with all variables, committed to repo. |
| **.env.local** | Local development values, gitignored. |
| **Zod validation** | Runtime validation of all env vars with typed inference. |
| **Cloudflare Secrets** | Production secrets stored in Workers. |
| **GitHub Secrets** | CI/CD secrets for Actions. |

---

## Licensing

| Item | Choice |
|------|--------|
| **License** | Proprietary (source-available, no rights granted). |
| **CLA** | Required for all contributions via CLA Assistant bot. |

---

## Monorepo Structure

```
/
├── apps/
│   ├── web/              # React + Vite (main application)
│   ├── marketing/        # Astro (marketing site)
│   ├── api/              # Hono (Cloudflare Workers)
│   └── mobile/           # Capacitor (iOS/Android wrapper)
│
├── packages/
│   ├── ui/               # shadcn/ui components
│   ├── shared/           # Zod schemas, types, constants
│   ├── db/               # Drizzle schema, migrations, client
│   └── config/           # Shared ESLint, TypeScript configs
│
├── services/
│   └── sandbox/          # Fly.io Machine Docker image
│
├── mocks/
│   ├── openrouter/       # LLM response fixtures
│   └── sandbox/          # Code execution fixtures
│
├── docs/                 # Documentation
│
├── .github/
│   └── workflows/
│       ├── ci.yml        # Test on PR
│       ├── deploy.yml    # Deploy on merge
│       └── backup.yml    # Daily backups
│
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
└── README.md
```

---

## Data Flow

### Cloud Mode
```
Browser → API (Workers) → Neon Postgres / R2
                       → OpenRouter (LLM)
                       → Fly.io (code execution)
```

### Local-Only Mode
```
Browser → API (Workers) → OpenRouter (LLM)
   ↓                    → Fly.io (code execution)
PGlite (IndexedDB)
   
Server returns responses but never persists.
Browser stores everything in PGlite.
Does not support S3 usage like media. Text only.
```

---

## API Patterns

| Pattern | Technology | Use Case |
|---------|------------|----------|
| Request/Response | Hono + Zod | CRUD, auth, file uploads |
| SSE Streaming | Hono streaming | LLM token streaming, code execution output |

---

## Local Development

```bash
pnpm dev
```

Starts:
- Vite (frontend) on :5173
- Wrangler (Workers) on :8787
- Postgres (Docker) on :5432
- MinIO (S3 mock) on :9000

All external APIs (OpenRouter, Helcim) are mocked locally. Real API calls (to OpenRouter and Helcim Sandbox) only run in CI when a LOME team member comments "pr test". These tests must pass to merge the PR.