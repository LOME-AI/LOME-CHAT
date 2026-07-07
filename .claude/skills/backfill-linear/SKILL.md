---
name: backfill-linear
description: Audit recent git history against current Linear state. Propose new tickets for unticketed work and updates for stale tickets. Zero writes without explicit per-item user approval. User-invoked, runs in dedicated session. May spawn linear-task-manager for actual ticket writing, or write tickets directly via Linear MCP.
---

# Backfill Linear from Git

You walk recent git history, classify each commit against current Linear state, and propose new tickets or updates. You write nothing without explicit per-item user approval.

> Sync notes:
> - The "Audience" and "Linear Usage" sections below are duplicated in `.claude/agents/linear-task-manager.md`. Keep them in sync.
> - The "Anti-Slop Rules" section below is duplicated in `.claude/skills/anti-ai-writing/SKILL.md`, `.claude/skills/write-blog/SKILL.md`, and `.claude/agents/linear-task-manager.md`. Keep them in sync.

## Audience

Tickets in the HUS workspace surface on **hushbox.ai/roadmap**. Today only the **title** is shown publicly; description, labels, status colour mapping, and URLs stay internal (`packages/shared/src/schemas/api/roadmap.ts` strips the rest). Treat the title as marketing copy a non-technical visitor must understand. Treat the description as engineering notes for the teammate who picks the work up next.

## Linear Usage

### Workspace and team

Workspace: **HushBox**. Team key: **HUS**. Team ID: `10ff187f-22ea-4449-a6d1-d5f7f8dfc9c9`.

### Hierarchy

| Level | Use for | When required |
|---|---|---|
| Project | A defined deliverable with a clear done state. Top-level container. | Optional. Skip for one-off issues |
| Milestone | Sub-stage of a project | Only when a project has ≥3 distinct phases needing separate done states |
| Issue | Atomic task, the default unit | Default for any piece of work |
| Sub-issue | Decomposition of an issue | Only when ≥3 internal steps need separate states |
| Cycle | Sprint timebox | Not in use |

### Labels (three orthogonal families, apply at most one from each)

**`type:`** — what kind of work
- `bug` — fixes broken behavior
- `feature` — new functionality
- `refactor` — implementation change, same observable behavior
- `doc` — documentation only
- `chore` — maintenance and cleanup that doesn't fit elsewhere

**`area:`** — where the change lives
- `api` — apps/api
- `web` — apps/web
- `marketing` — apps/marketing
- `crypto` — packages/crypto (cryptographic protocol code)
- `payments` — billing, Helcim, crypto payment integrations
- `mobile` — Capacitor, native iOS, native Android
- `auth` — OPAQUE, sessions, authorization
- `infra` — CI/CD pipelines, Docker, deployment config, env vars, build tooling
- `tooling` — scripts, ESLint config, codegen, internal dev tools

**`risk:`** — optional, sticky once applied
- `security`
- `perf`
- `reliability`

### Statuses

Triage, Backlog, Todo, In Progress, In Review, Done.

- New ticket defaults to **Triage** unless the user explicitly confirmed scope. If confirmed for later, use **Backlog**. If confirmed ready to start, use **Todo**.
- Never set In Progress on creation.

### Hard rules for writing

1. Never include information the user did not directly provide or explicitly approve. No inferred code paths, no inferred file refs, no assumed implementation details, no "this likely affects X". If you don't have it from the commit message or the user, it does not go in the ticket. Commit messages themselves are user-authored, so quoting them verbatim is fine, and citing the files a commit touched is fine (those are facts from `git show`).
2. Title: user-facing plain English, ≤70 chars, no trailing period.
   - Frame as a change a HushBox customer would notice or care about.
   - No internal jargon (see Banned Developer Jargon below).
   - Bug titles describe the broken behaviour in user terms, not the code path.
   - Imperative or noun-phrase, whichever a layperson reads faster.
3. Description: write for engineers. Be as technical as the work demands.
   - Lead with the load-bearing fact in one sentence: what changed, what broke, or what needs building.
   - Then the minimum context a teammate needs to act: affected paths, failing test name, regression SHA, schema field, protocol step.
   - File paths, function names, library names, error codes, table columns, env vars are encouraged when they save a future reader from re-discovering context.
   - Quote commit messages and error output verbatim when they're the primary evidence.
   - No padding, no throat-clearing, no restatement.
4. Confirm parent placement before any `create_*`. Ambiguous parent → ask the user.
5. Archive permitted; delete forbidden. Allowlist enforces this — do not attempt deletes.

### Title Examples

Titles tagged `type:feature` or `type:bug` reach the roadmap and need plain-English framing. Other types (`refactor`, `chore`, `doc`) stay internal and can be as technical as the description.

| Reject (developer voice) | Accept (correct voice for the type) |
|---|---|
| Implement OPAQUE password change flow | Change your password without re-encrypting your history (feature) |
| Fix Redis TTL on rate-limit keys | Rate limiter forgets recent failed attempts (bug) |
| Refactor Drizzle queries to use uuidv7 | Move primary keys to uuidv7 in the issue and session tables (refactor, internal) |
| Add Helcim webhook idempotency | Card top-ups never double-charge on retry (feature) |
| Migrate marketing site to Astro 5 | Bump Astro to 5.x and migrate breaking config (chore, internal) |
| Fix delete-account handler session leak | Deleted accounts sign you out of other devices (bug) |

### Banned Developer Jargon (titles only)

Titles surface on hushbox.ai/roadmap. Descriptions stay internal and may use any of these freely.

- **Library / protocol names:** OPAQUE, AEAD, XChaCha20, Argon2, ECIES, X25519, BIP39, Drizzle, Hono, Zod, Wrangler, Vite, Astro, Capacitor, Sandpack, Durable Object, Iron Session, Helcim API, OpenRouter.
- **Infra terms:** Worker, Redis, KV, R2 bucket, Postgres, Neon, Upstash, Cloudflare, queue, cron, cold start, edge cache, CDN, websocket.
- **Code shapes:** middleware, handler, hook, mutation, schema, migration, endpoint, route, payload, fixture, mock, stub.
- **HTTP / status codes:** 401, 403, 429, 503, "returns 200", "responds with".
- **File-path or symbol references:** `apps/api/...`, `packages/crypto/...`, function names, table names, env-var names.

Translate to behaviour in the title. Use the real names in the description.

### Description Density (descriptions only)

Anti-Slop rules target marketing-style padding in titles. Descriptions have a different failure mode: filler that adds words without adding signal. Reject "this PR addresses the issue where..." in favour of "Bug:". Reject "the following changes have been made:" in favour of a bare list. Cut every sentence that a teammate could delete without losing information.

## Anti-Slop Rules

AI-generated writing has recognizable fingerprints. Ticket descriptions must read as if a human with strong opinions and concrete knowledge wrote them. Every draft must pass this checklist before being presented to the user.

> Sync: this content is duplicated in `.claude/skills/anti-ai-writing/SKILL.md`, `.claude/skills/write-blog/SKILL.md`, and `.claude/agents/linear-task-manager.md`. If you modify rules here, update those files to match.

### Banned Vocabulary

If any of these words appear in the draft, replace them or restructure the sentence. No exceptions.

**Verbs:** delve, leverage, utilize, harness, streamline, underscore, embark, navigate (as metaphor), endeavour, elevate, foster, encompass

**Adjectives:** pivotal, robust, innovative, seamless, cutting-edge, groundbreaking, transformative, multifaceted, compelling, meticulous, vibrant, commendable, paramount, invaluable, comprehensive, crucial, vital

**Nouns:** landscape (digital/technological), realm, tapestry, synergy, testament, underpinnings, beacon, paradigm, journey (metaphorical)

**Transitions:** furthermore, moreover, consequently, notably, importantly, indeed, notwithstanding

**Filler phrases:** "it's important to note," "it's worth noting," "it bears mentioning," "one might argue," "from a broader perspective," "generally speaking," "to some extent"

**Filler adverbs:** effectively, efficiently, successfully, significantly, surprisingly, simply, seamlessly

### Banned Phrases & Openers

Never begin a draft, section, or paragraph with any of these:

- "In today's ever-evolving..."
- "In the fast-paced world of..."
- "As we navigate the complexities of..."
- "In conclusion / In summary / In essence..."
- "Imagine a world where..."
- "Let's dive in / Let's unpack this"
- "In an era where..."
- "It's no secret that..."
- "When it comes to..."

Never use these structures anywhere:

- "It's not just X, it's Y"
- "This is where X comes in"
- "X is more than just Y; it's Z"
- "It wasn't X, it was Y" (false-contrast kicker)

### Banned Structural Patterns

**No em-dashes.** Never use em-dashes. Use commas, semicolons, colons, periods, or parentheticals instead. Zero tolerance.

**Rule of three.** Do not list three adjectives, three short phrases, or three parallel clauses unless you are making a genuinely tripartite point. "Fast, secure, and private" is a real triad. "Dynamic, innovative, and transformative" is slop.

**Uniform paragraph length.** Vary deliberately. A one-sentence paragraph after a long one creates emphasis. A five-sentence paragraph after two short ones creates depth. If all paragraphs are 3-4 sentences, you've written AI slop.

**Hedging into oblivion.** Take positions. Say "this is worse" not "this may potentially be considered less optimal by some." Tickets have opinions about what should happen.

**Mic-drop kickers on every section.** One punchy closing line per ticket, maximum. If every section ends with a one-liner meant to land like a hammer, none of them land. Most sections should end mid-thought, or with a transition, or just... stop.

**Recursive summarization.** Do not restate what you just said in different words. If the previous paragraph explained the bug, the next paragraph should not begin with "In other words, the bug is..." Move forward.

**Mechanical bold formatting.** Do not bold key terms as if making "key takeaways" from a slide deck. Bold is for emphasis of specific words in specific moments, not for highlighting every occurrence of a concept.

**Avoiding contractions.** Use them. "You'll" not "You will." "Can't" not "Cannot." "It's" not "It is." Unless formality is doing specific rhetorical work, write like a person talks.

### What to Do Instead

- **Vary sentence length dramatically.** A long sentence that builds and qualifies and extends, followed by a short one. Then medium.
- **Use specific numbers, dates, names.** Not "many users" but "2.3 million users." Not "recently" but "in January 2026." Not "a major AI company" but "OpenAI."
- **Include sensory and concrete details.** Instead of "the experience is seamless," describe what actually happens: "User taps Pay. Wallet popup shows the address. They sign. Server polls chain for confirmation."
- **Have opinions.** The ticket is not a Wikipedia article. It argues for what should happen.
- **Leave some threads open.** Not every point needs a neat conclusion. Sometimes the most powerful move is to present a fact and let the reader sit with it.
- **Break a grammar rule when it sounds better.** Start a sentence with "And" or "But." Use a fragment for emphasis. End on a preposition if the alternative sounds stilted.

### The Final Slop Check

Before presenting any draft, run this exact checklist:

1. Ctrl+F every word in the banned vocabulary list. Replace all hits.
2. Read the first sentence of every paragraph. If more than two start with the same word or structure, rewrite.
3. Search for em-dashes. If any exist, replace them. Zero allowed.
4. Check paragraph lengths. If three consecutive paragraphs are the same length (within one sentence), rewrite one.
5. Read the last sentence of every section. If more than one is a "kicker" (short, punchy, meant to land hard), keep the best one and rewrite the rest.
6. Search for "not just...but" and "more than just...it's" constructions. Delete all of them.
7. Read the entire draft aloud (mentally). Flag anything that sounds like a JIRA template, a status report, a press release, or AI-generated boilerplate. Rewrite those parts.

## Workflow

1. Call `list_projects`, `list_issues` (open + recently closed), `list_issue_statuses`.
2. Walk `git log` backward from HEAD across: current branch, `main`, and every other local branch not yet merged to `main`.
3. Classify each commit (see Classification).
4. Stop walking when 10 consecutive commits are all Synced or Trivial. That's the "caught up" signal. Configurable via skill args (default 10).
5. Group multi-commit features into a single proposal where commit messages clearly belong together.
6. Compose proposals following Linear Usage and Anti-Slop Rules.
7. Present ranked preview + per-item drafts to user with approval prompt.
8. Wait for the user's approval string.
9. For each approved item, either: (a) call Linear MCP write tools directly, or (b) spawn the `linear-task-manager` agent with the approved draft for it to execute. Default: spawn `linear-task-manager` so all ticket writes funnel through the same approval-gated path.
10. Report URLs.

## Classification

- **Synced** — commit message references a Linear ticket key (HUS-N format), and that ticket exists in non-stale state (status reflects the commit's level of completion).
- **Trivial** — lint, format, typo, comment-only, merge commit, version bump, dependency bump.
- **Unticketed** — substantive change with no Linear key in the message.
- **Stale-ticket** — commit references a Linear key but the ticket's state lags behind the commit.

## Proposal format

```
RANKED PREVIEW
#N  new-ticket   <title>                  parent: <project or "?">       commits: <SHAs>
#N  update       <HUS-N> → <change>       commits: <SHAs>

PROPOSED #N
Type:        issue | sub-issue | project
Parent:      <name+ID or "?"> (will ask before write if "?")
Title:       <title>
Labels:      type:..., area:...
Status:      Backlog
Description:
<commit message verbatim>
---
PROPOSED #N
...

Approve? Reply "do #N" per item, "all", "all unticketed", or "skip #N".
```

## Output

Per executed item: `#N → <Linear URL>`. Nothing else.
