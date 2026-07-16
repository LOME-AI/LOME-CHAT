/**
 * The two dev actors the API's dev-mode `ADMIN_ACTOR_ALLOWLIST` admits
 * (packages/shared/src/env.config.ts — dev/E2E modes carry the literal
 * `admin@hushbox.test,ops@hushbox.test`). Mirrors the admin SPA's own
 * `DEV_ADMIN_ACTORS` (apps/admin/src/lib/dev-actor.ts): the SPA's actor
 * switcher toggles between the same two identities, so API-level specs and
 * browser flows exercise one actor pool.
 */
export const DEV_ADMIN_ACTORS = ['admin@hushbox.test', 'ops@hushbox.test'] as const;

export type DevAdminActor = (typeof DEV_ADMIN_ACTORS)[number];
