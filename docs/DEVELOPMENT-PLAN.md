# Development Plan

Complete phased development plan for LOME-CHAT. Each phase builds on the previous and introduces new tech stack components gradually.
For AI agents: If anything ever seems uncertain or could be improved, ask the human and present your reasoning.

---

## Acceptance Criteria

Every phase must meet these criteria before being marked complete:

### Code Quality

- [ ] ESLint passes with zero warnings
- [ ] Prettier formatting applied

### Testing

- [ ] Unit tests for all business logic (Vitest)
- [ ] Integration tests for API endpoints
- [ ] E2E tests for user-facing flows (Playwright)
- [ ] All tests pass locally
- [ ] Test coverage does not decrease

---

## Progress Tracking

Mark phases and sub-items complete by changing `[ ]` to `[x]`:

```markdown
- [x] Completed item
- [ ] Incomplete item
```

Commit this file with progress updates to maintain state across sessions.

---

## Phase 1: Repository Setup

**Purpose:** Initialize monorepo structure with all tooling configured.

- [x] Create `pnpm-workspace.yaml` with workspace definitions
- [x] Create root `package.json` with workspace scripts
- [x] Set `"packageManager": "pnpm@10.26.0"` in package.json
- [x] Create `turbo.json` with pipeline configuration
- [x] Create directory structure:
  ```
  apps/
  packages/
  services/
  mocks/
  docs/
  ```
- [x] Add root `.gitignore`
- [x] Add root `.npmrc` for pnpm settings
- [x] Add `LICENSE` file
- [x] Add `CLA.md` file

---

## Phase 2: Shared Configuration

**Purpose:** Set up shared TypeScript, ESLint, and Prettier configs.

- [x] Create `packages/config/` package
- [x] Create shared `tsconfig.base.json`
- [x] Create shared ESLint config (`eslint.config.js`)
- [x] Create shared Prettier config (`.prettierrc`)
- [x] Create shared Tailwind config
- [x] Add lint-staged and husky for pre-commit hooks
- [x] Configure Turborepo caching for lint/build tasks

---

## Phase 3: Testing Infrastructure

**Purpose:** Set up testing framework before any production code (TDD requirement).

**Tech Stack Addition:** Vitest, Playwright

- [x] Install and configure Vitest
- [x] Create `packages/shared` structure (utilities added when needed)
- [x] Configure coverage reporting (95% enforcement)
- [x] Install and configure Playwright
- [x] Create Playwright config for E2E tests
- [x] Add test scripts to root package.json:
  - [x] `pnpm test` - run unit tests
  - [x] `pnpm e2e` - run E2E tests
  - [x] `pnpm test:coverage` - run with coverage

---

## Phase 4: Shared Types & Schemas

**Purpose:** Create the shared package for types and Zod schemas.

**Tech Stack Addition:** Zod

- [x] Create `packages/shared/` package
- [x] Install Zod
- [x] Create initial schema files:
  - [x] `schemas/user.ts`
  - [x] `schemas/conversation.ts`
  - [x] `schemas/message.ts`
  - [x] `schemas/project.ts`
- [x] Create shared constants file
- [x] Create shared utility types
- [x] Export all from package index

---

## Phase 5: Database Schema

**Purpose:** Define database schema with Drizzle ORM.

**Tech Stack Addition:** Drizzle ORM

- [x] Create `packages/db/` package
- [x] Install Drizzle ORM and Drizzle Kit
- [x] Create schema files:
  - [x] `schema/users.ts`
  - [x] `schema/conversations.ts`
  - [x] `schema/messages.ts`
  - [x] `schema/projects.ts`
  - [ ] `schema/memories.ts` _(Deferred - MVP scope)_
  - [ ] `schema/documents.ts` _(Deferred - MVP scope)_
- [x] Create `schema/index.ts` exporting all tables
- [x] Create `drizzle.config.ts`
- [x] Add migration scripts to package.json
- [x] Generate initial migration _(Deferred to Phase 6 - requires DATABASE_URL)_

---

## Phase 6: Database Clients

**Purpose:** Create unified database client with local development parity via Neon wsproxy.

**Tech Stack Addition:** Neon (with wsproxy for local dev)

- [x] Install `@neondatabase/serverless`
- [x] Install `drizzle-orm/neon-serverless` adapter
- [x] Create `client.ts` with `createDb(connectionString)` function
- [x] Create type exports for database instance
- [x] Add neon-proxy to Docker Compose for local development
- [x] Configure WebSocket proxy settings for local dev
- [x] Test connection locally via wsproxy
- [x] Integration tests pass against Docker Postgres

**Deferred to Phase 23:** PGlite browser client for local-only mode

**Human Setup Required (for production):**

1. Create Neon account at https://neon.tech
2. Create new project and database
3. Add connection string to Cloudflare Secrets as `DATABASE_URL`

---

## Phase 7: Test Factories

**Purpose:** Create factories for TDD from the start.

**Tech Stack Addition:** fishery, @faker-js/faker

- [x] Install fishery and @faker-js/faker in `packages/db`
- [x] Create factories for each entity:
  - [x] `packages/db/src/factories/user.ts`
  - [x] `packages/db/src/factories/conversation.ts`
  - [x] `packages/db/src/factories/message.ts`
  - [x] `packages/db/src/factories/project.ts`
- [x] Export all factories from `packages/db/src/factories/index.ts`
- [x] Test factories create valid records

---

## Phase 8: Frontend Foundation

**Purpose:** Scaffold the main web application.

**Tech Stack Addition:** React, Vite, TanStack Router

- [ ] Create `apps/web/` with Vite React template
- [ ] Configure Vite for TypeScript strict mode
- [ ] Install and configure TanStack Router
- [ ] Create route structure:
  - [ ] `routes/__root.tsx`
  - [ ] `routes/index.tsx` (landing/redirect)
  - [ ] `routes/_app.tsx` (authenticated layout)
  - [ ] `routes/_app/chat.$conversationId.tsx`
  - [ ] `routes/_app/projects.tsx`
  - [ ] `routes/_app/settings.tsx`
- [ ] Configure path aliases (`@/`)
- [ ] Add route type generation script
- [ ] Move all images in public/ to their final desination. Dont miss any. Delete public/ after
- [ ] Record all the colors in colors.md in a real code file in their final destination. Dont miss any. Delete colors.md after

---

## Phase 9: UI Components

**Purpose:** Set up component library with shadcn/ui.

**Tech Stack Addition:** shadcn/ui, Tailwind CSS

- [ ] Create `packages/ui/` package
- [ ] Install and configure Tailwind CSS
- [ ] Initialize shadcn/ui with CLI
- [ ] Add base components:
  - [ ] Button
  - [ ] Input
  - [ ] Textarea
  - [ ] Card
  - [ ] Dialog
  - [ ] Dropdown Menu
  - [ ] Select
  - [ ] Tabs
  - [ ] Toast
  - [ ] Tooltip
  - [ ] Avatar
  - [ ] Badge
  - [ ] Separator
  - [ ] Scroll Area
  - [ ] Sheet (slide-over panel)
- [ ] Create component exports from package
- [ ] Import and use in `apps/web`

---

## Phase 10: State Management

**Purpose:** Configure client and server state management.

**Tech Stack Addition:** TanStack Query, Zustand

- [ ] Install TanStack Query in `apps/web`
- [ ] Create QueryClient provider
- [ ] Install Zustand
- [ ] Create initial stores:
  - [ ] `stores/ui.ts` (sidebar state, theme, etc.)
  - [ ] `stores/chat.ts` (current conversation, pending messages)
- [ ] Create TanStack Query hooks directory structure
- [ ] Add React Query Devtools (dev only)

---

## Phase 11: Backend Foundation

**Purpose:** Scaffold the API application.

**Tech Stack Addition:** Hono, Cloudflare Workers

- [ ] Create `apps/api/` package
- [ ] Install Hono
- [ ] Install Wrangler (Cloudflare CLI)
- [ ] Create `wrangler.toml` configuration
- [ ] Create basic Hono app with health endpoint
- [ ] Create middleware structure:
  - [ ] `middleware/cors.ts`
  - [ ] `middleware/error.ts`
  - [ ] `middleware/validate.ts`
- [ ] Create route structure:
  - [ ] `routes/health.ts`
  - [ ] `routes/auth.ts` (placeholder)
  - [ ] `routes/conversations.ts` (placeholder)
  - [ ] `routes/chat.ts` (placeholder)
- [ ] Configure local development with Wrangler
- [ ] Add OpenAPI generation from Zod schemas

**Human Setup Required:**

1. Create Cloudflare account at https://cloudflare.com
2. Install Wrangler CLI: `pnpm add -g wrangler`
3. Run `wrangler login` to authenticate

---

## Phase 12: Early Cloud Deployment

**Purpose:** Verify local code actually deploys to cloud before building more features.

- [ ] Deploy `apps/api` to Cloudflare Workers
- [ ] Deploy `apps/web` to Cloudflare Pages
- [ ] Verify health endpoint responds in production
- [ ] Verify frontend loads in production
- [ ] Document any deployment issues encountered
- [ ] Create simple deployment script for future deploys

**Human Setup Required:**

1. Ensure Cloudflare account is configured (from Phase 10)
2. Set up Cloudflare Pages project
3. Connect GitHub repo for automatic deploys (optional at this stage)

---

## Phase 13: Basic CI Pipeline

**Purpose:** Establish CI early to catch issues continuously.

**Tech Stack Addition:** GitHub Actions

- [ ] Create `.github/workflows/ci.yml`
- [ ] Configure jobs:
  - [ ] Lint
  - [ ] Type check
  - [ ] Unit tests
  - [ ] Build verification
- [ ] Add PR status checks
- [ ] Verify CI runs on push to main and PRs

---

## Phase 14: Local Development Environment

**Purpose:** Create seamless local development experience.

**Tech Stack Addition:** Docker (Postgres), Turborepo dev orchestration

- [ ] Create `docker-compose.yml` with:
  - [ ] Postgres container (port 5432)
- [ ] Create `scripts/dev.ts` startup script
- [ ] Configure Turborepo `dev` task to start all services
- [ ] Create seed script for test data
- [ ] Update root package.json scripts:
  - [ ] `pnpm dev` - start all services
  - [ ] `pnpm db:migrate` - run migrations
  - [ ] `pnpm db:seed` - seed database
  - [ ] `pnpm db:studio` - open Drizzle Studio
- [ ] Test full local stack startup
- [ ] Document setup in `docs/CONTRIBUTING.md`

---

## Phase 15: Environment Management

**Purpose:** Set up typed environment variable handling.

- [ ] Create `packages/shared/env.ts` with Zod validation
- [ ] Define all environment variables with defaults for dev
- [ ] Create `.env.example` with all variables documented
- [ ] Configure Vite env exposure (VITE\_ prefix)
- [ ] Configure Wrangler env/secrets separation
- [ ] Add startup validation that fails fast on missing vars
- [ ] Document secret vs non-secret variables

---

## Phase 16: Authentication

**Purpose:** Implement user authentication.

**Tech Stack Addition:** Better Auth

- [ ] Install Better Auth
- [ ] Create auth configuration in `apps/api`
- [ ] Configure Drizzle adapter for Better Auth
- [ ] Add auth tables to database schema:
  - [ ] `sessions`
  - [ ] `accounts`
  - [ ] `verifications`
- [ ] Run migration for auth tables
- [ ] Implement auth endpoints:
  - [ ] `POST /auth/signup`
  - [ ] `POST /auth/login`
  - [ ] `POST /auth/logout`
  - [ ] `GET /auth/session`
- [ ] Create auth middleware for protected routes
- [ ] Create frontend auth hooks
- [ ] Create login/signup pages
- [ ] Create auth context provider
- [ ] Implement session persistence

---

## Phase 17: Developer Personas

**Purpose:** Enable fast login switching for dev and pre-authenticated E2E tests.

- [ ] Define personas in `packages/shared/personas.ts` (admin, member, viewer, new user)
- [ ] Create `scripts/seed.ts` with persona users and sample data
- [ ] Add `pnpm db:seed` script to root package.json
- [ ] Create dev-only persona page at `apps/web/routes/_dev/personas.tsx`
- [ ] Gate route with `import.meta.env.DEV` for dead code elimination
- [ ] Implement instant login on persona card click
- [ ] Create Playwright auth fixture in `e2e/fixtures/auth.ts`
- [ ] Generate storageState per persona on each CI run
- [ ] Test persona page login flow
- [ ] Test E2E with pre-authenticated personas

---

## Phase 18: Basic Chat UI

**Purpose:** Build the core chat interface (no AI yet).

- [ ] Create chat layout component (sidebar + main area)
- [ ] Create conversation list component
- [ ] Create message list component
- [ ] Create message input component
- [ ] Create empty state component
- [ ] Implement conversation CRUD API:
  - [ ] `GET /conversations`
  - [ ] `POST /conversations`
  - [ ] `GET /conversations/:id`
  - [ ] `DELETE /conversations/:id`
  - [ ] `PATCH /conversations/:id` (rename)
- [ ] Implement message API:
  - [ ] `GET /conversations/:id/messages`
  - [ ] `POST /conversations/:id/messages`
- [ ] Wire up frontend to API
- [ ] Test creating conversations and messages (stored in DB, no AI response)

---

## Phase 19: OpenRouter Integration

**Purpose:** Connect to OpenRouter for LLM access.

**Tech Stack Addition:** OpenRouter API

- [ ] Create `packages/shared/openrouter.ts` types
- [ ] Create OpenRouter client wrapper
- [ ] Implement model metadata fetching from OpenRouter API
- [ ] Cache model list and capabilities
- [ ] Create model selector component
- [ ] Implement basic (non-streaming) chat completion
- [ ] Handle API errors gracefully
- [ ] Display AI responses in chat

**Human Setup Required:**

1. Create OpenRouter account at https://openrouter.ai
2. Generate API key
3. Add to `.env.local` as `OPENROUTER_API_KEY`

---

## Phase 20: Streaming Responses

**Purpose:** Implement Server-Sent Events for streaming LLM responses.

- [ ] Create SSE streaming endpoint `POST /chat/stream`
- [ ] Pipe OpenRouter stream through Hono
- [ ] Create frontend SSE consumer hook
- [ ] Display tokens as they arrive
- [ ] Handle stream interruption gracefully
- [ ] Add stop generation button
- [ ] Save complete message to database when stream ends
- [ ] Test streaming with multiple models

---

## Phase 21: OpenRouter Mocks

**Purpose:** Create mock responses for local development.

- [ ] Create `mocks/openrouter/` directory
- [ ] Create fixture files for different response types:
  - [ ] Simple text response
  - [ ] Code response
  - [ ] Long response
  - [ ] Multi-turn conversation
- [ ] Create mock server/handler for OpenRouter endpoints
- [ ] Configure environment to use mocks in development
- [ ] Ensure mocks return SSE stream format
- [ ] Document how to add new fixtures

---

## Phase 22: Model Switching

**Purpose:** Allow changing models mid-conversation.

**Features:** Model Switching

- [ ] Add `model` field to messages table
- [ ] Create model selector in chat header
- [ ] Store selected model per conversation
- [ ] Allow model override per message
- [ ] Display model badge on each message
- [ ] Handle model capability differences (context length, vision)
- [ ] Block incompatible actions (e.g., image to non-vision model)

---

## Phase 23: Local-Only Mode (PGlite)

**Purpose:** Implement conversations that stay in browser only.

**Features:** Local-Only Mode, Incognito Chat

- [ ] Add `mode` field to conversations (cloud/local)
- [ ] Initialize PGlite in browser
- [ ] Run migrations on PGlite
- [ ] Create mode selector when starting new conversation
- [ ] Route database operations based on mode
- [ ] Visual indicator for local-only conversations
- [ ] Implement incognito mode (local + auto-delete on close)
- [ ] Test data isolation between modes
- [ ] Ensure local data survives page refresh

---

## Phase 24: Conversation Management

**Purpose:** Implement conversation organization features.

**Features:** Chat History, Chat Search, Chat Naming, Chat Pinning, Chat Archive, Message Editing

- [ ] Add `pinned`, `archived`, `title` fields to conversations
- [ ] Implement pin/unpin functionality
- [ ] Implement archive/unarchive functionality
- [ ] Implement conversation rename
- [ ] Implement full-text search on messages
- [ ] Create search UI component
- [ ] Implement message editing
- [ ] Store edit history (original + edited)
- [ ] Update UI to show edited indicator

---

## Phase 25: Conversation Forking

**Purpose:** Allow branching conversations from any point.

**Features:** Conversation Forking

- [ ] Design fork data model (parent reference, branch point)
- [ ] Add `parent_id`, `forked_from_message_id` to conversations
- [ ] Implement fork creation endpoint
- [ ] Create fork button on messages
- [ ] Create fork visualization (tree/branch UI)
- [ ] Navigate between forks
- [ ] Test forking with message history

---

## Phase 26: Document Panel - Basic

**Purpose:** Create the unified document panel structure.

**Features:** Unified Panel, Split-Screen View

- [ ] Create document panel component
- [ ] Implement split-screen layout (resizable)
- [ ] Create document state management
- [ ] Create code editor component (CodeMirror or Monaco)
- [ ] Create markdown editor component
- [ ] Create panel toggle/minimize controls
- [ ] Wire up AI responses to populate panel
- [ ] Implement panel content types (code, markdown, html)

---

## Phase 27: Document Panel - Live Preview

**Purpose:** Add live rendering for HTML/React content.

**Tech Stack Addition:** Sandpack

**Features:** Live Preview, React Rendering, HTML/CSS Preview

- [ ] Install Sandpack
- [ ] Create preview pane component
- [ ] Implement HTML preview mode
- [ ] Implement React/JSX preview mode
- [ ] Implement CSS styling in preview
- [ ] Handle preview errors gracefully
- [ ] Add preview refresh control
- [ ] Support light/dark theme in preview

---

## Phase 28: Document Panel - Versions

**Purpose:** Implement document versioning and history.

**Features:** Version History, Diff View, User Editing, Inline Editing

- [ ] Create document versions table
- [ ] Save version on each AI edit
- [ ] Save version on each user edit
- [ ] Create version history sidebar
- [ ] Implement version restore
- [ ] Implement diff view between versions
- [ ] Implement inline editing (edit selection only)
- [ ] Track edit source (user vs AI)

---

## Phase 29: Context Management

**Purpose:** Implement context awareness features.

**Features:** Context Compacting, Auto Model Selection

- [ ] Calculate and display context usage
- [ ] Create context usage indicator component
- [ ] Implement context compacting prompt
- [ ] Allow manual trigger of compacting
- [ ] Implement auto model selection based on task
- [ ] Create model recommendation logic
- [ ] Display model recommendation UI

---

## Phase 30: Response Features

**Purpose:** Implement response manipulation features.

**Features:** Response Regeneration, Multi-Model Conversations

- [ ] Add regenerate button to messages
- [ ] Implement regenerate endpoint
- [ ] Store regeneration history
- [ ] Allow model selection for regeneration
- [ ] Implement multi-model response (ask same question to multiple models)
- [ ] Create comparison view for multi-model responses

---

## Phase 31: Testing Additions

**Purpose:** Add comprehensive test coverage for all implemented features.

- [ ] Add unit tests for:
  - [ ] Zod schemas
  - [ ] Database queries
  - [ ] Utility functions
  - [ ] React hooks
- [ ] Create E2E tests for:
  - [ ] Authentication flow
  - [ ] Create conversation
  - [ ] Send message (mocked AI)
  - [ ] Model switching
- [ ] Verify coverage remains at 95%

---

## Phase 32: Redis & Rate Limiting

**Purpose:** Add caching and rate limiting infrastructure.

**Tech Stack Addition:** Upstash Redis

**Features:** Rate Limiting

- [ ] Create Upstash account and database
- [ ] Install `@upstash/redis` and `@upstash/ratelimit`
- [ ] Create rate limit middleware
- [ ] Implement rate limits:
  - [ ] Chat messages: 60/minute
  - [ ] API general: 1000/minute
  - [ ] Account creation: 3/day per IP
- [ ] Add rate limit headers to responses
- [ ] Create rate limit error handling UI
- [ ] Cache OpenRouter model metadata in Redis
- [ ] Cache user session data in Redis

**Human Setup Required:**

1. Create Upstash account at https://upstash.com
2. Create Redis database
3. Copy `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` to `.env.local`

---

## Phase 33: Storage Setup

**Purpose:** Add object storage for files.

**Tech Stack Addition:** Cloudflare R2, MinIO

- [ ] Create R2 bucket in Cloudflare dashboard
- [ ] Configure R2 binding in `wrangler.toml`
- [ ] Create storage client wrapper
- [ ] Add MinIO to `docker-compose.yml`
- [ ] Create MinIO initialization script
- [ ] Configure environment to switch R2/MinIO based on env
- [ ] Create storage utility functions:
  - [ ] `uploadFile()`
  - [ ] `getFileUrl()`
  - [ ] `deleteFile()`
- [ ] Test upload/download locally with MinIO
- [ ] Add `files` table to database schema

**Human Setup Required:**

1. Go to Cloudflare Dashboard → R2
2. Create a new bucket named `lome-chat-files`
3. Generate R2 API tokens
4. Add `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to `.env.local`

---

## Phase 34: File Upload - Basic

**Purpose:** Implement basic file upload functionality.

**Features:** File Upload, Multi-File Upload

- [ ] Create file upload endpoint
- [ ] Create file upload UI component
- [ ] Implement drag-and-drop upload
- [ ] Implement multi-file selection
- [ ] Show upload progress
- [ ] Store file metadata in database
- [ ] Link files to conversations
- [ ] Display uploaded files in chat
- [ ] Implement file deletion
- [ ] Add file size limits

---

## Phase 35: File Analysis - Documents

**Purpose:** Analyze uploaded document files.

**Features:** PDF Analysis, Spreadsheet Analysis, Word Document Processing, PowerPoint Analysis, Code File Analysis

- [ ] Install document parsing libraries (pdf-parse, xlsx, mammoth)
- [ ] Create document processing service
- [ ] Implement PDF text extraction
- [ ] Implement Excel/CSV parsing
- [ ] Implement Word document parsing
- [ ] Implement PowerPoint parsing
- [ ] Implement code file syntax detection
- [ ] Send extracted content to AI with context
- [ ] Display document preview in UI

---

## Phase 36: File Analysis - Images

**Purpose:** Analyze uploaded images with vision models.

**Features:** Image Analysis, Visual PDF Processing

- [ ] Detect vision-capable models from OpenRouter
- [ ] Implement image upload to vision models
- [ ] Convert images to base64 for API
- [ ] Implement PDF-as-image processing
- [ ] Display image previews in chat
- [ ] Handle large images (resize/compress)
- [ ] Fall back gracefully for non-vision models

---

## Phase 37: Storage Quota

**Purpose:** Implement dynamic storage limits.

**Features:** Dynamic Storage Quota

- [ ] Calculate user storage usage
- [ ] Implement quota formula: 1GB base + 1GB per $1 fees
- [ ] Add storage tracking to file uploads
- [ ] Create storage usage display
- [ ] Block uploads when quota exceeded
- [ ] Create monthly cleanup job logic (scheduled later)

---

## Phase 38: Compute Setup

**Purpose:** Set up server-side code execution.

**Tech Stack Addition:** Fly.io Machines

- [ ] Create Fly.io account
- [ ] Create `services/sandbox/` directory
- [ ] Create Dockerfile for sandbox environment:
  - [ ] Python 3.11 with NumPy, Pandas, Matplotlib
  - [ ] Node.js 20
  - [ ] Security restrictions (non-root, resource limits)
- [ ] Create execution harness script
- [ ] Deploy sandbox to Fly.io
- [ ] Create sandbox API client
- [ ] Create mock sandbox for local development
- [ ] Test Python execution
- [ ] Test JavaScript execution

**Human Setup Required:**

1. Create Fly.io account at https://fly.io
2. Install flyctl: `curl -L https://fly.io/install.sh | sh`
3. Run `flyctl auth login`
4. Run `flyctl launch` in `services/sandbox/`

---

## Phase 39: Code Execution - Backend

**Purpose:** Implement Python and JavaScript execution.

**Features:** Python Execution, JavaScript Execution

- [ ] Create code execution endpoint
- [ ] Detect language from code or explicit parameter
- [ ] Send code to Fly.io sandbox
- [ ] Stream execution output back to client
- [ ] Handle execution timeouts (30s default)
- [ ] Handle execution errors
- [ ] Return stdout, stderr, and generated files
- [ ] Display execution results in document panel
- [ ] Implement execution history per conversation

---

## Phase 40: Document Creation

**Purpose:** Generate downloadable document files.

**Features:** Word Documents, PDF Documents, Spreadsheets, Presentations

- [ ] Add document generation libraries to sandbox (python-docx, reportlab, openpyxl, python-pptx)
- [ ] Create document generation prompts/templates
- [ ] Implement Word document generation
- [ ] Implement PDF generation
- [ ] Implement Excel generation
- [ ] Implement PowerPoint generation
- [ ] Upload generated files to R2
- [ ] Create download links
- [ ] Display download button in chat

---

## Phase 41: File Handling - Advanced

**Purpose:** Implement remaining file handling features.

**Features:** ZIP Archive Handling, GitHub Repository Import, OCR, Audio Transcription, Video Analysis

- [ ] Implement ZIP extraction and processing
- [ ] Implement GitHub repo clone and analysis
- [ ] Implement OCR using Tesseract in sandbox
- [ ] Implement audio transcription (Whisper or similar)
- [ ] Implement video frame extraction for analysis
- [ ] Add appropriate file type icons

---

## Phase 42: Content Publishing

**Purpose:** Allow publishing documents to public URLs.

**Features:** Content Publishing, Chat Sharing

- [ ] Create `published_documents` table
- [ ] Create `shared_conversations` table
- [ ] Generate unique public URLs
- [ ] Create public document viewer page
- [ ] Create public conversation viewer page
- [ ] Implement publish/unpublish toggle
- [ ] Add Open Graph meta tags for previews
- [ ] Handle access permissions

---

## Phase 43: Payments Setup

**Purpose:** Implement payment processing.

**Tech Stack Addition:** Helcim

- [ ] Create Helcim account (business verification required)
- [ ] Install Helcim SDK
- [ ] Create payment endpoints:
  - [ ] `POST /payments/add-credit`
  - [ ] `GET /payments/history`
- [ ] Create payment webhook handler
- [ ] Create local payment mocks in `mocks/helcim/`
- [ ] Configure environment to use mocks in local development
- [ ] Add `credits`, `transactions` tables
- [ ] Implement credit addition flow
- [ ] Display credit balance in UI
- [ ] Create payment history page

**Human Setup Required:**

1. Create Helcim account at https://helcim.com
2. Complete business verification
3. Generate API tokens
4. Add `HELCIM_API_KEY` to `.env.local`
5. Configure webhook URL in Helcim dashboard

---

## Phase 44: Credit System

**Purpose:** Implement usage tracking and billing.

**Features:** Credit System, New Account Credits

- [ ] Track API usage costs per request
- [ ] Apply 5% fee calculation
- [ ] Deduct credits after each API call
- [ ] Block API calls when credits exhausted
- [ ] Grant $1.00 free credit on account creation
- [ ] Create low balance warning
- [ ] Create usage breakdown view
- [ ] Implement daily spending limits

---

## Phase 45: Backups

**Purpose:** Implement disaster recovery.

**Tech Stack Addition:** Kopia, Backblaze B2

- [ ] Create Backblaze B2 account
- [ ] Create backup bucket
- [ ] Create `.github/workflows/backup.yml`
- [ ] Implement database backup with pg_dump
- [ ] Implement R2 backup with rclone
- [ ] Configure Kopia repository
- [ ] Set retention policy
- [ ] Add backup verification step
- [ ] Test restore procedure
- [ ] Document disaster recovery process

**Human Setup Required:**

1. Create Backblaze B2 account at https://backblaze.com
2. Create bucket for backups
3. Generate application key
4. Add secrets to GitHub:
   - `B2_ACCOUNT_ID`
   - `B2_ACCOUNT_KEY`
   - `B2_BUCKET`
   - `KOPIA_REPOSITORY_PASSWORD`

---

## Phase 46: Observability - Error Tracking

**Purpose:** Add error tracking and monitoring.

**Tech Stack Addition:** Sentry

- [ ] Create Sentry account and project
- [ ] Install Sentry SDK for React
- [ ] Install Sentry SDK for Cloudflare Workers
- [ ] Configure source maps upload
- [ ] Add error boundaries to React app
- [ ] Test error capture
- [ ] Create error alerting rules

**Human Setup Required:**

1. Create Sentry account at https://sentry.io
2. Create new project for React
3. Create new project for Node/Edge
4. Add `SENTRY_DSN` to `.env.local`

---

## Phase 47: Observability - Analytics

**Purpose:** Add product analytics and feature flags.

**Tech Stack Addition:** PostHog

**Features:** Account Analytics, Feature Flags

- [ ] Create PostHog account
- [ ] Install PostHog SDK
- [ ] Configure PostHog provider
- [ ] Implement event tracking:
  - [ ] Page views
  - [ ] Conversation created
  - [ ] Message sent
  - [ ] Model switched
  - [ ] File uploaded
- [ ] Set up feature flags
- [ ] Create analytics dashboard
- [ ] Implement feature flag checks in code

**Human Setup Required:**

1. Create PostHog account at https://posthog.com
2. Create new project
3. Add `POSTHOG_KEY` to `.env.local`

---

## Phase 48: Observability - Logs

**Purpose:** Add structured logging.

**Tech Stack Addition:** Axiom

- [ ] Create Axiom account
- [ ] Install Axiom SDK
- [ ] Create logging utility
- [ ] Add structured logs to:
  - [ ] API requests
  - [ ] Database operations
  - [ ] External API calls
  - [ ] Error events
- [ ] Configure log retention
- [ ] Create log queries for debugging

**Human Setup Required:**

1. Create Axiom account at https://axiom.co
2. Create dataset
3. Add `AXIOM_TOKEN` and `AXIOM_DATASET` to `.env.local`

---

## Phase 49: Memory System

**Purpose:** Implement cross-session memory.

**Features:** Cross-Session Memory, Automatic Memory Learning, Explicit Memory Commands, Memory Management, Project-Scoped Memory

- [ ] Create `memories` table with user/project scope
- [ ] Create memory extraction prompts
- [ ] Implement memory save/retrieve API
- [ ] Implement "remember this" command detection
- [ ] Implement "forget this" command detection
- [ ] Create memory management UI
- [ ] Include relevant memories in chat context
- [ ] Implement project-scoped memories
- [ ] Add memory usage limits

---

## Phase 50: Custom Instructions

**Purpose:** Allow persistent user preferences.

**Features:** Custom Instructions, Per-Project Instructions, Preset Styles

- [ ] Add `custom_instructions` field to users table
- [ ] Add `instructions` field to projects table
- [ ] Create instructions editor UI
- [ ] Inject instructions into system prompt
- [ ] Create preset style options
- [ ] Allow style selection per conversation
- [ ] Implement Writing Style Learning (with file upload)

---

## Phase 51: Projects - Basic

**Purpose:** Implement project organization.

**Features:** Projects, Spaces

- [ ] Create projects UI (list, create, edit, delete)
- [ ] Associate conversations with projects
- [ ] Filter conversations by project
- [ ] Create project settings page
- [ ] Implement Spaces (project groups)
- [ ] Create navigation between spaces/projects

---

## Phase 52: Projects - Files & Knowledge

**Purpose:** Add project file storage and knowledge base.

**Features:** Project File Storage, Project Knowledge Base

- [ ] Create project files storage
- [ ] Upload files to projects (not conversations)
- [ ] Create knowledge base configuration
- [ ] Index project files for context
- [ ] Include project knowledge in chat context
- [ ] Display project files in sidebar
- [ ] Implement file organization (folders)

---

## Phase 53: Projects - Sharing

**Purpose:** Allow sharing projects with others.

**Features:** Project Sharing, Project Permissions

- [ ] Create project sharing UI
- [ ] Generate share links
- [ ] Implement permission levels (view/edit)
- [ ] Create shared project acceptance flow
- [ ] Display shared indicator
- [ ] Handle permission checks on all project operations

---

## Phase 54: Web Search

**Purpose:** Implement web search capabilities.

**Features:** Real-Time Web Search, Auto-Triggered Search, Inline Citations, Source Panel, Search Focus Modes, Site-Restricted Search

- [ ] Choose and integrate search API (Tavily, Serper, or similar)
- [ ] Create search tool for AI
- [ ] Implement auto-search detection
- [ ] Parse and display citations
- [ ] Create source panel component
- [ ] Implement search focus modes
- [ ] Implement site restriction option
- [ ] Cache search results

**Human Setup Required:**

1. Create account with search provider
2. Generate API key
3. Add to `.env.local`

---

## Phase 55: Research Mode

**Purpose:** Implement deep research capabilities.

**Features:** Deep Research Mode, Research Plan Display

- [ ] Create research orchestration logic
- [ ] Implement research plan generation
- [ ] Display research plan before execution
- [ ] Execute multi-step research
- [ ] Aggregate and synthesize findings
- [ ] Generate research report
- [ ] Track research progress
- [ ] Allow research cancellation

---

## Phase 56: Reasoning Features

**Purpose:** Expose model reasoning capabilities.

**Features:** Extended Thinking, Visible Reasoning, Thinking Summaries, Thinking Budget, Reasoning Toggle

- [ ] Detect models with reasoning capabilities (o1, Claude thinking)
- [ ] Create reasoning mode toggle
- [ ] Implement thinking budget selector
- [ ] Display reasoning tokens when available
- [ ] Create thinking summary generation
- [ ] Style reasoning display differently from response

---

## Phase 57: Custom Bots - Basic

**Purpose:** Allow creating custom AI assistants.

**Features:** Bot Creation, Bot Builder

- [ ] Create `bots` table
- [ ] Create bot builder UI
- [ ] Implement bot configuration:
  - [ ] Name and description
  - [ ] System prompt
  - [ ] Default model
  - [ ] Temperature and parameters
- [ ] Create bot selection in chat
- [ ] Apply bot config to conversations
- [ ] Create bot management page

---

## Phase 58: Custom Bots - Advanced

**Purpose:** Add knowledge and actions to bots.

**Features:** Bot Knowledge Base, Custom Actions, Bot Marketplace, Bot Monetization

- [ ] Implement bot-specific file uploads
- [ ] Create custom action configuration
- [ ] Implement action execution
- [ ] Create public bot directory
- [ ] Implement bot publishing
- [ ] Create bot usage tracking
- [ ] Implement creator earnings (with Helcim payouts)

---

## Phase 59: Integrations - MCP

**Purpose:** Implement Model Context Protocol support.

**Features:** MCP Support, Custom MCP Connectors, Connector Directory

- [ ] Study MCP specification
- [ ] Implement MCP client
- [ ] Create connector configuration UI
- [ ] Build sample connectors:
  - [ ] File system
  - [ ] Database
  - [ ] API
- [ ] Create connector directory
- [ ] Document connector creation

---

## Phase 60: Integrations - Webhooks

**Purpose:** Allow external integrations via webhooks.

**Features:** Webhooks, Google Workspace Access

- [ ] Create `webhooks` table
- [ ] Create webhook configuration UI
- [ ] Implement webhook trigger system
- [ ] Support webhook events:
  - [ ] Message received
  - [ ] Conversation created
  - [ ] Project updated
- [ ] Implement webhook signing
- [ ] Add Google OAuth for Workspace access
- [ ] Implement Google Docs/Sheets/Slides reading

---

## Phase 61: Quick Analytics

**Purpose:** Implement in-chat analytics.

**Features:** Quick Analytics Panel

- [ ] Create analytics panel component
- [ ] Calculate conversation cost
- [ ] Display context usage
- [ ] Show message counts
- [ ] Show model usage breakdown
- [ ] Display token counts
- [ ] Make panel toggleable

---

## Phase 62: Teams - Basic

**Purpose:** Implement team functionality.

**Features:** Team Plans, Shared Workspaces, Roles & Permissions, Admin Console

- [ ] Create `teams`, `team_members` tables
- [ ] Create team creation flow
- [ ] Implement team invitations
- [ ] Create role system (admin, member, viewer)
- [ ] Create admin console UI
- [ ] Implement team billing (shared credits)
- [ ] Create team workspace view
- [ ] Filter team conversations/projects

---

## Phase 63: Teams - Advanced

**Purpose:** Add enterprise team features.

**Features:** Team Analytics, Group Chats, SSO/SAML

- [ ] Implement team usage analytics
- [ ] Create team analytics dashboard
- [ ] Implement group chat (multiple users in one conversation)
- [ ] Add SAML/SSO configuration to Better Auth
- [ ] Create SSO setup UI
- [ ] Test with common providers (Okta, Azure AD)

---

## Phase 64: Privacy Features

**Purpose:** Implement privacy and compliance features.

**Features:** Custom Data Retention, Audit Logs

- [ ] Add retention settings to user preferences
- [ ] Implement automatic data deletion job
- [ ] Create `audit_logs` table
- [ ] Log security-relevant events:
  - [ ] Login/logout
  - [ ] Settings changes
  - [ ] Data access
  - [ ] Admin actions
- [ ] Create audit log viewer (admin)

---

## Phase 65: Marketing Site

**Purpose:** Create public marketing website.

**Tech Stack Addition:** Astro

- [ ] Create `apps/marketing/` with Astro
- [ ] Create pages:
  - [ ] Home/landing
  - [ ] Features
  - [ ] Pricing
  - [ ] About
  - [ ] Privacy policy
  - [ ] Terms of service
- [ ] Configure Tailwind (share with main app)
- [ ] Add SEO meta tags
- [ ] Create OpenGraph images
- [ ] Configure deployment alongside main app

---

## Phase 66: Mobile App

**Purpose:** Create native mobile applications.

**Tech Stack Addition:** Capacitor

- [ ] Create `apps/mobile/` package
- [ ] Install Capacitor
- [ ] Configure Capacitor for iOS and Android
- [ ] Adapt responsive design for mobile
- [ ] Implement native features:
  - [ ] Push notifications
  - [ ] Camera access (for image upload)
  - [ ] Share extension
- [ ] Test on iOS simulator
- [ ] Test on Android emulator
- [ ] Create app store assets

**Human Setup Required:**

1. Install Xcode for iOS development
2. Install Android Studio for Android development
3. Create Apple Developer account for iOS distribution
4. Create Google Play Developer account for Android distribution

---

## Phase 67: CI/CD - Advanced Testing

**Purpose:** Add comprehensive CI testing including real API tests.

- [ ] Add E2E tests to CI (with mocks)
- [ ] Configure Turborepo remote caching
- [ ] Create "pr test" comment trigger for real API tests
- [ ] Add CLA bot workflow
- [ ] Add integration tests for payment flows (Helcim Sandbox)

**Human Setup Required:**

1. Add repository secrets in GitHub Settings:
   - `TURBO_TOKEN` (for remote caching)
   - `TURBO_TEAM`
   - `HELCIM_SANDBOX_API_KEY` (for payment flow tests)
   - Test API keys for CI

---

## Phase 68: CI/CD - Deployment

**Purpose:** Implement continuous deployment.

- [ ] Create `.github/workflows/deploy.yml`
- [ ] Configure deployment triggers (merge to main)
- [ ] Add Cloudflare Pages deployment
- [ ] Add Cloudflare Workers deployment
- [ ] Configure environment-specific deploys:
  - [ ] Preview (PR)
  - [ ] Staging (develop branch)
  - [ ] Production (main branch)
- [ ] Add deployment notifications
- [ ] Create rollback procedure

**Human Setup Required:**

1. Add repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - Production API keys

---

## Phase 69: Storage Cleanup Job

**Purpose:** Implement scheduled maintenance tasks.

- [ ] Create cleanup workflow on schedule (monthly)
- [ ] Implement storage quota enforcement
- [ ] Delete data exceeding retention policies
- [ ] Clean up orphaned files in R2
- [ ] Generate cleanup reports
- [ ] Send notifications for affected users

---

## Phase 70: Performance Optimization

**Purpose:** Optimize application performance.

- [ ] Implement lazy loading for routes
- [ ] Add virtual scrolling for long message lists
- [ ] Implement optimistic UI updates
- [ ] Load test critical endpoints (chat, auth)
- [ ] Address any bottlenecks found in load testing

---

## Phase 71: Final Polish

**Purpose:** Complete remaining features and refinements.

- [ ] Accessibility audit and fixes
- [ ] Cross-browser testing
- [ ] Mobile responsiveness review
- [ ] Error message review
- [ ] Loading state review
- [ ] Empty state review
- [ ] Documentation review
- [ ] Security audit
- [ ] Legal review (privacy policy, terms)
- [ ] Launch checklist completion

---

## Phase 72: Together AI Privacy Models

**Purpose:** Offer verifiable private AI option via Together AI with zero-retention.

**Tech Stack Addition:** Together AI API

- [ ] Create Together AI enterprise account
- [ ] Negotiate enterprise agreement with contractual no-logging
- [ ] Obtain DPA (Data Processing Agreement)
- [ ] Implement Together AI client wrapper
- [ ] Configure zero-retention in Together AI settings
- [ ] Add "Privacy Model" option in model selector
- [ ] Route privacy model requests to Together AI instead of OpenRouter
- [ ] Create privacy model documentation for users
- [ ] Display clear indicator when using Privacy Models
- [ ] Same 5% fee structure on Together AI costs

**Human Setup Required:**

1. Create Together AI account at https://together.ai
2. Contact sales for enterprise agreement
3. Complete DPA signing
4. Add `TOGETHER_API_KEY` to production secrets
5. Configure zero-retention in Together AI dashboard (Settings > Profile)

---

## Phase 73: Self-Hosted Privacy LLM

**Purpose:** Maximum privacy option with infrastructure we fully control.

**Note:** Future consideration, not immediate priority.

- [ ] Evaluate GPU cloud providers (Lambda Labs, CoreWeave)
- [ ] Select open-source model (Llama, Mistral, Qwen)
- [ ] Design isolated compute environment
- [ ] Deploy inference stack (vLLM or TGI)
- [ ] Implement verifiable no-logging architecture
- [ ] Add "Maximum Privacy Model" option in model selector

---

## Appendix: Phase Dependencies

```
Phase 1-2: Foundation (no dependencies)
    ↓
Phase 3: Testing Infrastructure (depends on 2)
    ↓
Phase 4-6: Data layer (depends on 2-3)
    ↓
Phase 7: Test Factories (depends on 5-6, enables TDD for all subsequent phases)
    ↓
Phase 8-10: Frontend core (depends on 4-7)
    ↓
Phase 11: Backend core (depends on 4-7)
    ↓
Phase 12-13: Early Deploy + CI (depends on 11)
    ↓
Phase 14-15: Dev Environment (depends on 11)
    ↓
Phase 16: Auth (depends on 8-15)
    ↓
Phase 17: Developer Personas (depends on 16, enables fast E2E testing)
    ↓
Phase 18-21: Basic chat (depends on 16-17)
    ↓
Phase 22-30: Chat features (depends on 18-21)
    ↓
Phase 31: Testing additions (can parallel with 22+)
    ↓
Phase 32: Redis (depends on 11-15)
    ↓
Phase 33-37: Storage (depends on 11-15, 32)
    ↓
Phase 38-41: Compute (depends on 33-37)
    ↓
Phase 42: Publishing (depends on 33-37)
    ↓
Phase 43-44: Payments (depends on 16)
    ↓
Phase 45: Backups (depends on 43-44)
    ↓
Phase 46-48: Observability (can start after 11)
    ↓
Phase 49-53: Memory/Projects (depends on 16, 33-37)
    ↓
Phase 54-56: Search/Research/Reasoning (depends on 19-21)
    ↓
Phase 57-60: Bots/Integrations (depends on 49-53)
    ↓
Phase 61: Quick Analytics (depends on 18-21)
    ↓
Phase 62-64: Teams/Privacy (depends on 43-44)
    ↓
Phase 65-66: Marketing/Mobile (depends on 8-10)
    ↓
Phase 67-69: DevOps (depends on all above)
    ↓
Phase 70-71: Polish (depends on all above)
    ↓
Phase 72-73: Privacy LLM (depends on all above)
```
