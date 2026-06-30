# The `projects` feature — full surface (to be removed in v2)

The projects feature is a half-shipped, feature-flagged grouping mechanism for
conversations. It is **disabled in production UI** (`PROJECTS_ENABLED: false`) and has
**no API routes** — its surface is a DB table, an FK + factory + zod schemas, a route
constant, a stub page, a flag-gated sidebar link, and a marketing "Coming Soon" card.
v2 removes all of it. Every location below is **Verified** (read this session).

## Marketing entry

- `packages/shared/src/features.ts:105` — `{ id: 'projects', name: 'Projects', emoji: '📁', lucideIcon: 'FolderOpen' }` inside `COMING_SOON_FEATURES` (declared at `features.ts:103`).
- `apps/marketing/src/pages/welcome.astro:6` imports `COMING_SOON_FEATURES`; `welcome.astro:270` renders the list (under the "Coming Soon" heading at `:267`). Removing the registry entry removes the marketing card.
- Note: `apps/marketing/src/components/roadmap/ProjectCard.tsx` is **unrelated** — it renders Linear roadmap projects, not this feature. Do not delete it.

## Route constant

- `packages/shared/src/routes.ts:13` — `PROJECTS: '/projects'` in the `ROUTES` map.

## Web app surface

- `apps/web/src/routes/_app/projects.tsx` — auth-gated stub page (`createFileRoute('/_app/projects')`, renders the literal text `Projects`).
- `apps/web/src/components/sidebar/projects-link.tsx:13` — `ProjectsLink` linking to `ROUTES.PROJECTS` with `TEST_IDS.projectsLink` / `TEST_IDS.folderIcon`.
- `apps/web/src/components/sidebar/sidebar-content.tsx:274` — render gated on `FEATURE_FLAGS.PROJECTS_ENABLED`.
- `packages/shared/src/constants.ts:222-231` — the `PROJECTS_ENABLED` flag, currently `false` ("disabled pending feature completion").
- Colocated tests: `apps/web/src/components/sidebar/projects-link.test.tsx` (plus sidebar tests referencing the link).

## Database surface

- `packages/db/src/schema/projects.ts:7-22` — the `projects` table: `id` (uuidv7), `userId` FK → `users.id` `onDelete: 'cascade'`, `encryptedName` (bytea, not null), `encryptedDescription` (bytea, nullable), timestamps, `projects_user_id_idx`.
- `packages/db/src/schema/index.ts:5` — `export { projects } from './projects'`.
- `packages/db/src/schema/conversations.ts:18` — `conversations.projectId`: `text('project_id').references(() => projects.id, { onDelete: 'set null' })`.
- `packages/db/src/zod/index.ts:97-104` — `selectProjectSchema` / `insertProjectSchema` (bytea overrides for the encrypted columns).
- `packages/db/src/factories/conversation.ts:13` — conversation factory sets `projectId: null`.
- `packages/db/src/zod/index.ts:175` — `Conversation = typeof conversations.$inferSelect` therefore carries `projectId` into every consumer of the type.

## API surface

There are **no** `/projects` API routes (Verified: no `projects` file under
`apps/api/src/routes/`). The feature's API footprint is the `projectId` column riding
through the conversations service:

- `apps/api/src/services/conversations/conversations.ts:133` — `rowToConversation` maps `project_id` → `projectId` (raw-SQL row shape declared with `project_id: string | null` at `:115` region).
- `apps/api/src/services/conversations/conversations.ts:203` — list query selects `conversations.projectId`.
- `apps/api/src/services/conversations/conversations.ts:241` — list result rows include `projectId`.

**Important delta vs. the task brief's assumption:** the **public HTTP response does NOT
include `projectId`**. `serializeConversation` (`apps/api/src/routes/conversations.ts:37-48`)
omits it, and `conversationResponseSchema`
(`packages/shared/src/schemas/api/conversations.ts:172-181`) has no `projectId` field.
The field exists only on the internal service/DB types. So removing the feature changes
no wire contract for conversations — only the DB schema (migration dropping
`projects` + `conversations.project_id`), the internal types, the factory, the zod
schemas, the route constant, the web stub/flag, and the marketing card.

## Deletion-cascade coupling

Account deletion currently cascades projects: the integration test
`apps/api/src/services/account-deletion/delete-user.integration.test.ts:328`
("cascades owned conversations, projects, device tokens; …") encodes that owned
`projects` rows die with the user. The v2 deletion task must drop this expectation
together with the table.

## What the feature "did"

Inferred from the surface above (no other behavior exists in code): a per-user grouping
of conversations — encrypted name/description rows owned by a user, with conversations
optionally pointing at one via `projectId` (SET NULL on project deletion), surfaced as a
flagged-off sidebar link and a stub page. No create/read/update/delete endpoints were
ever built.
