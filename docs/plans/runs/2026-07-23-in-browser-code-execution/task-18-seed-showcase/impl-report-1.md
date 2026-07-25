# Task 18 — seed the document showcase conversation — impl report 1

## Objective

Seed a "Document showcase" conversation for every dev persona (`DEV_PERSONAS`) so a developer
running `pnpm dev` can open the document panel and exercise every runnable-document path locally
without waiting on a model. Seven documents (HTML interactive, React + npm import, Python
compute/figure, mermaid, broken-compile React, broken-runtime React, and a no-language block that
must stay a plain code block), idempotent across repeated `pnpm db:seed` runs.

## Files changed

- `scripts/lib/seed-documents.ts` (new) — the showcase transcript: title, the seven document
  bodies, and the lead-in + single-fence composition each assistant message uses.
- `scripts/lib/seed-documents.test.ts` (new) — pins the transcript's shape, per-document
  properties, and the extraction-threshold facts.
- `scripts/seed.ts` — `buildDocumentShowcaseConversations` (pure, per-persona, deterministic ids)
  plus `seedDocumentShowcases`, called from `seedDevData` for `DEV_PERSONAS`; the dev summary line
  now counts showcase conversations.
- `scripts/seed.test.ts` — covers the builder: one per dev persona, title, transcript, deterministic
  unique ids, identical output on a second call.
- `scripts/seed-run.test.ts` — one assertion that `runSeed` drives the dev-conversation factory once
  per dev persona with the showcase title.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `DOCUMENT_SHOWCASE_MESSAGES` › names the conversation… | title is `Document showcase` | clear sidebar title |
| … › opens with a user prompt and answers with one assistant message per document | 1 user + 7 ai | conversation shape |
| … › gives every assistant message a lead-in line above exactly one fence | lead-in present, one fence per message | transcript reads naturally |
| … › covers each panel path in order | languages `html, jsx, python, mermaid, jsx, jsx, ''` | the seven documents |
| … › makes every block long enough to clear the document-extraction threshold | every body ≥ 15 lines | extraction threshold |
| … › leaves exactly one block without a language… | exactly one untagged block, itself ≥ 15 lines | plain-code boundary |
| … › wires the html document to a button that mutates the page | inline `<script>`, `addEventListener`, `<button>` | doc 1 interactivity |
| … › imports an npm package by bare specifier… and never imports React | `canvas-confetti`, default export, no React import | doc 2 import-map path |
| … › computes, prints, and plots in the python document | numpy + matplotlib + `print()` | doc 3 Run/console/PNG |
| … › draws a flowchart in the mermaid document | body starts `flowchart` | doc 4 |
| … › leaves a JSX tag unclosed in the compile-failure document | one `<div>`, no `</div>` | doc 5 compile error |
| … › reads through an undefined property at render time… | `config.palette.accent`, no `palette:` key, balanced `<section>` | doc 6 runtime error |
| `buildDocumentShowcaseConversations` › (5 tests) | one per dev persona, title, whole transcript, deterministic unique ids, identical second call | seeds for every persona + idempotency by construction |
| `runSeed` › seeds a document-showcase conversation for every dev persona | factory called once per dev persona with the showcase title | wiring |

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/lib/seed-documents.test.ts scripts/seed.test.ts --run` | pass — 2 files, 42 tests |
| `npx turbo test --filter=@hushbox/scripts --force` | fail — 1839 passed / 1 failed test, 3 failed files, **none mine** (see attribution) |
| `npx turbo typecheck --filter=@hushbox/scripts --force` | pass |
| `npx eslint seed.ts seed.test.ts seed-run.test.ts lib/seed-documents.ts lib/seed-documents.test.ts` (from `scripts/`) | pass (exit 0) after `--fix` resolved 3 prettier errors; run after the last edit |
| `pnpm ensure-stack` then `pnpm db:seed` ×4 | pass, no errors |

### Failure attribution (all pre-existing, outside my files)

- `seed-run.test.ts` and `refresh-catalog-run.test.ts` fail to load:
  `Cannot find module .../deps_ssr/@hushbox_db.js&v=c3db23c4`. Reproduced with the **HEAD version**
  of `seed-run.test.ts` restored in place (my edits removed), and it survives deleting
  `scripts/node_modules/.vite`. Recorded in this run's `ledger.md:227` as a known out-of-scope
  failure. Consequence: my one added assertion in that file could not be executed locally.
- `generate-env.test.ts` › verify-secrets — expectation is stale against the concurrent
  push-notification workstream's uncommitted `env.config.ts` additions (`VAPID_*`,
  `NOTIFICATION_TAG_SECRET`), same ledger entry.

## Acceptance criteria

- **Seeds for every dev persona** — met. `seedDevData` calls `seedDocumentShowcases(db, DEV_PERSONAS)`;
  DB after seeding shows 3 showcase conversations (alice, bob, charlie), 8 messages each.
  Mallory (`ADMIN_TARGET_PERSONA`) is excluded on purpose — she is chargeback-locked and kept out of
  demo flows.
- **Follows the existing seeding pattern** — met. Same `createDevConversation` factory, same
  `seedUUID(seedKey)` id derivation, same `SEED_MODEL_ID` stamping on assistant messages as
  charlie's conversation and the screenshot conversations.
- **Idempotent** — met. Ids are deterministic and `createDevConversation` returns early on a pinned
  id that already exists. Verified against the live DB: four `pnpm db:seed` runs left the showcase
  rows at exactly 3 conversations × 8 messages (max sequence 8), and dev-persona-owned conversations
  held steady at 159 (150 alice bulk + 5 screenshot + 1 charlie + 3 showcase) across a run.
- **Seven documents, each genuinely runnable, ≥ 15 lines** — met (test-pinned). HTML counter with
  inline script; React default export importing `canvas-confetti` (no React import — the runtime
  provides it, per `packages/shared/src/prompt/base-preamble.ts:27`); Python with numpy compute,
  four `print()` lines and a matplotlib figure (only bundled-distribution packages, no
  version-sensitive APIs such as `np.trapezoid`); a mermaid flowchart; React with an unclosed JSX
  element; React that compiles and dereferences an undefined object during render.
- **No-language block stays a plain code block** — met. `apps/web/src/lib/document-parser.ts:202`
  (`shouldExtractAsDocument`) returns `false` when the language is absent, and
  `markdown-renderer.tsx:73` returns no code-block meta at all without a `language-*` class, so the
  block never reaches `DocumentCard`. The seeded block is 16 lines — long enough that only the
  missing language keeps it out of the panel, which is what makes it a usable eyeball check.
- **Clear title, lead-in per document** — met: `Document showcase`, one lead-in line above each
  fence (test-pinned).

## Deviations

None from the brief.

## Concerns and limitations

- **The runtime-failure document may not surface an error card.** `apps/sandbox/src/render/bootstrap.ts`
  posts a typed `error` only from its own `try/catch`; React 19 reports render-phase throws
  asynchronously (`createRoot(...).render()` schedules work), and the frame installs no
  `window.onerror`/`unhandledrejection` handler. `document-sandbox.tsx` derives its error UI purely
  from the frame's `error` message, so the panel may sit at "loading" instead of showing the card.
  The document is exactly what was asked for; whether it is *seen* as a completed failure card is a
  renderer question outside this task's ownership. Flagged, not fixed.
- The extraction threshold (15) is restated as a local constant in `seed-documents.ts` with a comment;
  the authoritative `MIN_LINES_FOR_DOCUMENT` lives in `apps/web/src/lib/document-parser.ts`, which
  scripts cannot import. Not a correctness coupling — a drift would only cost the seeded fixture its
  card, and the local test would still hold the seed to its own ≥ 15 requirement.
- The showcase's react/python documents load modules from `https://esm.sh` in development mode
  (`ESM_CDN_URL`, `packages/shared/src/env.config.ts:144`), so the confetti document needs network on
  first render locally. Test modes point at the local stub instead.
- Streaming needs no seeding: the local mock provider echoes deterministically with a per-chunk
  delay, so pasting any of these documents into the composer streams it back at observable speed.
  Noted in the fixture module's header comment.

## Confidence

High — for the seeded content and idempotency, both verified against the live local stack across
four `pnpm db:seed` runs with per-conversation row counts. Medium on the single `seed-run.test.ts`
assertion, which the pre-existing dep-optimizer load failure kept me from executing locally.
