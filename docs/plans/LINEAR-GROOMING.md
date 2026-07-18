# Autonomous Linear Board Grooming — Plan of Record

> **Status:** Implemented 2026-07-17 (uncommitted), built via subagent-driven-dev,
> all tasks audited clean. Not yet live: the founder must add the two secrets and flip
> `GROOM_LINEAR_DRY_RUN=false` after a dry-run soak. No writes to Linear have occurred.

A weekly GitHub Actions job runs a headless Claude Code agent that (1) grooms
un-groomed board items and (2) reflects recent commit activity onto the board,
after taking and validating a full board backup, and does nothing on a quiet week.

---

## 1. Feasibility: subscription, not API billing

The scheduled run authenticates with a **Claude subscription**, not pay-as-you-go
API credits.

- Run `claude setup-token` locally once (requires Pro / Max / Team / Enterprise) to
  mint a **~1-year OAuth token**. Store it as the secret `CLAUDE_CODE_OAUTH_TOKEN`.
- The headless run draws on the subscription's rate/usage limits, not a metered cap.
  A long grooming pass consumes weekly allowance, so keep the run bounded.
- Do **not** use `--bare` mode with the OAuth token (bare accepts only an API key).
- Token expires in ~1 year. Set a rotation reminder.

---

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Autonomy | **Fully autonomous.** The bot writes grooming, issue/project creation, and status moves directly. Backup + an after-the-fact run report are the safety net. |
| Groomed marker | **`groomed` label + a bot comment holding a content-hash** (detects later human edits and re-grooms). |
| Backup storage | **GitHub Actions artifact**, retention 90 days (the max), one uniquely named artifact per run so none are overwritten. Rolling ~13-week recovery window. |
| Write secret | **`LINEAR_API_KEY_WRITE`** — a GitHub Actions secret only. Never added to the Worker `generate:env` list or the `wrangler secret put` loop. |
| Client library | **`@linear/sdk`** (official, typed, handles pagination + rate-limit backoff). New root dev dependency. |
| Old manual tooling | `backfill-linear` skill and `linear-task-manager` agent are removed; conventions fold into a new `groom-linear` skill. |

---

## 3. Backup: no native API, GraphQL via the SDK

Linear offers **no backup or export API**. The UI CSV export is admin-only, manual,
emails a link that expires in ~12h, and omits attachments, so it cannot back an
automated job. The only automatable route is the GraphQL API, reached through
`@linear/sdk`, which paginates and backs off under the 1,500 req/hour limit for us.

Backup captures full fidelity (issues in every state, descriptions, comments,
labels, projects, estimates, priority, timestamps, urls) and serialises to one
timestamped JSON.

---

## 4. Reuse and deduplication

The Worker's roadmap client (`apps/api/src/platform/roadmap/linear-*.ts`) is
**deliberately the wrong shape to reuse for grooming** and must not be widened:

- Its `LinearIssue` type is a **privacy wall** that intentionally strips
  description, comments, assignee, estimate, priority, and urls
  (`linear-types.ts` header). Grooming needs exactly those fields.
- Its state enums are a **filtered subset** (`triage` and `canceled` excluded by
  the roadmap query). Grooming needs the full universe.
- It is **read-only** — no mutation knowledge lives in the repo.

What we reuse and dedupe:

- **Schema knowledge, for free.** Field names, the `teams(filter:{key:{eq}})`
  team lookup, pagination shape, and the enum universe are proven against live
  Linear (the roadmap client runs against real Linear in CI). This replaces the
  discovery spike. Write mutations come from `@linear/sdk`'s generated types,
  which are the schema guarantee — no manual spike needed.
- **Shared constants module** `packages/shared/src/linear/` exporting the team key
  `HUS`, the team ID `10ff187f-22ea-4449-a6d1-d5f7f8dfc9c9`, and the full issue /
  project state-type enums (Zod + inferred types). Both the grooming script and the
  Worker roadmap client import from here; the Worker re-narrows its own view. The
  module holds **only pure constants and enums** — no `@linear/sdk`, so
  `@hushbox/shared` stays dependency-light and the Worker bundle is untouched.
- The **full-fidelity grooming schema** stays local to `scripts/linear/`, with a
  comment stating it is deliberately not shared with the stripped roadmap type.

---

## 5. Architecture: `.github/workflows/groom-linear.yml`

Weekly cron plus `workflow_dispatch` (with a `dry_run` input). Three gated jobs.
The agent never runs unless backup succeeds and validates.

**Job 1 — `preflight` (plain scripts, no agent).**
1. `checkout` with `fetch-depth: 0` (all branches, for the commit scan).
2. **Backup + validate:** `pnpm linear:backup` dumps the full board via `@linear/sdk`
   to timestamped JSON, then validates: JSON parses, issue count matches the fetch,
   pagination completed, size floor met, and the count did not drop versus the last
   backup (hard fail on shrink unless `--allow-shrink`). Any failure exits non-zero,
   so the agent never runs.
3. `upload-artifact` (retention 90, unique name per run).
4. **No-op guard:** compute new *significant* commits since the watermark, and count
   ungroomed issues. Output `skip = (new_commits == 0 && ungroomed == 0)`.

**Job 2 — `groom` (`claude -p`, `CLAUDE_CODE_OAUTH_TOKEN`).** `needs: preflight`,
`if: skip == false`. Runs the two passes. Writes go through the delete-free
`board.ts` CLI. Honors `dry_run` (report-only, writes nothing).

**Job 3 — `watermark`.** `needs: groom`, `if: success && !dry_run`. Commits
`.linear-groom/state.json` (last commit SHA per branch + timestamp). **Only the
workflow shell touches git; the agent never does git writes**, keeping the repo's
git-write doctrine intact.

---

## 6. The two agent passes

- **Grooming pass** (commit-independent): for each issue lacking the current
  `groomed` marker, set difficulty (Linear **Estimate**), project, and
  `type:` / `area:` / `risk:` labels; rewrite the title to the public roadmap rules;
  polish the description meaning-locked; then apply the `groomed` label and refresh
  the hash comment.
- **Activity pass** (only when there are new commits): commits since the watermark
  across all branches, skipping trivial and dependency commits, classified to avoid
  duplicates (keyed off `HUS-N` references and open/closed state). Creates net-new
  issues or projects, and moves existing issues' status.

**"No commits does nothing"** is enforced two ways: the activity pass runs only when
new commits exist, and the whole `groom` job is skipped when there are zero new
commits and zero ungroomed items (so a quiet week spends no subscription usage).

---

## 7. Groomed marker mechanics

The `groomed` label means done. A bot comment stores `sha256(title + description)`
at groom time plus the pre-groom original text. Next run: label present and hash
matches means skip; hash mismatch (a human edited it) means re-groom. Difficulty
maps to the native **Estimate** field; priority to native **Priority**.

Difficulty scale (Estimate points): `1` trivial, `2` small, `3` medium, `5` large,
`8` extra-large. Metadata like this is inference, which is the point of grooming
(see §8).

---

## 8. Meaning-preservation guarantee

Two rules for two operations, stated explicitly in the agent brief:

- **Metadata** (difficulty, labels, project, status) is inference. Allowed.
- **Description text** is meaning-locked. The rewrite may change wording and
  structure only, never facts. Safeguards: a self-check pass ("does this add, drop,
  or change any fact versus the original? If so, revert"), the pre-groom original
  preserved in the hash comment for a one-click diff, and the full board recoverable
  from the backup artifact.

---

## 9. Safety model (no human gate)

Backup-before-run hard gate. Deletes and archives are denied at the `board.ts`
layer (the module never calls the SDK's delete/archive methods; a test asserts the
source contains no such call). Idempotent, marker-based passes (a mid-run
rate-limit cutoff resumes cleanly next week). An after-the-fact run report (Actions
summary) is the audit trail. A **1–2 week dry-run soak** runs before writes are
enabled, to prove meaning-preservation and no-duplicate behaviour on the real board.

---

## 10. The `.claude` reorganisation

- **Create** `.claude/skills/groom-linear/SKILL.md` — the autonomous brief. Folds in
  the Linear conventions (workspace, hierarchy, `type:` / `area:` / `risk:` labels,
  statuses, title rules, banned jargon, examples), the two passes, marker mechanics,
  and the no-op guard. Autonomous voice; approval-gate language removed. References
  `anti-ai-writing` for slop rules instead of duplicating them.
- **Delete** `.claude/skills/backfill-linear/` and
  `.claude/agents/linear-task-manager.md` (manual, approval-gated; recoverable from
  git). `write-blog` has no functional dependency on either (only a doc sync-note),
  so nothing breaks.
- **Edit** sync-notes in `.claude/skills/anti-ai-writing/SKILL.md` (lines 3 and 10)
  and `.claude/skills/write-blog/SKILL.md` (line 131) to drop the two removed files
  and reference `groom-linear`. Net effect: fewer duplicated copies to keep in sync.

---

## 11. Package commands

The repo convention is that workflow commands go through pnpm scripts. Two thin
wrappers, called by the workflow YAML (not for local use), bypassing
`scripts/with-env.ts` so they read secrets straight from `process.env` in CI:

- `linear:backup` → `tsx scripts/linear/board.ts backup …`
- `linear:groom` → the agent invocation, or the agent calls `board.ts` sub-commands.

---

## 12. File manifest

| Path | Action |
|---|---|
| `.github/workflows/groom-linear.yml` | create |
| `scripts/linear/board.ts` | create — `@linear/sdk` CLI: `backup` (dump + validate), `count-ungroomed`, and delete-free write commands. No delete/archive call exists in the module. |
| `scripts/linear/board.test.ts` | create — pure-logic tests (validation gate, hash marker, no-op guard, commit-triviality classifier, and the deny-delete source assertion). |
| `packages/shared/src/linear/` | create — team key, team ID, full state enums (pure). |
| `apps/api/src/platform/roadmap/linear-real.ts`, `linear-types.ts` | edit — consume the shared enums / constants; re-narrow the Worker view. |
| `.claude/skills/groom-linear/SKILL.md` | create |
| `.claude/skills/backfill-linear/` | delete |
| `.claude/agents/linear-task-manager.md` | delete |
| `.claude/skills/anti-ai-writing/SKILL.md`, `.claude/skills/write-blog/SKILL.md` | edit — sync notes |
| `package.json` | add `@linear/sdk` dev dependency + `linear:backup` / `linear:groom` scripts |
| `.linear-groom/state.json` | created at first successful run (the watermark) |

---

## 13. What the founder must provide

- Run `claude setup-token`, add `CLAUDE_CODE_OAUTH_TOKEN` secret.
- Create a Linear Personal API key, add `LINEAR_API_KEY_WRITE` secret. (Linear PATs
  carry the creator's full workspace permissions; there is no per-key read/write
  toggle. The existing `LINEAR_API_KEY_READ` is "read-only" only by how it is used.)
- Confirm a `groomed` label and an Estimate scale exist in HUS, or the bot creates
  the label on first run.

---

## 14. Build phases (spike removed)

1. Shared constants module + Worker refactor to consume it.
2. `board.ts` backup + validation + `count-ungroomed`, with tests. Wire the
   `preflight` job and artifact upload. Writes nothing to Linear; useful alone.
3. `groom-linear` skill + the `.claude` reorganisation.
4. `board.ts` write commands (delete-free) + the `groom` job, run in **dry-run**.
   Soak 1–2 weeks (report-only).
5. Flip writes on.

---

## 15. Risks and verify-at-implementation notes

- Fully-autonomous title/description rewrites on a public-facing roadmap with no
  human gate. Mitigated by backup, the run report, and the dry-run soak.
- 90-day artifact retention is the ceiling and, in autonomous mode, the only revert
  path. If longer recovery is ever wanted, R2 is the one place to revisit.
- Exact headless `claude` flags (`anthropics/claude-code-action@v1` versus the raw
  CLI) are settled during phase 4; the dry-run soak means a wrong flag writes
  nothing.
- The Linear write mutations are typed by `@linear/sdk`, which is the schema
  guarantee that replaces the spike; first real exercise is the dry-run then the
  first live run.
