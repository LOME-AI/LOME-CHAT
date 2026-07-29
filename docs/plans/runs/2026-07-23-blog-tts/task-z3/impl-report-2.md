# impl-report-2 — Finish the model-host deduplication (remaining two sites)

## Objective

Collapse the two remaining hardcodings of the TTS model host in
`e2e/marketing-roadmap.spec.ts` — the `fetch` inside `page.evaluate`, and the assertion
string — onto the shared `TTS_MODEL_HOST` constant already imported by the file. No new
dependency, no new timeout, no assertion's meaning changed, no other edit to the file.

## Files changed

- `e2e/marketing-roadmap.spec.ts` — the in-page probe URL and the assertion's expected
  host now derive from `TTS_MODEL_HOST` instead of restating it. Two hunks,
  6 insertions / 4 deletions; no other file touched.

## The two sites — old and new form

### Site 1 — the `fetch` inside `page.evaluate`

Old:

```ts
    await page.evaluate(async () => {
      await fetch('https://blocked.invalid/probe', { mode: 'no-cors' }).catch(() => null);
      await fetch('https://huggingface.co/probe', { mode: 'no-cors' }).catch(() => null);
    });
```

New:

```ts
    // The browser context cannot close over a Node-side binding, so the host
    // crosses into the page as an argument.
    await page.evaluate(async (modelHost) => {
      await fetch('https://blocked.invalid/probe', { mode: 'no-cors' }).catch(() => null);
      await fetch(`${modelHost}/probe`, { mode: 'no-cors' }).catch(() => null);
    }, TTS_MODEL_HOST);
```

The `blocked.invalid` control fetch is untouched — it is a deliberately unallowlisted host,
not a restatement of anything shared.

### Site 2 — the assertion

Old:

```ts
    expect(blocked.some((uri) => uri.includes('huggingface.co'))).toBe(false);
```

New:

```ts
    expect(blocked.some((uri) => uri.includes(new URL(TTS_MODEL_HOST).host))).toBe(false);
```

**The assertion checks exactly what it checked before.** It is the same `expect`, the same
`blocked.some(...)` predicate, the same `.includes(...)` substring test, the same
`.toBe(false)`. Only the source of the expected substring changed.

The substring itself is unchanged because the naive substitution would have been wrong:
`TTS_MODEL_HOST` is `https://huggingface.co` (with scheme), while the literal it replaces is
the bare host `huggingface.co`. Interpolating the constant directly would have narrowed the
predicate to blocked URIs carrying the scheme — a different assertion. `new URL(…).host`
recovers the exact former literal, verified by execution rather than inspection:

```
constant           : "https://huggingface.co"
built probe url    : "https://huggingface.co/probe"
previous probe url : "https://huggingface.co/probe"
probe identical    : true
derived host       : "huggingface.co"
previous host lit  : "huggingface.co"
host identical     : true
```

Both derived values are byte-identical to the literals they replace, so neither the request
the page makes nor the substring the assertion matches on can differ.

## How the constant reaches the browser context

`page.evaluate` serializes a second argument and passes it to the page function; the
callback receives it as a parameter. The callback's signature changed from `async ()` to
`async (modelHost)`, and `TTS_MODEL_HOST` is passed as the second argument to `evaluate`.
This is the API requirement — the browser realm cannot close over a Node-side binding — and
`modelHost` is inferred as `string`.

**Confirmation the evaluated code behaves identically, per project.** Byte-identity of the
constructed URL is necessary but not sufficient: had the argument failed to thread through,
the in-page URL would have become `undefined/probe`, and the test would still have passed
*vacuously* (the assertion checks that no blocked URI names the model host, which an
unrelated URL also satisfies). That hole is closed by observing the URL the browser actually
requested. The suite retains traces only on first failure, so the run was executed with
`--trace on` via the CLI (no file edit) and the network log of each project's CSP test read
back:

| Project   | Probe URL recorded in trace  |
| --------- | ---------------------------- |
| chromium  | `https://huggingface.co/probe` |
| firefox   | `https://huggingface.co/probe` |
| webkit    | `https://huggingface.co/probe` |
| iphone-15 | `https://huggingface.co/probe` |
| pixel-7   | `https://huggingface.co/probe` |
| ipad-pro  | `https://huggingface.co/probe` |

The argument threaded through on every engine, and the URL is byte-identical to the one the
literal produced.

## Self-gate

| Command                                                     | Result                                   |
| ----------------------------------------------------------- | ---------------------------------------- |
| `npx eslint marketing-roadmap.spec.ts` (from `e2e/`, after the last edit) | **pass** — exit 0, no output |
| `npx tsgo --noEmit` (from `e2e/`)                           | **pass** — exit 0                        |
| `playwright test e2e/marketing-roadmap.spec.ts --retries=0 --trace on` | **pass** — 276 passed, 0 failed, 0 flaky |

Both were run after the final edit and re-run once more at the end with no intervening edit;
green both times.

## Verification — per-project run

Full run, no project filter, `--retries=0`. Report: `e2e/report/2026-07-29T04-57-57/` —
**276 passed, 0 failed, 0 flaky** in 4.7m, matching last cycle's 276/0/0 exactly. All
eighteen spec entries passed:

| Project   | Public roadmap | TTS model-download CSP | Blog Listen control |
| --------- | -------------- | ---------------------- | ------------------- |
| chromium  | pass           | pass                   | pass                |
| firefox   | pass           | pass                   | pass                |
| webkit    | pass           | pass                   | pass                |
| iphone-15 | pass           | pass                   | pass                |
| pixel-7   | pass           | pass                   | pass                |
| ipad-pro  | pass           | pass                   | pass                |

## Verification — no external download on any project

**Method used: the two in-run, per-project instruments, plus a whole-run interface-byte
bound.** The host-level `/proc/net` connection sampler with the DNS-collected address set
and the `curl` positive control was not repeated.

**Why that is sufficient here.** Nothing about routing changed this cycle. Both `page.route`
interceptors — the mechanism that keeps the model request off the network — are untouched by
this task; they were established and measured last cycle, and this diff contains no
`page.route` line on either side. What changed is the URL the page requests, and the risk
that introduces is not "the request escapes" but "the request goes somewhere else", which
the trace evidence above settles directly by showing the exact URL on all six projects. The
two in-run instruments are also not a lighter substitute for the sampler — they are
per-project and automatic, whereas the sampler is whole-run and aggregate:

1. **In-test proof of interception (per project).** The Blog Listen test's
   `expect.poll(() => modelRequested).toBe(true)` flips only inside the `page.route`
   handler, which neither fulfills, continues, nor aborts — the request is held in-process
   and never issued. It passed on all six projects.
2. **In-suite guard (per project).** Neither `huggingface.co` nor `*.hf.co` is on the
   e2e network allowlist; any request escaping the page route is aborted, recorded, and
   thrown at teardown. Zero failures on all six projects means nothing reached an external
   host. The CSP test's own trace corroborates this from the other side: the probe request
   appears in the trace as intercepted, and the run is green.
3. **Whole-run interface bound.** `eth0` RX across the entire run was **7.1 MB** — an order
   of magnitude below a single ~90 MB model, and two below the six a per-project download
   would have cost. (Lower than last cycle's 23 MB, consistent with a warmer build cache.)

## Acceptance criteria

1. **Both remaining sites deduplicated — met.** Site 1 and Site 2 above; both derived values
   proven byte-identical to the literals they replaced.
2. **Assertion's meaning unchanged — met.** Before/after quoted above; only the source of
   the expected substring changed, and the substring is byte-identical.
3. **No new dependency, no new timeout, no other edit — met.** `TTS_MODEL_HOST` was already
   imported by this file from last cycle's change; `@hushbox/shared` was already an `e2e`
   devDependency. The diff is two hunks, contains no `timeout`/`TIMEOUTS` line on either
   side, and touches no other file.
4. **Passes on all six projects, no external download — met.** See the two verification
   sections.

## Deviations

None.

## Concerns and limitations

- **The host literal still appears twice in the file — in prose comments only.** The
  required grep evidence was phrased as proving the literal appears nowhere in the file. It
  does still appear at two comment lines: one explaining what the CSP allowlist is for, one
  explaining why the test probes two hosts. No code occurrence remains anywhere in the e2e
  suite:

  ```
  $ grep -rn --include='*.ts' huggingface e2e/
  e2e/marketing-roadmap.spec.ts:64: * model files from `https://huggingface.co`; without it in `connect-src` the
  e2e/marketing-roadmap.spec.ts:94:    // CSP (before any network request) and raises a violation. `huggingface.co`
  ```

  These were flagged in report-1 as prose and were not among the two sites this task names,
  and the brief forbade other edits to the file, so they were left. They are also not the
  drift class the ruling targets: a comment cannot silently change what the test requests or
  asserts. Raised for an explicit decision rather than resolved unilaterally — collapsing
  them would mean rewriting explanatory prose to not name the thing it explains, which reads
  as a net loss.
- **`pnpm e2e:prepare` still fails for the foreign reason recorded last cycle** — its
  `catalog:refresh --require-e2e-models` step aborts on an e2e-declared model that is no
  longer sellable in the live OpenRouter catalog. Worked around exactly as before by running
  the remaining prepare steps directly (`pnpm ensure-stack --env-mode e2e`, `pnpm db:seed`,
  `tsx scripts/e2e-clean.ts`, all clean). Not investigated, not fixed.
- **Teardown env regeneration (accepted side effect).** `generate:env` reported writing
  `.env.development`, `.env.scripts`, `apps/api/.dev.vars`, `apps/api/wrangler.toml`
  `[vars]`, and the generated blocks of `.github/workflows/{ci,release,build-android,run-ops-script}.yml`.
  This cycle the regeneration was byte-idempotent — none of those files appear as modified
  in `git status`. Left exactly as produced.
- **`--trace on` wrote trace archives under `test-results/`.** That path is gitignored
  (`.gitignore:51`), so nothing entered the repo.
- **Concurrent work is visible in the tree** — another workstream has `e2e/chat/runnable-documents.spec.ts`,
  `e2e/pages/document-panel.page.ts` and a separate run directory modified. Untouched. My
  own file shows exactly the two intended hunks.
- The run again executed on a saturated host (load average 44 on 24 cores, inflated by trace
  capture) and was still zero-flake at `--retries=0`.

## Confidence

**High.** Both substitutions are proven byte-identical to the literals they replaced, the
argument-threading was confirmed from the real run's network traces on every project rather
than assumed, and the full spec is green on all six projects at `--retries=0` with the
egress properties intact.
