# Research: R3 (media GC runtime budget) + R17 (video duration pre-flight)

All paths relative to repo root. Every snippet opened this session.

---

### R3 — Media GC lost its runtime budget + operational stats

**LEGACY** `legacy/apps/api/src/legacy/services/gc/r2-gc.ts`

- Line 27, with rationale comment at 22-26:
  ```ts
  /**
   * Soft runtime budget for the cron handler. The Workers `cpu_ms` ceiling is
   * 30s; we bail at 25s so we have headroom to record evidence and return
   * stats. Partial completion is recorded so dashboards can flag pile-ups.
   */
  const MAX_GC_RUNTIME_MS = 25_000;
  ```
- Stats shape, lines 45-53:
  ```ts
  export interface R2GcStats {
    scanned: number;
    orphansFound: number;
    deleted: number;
    bytesReclaimed: number;
    durationMs: number;
    /** True when the run exited early because MAX_GC_RUNTIME_MS elapsed. */
    partialCompletion: boolean;
  }
  ```
- Bail mechanics — a `do { … } while (cursor !== undefined)` **loop** (not
  recursion), lines 125-163. Each iteration checks the budget *before* issuing
  the next `list()` page:
  ```ts
  const startedAt = Date.now();
  ...
  do {
    if (Date.now() - startedAt > MAX_GC_RUNTIME_MS) {
      partialCompletion = true;
      console.warn('r2-gc bailing early due to MAX_GC_RUNTIME_MS', {
        scanned, deleted, durationMs: Date.now() - startedAt,
      });
      break;
    }
    const page = await input.storage.list(prefix, { limit, ...(cursor !== undefined && { cursor }) });
    scanned += page.objects.length;
    const pageStats = await processPage(input, cutoffMs, page);
    orphansFound += pageStats.orphansFound;
    deleted += pageStats.deleted;
    bytesReclaimed += pageStats.bytesReclaimed;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  ```
- Stats always built and evidence recorded regardless of `partialCompletion`
  (lines 165-181): the `stats` object is assembled unconditionally after the
  loop exits (whether by exhaustion or budget bail), and `recordServiceEvidence`
  is called with a payload that includes `partialCompletion` — i.e. legacy
  records evidence **even for a partial pass**, distinguishing it via the flag
  rather than withholding the row.

**CURRENT** `apps/api/src/slices/media/domain/gc.ts`

- No budget constant, no clock-based bail anywhere in the file (verified —
  `grep MAX\|BUDGET\|RUNTIME` in the file: no hits beyond the doc comment
  citing `MEDIA_GC_GRACE_MARGIN_SECONDS`, which is an *age* margin, not a
  *runtime* budget).
- `runMediaGc` (lines 81-111) runs two full sweeps in sequence — `orphanSweep`
  then `stagingSweep` — via `.andThen` chaining, each internally *recursive*
  (not loop-based):
  ```ts
  return sweep(deps, orphanSweep, undefined, { scanned: 0, reclaimed: 0 })
    .andThen((media) =>
      sweep(deps, stagingSweep, undefined, { scanned: 0, reclaimed: 0 }).map((staging) => ({
        mediaScanned: media.scanned,
        mediaReclaimed: media.reclaimed,
        stagingScanned: staging.scanned,
        stagingReclaimed: staging.reclaimed,
      }))
    )
  ```
- `sweep()` (lines 113-138) is the recursion point — it lists one page, reclaims
  expired keys, then **unconditionally** recurses on `page.nextCursor` with no
  time check anywhere in the recursion:
  ```ts
  function sweep(deps, plan, cursor, tally): ResultAsync<SweepTally, DomainError> {
    const options = { ...(cursor === undefined ? {} : { cursor }), ... };
    return deps.storage.list(plan.prefix, options).andThen((page) => {
      const nowMs = deps.now().getTime();   // used only for age-cutoff filtering, not elapsed-budget
      const expired = page.objects.filter(...).map((o) => o.key);
      return reclaim(deps, plan, expired).andThen((reclaimed) => {
        const next: SweepTally = { scanned: tally.scanned + page.objects.length, reclaimed: tally.reclaimed + reclaimed };
        return page.nextCursor === undefined
          ? okAsync(next)
          : sweep(deps, plan, page.nextCursor, next);   // <-- unconditional recursion, no budget check
      });
    });
  }
  ```
  This is the exact insertion point for a budget bail: before the recursive
  `sweep(...)` call (or at loop entry if converted to a loop), compare
  `deps.now().getTime()` against a `startedAt` captured once at `runMediaGc`
  entry.
- `MediaGcReport` (lines 56-61) carries only scan/reclaim counts — no
  `durationMs`, no `partialCompletion`:
  ```ts
  export interface MediaGcReport {
    readonly mediaScanned: number;
    readonly mediaReclaimed: number;
    readonly stagingScanned: number;
    readonly stagingReclaimed: number;
  }
  ```
- Evidence recorded only after **both** sweeps fully complete (lines 104-110):
  ```ts
  .andThen((report) =>
    // Records only after both sweeps complete (a no-op outside CI), so the
    // evidence row proves a full pass ran, never a partial one.
    fromPromise(recordServiceEvidence(deps.db, deps.isCI, SERVICE_NAMES.R2_GC), (cause) =>
      unavailableError('service-evidence write failed', cause)
    ).map(() => report)
  );
  ```
  The comment states the design intent explicitly ("never a partial one") —
  this is a deliberate choice in the new code, not an oversight, but it is the
  opposite of legacy's behavior (legacy recorded evidence for partial passes
  too, flagged via `partialCompletion`). A budget-bail fix must decide whether
  to keep this "evidence only on full pass" posture or restore legacy's
  "always record, flag partial" posture — flagged for the remediation plan,
  not resolved here.
- Platform ceiling unchanged: `apps/api/wrangler.toml:17-18`:
  ```toml
  [limits]
  cpu_ms = 30000
  ```
- GC now shares one cron isolate/invocation with three other entries.
  `apps/api/src/scheduled.ts` `HOURLY_MAINTENANCE_CRON` branch (lines 92-124)
  builds `createCatalogRefreshEntry`, `createMediaGcEntry`,
  `createLedgerConservationEntry`, `createSnapshotDriftEntry` as one array;
  `apps/api/src/jobs/cron.ts` `runCronEntries` (lines 22-39) runs them via
  `Promise.all(entries.map(...))` — concurrent, one shared 30s `cpu_ms`
  ceiling, isolated only by try/catch per entry (a thrown error in one entry
  doesn't stop siblings, but a platform CPU-ms kill is not a catchable
  exception and would abort the whole isolate, all four entries, at once).

**DELTA**: Reinstate a soft runtime budget (e.g. a `MEDIA_GC_MAX_RUNTIME_MS`
constant sized under the shared 30s ceiling, leaving headroom for the other
three cron entries sharing the isolate — note legacy's 25s budget assumed GC
had the *whole* isolate to itself; today's shared-isolate cron design may
call for a smaller number) with an early bail in `sweep()`'s recursion,
`partialCompletion` added to `MediaGcReport`, `durationMs` added, and a
decision on whether partial-pass evidence gets recorded.

**NOTES**:

- **Clock source**: `MediaGcDeps.now: () => Date` (gc.ts:37) is already an
  injected dependency — the same pattern legacy used, but DI'd for testability.
  Production wiring is `now: () => new Date()` at
  `apps/api/src/scheduled.ts:187` (the `entriesFor` default-branch cron
  dependency assembly) and threaded down to `productionMediaGcDeps` via
  `deps.now` at `scheduled.ts:100,113,136,145,159`
  (`apps/api/src/jobs/media-gc-entry.ts:39-48` `productionMediaGcDeps` just
  forwards `args.now`). This is wall-clock (`Date`), **not** a monotonic
  clock — confirmed no `performance.now()` usage anywhere under
  `apps/api/src` (grepped repo-wide; only hit is `Date.now()` used elsewhere,
  e.g. `middleware/request-log.ts:34,42` for request latency and
  `lib/jobs/dispatcher-bindings.ts:93,99` for the JobDispatcher DO's lease
  clock — also `Date.now()`, also wall-clock). **No monotonic clock source
  exists in this Worker context** — a budget check here would use
  `deps.now().getTime()` deltas exactly as legacy did with `Date.now()`,
  accepting the same (negligible in practice, within one cron invocation)
  wall-clock-adjustment risk legacy accepted.
- `apps/api/CLAUDE.md`'s "Engine/node code uses `ctx.clock.now()`... never
  `Date.now()`" rule applies to workflow *engine/node* code
  (`src/slices/workflows/nodes/**`), not to slice-domain cron code like GC —
  GC already uses its own DI'd `now: () => Date` dependency, which is the
  established pattern for testable domain code outside the engine (mirrors
  `CronDependencies.now` used by the catalog poller, retention steps, etc. —
  `scheduled.ts:74`). No conflict with CODE-RULES; a `startedAt` capture at
  the top of `runMediaGc` via `deps.now().getTime()` is the correct
  idiom, not a raw `Date.now()` call.

---

### R17 — Per-model discrete video-duration pre-flight enforced nowhere

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:1701` (report text, legacy source
not in this corpus beyond the report — legacy chat route quoted at
`legacy/apps/api/src/legacy/routes/chat.ts:433` for the wire response and
`:18` for the imported error code):
> Video-specific extra gate: per-model discrete-duration check via
> `getSupportedVideoDurations(modelId)` — a model whose declared supported
> durations set doesn't include the requested `durationSeconds` → `400
> UNSUPPORTED_DURATION` with `{ invalidModels, durationSeconds }`. Models
> with no declared duration data (`undefined`) are allowed through...

**CURRENT**

1. **Compiler exists, exported, never called.** `apps/api/src/slices/models/domain/wire-params.ts`:
   - `compileWireParams` (lines 26-46):
     ```ts
     export function compileWireParams(
       descriptor: ModelDescriptor,
       params: Record<string, unknown>
     ): Result<WireParams, DomainError> {
       const parsed = compileParamSpec(descriptor.parameters).safeParse(params);
       if (!parsed.success) {
         return err(validationError('request params failed the model parameter contract', parsed.error));
       }
       ...
     }
     ```
   - `resolveMediaInputs` (lines 54-65) — sibling export, also dead.
   - Repo-wide grep for `compileWireParams` and `resolveMediaInputs` (excluding
     `.test.` files): only hits are the definition itself, the
     `slices/models/domain/index.ts:51` re-export, and the
     `slices/models/index.ts` barrel re-export. **No route, adapter, or
     workflow-node call site anywhere** — confirms the audit's "exported but
     never called from any live path."

2. **Admission comment admitting pending wiring**: `apps/api/src/slices/models/adapters/video-adapter.ts:146-154`:
   ```ts
   /**
    * The first-class call settings the adapter can wire today. The
    * ParamSpec→wire compiler (catalog work) replaces this closed set; until
    * then an unknown key is rejected at the boundary, never dropped silently.
    * `resolution` stays a free string: the SDK types it `${number}x${number}`
    * but providers accept shorthand like '720p'/'1080p'/'4k' at runtime —
    * the per-model vocabulary is ParamSpec data (OpenRouter catalog), not adapter
    * logic.
    */
   const callParametersSchema = z.strictObject({
     n: z.number().int().positive().optional(),
     aspectRatio: z.templateLiteral([z.number(), ':', z.number()]).optional(),
     resolution: z.string().min(1).optional(),
     durationSeconds: z.number().int().positive().optional(),  // line 161 — no enum/set check, just positive-int
   });
   ```

3. **Where duration IS validated today — global range only.**
   `packages/shared/src/schemas/api/conversations.ts:86-90`:
   ```ts
   export const videoConfigSchema = z.object({
     aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
     durationSeconds: z.number().int().min(MIN_VIDEO_DURATION_SECONDS).max(MAX_VIDEO_DURATION_SECONDS),
     resolution: z.enum(VIDEO_RESOLUTIONS),
   });
   ```
   Bounds from `packages/shared/src/constants.ts:107,110`:
   `MIN_VIDEO_DURATION_SECONDS = 1`, `MAX_VIDEO_DURATION_SECONDS = 8` — a
   flat 1-8s range applied to every video model regardless of that model's
   actual supported set (e.g. a model only supporting {4, 8} would currently
   accept 5, 6, 7 at this boundary and only fail downstream at the provider).
   This schema is the request-body-level gate (client request validation);
   there is no second, per-model gate anywhere after it. Also enforced at
   estimate time but only for *presence/type*, not *membership*:
   `apps/api/src/slices/models/domain/estimate.ts:264-277` rejects a missing
   or non-positive-integer `durationSeconds` with `ERROR_CODES.UNSUPPORTED_DURATION`,
   but does not check it against the model's declared discrete set — any
   positive integer passes this gate.

4. **Where `compileWireParams` SHOULD be invoked pre-flight** — the exact call
   site: `apps/api/src/slices/workflows/nodes/model-call-execution.ts`. The
   `InferenceRequest` is assembled at lines 160-167:
   ```ts
   const request: InferenceRequest = {
     model: node.model,
     inputs: [part],
     parameters: node.params,
     outputs: deps.binding.descriptor.outputs,
     ...
   };
   ```
   and handed straight to the provider with **no parameter validation** at
   `streamModelCall` (lines 221-249), specifically the call:
   ```ts
   for await (const event of deps.provider.infer(
     request,
     deps.binding.descriptor,
     inferOptionsOf(deps, ctx)
   )) { ... }
   ```
   (line 242). `deps.binding.descriptor` is already the `ModelDescriptor` that
   `compileWireParams` needs as its first argument, and `request.parameters`
   (== `node.params`) is exactly the `params` argument it needs — the call
   site is a one-line insertion of
   `compileWireParams(deps.binding.descriptor, request.parameters)` before
   line 242, with its `Result` threaded into the existing error path (the
   function containing this block already returns `Result<NodeRunSuccess,
   NodeRunError>`).

5. **What catalog data feeds per-model discrete duration sets.** OpenRouter
   video catalog → `apps/api/src/slices/models/domain/gateway-metadata.ts:140,226,359`:
   - Wire field: `supported_durations: z.array(z.union([z.number(), z.string()])).nullish()` (line 140)
   - Normalized field: `readonly durations: readonly string[]` (line 226)
   - Mapping: `durations: (entry.supported_durations ?? []).map(String)` (line 359)

   Then `apps/api/src/slices/models/domain/normalize.ts` builds the
   `ModelDescriptor.parameters` ParamSpec from it, `videoParameters()`
   (lines 483-501):
   ```ts
   function videoParameters(model: VideoMetadata): Record<string, ParameterSpec> {
     const specs: Record<string, ParameterSpec> = {};
     ...
     if (model.durations.length > 0) {
       specs['duration'] = { type: 'enum', values: [...model.durations], wire: 'providerOptions' };
     }
     ...
     return specs;
   }
   ```
   **Key-name mismatch, load-bearing for wiring**: the ParamSpec is keyed
   `'duration'` here, but every consumer of the actual request parameter
   (video-adapter's `callParametersSchema`, `estimate.ts`'s
   `videoCallUsage`, `model-call-execution.ts`'s `mediaFactsOf`) uses the key
   `'durationSeconds'`. `compileParamSpec` builds a `z.strictObject` keyed
   exactly by the ParamSpec record's keys (`param-spec.ts:126-130`) and
   **rejects unknown keys** — so calling
   `compileWireParams(descriptor, { durationSeconds: 8, ... })` against a
   descriptor whose spec key is `duration` would currently reject every
   video call outright (strictObject: `durationSeconds` is an undeclared
   key). Wiring this correctly requires reconciling the key name — either
   renaming the catalog-side spec key to `durationSeconds` in
   `videoParameters()` (normalize.ts:496) or renaming the request-parameter
   key everywhere else to `duration` — before `compileWireParams` can be
   called on live video requests without breaking every request. This is the
   load-bearing blocker beyond just "add the call site."

   Confirmed this same `duration` spec key already backs a **read-only,
   client-facing** consumer today: `apps/api/src/slices/models/domain/list-models.ts`
   `enumIntegers(descriptor, 'duration')` (line 138, helper at 86-94) feeds
   `supportedVideoDurationsSeconds` on the wire `Model` shape (lines 132-143)
   — i.e. the per-model discrete set is already surfaced to the client for
   *display*, just not enforced server-side pre-flight.

6. **Wire code + friendly message already exist** (audit's "confirm" ask):
   - `packages/shared/src/error-codes.ts:33`: `UNSUPPORTED_DURATION: 'UNSUPPORTED_DURATION'`
   - `packages/shared/src/error-codes.ts:152-153`:
     `UNSUPPORTED_DURATION: "One or more selected video models don't support the requested duration. Pick a different duration."`
   - Already consumed today (but only for missing/non-integer duration, not
     set-membership) at `apps/api/src/slices/models/domain/estimate.ts:270-276`
     via `validationError(..., ERROR_CODES.UNSUPPORTED_DURATION)` — this is
     the existing pattern for how a `DomainError`'s generic `validation` code
     gets a precise wire code override (`DomainErrorOf.wireCode`, see
     `apps/api/src/lib/errors/domain-error.ts:32-39,44-53,60-62`).
     `compileWireParams`'s own `validationError(...)` call
     (`wire-params.ts:32`) does **not** pass a `wireCode` today — it would
     need to inspect the Zod issue path to detect a duration-field failure
     and pass `ERROR_CODES.UNSUPPORTED_DURATION` explicitly (mirroring
     estimate.ts), otherwise a duration-membership failure would surface as
     the generic `VALIDATION` wire code instead of `UNSUPPORTED_DURATION`.

**DELTA**: Wire `compileWireParams(descriptor, request.parameters)` into
`streamModelCall` in `model-call-execution.ts` before the `provider.infer`
call (line 242), after resolving the `duration`/`durationSeconds` key-name
mismatch between `normalize.ts`'s `videoParameters()` and every consumer of
the request parameter, and after adding an explicit
`ERROR_CODES.UNSUPPORTED_DURATION` wire-code override on the duration-field
validation failure path so the response matches legacy's `400
UNSUPPORTED_DURATION` rather than a generic `VALIDATION` code. Legacy's "no
declared duration data ⇒ allow through" escape hatch has no equivalent
check confirmed in the new compiler — `compileParamSpec` only builds a
schema entry when `model.durations.length > 0`
(`normalize.ts:495-497`), so a model with an empty/absent duration set
simply has no `duration` key in its ParamSpec record at all, and
`compileParamSpec`'s `strictObject` would reject an *unexpected* incoming
`durationSeconds` for such a model rather than allow it through — this
diverges from legacy's explicit "undefined means unconstrained" semantics
and needs a ruling in the remediation plan, not resolved here.

**Gaps**: Legacy's exact `getSupportedVideoDurations` implementation and the
`chat.ts:433` route body were read only via the audit report's quote and a
grep hit, not opened directly in full — the legacy `routes/chat.ts` full
handler (lines around 420-440) was not read line-by-line in this session; if
the remediation plan needs the exact legacy response shape/details object,
read `legacy/apps/api/src/legacy/routes/chat.ts:420-440` directly.
