# Behavioral spec extraction (T0.0)

**Working artifact. This entire directory is deleted at T4.7** (once the e2e suite is
re-pointed and the ported integration tests are the living spec). Do not treat it as
permanent documentation; treat it as the source-of-truth inventory that later task
briefs cite during the rewrite.

## What this is

The existing e2e + integration test suites encode hard-won correctness. The v2 rewrite
is big-bang — the e2e suite is dark until Phase 4 — so this directory mines those suites
into per-family behavior lists that every rewrite task cites as "behavior that must be
preserved," re-encoded as per-slice integration tests.

Evidence discipline (per AGENT-RULES): e2e behaviors were captured from test titles
read directly out of every spec file; integration behaviors from titles read out of the
cited test files; constants and semantics from source with file:line citations. Facts
are Verified unless explicitly marked Inferred; unknowns are marked as gaps, never
guessed.

## Files

| File | Contents |
| --- | --- |
| `auth.md` | OPAQUE registration/login/2FA/password-change/recovery behaviors |
| `deletion.md` | Account-deletion wizard, step-up, lockout, cascade/saga behaviors |
| `payments-wallets.md` | Payments, webhooks, **payment idempotency** (integration-sourced), wallet provisioning, allowance |
| `group.md` | Members, privileges, invites, **key-rotation gates**, group budgets, realtime |
| `chat-core.md` | The turn: send/stream/persist, conversations CRUD, settlement-adjacent tests |
| `forking.md` | Fork CRUD, limits, fork×history, fork×regeneration |
| `multi-model-batchId.md` | Fan-out, sibling identity (`batchId` contract), partial failure, debit = sum |
| `regeneration.md` | Retry/edit/regenerate, group blocking rules |
| `smart-model.md` | Family behaviors **plus the four real semantics** (fallback, billed-on-completion, short-circuit, cheapest-eligible) |
| `media.md` | Image/video generation, **epoch-gated presign authz**, R2 failure handling |
| `trial.md` | 5/day quota, $0.01 cap, no-persist, premium gating, IP burst limit |
| `sharing.md` | Shared links/messages, link guests, public share endpoint, share-path presign |
| `usage.md` | Usage analytics read surface, cost-display == debit invariant |
| `platform-contracts.md` | Health, dev routes, e2e determinism contracts (signals/config/motion), **LWW merge** (integration-sourced), middleware, `x-mock-*` seam pointer |
| `constants.md` | Every constant a rewrite could silently change, with file:line citations (full rate-limit registry included) |
| `projects-feature.md` | Full surface of the deleted `projects` feature |
| `grounding-deltas.md` | cd1737a (`length`-finish = billable truncation), f79d690 (tool/stream-error recovery), the `x-mock-*` header seam |
| `mapping.json` | Every e2e spec file → exactly one family, or out-of-scope with reason |
| `coverage-check.mjs` | Ad-hoc check that `mapping.json` covers every e2e spec file. Run manually: `node docs/plans/behavioral-spec/coverage-check.mjs`. **Not CI-wired.** |

## How later task briefs should cite this

- Cite a behavior as: `behavioral-spec/<family>.md :: "<test title>"` — the title is the
  stable handle; the file:line of the original test can drift.
- A task brief's "behavioral spec" section should list the rows it must preserve and
  re-encode as integration tests in its slice; the auditor checks the new tests against
  those rows.
- Constants: cite `behavioral-spec/constants.md` row + the original source file:line.
  If a v2 value intentionally differs, the brief must say so explicitly — silence means
  "preserve exactly".
- Out-of-scope e2e files (4: `chat-scroll`, `mobile/viewport`, `ui/viewport-edges`,
  `ui/document-panel`) are frontend-only; they are preserved verbatim and re-pointed at
  Phase 4, never ported into integration tests.

## Known gaps (explicit, not guessed)

- `e2e/account-deletion.spec.ts` contains a `test.fixme` for the deletion-lockout UI
  surface — the backend lockout IS tested (`delete-account.test.ts`), the UI surfacing
  is not.
- The group regeneration blocking rules ("blocked when other user replied after") exist
  only in e2e today; no integration test encodes them (flagged in `regeneration.md`).
- Some platform-area integration files are cited at file level without per-title
  capture (listed in each family file under "read at port time").
- `projectId` is **not** in any public API response despite the task brief's assumption —
  documented with evidence in `projects-feature.md`.
