---
name: write-blog
description: Write a blog post for the HushBox marketing site (hushbox.ai/blog). Use this skill whenever the user wants to create, draft, plan, or iterate on a blog post. Trigger on mentions of "blog", "blog post", "write a post", "new article", "content for the blog", or any reference to hushbox.ai/blog content creation. This skill handles the full lifecycle — topic research, outline, drafting, anti-slop review, and final MDX file output. It does NOT handle the Astro engineering setup (content collection config, page templates, RSS feed) — only the content creation workflow.
argument-hint: Topic and author — e.g. "Why your AI conversations should be encrypted — author: Sarah Chen"
---

# Write Blog Post for HushBox

This skill produces a single MDX blog post file ready to drop into `apps/marketing/src/content/blog/`. One file, one post, zero engineering friction.

## Input

This skill takes one argument from the user:

**`topic_and_author`** — A short description of what the blog post is about and who the author is. Example: `"Why your AI conversations should be encrypted — author: Alex Chen"` or `"GPT-4o vs Claude Sonnet vs Gemini comparison — author: HushBox Team"`.

If the user doesn't provide an author, default to `"HushBox Team"`.

---

## Workflow

### Step 1: Research & Plan

Before writing a single sentence:

1. **Search the web** for the topic. Find current data, recent news, competitor claims, pricing pages, documentation — anything the post will reference. Gather specific numbers, dates, quotes, and facts. Every factual claim in the final post must trace back to a verified source.
2. **Search the codebase** if the topic involves HushBox features (OPAQUE, encryption, architecture, pricing). Read the actual source code in `apps/` and `packages/`. Do not describe features from memory — verify them against the code. The code is the only source of truth for what HushBox does.
3. **Discover existing tags.** Read all `.mdx` files in `apps/marketing/src/content/blog/` and extract the `tags` arrays from their frontmatter. Collect the full set of tags currently in use across all published posts.
4. **Present a plan to the user** that includes:
   - The angle / thesis (one sentence: what should the reader believe after reading this?)
   - 3–5 section headings (rough, not final)
   - Key facts and data points you found, with sources
   - Which voice blend fits this topic (see Voice section below)
   - Estimated word count (target: 1,200–2,000 words)
   - **Proposed tags**, marking each as `(existing)` if it's already used by another post, or `(new)` if this would be its first use. This keeps the tag namespace intentional without a rigid taxonomy.

### Step 2: Iterate with the User

Ask the user pointed questions before drafting. Examples:

- "I found [competitor] claims [X] on their pricing page. Do you want to address this directly or leave it implicit?"
- "The OPAQUE implementation in `packages/crypto/` uses [specific detail]. Should we go this deep or keep it conceptual?"
- "This topic could go technical-explainer (Feynman voice) or moral-argument (Hitchens voice). Which feels right?"
- "I found three conflicting stats about [topic]. Here they are — which source do you trust?"

Do NOT proceed to drafting until the user confirms the plan.

### Step 3: Draft

Write the full post as an MDX file. Follow every rule in the Voice and Anti-Slop sections below. After drafting:

1. Run the complete Anti-Slop Checklist (see below) against your own draft
2. Flag any violations and fix them before showing the user
3. Present the draft to the user for review

### Step 4: Revise

Incorporate feedback. Repeat until the user approves. Then output the final `.mdx` file to `apps/marketing/src/content/blog/`.

---

## Output Format

Every blog post is a single `.mdx` file with this frontmatter:

```mdx
---
title: 'Why Your AI Conversations Should Be Encrypted'
description: 'A short meta description for SEO and social cards, under 160 characters.'
author: 'Alex Chen'
date: 2026-03-27
tags: ['privacy', 'encryption']
draft: false
---

Post body here.

---

## Sources

1. [OpenAI Privacy Policy](https://openai.com/privacy)
2. [OPAQUE: An Asymmetric PAKE Protocol](https://eprint.iacr.org/2018/163)
```

Every post MUST end with a `## Sources` section. Every external factual claim in the post must have a corresponding numbered source link here. Sources are rendered as colored clickable links. Codebase references (verified by reading actual code) do not need a source entry — only external references do.

**File naming convention:** Slugified title, lowercase, hyphens. Example: `why-your-ai-conversations-should-be-encrypted.mdx`

---

## Voice

### Influences — Combine as the Topic Demands

No single voice dominates. Draw from several depending on what the section needs:

**Thomas Aquinas** — Steelman the opposition's best argument, then dismantle it with patient logic. Use when addressing counterarguments, competitor defenses, or "but what about..." objections. Never straw-man. Present the strongest version of the other side, then answer it.

**George Orwell** — Say what you mean at the cost of comfort. Translate corporate euphemism into plain truth. When a competitor says "we may use your data to improve our services," this voice says what that actually means. No hedging, no softening, no weasel words.

**Richard Feynman** — Explain complex things with joy and zero condescension, as if talking to a smart friend at a bar. Use for technical explainers: cryptography, protocols, architecture. Assume the reader is intelligent but not specialist. If you use a technical term, explain it immediately. If the explanation is longer than the term, use the explanation instead.

**Christopher Hitchens** — Morally uncompromising, rhetorically sharp. Make the reader feel foolish for having accepted the status quo. Use for conclusions, calls to action, and pieces where you're making a moral argument about privacy or data rights. Earn moral authority through argument, don't assert it.

**Paul Graham** — Build from first principles, conversational register, treat the reader as an intelligent peer. Use for comparison pieces, economic arguments, and "the true cost of X" posts. The voice HN and Reddit audiences already respect.

**Nassim Taleb** — Follow the money and the incentives. Expose asymmetries where one party bears risk and another profits. Use for pricing model comparisons, subscription vs. pay-per-use arguments, and any discussion of business model alignment.

### Voice Blending in Practice

A single post might use:

- Feynman's clarity for the technical explainer section
- Aquinas's structure when addressing counterarguments
- Orwell's directness when comparing competitor privacy policies
- Taleb's incentive-tracing when discussing pricing models
- Hitchens's moral urgency in the conclusion

The voice should never feel like a costume. It should feel like the natural way a principled, technically fluent person would explain this topic to someone they respect.

### Core Adjectives for All Posts

Lucid. Principled. Unhurried. Precise. Confident without arrogance. Technically honest.

---

## Anti-Slop Rules

> Sync: this content is duplicated in `.claude/skills/anti-ai-writing/SKILL.md`, `.claude/agents/linear-task-manager.md`, and `.claude/skills/backfill-linear/SKILL.md`. If you modify rules here, update those files to match.

This is the most important section of this skill. AI-generated writing has recognizable fingerprints. HushBox's blog must read as if a human with strong opinions and deep knowledge wrote it. Every draft MUST pass this checklist before being shown to the user.

### Banned Vocabulary

If any of these words appear in the draft, replace them or restructure the sentence. No exceptions.

**Verbs:** delve, leverage, utilize, harness, streamline, underscore, embark, navigate (as metaphor), endeavour, elevate, foster, encompass

**Adjectives:** pivotal, robust, innovative, seamless, cutting-edge, groundbreaking, transformative, multifaceted, compelling, meticulous, vibrant, commendable, paramount, invaluable, comprehensive, crucial, vital

**Nouns:** landscape (digital/technological), realm, tapestry, synergy, testament, underpinnings, beacon, paradigm, journey (metaphorical)

**Transitions:** furthermore, moreover, consequently, notably, importantly, indeed, notwithstanding

**Filler phrases:** "it's important to note," "it's worth noting," "it bears mentioning," "one might argue," "from a broader perspective," "generally speaking," "to some extent"

**Filler adverbs:** effectively, efficiently, successfully, significantly, surprisingly, simply, seamlessly

### Banned Phrases & Openers

Never begin a post, section, or paragraph with any of these:

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

**No em-dashes.** Never use em-dashes (—). Use commas, semicolons, colons, periods, or parentheticals instead. Zero tolerance.

**Rule of three.** Do not list three adjectives, three short phrases, or three parallel clauses unless you are making a genuinely tripartite point. "Fast, secure, and private" is a real triad. "Dynamic, innovative, and transformative" is slop.

**Uniform paragraph length.** Vary deliberately. A one-sentence paragraph after a long one creates emphasis. A five-sentence paragraph after two short ones creates depth. If all your paragraphs are 3–4 sentences, you've written AI slop.

**Hedging into oblivion.** Take positions. Say "this is worse" not "this may potentially be considered less optimal by some." The blog has opinions. That's the point.

**Mic-drop kickers on every section.** One punchy closing line per post, maximum. If every section ends with a one-liner meant to land like a hammer, none of them land. Most sections should end mid-thought, or with a transition, or just... stop.

**Recursive summarization.** Do not restate what you just said in different words. If the previous paragraph explained how OPAQUE works, the next paragraph should not begin with "In other words, OPAQUE ensures that..." Move forward.

**Mechanical bold formatting.** Do not bold key terms as if making "key takeaways" from a slide deck. Bold is for emphasis of specific words in specific moments, not for highlighting every occurrence of a concept.

**Avoiding contractions.** Use them. "You'll" not "You will." "Can't" not "Cannot." "It's" not "It is." Unless formality is doing specific rhetorical work, write like a person talks.

### What to Do Instead

- **Vary sentence length dramatically.** A long sentence that builds and qualifies and extends, followed by a short one. Then medium.
- **Use specific numbers, dates, names.** Not "many users" but "2.3 million users." Not "recently" but "in January 2026." Not "a major AI company" but "OpenAI."
- **Include sensory and concrete details.** Instead of "the experience is seamless," describe what actually happens: "You type your password. Nothing leaves your device. The server never sees it."
- **Have opinions.** The blog is not a Wikipedia article. It argues positions.
- **Leave some threads open.** Not every point needs a neat conclusion. Sometimes the most powerful move is to present a fact and let the reader sit with it.
- **Break a grammar rule when it sounds better.** Start a sentence with "And" or "But." Use a fragment for emphasis. End on a preposition if the alternative sounds stilted.

### The Final Slop Check

Before presenting the draft, run this exact checklist:

1. Ctrl+F every word in the banned vocabulary list. Replace all hits.
2. Read the first sentence of every paragraph. If more than two start with the same word or structure, rewrite.
3. Search for em-dashes (—). If any exist, replace them. Zero allowed.
4. Check paragraph lengths. If three consecutive paragraphs are the same length (within one sentence), rewrite one.
5. Read the last sentence of every section. If more than one is a "kicker" (short, punchy, meant to land hard), keep the best one and rewrite the rest.
6. Search for "not just...but" and "more than just...it's" constructions. Delete all of them.
7. Read the entire post aloud (mentally). Flag anything that sounds like a press release, a LinkedIn post, or a college application essay. Rewrite those parts.

---

## Data Integrity Rules

Every factual claim must be verified. There are two sources of truth:

1. **The internet** — for competitor features, pricing, industry stats, news, and general technical facts. Always search. Never cite from memory. If you can't find a source, don't make the claim.
2. **The HushBox codebase** — for anything about HushBox's own features, architecture, or implementation. Read the actual code in `apps/` and `packages/`, not just documentation files. If the post says "HushBox uses OPAQUE for authentication," you must have read the OPAQUE implementation in `packages/crypto/` and confirmed this is true in the current code.

**Never:**

- Invent statistics
- Describe a competitor's feature without checking their current documentation
- Describe a HushBox feature without reading the code
- Use phrases like "studies show" without a specific study
- Round numbers in a misleading direction

**If you're unsure, say so in the post.** "We haven't independently verified this claim" is better than presenting an unverified number as fact. Honesty is a brand pillar.
