# Spec family: platform-contracts

**v2 owner:** `platform` (app-level cross-cutting routes in `apps/api`: health, roadmap
proxy, dev-only routes, version-check, rate-limit registry) plus the e2e determinism
contracts the suite itself depends on. The LWW accessibility-preference merge lives here
too (v2 owner: `account` slice) because §19 names it as integration-test-sourced spec.

## e2e behaviors

### `e2e/api/health.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| `GET /api/health` returns 200 with status ok | `GET /api/health returns 200 with status ok` | platform |

### `e2e/contracts/config.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| The E2E build runs in UTC timezone and en-US locale (determinism contract) | `the page runs in the configured UTC timezone and en-US locale` | platform (e2e harness contract) |

### `e2e/contracts/motion-off.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| The E2E build forces reduced motion app-wide (determinism + a11y contract) | `the E2E build forces reduced-motion app-wide` | platform (e2e harness contract) |

### `e2e/contracts/signals.spec.ts` (titles Verified — the app-emitted state-signal seam)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Page-load signals render on the new-chat page | `page-load signals render on the new-chat page` | platform |
| Conversation signals render on a seeded conversation | `conversation signals render on a seeded conversation` | platform |
| Stream signals render and advance when a turn completes | `stream signals render and advance when a turn completes` | platform |
| WebSocket signals render on a group conversation | `websocket signals render on a group conversation` | platform |
| Roadmap-ready signal renders on the public roadmap | `roadmap-ready signal renders on the public roadmap` | platform |

These signals (`packages/shared/src/test-signals.ts`) are the determinism backbone of
the whole suite; v2 must keep emitting them or Phase-4 re-pointing fails wholesale.

### `e2e/ui/personas.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| `/dev/personas` page loads with all persona cards (dev-only route the suite logs in through) | `/dev/personas page loads with all persona cards` | platform (dev-only routes) |

### `e2e/marketing-roadmap.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Public roadmap renders, filters work, reachable from landing nav (Linear-backed proxy with 1 h Redis + 5 min CDN caching — `apps/api/src/lib/redis-registry.ts:191-201,341-346`) | `renders, filters, and is reachable from landing nav` | platform |

## The `x-mock-*` seam (named member of this family per §19)

Full capture in `grounding-deltas.md` (c). Server: `aiClientMiddleware`,
`apps/api/src/middleware/dependencies.ts:143-181`. Headers:
`x-mock-classifier-resolution`, `x-mock-classifier-failure`, `x-mock-failing-models`,
`x-mock-classifier-delay-ms`. Dev/E2E only; production ignores at the env fork.

## Integration behaviors

### LWW merge — `apps/api/src/routes/user-preferences.test.ts` (titles Verified; §19 names this explicitly)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| GET returns defaults for a fresh user; 404 `USER_NOT_FOUND` for a deleted user's live session | `returns defaults for a fresh user`, `returns 404 USER_NOT_FOUND when the session points at a deleted user` | account |
| PUT updates only when the client timestamp is **newer** than the DB's | `updates preferences when client timestamp is newer than DB` | account |
| PUT with an **older** timestamp does not update and returns `accepted=false` (no error) | `does NOT update when client timestamp is older than DB (returns accepted=false)` | account |
| Body validation: Zod-invalid, missing `updatedAt`, non-ISO `updatedAt` all rejected | `rejects request body that fails Zod validation`, `rejects body with missing updatedAt`, `rejects body with non-ISO updatedAt` | account |
| PUT-then-GET round-trips the value | `PUT then GET returns the put value` | account |
| **Replaying the same timestamp is accepted (LWW uses `<=`) — idempotent replay** | `PUT with same timestamp twice — LWW <= condition still accepts the replay (idempotent)` | account |

### Platform middleware & infrastructure (file-level sources; titles not captured — read at port time)

| Behavior area | Source | v2 slice |
| --- | --- | --- |
| Version-check middleware + exemption list | `apps/api/src/middleware/version-check.test.ts`, `apps/api/src/lib/version-override.test.ts` | platform |
| CSRF, CORS, security headers, request logging | `apps/api/src/middleware/csrf.test.ts`, `cors.test.ts`, `security.test.ts`, `request-log.test.ts` | platform |
| Dev-only route gating | `apps/api/src/middleware/dev-only.test.ts`, `apps/api/src/routes/dev.test.ts` | platform |
| Error envelope (`{code, details?}`) and error middleware | `apps/api/src/lib/error-response.test.ts`, `apps/api/src/middleware/error.test.ts`, `packages/shared/src/schemas/api/error.test.ts`, `packages/shared/src/error-messages.test.ts` | platform / shared |
| Redis key registry typing + TTLs | `apps/api/src/lib/redis-registry.test.ts`, `apps/api/src/lib/redis.test.ts` | platform |
| Rate-limit algorithm + per-route wiring | `apps/api/src/lib/rate-limit.test.ts`, `apps/api/src/middleware/rate-limit.test.ts`, `apps/api/src/middleware/rate-limit.routes.test.ts` | platform |
| App-update/download routes | `apps/api/src/routes/updates.test.ts` | platform |
| Roadmap proxy pipeline (Linear → normalize → cache) | `apps/api/src/services/roadmap/normalize.test.ts`, `pipeline.test.ts`, `cache.test.ts` | platform |
| Models catalog route + processed catalog | `apps/api/src/routes/models.test.ts`, `apps/api/src/lib/processed-catalog.test.ts` | models |
| Scheduled (cron) handlers | `apps/api/src/scheduled.test.ts`, `apps/api/src/scheduled.integration.test.ts` | platform |
| Device tokens (push) | `apps/api/src/routes/device-tokens.test.ts` | notifications |
| CI service-evidence recording (`verify:evidence` depends on it) | `apps/api/src/lib/evidence-config.test.ts`, `packages/db/src/evidence.ts` | billing (webhooks) / platform |
