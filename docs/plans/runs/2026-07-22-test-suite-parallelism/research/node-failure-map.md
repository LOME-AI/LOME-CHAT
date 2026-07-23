# Node-package failure map — Option A clean run (`full-suite-optionA.log`, 9m58s)

Config state: `sequence.concurrent:true` GLOBAL for node pkgs; frontend on `browserConfig` (concurrent:false).
`maxConcurrency:12`, `testTimeout:15000`, `retry:1`. Full-box run (turbo all pkgs at once).

In-flight feature work in tree (DO NOT attribute our concurrency change to these — separate reasoning-effort work):
`apps/api/.../language-adapter.integration.test.ts`, `.../wire-params.test.ts`,
`.../smart-model-execution.test.ts`, `.../template-html.test.ts.snap`, and many `apps/web/...` test files.
NOTE: the failing api files below mostly DO NOT overlap this set.

## Cluster 1 — SLOW (timeout / contention). Long durations ⇒ box-saturation + intra-file CPU/IO contention.
```
api  identity/routes.integration.test.ts        145/158 failed   480208ms  <-- the pole
api  chat/routes.integration.test.ts             25/184 failed   150046ms
api  platform/dev/routes.integration.test.ts     10/62  failed    51875ms
api  newsletter/routes.integration.test.ts        3/59  failed    45046ms
api  app-deletion.integration.test.ts             2/2   failed    40646ms
api  identity/credentials.integration.test.ts     7/7   failed    38054ms
api  models/list-descriptors.integration.test.ts 11/13  failed    37898ms
api  models/refresh.integration.test.ts          11/25  failed    35954ms
api  mint-admin-targets.integration.test.ts       3/6   failed    35644ms
api  app-auth-rate-limit.integration.test.ts      1/7   failed    32592ms
api  chat/smart-model-turn.integration.test.ts    4/5   failed    27736ms  (feature-adjacent? verify)
api  models/catalog-store.integration.test.ts    10/13  failed    21448ms
api  models/admin-disabled.integration.test.ts    7/11  failed    20177ms
api  models/pricing-resolver.integration.test.ts  3/3   failed    20031ms
api  models/routes.integration.test.ts            2/5   failed    20051ms
api  mock-provider.test.ts                         1/65  failed    15095ms
crypto envelope.test.ts                            7/21  failed   101553ms
crypto compression.test.ts                         6/10  failed    95882ms
crypto chunked.test.ts                             5/24  failed    82875ms
crypto opaque-step-up.test.ts                      4/5   failed    63269ms
crypto opaque-server.test.ts                       6/19  failed    57032ms
db   schema/schema.integration.test.ts           10/45  failed    28917ms
```
Hypothesis: concurrency-induced. crypto is CPU-bound (argon2id/OPAQUE) → gains nothing from concurrency,
same category as frontend. Candidate fix: extend the non-concurrent preset to CPU-bound node pkgs (crypto),
and/or raise testTimeout, and/or make heavy api integration files non-concurrent, and/or verify worker-budget
actually caps aggregate workers under full-box load. OUR domain.

## Cluster 2 — FAST (assertion, <1.5s mostly). NOT timeouts ⇒ real assertion failures. Attribution UNKNOWN.
```
api  lib/resilience/policies.test.ts             12/13  failed      226ms
api  platform/roadmap/linear-real.test.ts         5/7   failed      143ms
api  notifications/push-fcm.test.ts               4/22  failed      328ms
api  workflows/engine/live-run.test.ts            3/7   failed      470ms
api  cassette/recording-fetch.test.ts             6/15  failed     2257ms
api  cassette-store.test.ts                        1/10  failed      121ms
api  template-html.test.ts                         1/7   failed      380ms  (snapshot IS git-modified — feature work)
api  identity/billing-portal.integration.test.ts  2/11  failed     1462ms
api  admin/engine.integration.test.ts             1/50  failed     6722ms
api  admin/banner.integration.test.ts            16/29  failed    12232ms
api  media/gc.integration.test.ts                10/18  failed     4762ms
api  announcements/routes.integration.test.ts     2/11  failed    13487ms
api  lib/jobs/pass.integration.test.ts           26/26  failed     9438ms  <-- ALL failed (setup/beforeAll?)
config eslint-extensions/load-extensions.test.mjs  5/10  failed      85ms
db   evidence.integration.test.ts                 3/13  failed      710ms
db   client.integration.test.ts                   1/5   failed     2168ms
db   schema/admin-plane.integration.test.ts       5/14  failed     7572ms
crypto totp.test.ts                               1/28  failed      429ms
realtime room-core.test.ts                        1/135 failed      156ms
shared live-catalog-fetch.test.ts                 6/15  failed       48ms
```
Question: shared root cause (concurrency global-state pollution / order-dependence) vs independent
(feature-work / pre-existing)? Scattered fast-fails across unrelated packages = classic concurrency
cross-talk signature OR a shared broken dependency. MUST be diagnosed, not guessed.

## Separate: web exits non-zero but 5994/5994 tests PASS — unhandled async ECONNREFUSED (:8787 wrangler,
## :3000 vite) + Helcim JS-load DOMException. Not a test failure; likely pre-existing flake. Low priority.
