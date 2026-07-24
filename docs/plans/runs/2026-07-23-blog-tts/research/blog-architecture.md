# Marketing blog architecture — research for blog TTS

Repo: `apps/marketing` (Astro 5, SSG). All paths relative to repo root.

## 1. Blog page structure

**Layouts**

- `apps/marketing/src/layouts/LandingLayout.astro` — generic marketing page shell (used by non-blog pages).
- `apps/marketing/src/layouts/BlogLayout.astro` — blog-specific shell. Wraps `<html>`/`<head>` with blog OG/Twitter meta, `article:*` meta tags, JSON-LD `Article` schema, RSS `<link>`, `ThemeScript`, the a11y init script, mounts `AnnouncementBanner`, `<slot />`, `A11yProvider` (`client:load`), `AccessibilityWidget` (`client:load`), `CrawlerEye`. Same skeleton pattern as `LandingLayout.astro` (both import `../styles/global.css`, both mount the a11y widget).

**Post template (the article page)**

`apps/marketing/src/pages/blog/[slug].astro` — the single dynamic route for every post (`getStaticPaths` from `getPublishedPosts()`, statically generated, one file per post at build time). Structure top to bottom:

```
<BlogLayout ...>
  <LandingHeader />
  <main class="mx-auto w-full max-w-5xl flex-1 px-6 pt-24 pb-12">
    <a href="/blog">&larr; Back to Blog</a>
    <header class="mt-8">
      <h1>{post.data.title}</h1>
      <div class="mt-4 flex items-center gap-3">      <!-- BYLINE ROW, see §1a -->
        <div class="... rounded-full ...">{initials}</div>
        <div>
          <div class="text-foreground text-sm font-medium">{post.data.author}</div>
          <div class="text-muted-foreground text-xs">
            <time datetime=...>{formattedDate}</time> · <span>{readingTime} min read</span>
          </div>
        </div>
      </div>
      {tags.length > 0 && <div class="mt-4 ...">{tag badges}</div>}
    </header>

    <details class="... lg:hidden">   <!-- mobile-only ToC -->
      <summary>On this page</summary>
      <TableOfContents headings={headings} client:visible />
    </details>

    <div class="mt-4 lg:grid lg:grid-cols-[1fr_220px] lg:gap-10">
      <article class="prose-blog max-w-none" data-reading>   <!-- ARTICLE BODY, see §2 -->
        <Content />
      </article>
      <aside class="hidden lg:block">          <!-- desktop-only ToC -->
        <div class="sticky top-28"><TableOfContents headings={headings} client:visible /></div>
      </aside>
    </div>

    <div class="... flex ... justify-between">
      <BlogDisclaimer date={post.data.date} />
      <ShareButton client:visible />
    </div>
    <div class="... border-t pt-8"><NewsletterSignup compact client:visible /></div>
    {relatedPosts.length > 0 && <BlogPostCard ... />}
  </main>
  <SiteFooter />
</BlogLayout>
```

### 1a. Exact byline markup — what "to the right of the author" means concretely

File: `apps/marketing/src/pages/blog/[slug].astro:65-79`.

```astro
<div class="mt-4 flex items-center gap-3">
  <div class="bg-brand-red-subtle text-brand-red flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold">
    {initials}
  </div>
  <div>
    <div class="text-foreground text-sm font-medium">{post.data.author}</div>
    <div class="text-muted-foreground text-xs">
      <time datetime={post.data.date.toISOString()}>{formattedDate}</time>
      <span aria-hidden="true"> &middot; </span>
      <span>{readingTime} min read</span>
    </div>
  </div>
</div>
```

The row is a flex container: `[avatar-initials-circle] [stacked author-name + date-and-readtime]`. There is no existing slot to the right of this block — it's a two-cell flex row (avatar, then a `<div>` stacking name over metadata), not a three-cell row. "To the right of the author" would mean either:
- appending a new flex sibling after the name/date `<div>` (would need `justify-between` or an added `ml-auto` element inside the outer `flex items-center gap-3` row), or
- adding a new element inside the metadata line, appended after the `{readingTime} min read` span (same text-xs muted-foreground row).

The initials avatar is computed inline at `[slug].astro:34-39` (first-letter of each word in `post.data.author`, uppercased, max 2 chars) — there is no author image field in the content schema (see §2).

### 1b. Listing/index page

`apps/marketing/src/pages/blog/index.astro` — post grid using `BlogPostCard.astro` (`apps/marketing/src/components/blog/BlogPostCard.astro`), plus `BlogSearch.tsx` (client React island) for client-side search/filter. `BlogPostCard` shows author/date/read-time in the same three-`&middot;`-separated inline row (`apps/marketing/src/components/blog/BlogPostCard.astro:31-38`), no avatar circle there.

Also present: `apps/marketing/src/pages/blog-index.json.ts` (a JSON endpoint, likely feeding `BlogSearch`) and `apps/marketing/src/pages/rss.xml` presumably (RSS via `@astrojs/rss`, referenced in `BlogLayout.astro:48`).

## 2. Content storage & runtime DOM extraction of article text

**Storage**: Astro content collection, MDX files under `apps/marketing/src/content/blog/*.mdx`. Collection defined in `apps/marketing/src/content.config.ts`:

```ts
const blog = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/blog' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    description: z.string().max(160),
    author: z.string(),
    date: z.date(),
    tags: z.array(z.string()),
    image: image().optional(),
    draft: z.boolean().default(false),
  }),
});
export const collections = { blog };
```

No `authorImage`/`authorAvatar` field — avatar is always the computed-initials circle. Current posts (5): `a-judge-just-ruled-your-ai-chats-are-evidence.mdx`, `what-happens-to-everything-you-tell-your-ai.mdx`, `what-is-opaque-authentication.mdx`, `why-we-published-our-source-code.mdx`, `youre-probably-overpaying-for-ai.mdx`.

Rendering: `[slug].astro` calls `const { Content, headings } = await render(post);` (astro:content `render()`) — `<Content />` emits fully static HTML at build time (MDX → HTML, no client-side content fetch/hydration for the body itself). `getReadingTime(post.body ?? '')` (from `apps/marketing/src/lib/blog-utilities.ts:24-27`) does word-count on the raw MDX source string, not the DOM.

**DOM structure of the article body at runtime** (post-build, in-browser):

```html
<article class="prose-blog max-w-none" data-reading>
  <!-- MDX-compiled HTML: h2/h3/h4 (each carries `id` from Shiki/rehype slug plugin,
       referenced by TableOfContents `headings[].slug`), p, a, blockquote, pre>code,
       inline code, img, figcaption, ul/ol/li, hr, table/th/td -->
</article>
```

- Container selector: `article.prose-blog[data-reading]` (there is exactly one per post page — safe to `querySelector('article[data-reading]')` or `.prose-blog`).
- `data-reading` is **not** currently a TTS/read-extraction hook — it's an accessibility typography marker (comment at `apps/web/src/components/chat/message/message-body.tsx:55-57`: "data-reading flips this bubble's subtree to the editorial serif (twin of `data-chrome`)"). It is stamped identically on `apps/marketing/src/pages/terms.astro:30`, `apps/marketing/src/pages/privacy.astro:32`, the blog `<article>`, and in `apps/web` on auth subtitles / chat-welcome / chat message bubbles. No code today queries `[data-reading]` for content extraction — grep across the repo found zero consumers (only producers). It would be a natural, low-risk selector to key a "read this article aloud" feature off of, since it already demarcates exactly the editorial-prose regions site-wide, but that association would be new, not existing behavior.
- Headings carry stable `id`s (`headings[].slug`, consumed by `TableOfContents.tsx` for scroll-spy/anchors) — usable for chunked/paragraph-level reading-position tracking.
- No code fences currently ship in any blog post (`astro.config.mjs` comment notes this is a known CSP constraint — Shiki emits per-token inline styles that break the hashed `style-src`).

## 3. React islands / client-side hydration on marketing today

**Astro integrations** (`apps/marketing/astro.config.mjs`): `mdx()`, `react()` (`@astrojs/react`), `sitemap()`. React hydration is fully wired up already — this is not a new capability to add.

**Existing `client:*` usage** (grepped across `apps/marketing/src`):

| Component | Directive | Where |
|---|---|---|
| `A11yProvider` | `client:load` | `LandingLayout.astro`, `BlogLayout.astro` |
| `AccessibilityWidget` | `client:load` | `LandingLayout.astro`, `BlogLayout.astro` |
| `TableOfContents` | `client:visible` | `blog/[slug].astro` (both mobile `<details>` and desktop `<aside>` instances) |
| `ShareButton` | `client:visible` | `blog/[slug].astro` |
| `NewsletterSignup` | `client:visible` | `blog/[slug].astro`, elsewhere |
| `BlogSearch` | presumably hydrated on `blog/index.astro` (not directly inspected, but is a `.tsx` in `components/blog/`) |

Pattern: interactive one-off widgets are plain `.tsx` files under `src/components/**`, imported directly into `.astro` files with a `client:*` directive — no separate "islands" folder convention beyond colocation by feature (`components/blog/`, `components/newsletter/`, `components/roadmap/`, `components/stats/`, `components/ui/`).

**Imports from `packages/ui` / `apps/web`**: marketing imports extensively from `@hushbox/ui` (workspace package: `Badge`, `cn`, `A11yProvider`, `AccessibilityWidget`, `A11Y_INIT_SCRIPT`, font/asset paths, accessibility styles/banner CSS) — confirmed via `apps/marketing/package.json` dependency and imports in `BlogLayout.astro`, `LandingLayout.astro`, `BlogPostCard.astro`, `TableOfContents.tsx`. Marketing does **not** import from `apps/web` (`grep` for `apps/web|@hushbox/web` in `apps/marketing/src` returned no hits). One import runs the other direction: `apps/web/src/lib/theme-flash-script.ts` references `apps/marketing` (likely a comment/shared-logic pointer, not a build import — `apps/web` cannot depend on `apps/marketing` as a package since marketing has no build output package name consumed elsewhere). Confirmed by `eslint-plugin-boundaries` config comments in `packages/config/eslint.config.js` (lines ~50, ~380, ~463) which explicitly name `apps/web`, `apps/marketing`, `packages/ui` as the three trees sharing the React/JSX lint config and `src`-root-relative rules — i.e. slice-boundary tooling already treats marketing as a first-class consumer of `packages/ui`.

## 4. Shared code between apps/marketing, apps/web, and packages/*

- **`@hushbox/ui`** (`packages/ui`) — the primary shared surface. Marketing consumes: root export (`Badge`, `cn`, etc. via `.` → `./src/index.ts`), `@hushbox/ui/fonts` (self-hosted brand fonts, shared face-face CSS), `@hushbox/ui/accessibility` + `@hushbox/ui/accessibility/styles` + `@hushbox/ui/accessibility/init-script` (the entire accessibility widget/provider — same instance used across both apps), `@hushbox/ui/banner` + `@hushbox/ui/banner/styles`, `@hushbox/ui/assets/*` (e.g. favicon). Package exports map (`packages/ui/package.json`) also has TTS-related subpath exports not yet imported by marketing: `./accessibility/lib/tts-engine`, `./accessibility/lib/tts-stream-feeder`, `./accessibility/lib/sentence-chunker`, `./accessibility/store`.
- **`@hushbox/shared`** — listed as a marketing dependency but not seen directly imported in the files inspected (used at least transitively / for types).
- **`@hushbox/crypto`** — listed as a marketing dependency (used elsewhere on the marketing site, e.g. the encryption demo components referenced by `encryption-demo.test.tsx`/`encryption-demo-fallback.test.tsx`).
- **`@hushbox/config`** — devDependency; supplies `@hushbox/config/tailwind` (design tokens, see §5) and presumably shared ESLint/TS config, consistent with the rest of the monorepo.
- **No dependency on `apps/web`** — confirmed no imports in either direction as a package; the one `apps/web` file referencing "apps/marketing" (`src/lib/theme-flash-script.ts`) is not a build-time cross-app import (Vite apps don't resolve sibling app source paths).

## 5. Styling system & dark mode

**Tailwind**: Astro Tailwind v4 via the Vite plugin (`@tailwindcss/vite`, wired in `astro.config.mjs` `vite.plugins`), not the (older) `@astrojs/tailwind` integration. Marketing's own stylesheet `apps/marketing/src/styles/global.css` imports the **same shared token file the web app uses**:

```css
@import '../../../../packages/config/tailwind/index.css';
```

— which is exactly the package `apps/web/src/app.css` imports as `@import '@hushbox/config/tailwind';` (verified: `packages/config/tailwind/index.css` defines `--brand-red`, `--background`, `--foreground`, `--border`, semantic `--error/--warning/--info/--success`, etc., under `:root`, plus `@custom-variant dark (&:is(.dark *));`). So marketing and the web app render off **one identical design-token source** — same brand colors, same dark-mode variant strategy (a `.dark` class ancestor flips `@custom-variant dark`).

Marketing also layers in: `@hushbox/ui/fonts` (brand fonts), `@source` globs pointing at `packages/ui/src/components/{marketing,cipher-wall,accessibility}/**/*.tsx` (so Tailwind's content scanner picks up classes used inside those shared component trees), `@hushbox/ui/accessibility/styles`, and `@hushbox/ui/banner/styles`.

**Blog-specific prose styling**: `.prose-blog` utility class block in `global.css` (lines 55-137) — a hand-rolled prose/typography layer (not `@tailwindcss/typography`) styling `h2`-`h4` (brand-red headings), `p`, `a`, `blockquote`, `pre`/`code`, `img`, `figcaption`, lists, `hr`, tables, and a special rule for the "Sources" section (`h2#sources ~ ol a` gets link styling). Applied via `<article class="prose-blog max-w-none" data-reading>` in `[slug].astro`.

**Dark mode mechanism**: `apps/marketing/src/components/ThemeScript.astro` — an `is:inline` blocking `<script>` in `<head>` (loaded by both `BlogLayout.astro` and `LandingLayout.astro`) that reads `localStorage.getItem('themeMode')` and toggles `document.documentElement.classList.add('dark')`, falling back to `prefers-color-scheme: dark` when nothing is saved. Comment confirms: *"same key as the SPA"* — i.e. `themeMode` in `localStorage` is the same key `apps/web`'s theme toggle writes, so a user's dark-mode choice in the app carries over to the marketing/blog site (no live sync while both are open simultaneously; it's read once at page load, matching the SSG/no-hydration-by-default nature of Astro pages).

## Summary of items directly relevant to a blog-TTS feature

- **Read-aloud engine already exists** and is production-wired: `packages/ui/src/components/accessibility/lib/tts-engine.ts` (`getTtsService()`, on-device Kokoro-82M ONNX/WASM model, worker pool of 4, 5 voices, `speak(text, voice)`/`stop()`), plus `sentence-chunker.ts` and `tts-stream-feeder.ts` for streaming/chunked text. Currently the only consumer is chat "read replies aloud" (`packages/ui/src/components/accessibility/sections/audio.tsx`, gated by `useA11yStore` `ttsEnabled`/`streamChatAloud`). There is no existing "read this page/article" feature — building blog TTS would be net-new wiring of an existing, already-shared engine, not a new engine.
- **`data-reading`** is a pre-existing, unconsumed marker already sitting exactly on the blog `<article>` (and on `terms.astro`/`privacy.astro` and various `apps/web` editorial text) — a plausible, already-present selector for "this is the readable prose to speak," but no code currently treats it that way; that would be new behavior.
- The blog `<article>` is the sole per-page container of MDX-rendered static HTML (`article.prose-blog[data-reading]`); headings inside carry stable `id`s for position tracking.
- Marketing already has full React-island hydration (`@astrojs/react`, several `client:visible`/`client:load` components) and already depends on `@hushbox/ui`, including the TTS subpath exports (unused today) — no new integration or package-boundary work needed to add a client-side "listen to this post" island.
