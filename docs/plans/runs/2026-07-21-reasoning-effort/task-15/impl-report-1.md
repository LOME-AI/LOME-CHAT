# T15 — Welcome-page feature entry — impl report 1

## Objective

Add reasoning effort as one feature entry on the marketing /welcome page, matching the existing entry pattern exactly (plan §Task-T15).

## Files changed

- `packages/shared/src/features.ts` — added the `reasoning-effort` entry to `SHIPPED_FEATURES`. This is the file the page delegates its feature list to: `welcome.astro` renders `SHIPPED_FEATURES.map(...)` (welcome.astro:260) and a repo grep shows `welcome.astro` is the only consumer of `SHIPPED_FEATURES`. The entry matches the existing pattern field-for-field (`id`, `name`, one-sentence `description`, `emoji`, `lucideIcon`), placed before `notifications` at the list tail.
- `packages/shared/src/features.test.ts` — added one test pinning the new entry.

No edits to `welcome.astro` itself — the list is fully data-driven, so the "no layout or styling changes beyond the added entry" criterion is satisfied by construction.

## Tests added

- `reasoning effort feature › is listed as a shipped feature` — pins that `SHIPPED_FEATURES` contains id `reasoning-effort` with name `Reasoning Effort` and icon `BrainCircuit` — covers the "one new feature entry, existing pattern" criterion. Existing shape/uniqueness tests (`fully describes every shipped feature`, unique ids) automatically cover the new row.

## Self-gate

- `npx vitest run src/features.test.ts` (packages/shared) — RED first (feature missing, 1 failed / 5 passed), then pass — 6/6.
- `pnpm build` (apps/marketing) — pass, 14 pages built; built `/welcome/index.html` contains the rendered entry (grep hit).
- `pnpm test` (apps/marketing) — pass, coverage 99.84% stmts / 100% lines.
- `npx eslint src/features.ts src/features.test.ts` (from packages/shared, after final edit) — exit 0.
- Icon existence pre-verified: `lucide-static` exports `BrainCircuit` (welcome.astro throws at build for unknown icons; build pass re-confirms).

## Acceptance criteria

- One new feature entry, existing pattern exactly — **met**: single `Feature` object, same fields/ordering/length as siblings (features.ts).
- Copy matches brand voice + truthful (per-message thinking-effort control incl. Auto + visible thoughts) — **met**: "Set thinking effort per message, let Auto decide, and watch the reasoning live." Calm/direct, no hype, one sentence like every other entry; names per-message control, Auto, and visible thoughts.
- No layout/styling changes beyond the entry — **met**: zero template/CSS edits; data-only diff.
- Marketing build/tests green — **met**: build + test pass above.

## Deviations

- Edit lives in `packages/shared/src/features.ts`, not inside `apps/marketing`. The plan criterion anticipates this ("or the component it delegates its feature list to"); the delegation target happens to be shared-package data. `welcome.astro` is its sole consumer (grep-verified), so blast radius equals the marketing page. Raised to the orchestrator.

## Concerns and limitations

- `packages/shared` has heavy concurrent modification by sibling tasks (reasoning-plan, reasoning-format, etc. — all untracked/modified in git status before my edit); `features.ts`/`features.test.ts` were untouched by them, so no collision. I ran the focused shared test, not the full `pnpm test:shared` suite, to avoid attributing concurrent tasks' in-flight state.
- Placement: appended near the list tail (before `notifications`), consistent with how recent features (message-queue, usage-dashboard) were appended; no ordering rule is documented.

## Confidence

high — data-only change, pattern-identical, pinned by test, verified in the built page.
