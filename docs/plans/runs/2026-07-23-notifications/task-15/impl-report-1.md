# Task 15 — Env-schema test fixtures (run regression) — impl report 1

## Objective

Update `packages/shared/src/env.config.test.ts`'s `backendEnvSchema` fixtures so they
satisfy the schema as changed by this run (Task 04 added `NOTIFICATION_TAG_SECRET` as a
required backend var), without weakening the schema. `pnpm test:shared` green.

## Red BEFORE the change (verified)

`pnpm test:watch packages/shared/src/env.config.test.ts` →
`Tests  4 failed | 101 passed (105)`, exactly the four the brief named:

```
FAIL  |shared| src/env.config.test.ts > backendEnvSchema > validates correct development environment
FAIL  |shared| src/env.config.test.ts > backendEnvSchema > validates correct production environment
FAIL  |shared| src/env.config.test.ts > backendEnvSchema > accepts R2 media storage vars when provided
FAIL  |shared| src/env.config.test.ts > backendEnvSchema > allows CI/prod secrets to be optional
```

Each failure is `AssertionError: expected false to be true` on `result.success`
(lines 570, 593, 616, 684 pre-change) — i.e. `safeParse` rejecting the fixture, the
diagnosed cause.

## Files changed

- `packages/shared/src/env.config.test.ts` — added the now-required
  `NOTIFICATION_TAG_SECRET` to the four positive `backendEnvSchema` fixtures. No other
  file touched.

## Exact fixture diff

```diff
@@ -565,6 +565,7 @@ describe('backendEnvSchema', () => {
       UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
       OPAQUE_MASTER_SECRET: 'dev-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
       IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
+      NOTIFICATION_TAG_SECRET: 'dev-notification-tag-hmac-key', // gitleaks:allow
     };

@@ -587,6 +588,7 @@ describe('backendEnvSchema', () => {
       UPSTASH_REDIS_REST_TOKEN: 'prod_token_value',
       OPAQUE_MASTER_SECRET: 'prod-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
       IRON_SESSION_SECRET: 'prod-iron-session-secret-32-bytes-min', // gitleaks:allow
+      NOTIFICATION_TAG_SECRET: 'prod-notification-tag-hmac-key', // gitleaks:allow
     };

@@ -606,6 +608,7 @@ describe('backendEnvSchema', () => {
       UPSTASH_REDIS_REST_TOKEN: 'prod_token_value',
       OPAQUE_MASTER_SECRET: 'prod-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
       IRON_SESSION_SECRET: 'prod-iron-session-secret-32-bytes-min', // gitleaks:allow
+      NOTIFICATION_TAG_SECRET: 'prod-notification-tag-hmac-key', // gitleaks:allow
       R2_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',

@@ -677,6 +680,8 @@ describe('backendEnvSchema', () => {
       OPAQUE_MASTER_SECRET: 'dev-opaque-master-secret-32-bytes-minimum', // gitleaks:allow
       IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
+      // Required in every mode, so it stays even here (see the schema comment).
+      NOTIFICATION_TAG_SECRET: 'dev-notification-tag-hmac-key', // gitleaks:allow
       // CI/prod secrets are omitted - test they're optional
     };
```

The one added comment exists because a reader of the "allows CI/prod secrets to be
optional" fixture would otherwise wonder why a `*_SECRET` key is present in a fixture
whose stated point is omitting secrets. It states a durable fact (the var is required in
every mode) and carries no task/plan ID (G11).

## Schema byte-unchanged (verified)

`git diff -- packages/shared/src/env.config.ts` contains only `+` lines from Task 04;
there is no `-` line and no line of mine. The required-ness and the VAPID optionality
are exactly as Task 04 landed them:

```
+  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
+  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
+  VAPID_SUBJECT: z.string().min(1).optional(),
+  NOTIFICATION_TAG_SECRET: z.string().min(1),
+  VITE_VAPID_PUBLIC_KEY: z.string().min(1).optional(),
```

No `.optional()`, no `.default()`, no relaxation of any kind was added.

## Other vars added by this run — checked

The run added five env vars. Only `NOTIFICATION_TAG_SECRET` is non-optional; the VAPID
trio (`backendEnvSchema`) and `VITE_VAPID_PUBLIC_KEY` (`frontendEnvSchema`) are all
`.optional()`, so their absence from every fixture cannot fail a parse. Proof: the four
positive fixtures still omit all four VAPID vars and now parse successfully.

Consumers of the two schemas outside this file were checked for the same class of
regression: `apps/web/src/lib/api.ts` (production code, not a fixture),
`apps/web/src/lib/api.test.ts` and `apps/web/src/hooks/realtime/use-link-name.test.ts`
— both of which `vi.mock` the schema rather than building an env fixture. No other
fixture in the repo builds a `backendEnvSchema`/`frontendEnvSchema` object. Nothing else
to fix.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch packages/shared/src/env.config.test.ts` (after) | pass — `Tests 105 passed (105)` |
| `npx turbo test --filter=@hushbox/shared --force` | pass — `1 successful, 1 total` (includes the per-file coverage gate) |
| `npx turbo typecheck lint --filter=@hushbox/shared --force` | pass — `2 successful, 2 total` |
| `npx eslint src/env.config.test.ts` (from `packages/shared`, after last edit) | pass — exit 0, no output |
| `pnpm gitleaks detect --no-git --source packages/shared/src/env.config.test.ts` | 1 finding, pre-existing, not mine (below) |

### Gitleaks detail

The whole-file scan reports exactly one finding, and it is not one of my values:

```
Finding:     RESEND_API_KEY: 're_123456789'
RuleID:      generic-api-key
File:        packages/shared/src/env.config.test.ts
Line:        584
```

Attributed to pre-existing content: scanning the `HEAD` copy of the same file
(`git show HEAD:packages/shared/src/env.config.test.ts`) reproduces the identical finding
at line 583 — one line earlier, exactly the offset my first insertion introduces. The
line is unmodified by me and is already committed, so it is not in any diff CI's
`gitleaks-action` scans.

My three added values (`dev-notification-tag-hmac-key`,
`prod-notification-tag-hmac-key`) produced **zero** findings — they are inert
hyphenated words with low entropy. No `.gitleaks.toml` entry was needed and none was
added.

## Acceptance criteria

1. **All four tests pass by adding the missing var(s) to fixtures; `pnpm test:shared`
   fully green** — met. The four named tests pass; the file is 105/105; the full
   `@hushbox/shared` task (tests + coverage gate) is green.
2. **Schema NOT weakened (no `.optional()`, no default on `NOTIFICATION_TAG_SECRET`);
   VAPID trio's optionality unchanged** — met. `env.config.ts` has zero edits from this
   task; the diff evidence above shows required-ness and the three `.optional()` VAPID
   entries intact.
3. **If any OTHER var this run added is also missing from a fixture, fix it too and say
   so** — met (nothing to fix). The four VAPID vars are optional in their schemas and
   their absence cannot fail a parse; no other fixture in the repo constructs either
   schema's input. Reported as "no other var needed fixing" rather than silently
   omitted.
4. **No other test file touched** — met. `git diff --stat -- packages/shared/` shows
   `env.config.test.ts | 5 +` as the only test file changed by this task; the other
   modified files under `packages/shared/` are pre-existing changes from Task 04 and
   from concurrent workstreams, untouched here.

## Deviations

None.

## Concerns and limitations

- **Pre-existing, not introduced here:** the three negative `backendEnvSchema` tests
  (`rejects invalid NODE_ENV`, `rejects missing DATABASE_URL`, `rejects missing
  ADMIN_URL`) build fixtures that omit several required vars beyond the one each test
  names (`MARKETING_URL`, `ADMIN_URL`, `APP_VERSION` were already absent before this
  run), so none of them isolates its named var — each would pass even if its named var
  became optional. `NOTIFICATION_TAG_SECRET` is now one more omitted var in that set,
  but it does not change the tests' meaning: they were already non-isolating at `HEAD`.
  Left untouched deliberately (out of the acceptance criteria, and patching only the new
  var would not restore isolation anyway). Flagged for a possible separate cleanup.
- `turbo typecheck lint --filter=@hushbox/shared` took 3m21s on a forced cold run; that
  is build cost, not a signal.

## Confidence

**High** — the failure was reproduced red for the diagnosed reason before any edit, the
fix is three fixture lines plus one explanatory comment, every named gate is green, and
the schema file is provably untouched.
