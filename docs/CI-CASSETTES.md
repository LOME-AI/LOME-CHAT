# CI HTTP Cassettes

The models-slice adapter tests exercise OpenRouter calls — text inference, image
generation, video generation. Calling OpenRouter on every CI run costs money and adds
latency. The cassette layer records each HTTP exchange the first time it is seen and
replays it thereafter, so CI is **record-on-miss**: the first uncached request is a real
charged call (using the spend-restricted key `OPENROUTER_API_KEY_RESTRICTED`), recorded
into the `actions/cache`; every identical request afterward replays from that cache.

- **Warm cache** (steady state) = all replays, **zero charged calls**.
- **Cold cache** (a brand-new test, or an evicted/version-bumped cache) = real calls for
  the misses, recorded for next time.

There is no separate out-of-band recording step and CI is not "100% replay" — it records
what it is missing.

## The single seam

All three ways AI inference is served are selected in one place —
`resolveModelProvider` in the models slice
(`apps/api/src/slices/models/adapters/resolve-model-provider.ts`):

| Environment      | Provider                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| dev / E2E        | deterministic **mock** provider — no key, no cassette, no evidence.         |
| CI-vitest        | **real** provider whose SDK `fetch` is the record-on-miss cassette, wrapped so the first successful inference event writes `openrouter` service-evidence. |
| production       | **real** provider over plain `globalThis.fetch` — no cassette, no evidence. |

## How it works

```
adapter test
  └─ createCassetteFetch({ store, mode })          [cassette/recording-fetch.ts]
      │    store = createCassetteStore(...)        [cassette/cassette-store.ts]
      │    mode  = cassetteModeFor()               [cassette/mode.ts]  → 'record'
      └─ passed through the adapters' fetch option (the cassette/fixture seam)
          └─ createOpenRouter({ fetch })
              └─ on each request:
                   1. hash = sha256(canonical(request)).slice(0, 16)
                                                    [cassette/canonical-request.ts]
                   2. cassette = store.read(hash)
                   3. hit  → reconstruct Response, return
                   4. miss → record mode: real fetch, record on success, return
```

The cassette modules live at `apps/api/src/slices/models/adapters/cassette/`:

- `canonical-request.ts` — turns a `Request` into a deterministic descriptor (method,
  path+query, allowlisted headers, canonicalized body) and hashes it to 16 hex chars
  (an 8-byte sha256 prefix — ample for a CI run's cardinality). The header allowlist is
  deliberately pared to `content-type` + `accept`: OpenRouter carries the model id in the
  request **body** (`body.model`), not a header, so two models with the same prompt
  already hash differently via the body. This diverges from the legacy Vercel-gateway
  header set on purpose — auth, SDK-version, and per-request identifier headers are
  filtered out so record and replay of the same logical request hash identically.
- `cassette-store.ts` — file-backed storage at `.ai-cassettes/{version}/{hash}.json`
  (atomic writes via `.tmp` + rename); owns `AI_RECORDING_VERSION`.
- `recording-fetch.ts` — the fetch wrapper (`createCassetteFetch`); hit/miss/error
  policy below.
- `mode.ts` — `cassetteModeFor()` returns `'record'` (record-on-miss). The
  `'replay-only'` value still exists on the `CassetteMode` type but is exercised only by
  the cassette unit tests, never selected at runtime.
- `failure-fixtures.ts` / `media-failure-fixtures.ts` — hand-curated synthetic error
  exchanges (`createFixtureFetch`) injected at the same fetch seam, since real
  failures are never recorded.

The cassette is invisible to test code — tests call the adapters exactly as
production code would; only the injected fetch differs.

## Caching policy

In `record` mode, a miss goes to the real gateway and the result decides:

| Upstream result     | Action                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx / 3xx (success) | Cache. Subsequent identical requests replay this response.                                                                                                  |
| 4xx (client error)  | **Do not cache.** A failed request isn't billed, so re-running it live is free — and caching a transient auth/plan/rate-limit failure would replay forever. |
| 5xx (server error)  | **Do not cache.** Transient — caching would poison future runs.                                                                                             |
| Network error/throw | **Do not cache.** Pass the error through.                                                                                                                   |

Deterministic error paths come from the failure fixtures, never from recordings.

`replay-only` mode throws `CassetteMissError` on a miss. It is used only by the cassette
unit tests to assert miss behavior — CI never runs in this mode.

## When to bump `AI_RECORDING_VERSION`

Bumping (`'v1'` → `'v2'`) orphans all existing recordings — the next run records fresh
into a clean directory. Bump when:

1. The serialized `Cassette` schema changes (the file format).
2. The header allowlist in `canonical-request.ts` changes (hashes drift).
3. The AI SDK / OpenRouter provider ships a behavior change you want fresh
   recordings against.
4. You deliberately want a clean refresh (e.g., after fixing a request-construction
   bug that all recordings have baked in).

Don't bump for new test prompts (old hashes orphan naturally and age out of the CI
cache) or routine SDK patch upgrades (the SDK version is filtered out of the hash via
the header allowlist).

## Recording

Recording happens automatically on a miss — in CI (with `OPENROUTER_API_KEY_RESTRICTED`)
and locally (with a real `OPENROUTER_API_KEY`). Cassettes live at `.ai-cassettes/v{N}/`
(gitignored). To force one recording to refresh:

```bash
rm .ai-cassettes/v1/<hash>.json
```

To wipe everything:

```bash
rm -rf .ai-cassettes
```

The dev/E2E mock key (`mock-openrouter-key`) is refused on the CI-vitest recording path —
recording against it would burn a run and cache a `401` forever.

## What `verify:evidence --require=openrouter` proves

`scripts/verify-evidence.ts` checks the `service_evidence` table has at least one
`openrouter` row (`SERVICE_NAMES.OPENROUTER`) after the test job. Both real calls and
cassette replays write evidence rows — replay counts as evidence that the integration
code path was exercised, so a warm-cache (100% replay) run still satisfies the assertion.
It proves the integration code path ran, not that a live call happened this run; a
cold-cache run or a version bump is **not** required to satisfy it.

## CI cache mechanics

The test job in `.github/workflows/ci.yml` uses `actions/cache` for cassette storage:

```yaml
- name: Restore AI cassettes
  uses: actions/cache/restore@v4
  with:
    path: .ai-cassettes
    key: ai-cassettes-v1-${{ github.run_id }}-${{ github.run_attempt }}
    restore-keys: |
      ai-cassettes-v1-

- name: Save AI cassettes
  if: always()
  uses: actions/cache/save@v4
  with:
    path: .ai-cassettes
    key: ai-cassettes-v1-${{ github.run_id }}-${{ github.run_attempt }}
```

The unique save key + prefix `restore-keys` pattern: each run saves under a fresh
key, and every run restores the most recently saved set matching the prefix. Saves
run `if: always()` — fresh recordings from a failed run are still valuable, and the
per-run key means a failed save can't poison main. New recordings accumulate;
bumping the version prefix cleanly retires the old set. Blacksmith runners route
`actions/cache` to their backend transparently (7-day LRU).

## Multi-exchange operations

Some logical operations issue multiple HTTP requests (e.g., a media response carrying
a URL the SDK then downloads). Each fetch gets its own cassette entry keyed by its
own hash, so no special multi-exchange logic exists at the cassette level.

## Diagnostics

Cassette files are JSON — inspect directly:

```bash
ls .ai-cassettes/v1/
jq '.exchanges[0].status, .exchanges[0].headers' .ai-cassettes/v1/<hash>.json
```

Correlate recordings to tests by `recordedAt` and `recordedFromSha`.

## Fork PRs

Fork PRs cannot read the Actions cache and have no repo secrets — no cassettes to
replay and no key to record with. Cassette-dependent integration tests cannot pass
there.
