# Task-21 close-fix report — public-share leak-guard reconciliation

## Objective

Reconcile the public-share leak-guard test (`routes.integration.test.ts`, "never leaks
cost, model name, or the smart-model flag onto the unauthenticated read") to the approved
R2/T03 behavior: the shared `contentItemViewSchema` now re-serves `width`/`height`/
`durationMs` on both the authenticated history read and the unauthenticated public-share
read (legacy anchor L1226-1227; non-sensitive display metadata; re-serving explicitly
approved). Update the test's key expectation to accept those three keys without weakening
its real security intent.

## Semantics verified (step 1)

- `width`/`height`/`durationMs` are non-sensitive media-dimension fields on the base
  `contentItemViewSchema` (content-item-view.ts:17-22): pixel width/height and time-based
  media duration. The public read (`shares.ts:668`, `contentItems: z.array(contentItemViewSchema)`)
  serves exactly the base view — 9 keys: `byteLength`, `contentType`, `durationMs`,
  `encryptedBlob`, `height`, `id`, `mimeType`, `position`, `width`.
- The SENSITIVE fields the guard blocks are STILL ABSENT from the public read. They live
  only on `historyContentItemViewSchema` (history.ts:20-26), which `.extend()`s the base
  with `modelName: z.string().nullable()`, `cost: z.string().nullable()`, and
  `isSmartModel: z.boolean()` — the authenticated history read's shape. The base view the
  public read uses carries none of `cost`/`costNanoUsd`, `modelName`/`modelId`, or
  `isSmartModel`. The history.ts:12-18 comment states this separation is deliberate.
- No leak: no sensitive field is present on the unauthenticated read. Proceeded with the
  test-only reconciliation (not BLOCKED).

## Files changed

- `apps/api/src/slices/conversations/routes.integration.test.ts` — added `durationMs`,
  `height`, `width` to the sorted exact-key allowlist at the leak-guard assertion so it
  reflects the approved base-view shape.

## Updated assertion

The exact-key allowlist now reads (sorted):

```
expect(Object.keys(item ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
  'byteLength',
  'contentType',
  'durationMs',
  'encryptedBlob',
  'height',
  'id',
  'mimeType',
  'position',
  'width',
]);
```

The security intent is preserved and kept intact — the following denylist assertions
(already present, unchanged) still guard the sensitive fields:

```
expect(item).not.toHaveProperty('cost');
expect(item).not.toHaveProperty('modelName');
expect(item).not.toHaveProperty('isSmartModel');
expect(JSON.stringify(body)).not.toContain('1360000');
expect(JSON.stringify(body)).not.toContain('claude');
```

The exact-key allowlist is retained (matching existing test style) rather than replaced by
a bare denylist: an exact set is the stronger guard because it also trips on any FUTURE
unexpected key addition, while the explicit denylist independently pins the three known
sensitive fields absent.

## Self-gate

- `pnpm test:watch <file> -t "never leaks..."` — pass — 1 passed | 250 skipped.
- `pnpm exec eslint src/slices/conversations/routes.integration.test.ts` (from `apps/api`)
  — pass — exit 0.

## Acceptance criteria

- Test reflects approved behavior (accepts `width`/`height`/`durationMs`) — met — see
  updated assertion; test green.
- Real security intent not weakened — met — sensitive-absent denylist kept; exact-key
  allowlist retained as an additional new-key guard; verified no sensitive field present
  on the public read.

## Deviations

None.

## Concerns and limitations

- Pre-existing unrelated typecheck error in `pipeline-bindings.ts` is out of this task's
  scope and unattributable to this single-file test edit (start-of-task `git status`
  showed only the target file modified by me). Not touched, not investigated.

## Confidence

High — the change is a one-line allowlist reconciliation; semantics confirmed against
schema definitions; test green and lint clean.
