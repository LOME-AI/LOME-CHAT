# CI HTTP Cassettes

The models-slice adapter tests exercise OpenRouter calls — text inference, image
generation, video generation. Calling OpenRouter on every CI run costs money and adds
latency. The cassette layer replays recorded HTTP exchanges so CI's hot path is 100%
cassette hits with zero charged real calls: **a cassette miss in CI is a failure, not
a recording** — recording happens out-of-band.

## How it works

```
adapter test
  └─ createCassetteFetch({ store, mode })          [cassette/recording-fetch.ts]
      │    store = createCassetteStore(...)        [cassette/cassette-store.ts]
      │    mode  = cassetteModeFor(envUtils)       [cassette/mode.ts]
      └─ passed through the adapters' fetch option (the cassette/fixture seam)
          └─ createOpenRouter({ fetch })
              └─ on each request:
                   1. hash = sha256(canonical(request)).slice(0, 16)
                                                    [cassette/canonical-request.ts]
                   2. cassette = store.read(hash)
                   3. hit  → reconstruct Response, return
                   4. miss → record mode: real fetch, record on success, return
                             replay-only mode (CI): throw CassetteMissError
```

The cassette modules live at `apps/api/src/slices/models/adapters/cassette/`:

- `canonical-request.ts` — turns a `Request` into a deterministic descriptor (method,
  path+query, allowlisted headers, canonicalized body) and hashes it to 16 hex chars
  (an 8-byte sha256 prefix — ample for a CI run's cardinality).
- `cassette-store.ts` — file-backed storage at `.ai-cassettes/{version}/{hash}.json`
  (atomic writes via `.tmp` + rename); owns `AI_RECORDING_VERSION`.
- `recording-fetch.ts` — the fetch wrapper (`createCassetteFetch`); hit/miss/error
  policy below.
- `mode.ts` — `cassetteModeFor(envUtils)`: `replay-only` in CI, `record` elsewhere.
- `failure-fixtures.ts` / `media-failure-fixtures.ts` — hand-curated synthetic error
  exchanges (`createFixtureFetch`) injected at the same fetch seam, since real
  failures are never recorded.

The cassette is invisible to test code — tests call the adapters exactly as
production code would; only the injected fetch differs.

## Caching policy

In `record` mode (outside CI), a miss goes to the real gateway and the result decides:

| Upstream result     | Action                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx / 3xx (success) | Cache. Subsequent identical requests replay this response.                                                                                                  |
| 4xx (client error)  | **Do not cache.** A failed request isn't billed, so re-running it live is free — and caching a transient auth/plan/rate-limit failure would replay forever. |
| 5xx (server error)  | **Do not cache.** Transient — caching would poison future runs.                                                                                             |
| Network error/throw | **Do not cache.** Pass the error through.                                                                                                                   |

Deterministic error paths come from the failure fixtures, never from recordings.

In `replay-only` mode (CI), a miss throws `CassetteMissError` — the test fails; CI
never records and never makes a charged call.

## When to bump `AI_RECORDING_VERSION`

Bumping (`'v1'` → `'v2'`) orphans all existing recordings — the next recording pass
starts from a clean directory. Bump when:

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

Recording requires a real `OPENROUTER_API_KEY` and happens out-of-band — agents and
CI never hold recording credentials. Cassettes live at `.ai-cassettes/v{N}/`
(gitignored). To refresh one recording:

```bash
rm .ai-cassettes/v1/<hash>.json
```

To wipe everything:

```bash
rm -rf .ai-cassettes
```

## What `verify:evidence --require=openrouter` proves

`scripts/verify-evidence.ts` checks the `service_evidence` table has at least one
`openrouter` row (`SERVICE_NAMES.OPENROUTER`) after the test job. Both real calls and
cassette replays write evidence rows — replay counts as evidence that the integration
code path was exercised, so a 100% replay run still satisfies the assertion. If you
need a periodic we-really-contacted-the-gateway signal, bump `AI_RECORDING_VERSION`
(or delete the cache) before a recording pass.

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
