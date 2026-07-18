/**
 * HTML fixtures for the end-to-end engine scenarios. Pure data (exported string
 * constants) — imported by the analyze tests so a no-JS crawler's exact input is
 * reproducible offline.
 */

export const HEALTHY_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>The Healthy Page</title>
    <meta name="description" content="A fully server-rendered article with real content." />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="https://example.com/" />
    <meta property="og:title" content="The Healthy Page" />
    <meta property="og:description" content="A fully server-rendered article." />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="https://example.com/" />
    <meta property="og:site_name" content="Example" />
    <meta property="og:image" content="https://example.com/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="The Healthy Page" />
    <meta name="twitter:description" content="A fully server-rendered article." />
    <meta name="twitter:image" content="https://example.com/tw.png" />
    <script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "Article", "headline": "The Healthy Page" }
    </script>
  </head>
  <body>
    <main>
      <h1>The Healthy Page</h1>
      <p>This article is rendered entirely on the server so that every no-JavaScript
      crawler receives the full text immediately. There is more than enough real
      prose here for an AI model or a search engine to understand the topic,
      summarize it, and index the page without executing any client script at all.</p>
      <h2>Why server rendering matters</h2>
      <p>Because bots like GPTBot and ClaudeBot never run JavaScript, the words must
      already be present in the initial HTML payload they download in one request.</p>
    </main>
  </body>
</html>`;

export const SPA_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>My App</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/assets/app.js"></script>
  </body>
</html>`;

export const PAGE_WITH_MISSING_IMAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Article With A Broken Preview Image</title>
    <meta name="description" content="Good text, but the social preview image is broken." />
    <link rel="canonical" href="https://example.com/broken-image" />
    <meta property="og:title" content="Article With A Broken Preview Image" />
    <meta property="og:image" content="https://example.com/missing.png" />
  </head>
  <body>
    <main>
      <h1>Article With A Broken Preview Image</h1>
      <p>The body of this page has plenty of readable content for text crawlers to
      ingest, but the Open Graph image it advertises returns a 404, so social
      platforms cannot build a rich link preview card for it at all.</p>
    </main>
  </body>
</html>`;

export const CLOAKED_TO_BOT = `<!doctype html>
<html lang="en"><head><title>Members Only</title></head>
<body><main><h1>Please sign in</h1><p>This content is only available to signed-in members.</p></main></body></html>`;

export const CLOAKED_TO_BROWSER = `<!doctype html>
<html lang="en"><head><title>Members Only</title></head>
<body><main><h1>The Real Article</h1><p>Here is the genuine full article that a human
visitor sees but that the crawler was never shown, which is exactly what cloaking means.</p></main></body></html>`;

export const NOINDEX_TARGET_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Moved And De-indexed</title>
    <meta name="description" content="This page redirects here and is marked noindex by header." />
    <link rel="canonical" href="https://example.com/new" />
  </head>
  <body>
    <main>
      <h1>Moved And De-indexed</h1>
      <p>This destination page carries an X-Robots-Tag noindex response header, so
      search engines will drop it from their index even though the content loads.</p>
    </main>
  </body>
</html>`;
