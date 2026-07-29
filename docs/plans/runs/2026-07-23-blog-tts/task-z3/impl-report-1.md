# impl-report-1 — Deduplicate model-host string; remove browser restriction

## Objective

Two independent fixes in `e2e/marketing-roadmap.spec.ts`:

1. Replace the twice-hardcoded `huggingface.co` route pattern with the shared constant the
   CSP allowlist derives from.
2. Remove the `@chromium-only` tag so the spec runs on every configured project.

Behaviour otherwise unchanged; no new dependency; no assertion weakened, added, or removed;
no new timeout.

## Files changed

- `e2e/marketing-roadmap.spec.ts` — imports `TTS_MODEL_HOST` from `@hushbox/shared` and
  builds both `page.route` patterns from it; drops the `@chromium-only` describe tag.

No other file was touched.

## Fix 1 — the two hardcoded sites

| Site                      | Old                                                  | New                                            |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| CSP test, model probe     | `page.route('https://huggingface.co/**', …)`         | ``page.route(`${TTS_MODEL_HOST}/**`, …)``      |
| Blog Listen, model request| `page.route('https://huggingface.co/**', …)`         | ``page.route(`${TTS_MODEL_HOST}/**`, …)``      |

Import added: `import { TTS_MODEL_HOST } from '@hushbox/shared';` (barrel-exported at
`packages/shared/src/index.ts`, defined in `packages/shared/src/tts-hosts.ts`). `@hushbox/shared`
is already an `e2e` devDependency and is imported by many sibling specs, so no dependency
was added.

### How the matching behaviour was confirmed identical

`TTS_MODEL_HOST` carries no trailing slash, so the concern was whether the interpolated
pattern still ends in the `/**` glob suffix Playwright's URL matcher needs. It does — the
constructed pattern is **byte-identical** to the literal it replaced, so matching cannot
differ. Confirmed by executing the concatenation against the real constant rather than by
inspection:

```
constant       : "https://huggingface.co"
built pattern  : "https://huggingface.co/**"
previous       : "https://huggingface.co/**"
byte-identical : true
```

Independently corroborated at runtime: both routes fired in the live run on every project
(the CSP probe was fulfilled with 204, and the Blog Listen test's `modelRequested` flag —
set only inside the route handler — went true on all six projects). A pattern that no longer
matched would have failed both tests.

## Fix 2 — `@chromium-only` removed

`test.describe('Blog Listen control', { tag: '@chromium-only' }, …)` →
`test.describe('Blog Listen control', …)`.

The tag was a project-level gate: `playwright.config.ts:36` defines
`excludeChromiumOnly = { grepInvert: /@chromium-only/ }`, spread into the `firefox`,
`webkit`, `iphone-15`, `pixel-7` and `ipad-pro` projects (`:253`, `:269`, `:281`, `:294`,
`:306`). With the tag gone the test is collected everywhere the spec file is collected —
verified by `playwright test e2e/marketing-roadmap.spec.ts --list`, which now lists
`Blog Listen control › starts an on-device read from the built worker` under all six
projects.

## Self-gate

| Command                                                            | Result                                   |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `npx eslint marketing-roadmap.spec.ts` (run from `e2e/`, after last edit) | **pass** — exit 0, no output       |
| `npx tsgo --noEmit` (run from `e2e/`)                              | **pass** — exit 0                        |
| `playwright test e2e/marketing-roadmap.spec.ts --retries=0` (all projects) | **pass** — 276 passed, 0 failed, 0 flaky |

Both lint and typecheck were re-run after the concurrent commit described under Concerns,
and were green both times.

## Verification — per-project run

Full run, no project filter, `--retries=0` (stricter than the local default of 1 retry).
Report: `e2e/report/2026-07-29T04-43-44/` — `276 passed, 0 flaky, 0 failed` in 4m 9s.
The 276 includes the six per-project auth-setup projects; the spec itself contributed 18
test entries, all passing:

| Project     | Public roadmap | TTS model-download CSP | Blog Listen control |
| ----------- | -------------- | ---------------------- | ------------------- |
| chromium    | pass (952ms)   | pass (446ms)           | pass (1.0s)         |
| firefox     | pass (3.9s)    | pass (3.5s)            | pass (4.2s)         |
| webkit      | pass (3.1s)    | pass (2.3s)            | pass (3.4s)         |
| iphone-15   | pass (3.0s)    | pass (2.2s)            | pass (3.4s)         |
| pixel-7     | pass           | pass                   | pass                |
| ipad-pro    | pass           | pass                   | pass                |

(`REPORT.md:282–299` lists all eighteen under Passed Tests.)

The auditor's finding generalises: module-worker cross-origin request interception works
in firefox and webkit, not only chromium. No engine needed special handling.

## Verification — no external download on any project

Three independent lines of evidence, because this is the property the removed tag was
protecting.

**1. In-test proof of interception (per project).** The Blog Listen test asserts
`expect.poll(() => modelRequested).toBe(true)`, and `modelRequested` is set *only* inside the
`page.route` handler. That handler neither fulfills, continues, nor aborts — the request is
held open — so a passing assertion means the request was captured in-process and never
issued to the network. It passed on all six projects.

**2. In-suite guard (per project).** Neither `huggingface.co` nor `*.hf.co` is on the
network allowlist (`e2e/fixtures.ts:253`, `:307–318` — localhost/127.0.0.1 on dev-stack
ports only). Any request that escaped the page route would be aborted, recorded, and
thrown at teardown (`e2e/fixtures.ts:1010`). Zero failures across all six projects means no
browser request reached any external host at all.

**3. Host-level measurement (whole run).** The run was wrapped in a sampler polling
`/proc/net/tcp{,6}` and `/proc/net/dev`. Across the 252s run it recorded **no TCP
connection to any Hugging Face or Xet address**, checked against a 22-address set collected
over eight DNS samples of `huggingface.co`, `hf.co`, `cas-bridge.xethub.hf.co`,
`transfer.xethub.hf.co` and `cdn-lfs-us-1.hf.co` (`3.168.73.x`, `13.33.67.x`, `18.213.x`,
`18.238.80.x`, `3.210.x`, `34.198/202/204.x`, `44.212.x`) — overlap: **NONE**. The public
endpoints that were seen reverse-resolve to GitHub (`lb-*.github.com`), Google
(`*.bc.googleusercontent.com`), Cloudflare, Fastly and one AWS host, all pre-existing host
background traffic outside the browser. Total `eth0` RX for the whole run was 23 MB —
below a single ~90 MB model, let alone the six a per-project download would have cost.

The instrument was validated with a positive control before use: run against a plain
`curl https://huggingface.co/`, it recorded the endpoint `3.168.73.129` and a 223 KB RX
delta. Egress from this machine is live and unblocked (`curl` fetched 181 KB from
huggingface.co), so the zero result is a real measurement, not an artefact of an offline
sandbox.

## Acceptance criteria

1. **Host string deduplicated at both named sites — met.** Both `page.route` patterns now
   derive from `TTS_MODEL_HOST`; byte-identity of the constructed pattern proven above.
2. **`@chromium-only` removed, spec runs on every configured project — met.** `--list`
   shows the test under all six projects; the run passed it on all six.
3. **Behaviour otherwise unchanged; no new dependency; no assertion weakened — met.** My
   change is four hunks: one added import, two route-pattern substitutions, one tag
   removal. No `expect` call, `TIMEOUTS` reference, or `package.json` entry was touched —
   the change contains no `expect`/`timeout` line on either side.

   **Note for review:** `git diff` against the last commit that predates this file's
   current shape (`39a07db0`) no longer isolates my change — the concurrent commit
   described under Concerns folded my edit together with a sibling task's addition of the
   entire `Blog Listen control` describe block. A range diff therefore shows that whole
   block, including its `expect` lines, as added. The authoritative record of my change is
   the pre-commit working-tree diff, reproduced verbatim here:

   ```
   +import { TTS_MODEL_HOST } from '@hushbox/shared';
   +
    import { test, expectConsoleErrors } from './fixtures.js';
   @@
   -    await page.route('https://huggingface.co/**', (route) =>
   -      route.fulfill({ status: 204, body: '' })
   -    );
   +    await page.route(`${TTS_MODEL_HOST}/**`, (route) => route.fulfill({ status: 204, body: '' }));
   @@
   -test.describe('Blog Listen control', { tag: '@chromium-only' }, () => {
   +test.describe('Blog Listen control', () => {
   @@
   -    await page.route('https://huggingface.co/**', () => {
   +    await page.route(`${TTS_MODEL_HOST}/**`, () => {
   ```
4. **Confirmed by running — met.** See the two verification sections.

## Deviations

None.

## Concerns and limitations

- **Two further hardcodings of the host remain in the file, deliberately left in scope-
  respect.** The CSP test still writes the host literally at `:98`
  (`fetch('https://huggingface.co/probe', …)`, inside `page.evaluate`) and at `:110`
  (`uri.includes('huggingface.co')`), plus prose mentions at `:64` and `:94`. The task named
  exactly two sites, so I changed exactly those two; collapsing the other two would mean
  editing an assertion and threading the constant through `page.evaluate` as an argument.
  Flagging for the orchestrator: if the intent was "the spec restates the host nowhere",
  these two are still restatements and want a follow-up decision.
- **`pnpm e2e:prepare` fails for an unrelated reason on this machine.** Its
  `catalog:refresh --require-e2e-models` step aborts with `e2e model
  'kwaivgi/kling-video-o1' is not sellable in the live OpenRouter catalog`. The declaration
  (`scripts/lib/e2e-model-ids.ts:23`) is unmodified in git, so this is live-catalog drift in
  a foreign workstream, not a consequence of this task — attributed, not fixed. The catalog
  itself was written (176 rows) before the assertion failed. I ran the remaining prepare
  steps directly (`pnpm db:seed`, `tsx scripts/e2e-clean.ts`, both exit 0) to get a seeded
  stack. This spec touches no model path, so the gate is irrelevant to its result.
- **A concurrent process committed the working tree during the run.** Commits `53daba72` /
  `f1d99703` / `a94ca204` ("billing refactor") swept in a large foreign change set along
  with this task's edit. `git diff HEAD -- e2e/marketing-roadmap.spec.ts` is empty, so what
  landed is exactly the intended edit, and lint + typecheck were re-run green afterwards.
  Not my action, and no git write command was run by this task.
- **Teardown env regeneration (accepted side effect).** `e2e/global-teardown.ts` ran
  `pnpm generate:env`, which reported writing: `.env.development`, `.env.scripts`,
  `apps/api/.dev.vars`, `apps/api/wrangler.toml` (`[vars]`), and the generated blocks of
  `.github/workflows/ci.yml`, `release.yml`, `build-android.yml`, `run-ops-script.yml`.
  Left exactly as the teardown produced them.
- The run executed on a saturated host (peak CPU 100%, load 31.4 on 24 cores) and was still
  zero-flake at `--retries=0`.

## Confidence

**High.** The Fix 1 change is provably behaviour-preserving (byte-identical pattern) and the
Fix 2 risk was measured on the real spec on every configured project by three independent
methods, on a machine with confirmed live egress.
