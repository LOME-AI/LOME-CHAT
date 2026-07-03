import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKETING_ROUTES, ROUTES } from '../packages/shared/src/routes.js';
import {
  generateHeaders,
  computePageCsp,
  deriveApiOrigin,
  deriveLocalR2Origin,
} from './generate-headers.js';
import { parseHeadersFile, matchHeaders } from './lib/headers-vite-plugin.js';

let repoRoot: string;

async function makeTemporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'generate-headers-'));
}

async function writeHtml(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function sha256Token(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

function htmlWithInlineScripts(...bodies: string[]): string {
  const scripts = bodies.map((b) => `<script>${b}</script>`).join('');
  return `<!DOCTYPE html><html><head>${scripts}</head><body></body></html>`;
}

function blockHead(block: string): string {
  return block.split('\n')[0] ?? '';
}

/**
 * Write the SPA shell `dist/index.html` that the `/*` (and inherited `/demo`)
 * blocks serve. Defaults to a script-free shell so tests asserting a hashless
 * `/*` stay valid; pass inline-script bodies to exercise SPA-shell hashing.
 */
async function seedSpaShell(distributionDir: string, ...bodies: string[]): Promise<void> {
  const html =
    bodies.length > 0
      ? htmlWithInlineScripts(...bodies)
      : '<!DOCTYPE html><html><head></head><body></body></html>';
  await writeHtml(path.join(distributionDir, 'index.html'), html);
}

async function seedAllMarketingRoutes(distributionDir: string): Promise<void> {
  await seedSpaShell(distributionDir);
  for (const route of MARKETING_ROUTES) {
    const prefix = route.replace(/^\//, '');
    await writeHtml(
      path.join(distributionDir, prefix, 'index.html'),
      htmlWithInlineScripts(`/*${route}*/`)
    );
  }
}

/**
 * Strip the file banner / comment lines so assertions don't trip on tokens
 * (`localhost`, `script-src`, `connect-src`) that appear in directive-notes
 * prose. The banner is documentation; only the directives below it govern
 * what the browser enforces.
 */
function stripComments(content: string): string {
  return content
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
}

// Most tests don't care about MinIO; clearing this keeps them deterministic
// regardless of what's in the dev shell when `pnpm test` is run.
// Tests that DO care opt in by passing `minioApiPort` explicitly or by
// manipulating `process.env.HB_MINIO_API_PORT` inside the test body.
let originalMinioPort: string | undefined;

beforeEach(async () => {
  repoRoot = await makeTemporaryRoot();
  originalMinioPort = process.env['HB_MINIO_API_PORT'];
  delete process.env['HB_MINIO_API_PORT'];
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
  if (originalMinioPort === undefined) delete process.env['HB_MINIO_API_PORT'];
  else process.env['HB_MINIO_API_PORT'] = originalMinioPort;
});

describe('computePageCsp', () => {
  it('hashes the body of every inline <script>', () => {
    const html = htmlWithInlineScripts('console.log(1)', 'console.log(2)');
    const csp = computePageCsp(html);
    expect(csp.scriptHashes).toEqual([
      sha256Token('console.log(1)'),
      sha256Token('console.log(2)'),
    ]);
  });

  it('ignores <script src=...> external loads', () => {
    const html = `<html><script src="/x.js"></script><script>inline</script></html>`;
    const csp = computePageCsp(html);
    expect(csp.scriptHashes).toEqual([sha256Token('inline')]);
  });

  it('hashes <script is:inline> blocks (treated like any other inline script)', () => {
    const html = `<html><script is:inline>theme()</script></html>`;
    const csp = computePageCsp(html);
    expect(csp.scriptHashes).toEqual([sha256Token('theme()')]);
  });

  it('deduplicates identical inline script bodies', () => {
    const html = htmlWithInlineScripts('a', 'a', 'b');
    const csp = computePageCsp(html);
    expect(csp.scriptHashes).toEqual([sha256Token('a'), sha256Token('b')]);
  });

  it('hashes empty <script></script> as the SHA-256 of the empty string', () => {
    const html = htmlWithInlineScripts('');
    const csp = computePageCsp(html);
    expect(csp.scriptHashes).toEqual([sha256Token('')]);
  });

  it('returns empty array when no inline scripts exist', () => {
    const html = `<html><script src="/x.js"></script></html>`;
    const csp = computePageCsp(html);
    expect(csp.scriptHashes).toEqual([]);
  });
});

describe('generateHeaders', () => {
  it('emits one block per marketing route plus the SPA fallback', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });

    expect(result.pagesProcessed).toBe(MARKETING_ROUTES.length);
    // Each marketing page emits two blocks (`/route` + `/route/`), plus the SPA
    // `/*` fallback and the two `/demo` + `/demo/*` iframe-override blocks.
    expect(result.blocksEmitted).toBe(MARKETING_ROUTES.length * 2 + 3);
    const content = await fs.readFile(result.outputPath, 'utf8');
    for (const route of MARKETING_ROUTES) {
      expect(content).toMatch(new RegExp(`^${route}$`, 'm'));
    }
    expect(content).toMatch(/^\/\*$/m);
  });

  it('throws when the dist path is not a directory', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await fs.mkdir(path.dirname(distribution), { recursive: true });
    await fs.writeFile(distribution, 'not a directory');

    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      'to be a directory'
    );
  });

  it('rethrows non-ENOENT errors from the dist directory check', async () => {
    // apps/web is a FILE, so stat("apps/web/dist") fails with ENOTDIR — a
    // genuine filesystem error that must surface, not the friendly hint.
    await fs.mkdir(path.join(repoRoot, 'apps'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'apps/web'), 'a file in the way');

    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      /ENOTDIR/
    );
  });

  it('rethrows non-ENOENT errors from reading a route directory', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await fs.mkdir(distribution, { recursive: true });
    // The first marketing route exists as a FILE, so readdir fails with
    // ENOTDIR instead of ENOENT and must surface unchanged.
    const prefix = MARKETING_ROUTES[0].replace(/^\//, '');
    await fs.writeFile(path.join(distribution, prefix), 'a file in the way');

    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      /ENOTDIR/
    );
  });

  it('throws when a route directory has no built index.html', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    for (const route of MARKETING_ROUTES) {
      const prefix = route.replace(/^\//, '');
      await fs.mkdir(path.join(distribution, prefix), { recursive: true });
    }

    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      'produced no index.html'
    );
  });

  it('emits a hashless script-src for pages without inline scripts', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    // Script-free SPA shell: generateHeaders requires dist/index.html to
    // exist, and a shell without inline scripts keeps the /* block hashless.
    await seedSpaShell(distribution);
    for (const route of MARKETING_ROUTES) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(
        path.join(distribution, prefix, 'index.html'),
        '<!DOCTYPE html><html><head></head><body></body></html>'
      );
    }

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = stripComments(await fs.readFile(result.outputPath, 'utf8'));

    expect(content).toContain('script-src');
    expect(content).not.toContain('sha256-');
  });

  it('emits the marketing block at both path forms (slash + no-slash)', async () => {
    // Cloudflare Pages serves Astro's `<route>/index.html` at `/route/`
    // (trailing slash, after a 308 redirect from `/route`). Its `_headers`
    // matching is exact, so the hashed block must be keyed at BOTH path
    // forms. Otherwise the hashed CSP applies only to the 308 redirect
    // and the actual HTML response falls through to the SPA `/*` block
    // with no hashes, blocking every inline Astro hydration script.
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedSpaShell(distribution);
    await writeHtml(path.join(distribution, 'welcome/index.html'), htmlWithInlineScripts('alpha'));
    await writeHtml(path.join(distribution, 'blog/index.html'), htmlWithInlineScripts('blog-idx'));
    await writeHtml(
      path.join(distribution, 'blog/post-a/index.html'),
      htmlWithInlineScripts('post-a')
    );
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/welcome' && r !== '/blog')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(path.join(distribution, prefix, 'index.html'), htmlWithInlineScripts('x'));
    }

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    for (const route of MARKETING_ROUTES) {
      expect(content).toMatch(new RegExp(`^${route}$`, 'm'));
      expect(content).toMatch(new RegExp(`^${route}/$`, 'm'));
    }
    expect(content).toMatch(/^\/blog\/post-a$/m);
    expect(content).toMatch(/^\/blog\/post-a\/$/m);

    const blocks = content.split('\n\n');
    const welcomeNoSlash = blocks.find((b) => blockHead(b) === '/welcome');
    const welcomeSlash = blocks.find((b) => blockHead(b) === '/welcome/');
    const postNoSlash = blocks.find((b) => blockHead(b) === '/blog/post-a');
    const postSlash = blocks.find((b) => blockHead(b) === '/blog/post-a/');

    expect(welcomeNoSlash).toContain(sha256Token('alpha'));
    expect(welcomeSlash).toContain(sha256Token('alpha'));
    expect(postNoSlash).toContain(sha256Token('post-a'));
    expect(postSlash).toContain(sha256Token('post-a'));
    expect(welcomeSlash).not.toContain(sha256Token('post-a'));
    expect(postSlash).not.toContain(sha256Token('alpha'));
  });

  it('emits the SPA `/*` block first, before any marketing block', async () => {
    // A per-path `! Content-Security-Policy` only strips the `/*` CSP when `/*`
    // precedes it (Cloudflare applies rules top-to-bottom). `/*` last — the
    // shipped bug — leaves its hashless CSP appended: two policies the browser
    // intersects.
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    const firstPathBlock = content
      .split('\n\n')
      .map((b) => blockHead(b))
      .find((h) => h.startsWith('/'));
    expect(firstPathBlock).toBe('/*');
  });

  it('unsets every header it re-sets in each marketing block, before re-setting it', async () => {
    // Every header a marketing block re-sets is already set by `/*`, and
    // Cloudflare appends rather than replaces — so each must be unset first or
    // it carries two values. The `/*` block itself has no unsets.
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    const blocks = content.split('\n\n');
    for (const route of MARKETING_ROUTES) {
      for (const variant of [route, `${route}/`]) {
        const block = blocks.find((b) => blockHead(b) === variant);
        expect(block, `block for ${variant} not found`).toBeDefined();
        const lines = (block ?? '').split('\n').map((l) => l.trim());
        // Setters are `Name: value` lines (path and `! Name` lines have no
        // colon); split on the first colon so `https://` in CSP values is safe.
        const setterNames = lines
          .filter((l) => l.includes(':') && !l.startsWith('!'))
          .map((l) => l.slice(0, l.indexOf(':')).trim());
        expect(setterNames, `${variant} sets no CSP`).toContain('Content-Security-Policy');
        for (const name of setterNames) {
          const unsetIndex = lines.indexOf(`! ${name}`);
          const setterIndex = lines.findIndex((l) => l.startsWith(`${name}:`));
          expect(unsetIndex, `${variant} missing ! ${name}`).toBeGreaterThan(-1);
          expect(unsetIndex, `${variant} unset of ${name} must precede its setter`).toBeLessThan(
            setterIndex
          );
        }
      }
    }

    const spaBlock = blocks.find((b) => blockHead(b) === '/*');
    expect(spaBlock).toBeDefined();
    expect(spaBlock).not.toContain('! ');
  });

  it('inlines per-page script hashes into the marketing CSP script-src', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedSpaShell(distribution);
    await writeHtml(
      path.join(distribution, 'welcome/index.html'),
      htmlWithInlineScripts('alpha', 'beta')
    );
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/welcome')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(
        path.join(distribution, prefix, 'index.html'),
        htmlWithInlineScripts(`x-${prefix}`)
      );
    }

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    const welcomeBlock = content.split('\n\n').find((b) => b.startsWith('/welcome'));
    expect(welcomeBlock).toBeDefined();
    expect(welcomeBlock).toContain(sha256Token('alpha'));
    expect(welcomeBlock).toContain(sha256Token('beta'));
  });

  it('serves exactly one CSP per marketing path under Cloudflare rule semantics', async () => {
    // The real guard against the shipped bug: `matchHeaders` reproduces
    // Cloudflare's per-path + `/*` append, so each marketing path must resolve
    // to ONE Content-Security-Policy (the hashed one), never two. A pure SPA
    // path keeps the single hashless catch-all.
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedSpaShell(distribution);
    await writeHtml(
      path.join(distribution, 'welcome/index.html'),
      htmlWithInlineScripts('w1', 'w2')
    );
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/welcome')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(
        path.join(distribution, prefix, 'index.html'),
        htmlWithInlineScripts(`x-${prefix}`)
      );
    }
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const rules = parseHeadersFile(await fs.readFile(result.outputPath, 'utf8'));

    // Trailing-slash form is what Cloudflare serves the marketing HTML at.
    const welcomeCsp = matchHeaders(rules, '/welcome/')['Content-Security-Policy'];
    expect(Array.isArray(welcomeCsp), '/welcome/ must not carry two CSP headers').toBe(false);
    expect(welcomeCsp).toContain(sha256Token('w1'));
    expect(welcomeCsp).toContain(sha256Token('w2'));

    // Both path forms of every marketing route must resolve to one CSP.
    for (const route of MARKETING_ROUTES) {
      for (const variant of [route, `${route}/`]) {
        const csp = matchHeaders(rules, variant)['Content-Security-Policy'];
        expect(Array.isArray(csp), `${variant} must resolve to one CSP header`).toBe(false);
      }
    }

    // A pure SPA route inherits the hashless catch-all, also single-valued.
    const spaCsp = matchHeaders(rules, '/chat')['Content-Security-Policy'];
    expect(Array.isArray(spaCsp)).toBe(false);
    expect(spaCsp).not.toContain('sha256-');
  });

  it("isolates hashes per-path so no page gets another page's hashes", async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedSpaShell(distribution);
    await writeHtml(
      path.join(distribution, 'blog/index.html'),
      htmlWithInlineScripts('only-on-blog-index')
    );
    await writeHtml(
      path.join(distribution, 'blog/post-a/index.html'),
      htmlWithInlineScripts('only-on-post-a')
    );
    await writeHtml(
      path.join(distribution, 'blog/post-b/index.html'),
      htmlWithInlineScripts('only-on-post-b')
    );
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/blog')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(
        path.join(distribution, prefix, 'index.html'),
        htmlWithInlineScripts(`x-${prefix}`)
      );
    }

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    const postABlock = content.split('\n\n').find((b) => b.startsWith('/blog/post-a'));
    expect(postABlock).toContain(sha256Token('only-on-post-a'));
    expect(postABlock).not.toContain(sha256Token('only-on-blog-index'));
    expect(postABlock).not.toContain(sha256Token('only-on-post-b'));
  });

  it('emits one block per concrete blog post in addition to /blog', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedSpaShell(distribution);
    await writeHtml(path.join(distribution, 'blog/index.html'), htmlWithInlineScripts('idx'));
    await writeHtml(path.join(distribution, 'blog/post-a/index.html'), htmlWithInlineScripts('a'));
    await writeHtml(path.join(distribution, 'blog/post-b/index.html'), htmlWithInlineScripts('b'));
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/blog')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(
        path.join(distribution, prefix, 'index.html'),
        htmlWithInlineScripts(`x-${prefix}`)
      );
    }

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    expect(content).toMatch(/^\/blog$/m);
    expect(content).toMatch(/^\/blog\/post-a$/m);
    expect(content).toMatch(/^\/blog\/post-b$/m);
  });

  it('preserves the SPA fallback CSP verbatim (no hashes)', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    const spaBlock = content.split('\n\n').find((b) => blockHead(b) === '/*');
    expect(spaBlock).toBeDefined();
    expect(spaBlock).toContain(
      "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com;"
    );
    expect(spaBlock).not.toContain('sha256-');
    expect(spaBlock).toContain("default-src 'self'");
    expect(spaBlock).toContain("frame-ancestors 'none'");
  });

  it('hashes the SPA shell index.html inline scripts into the /* block', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedAllMarketingRoutes(distribution);
    // The real shell ships two pre-paint inline scripts (theme-flash +
    // a11y-init); the /* block serves every SPA route and must carry their
    // hashes or the strict script-src blocks them.
    await seedSpaShell(distribution, 'theme()', 'a11y()');

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');

    const spaBlock = content.split('\n\n').find((b) => blockHead(b) === '/*');
    expect(spaBlock).toContain(sha256Token('theme()'));
    expect(spaBlock).toContain(sha256Token('a11y()'));

    // The CSP Cloudflare actually applies to an SPA route carries them, single-valued.
    const rules = parseHeadersFile(content);
    const chatCsp = matchHeaders(rules, '/chat')['Content-Security-Policy'];
    expect(Array.isArray(chatCsp)).toBe(false);
    expect(chatCsp).toContain(sha256Token('theme()'));
    expect(chatCsp).toContain(sha256Token('a11y()'));
  });

  it('the /demo (+ subpath) blocks inherit the SPA shell inline-script hashes', async () => {
    // /demo serves the same SPA shell inside an iframe, so its CSP — derived
    // from the SPA headers — must carry the shell hashes too.
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await seedAllMarketingRoutes(distribution);
    await seedSpaShell(distribution, 'theme()');

    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const rules = parseHeadersFile(await fs.readFile(result.outputPath, 'utf8'));

    for (const route of [ROUTES.DEMO, `${ROUTES.DEMO}/chat/abc`]) {
      const csp = matchHeaders(rules, route)['Content-Security-Policy'];
      expect(csp, `${route} CSP`).toContain(sha256Token('theme()'));
    }
  });

  it('fails when the SPA shell index.html is missing', async () => {
    // Marketing routes built, but no root dist/index.html — the generator must
    // fail loudly rather than emit a /* block that blocks the shell's scripts.
    const distribution = path.join(repoRoot, 'apps/web/dist');
    for (const route of MARKETING_ROUTES) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(path.join(distribution, prefix, 'index.html'), htmlWithInlineScripts('x'));
    }
    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      /SPA shell/i
    );
  });

  it('does not put style-src hashes anywhere (inline style="..." still relies on \'unsafe-inline\')', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');
    expect(content).toContain("style-src 'self' 'unsafe-inline'");
    // A sha256 token paired with style-src would indicate we leaked style hashing.
    expect(content).not.toMatch(/style-src[^;]*sha256-/);
  });

  it('emits the generation banner so the file is recognizable', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');
    expect(content).toMatch(/^# Auto-generated/);
    expect(content).toContain('scripts/generate-headers.ts');
    expect(content).toContain('MARKETING_ROUTES');
  });

  it('fails when the web dist directory is missing', async () => {
    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      /Web dist directory does not exist/
    );
  });

  it('fails when a marketing route has no built directory', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await fs.mkdir(distribution, { recursive: true });
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/welcome')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(path.join(distribution, prefix, 'index.html'), htmlWithInlineScripts('x'));
    }
    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      /Marketing route \/welcome has no built directory/
    );
  });

  it('fails when a marketing route directory exists but has no index.html', async () => {
    const distribution = path.join(repoRoot, 'apps/web/dist');
    await fs.mkdir(path.join(distribution, 'welcome'), { recursive: true });
    for (const route of MARKETING_ROUTES.filter((r) => r !== '/welcome')) {
      const prefix = route.replace(/^\//, '');
      await writeHtml(path.join(distribution, prefix, 'index.html'), htmlWithInlineScripts('x'));
    }
    await expect(generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' })).rejects.toThrow(
      /produced no index\.html/
    );
  });

  it('writes to a custom output path when provided', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const customOutput = 'apps/web/dist/custom-headers.txt';
    const result = await generateHeaders({
      repoRoot,
      apiUrl: 'https://api.hushbox.ai',
      outputRelativePath: customOutput,
    });
    expect(result.outputPath).toBe(path.resolve(repoRoot, customOutput));
    expect(await fs.readFile(result.outputPath, 'utf8')).toMatch(/^# Auto-generated/);
  });

  it('templates connect-src with the prod API origin (https → wss)', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({
      repoRoot,
      apiUrl: 'https://api.hushbox.ai',
    });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    expect(nonComment).toContain('https://api.hushbox.ai');
    expect(nonComment).toContain('wss://api.hushbox.ai');
    expect(nonComment).not.toContain('localhost');
  });

  it('does not leak HB_MINIO_API_PORT into the prod CSP', async () => {
    // Even if the prod CI/CD env somehow has HB_MINIO_API_PORT set, the
    // localhost-only gate in deriveLocalR2Origin must keep it out.
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({
      repoRoot,
      apiUrl: 'https://api.hushbox.ai',
      minioApiPort: '9000',
    });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    expect(nonComment).not.toContain('localhost');
    expect(nonComment).not.toContain('http://localhost:9000');
  });

  it('templates connect-src with a local API origin (http → ws) and no MinIO when port is unset', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({
      repoRoot,
      apiUrl: 'http://localhost:8787',
    });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    expect(nonComment).toContain('http://localhost:8787');
    expect(nonComment).toContain('ws://localhost:8787');
    expect(nonComment).not.toContain('api.hushbox.ai');
    expect(nonComment).not.toContain('http://localhost:9000');
  });

  it('appends localhost MinIO to connect-src when minioApiPort is provided (dev/E2E path)', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({
      repoRoot,
      apiUrl: 'http://localhost:8787',
      minioApiPort: '9000',
    });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    expect(nonComment).toContain('http://localhost:9000');
    // Token sits inside the connect-src directive of every block (marketing
    // pages + SPA fallback). The banner is comments-only and stripped above.
    const connectLines = nonComment.split('\n').filter((l) => l.includes('connect-src'));
    expect(connectLines.length).toBeGreaterThan(0);
    for (const line of connectLines) {
      expect(line).toContain('http://localhost:9000');
    }
  });

  it('honors worktree-offset MinIO ports (slot 142 → port 9142)', async () => {
    // Confirms the design works for worktrees: BASE_PORTS.minioApi (9000) +
    // slot offset is what `scripts/generate-env.ts` writes to .env.scripts.
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({
      repoRoot,
      apiUrl: 'http://localhost:8929',
      minioApiPort: '9142',
    });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    expect(nonComment).toContain('http://localhost:9142');
    expect(nonComment).not.toContain('http://localhost:9000');
  });

  it('reads HB_MINIO_API_PORT from process.env when minioApiPort is not passed', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    process.env['HB_MINIO_API_PORT'] = '9050';
    const result = await generateHeaders({ repoRoot, apiUrl: 'http://localhost:8787' });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    expect(nonComment).toContain('http://localhost:9050');
  });

  it('emits script-src with wasm-unsafe-eval, unsafe-eval, and Helcim on every block', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'http://localhost:8787' });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    // One script-src directive per marketing route + one for SPA fallback.
    const scriptSourceLines = nonComment.split('\n').filter((l) => l.includes('script-src'));
    expect(scriptSourceLines.length).toBeGreaterThan(0);
    for (const line of scriptSourceLines) {
      expect(line).toContain("'wasm-unsafe-eval'");
      expect(line).toContain("'unsafe-eval'");
      expect(line).toContain('https://secure.myhelcim.com');
    }
  });

  it('emits connect-src with Helcim on every block (tokenization XHR)', async () => {
    // version2.js POSTs the card payload back to secure.myhelcim.com — if
    // the host is missing from connect-src the script loads (script-src
    // allows it) but tokenization silently fails in the browser.
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'http://localhost:8787' });
    const nonComment = stripComments(await fs.readFile(result.outputPath, 'utf8'));
    const connectSourceLines = nonComment.split('\n').filter((l) => l.includes('connect-src'));
    expect(connectSourceLines.length).toBeGreaterThan(0);
    for (const line of connectSourceLines) {
      expect(line).toContain('https://secure.myhelcim.com');
    }
  });

  it('throws when VITE_API_URL is not set anywhere', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const originalEnv = process.env['VITE_API_URL'];
    delete process.env['VITE_API_URL'];
    try {
      await expect(generateHeaders({ repoRoot })).rejects.toThrow(/VITE_API_URL/);
    } finally {
      if (originalEnv !== undefined) process.env['VITE_API_URL'] = originalEnv;
    }
  });

  it('reads VITE_API_URL from process.env when apiUrl is not passed', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const originalEnv = process.env['VITE_API_URL'];
    process.env['VITE_API_URL'] = 'http://localhost:9999';
    try {
      const result = await generateHeaders({ repoRoot });
      const content = await fs.readFile(result.outputPath, 'utf8');
      expect(content).toContain('http://localhost:9999');
      expect(content).toContain('ws://localhost:9999');
    } finally {
      if (originalEnv === undefined) delete process.env['VITE_API_URL'];
      else process.env['VITE_API_URL'] = originalEnv;
    }
  });
});

describe('generateHeaders — /demo iframe override', () => {
  it('emits /demo and /demo/* override blocks', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const content = await fs.readFile(result.outputPath, 'utf8');
    expect(content).toMatch(/^\/demo$/m);
    expect(content).toMatch(/^\/demo\/\*$/m);
  });

  it('relaxes /demo (+ subpaths) to same-origin framing, single-valued', async () => {
    // The marketing /welcome page embeds the demo SPA in a same-origin iframe;
    // the strict SPA frame-ancestors 'none' + X-Frame-Options DENY would block
    // it. The override must resolve to ONE relaxed CSP (not two intersected
    // back to 'none') under Cloudflare rule semantics.
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const rules = parseHeadersFile(await fs.readFile(result.outputPath, 'utf8'));

    for (const route of [ROUTES.DEMO, `${ROUTES.DEMO}/chat/abc`]) {
      const headers = matchHeaders(rules, route);
      const csp = headers['Content-Security-Policy'];
      expect(Array.isArray(csp), `${route} must resolve to one CSP`).toBe(false);
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).not.toContain("frame-ancestors 'none'");
      const xfo = headers['X-Frame-Options'];
      expect(Array.isArray(xfo), `${route} must resolve to one X-Frame-Options`).toBe(false);
      expect(xfo).toBe('SAMEORIGIN');
    }
  });

  it('keeps cross-origin framing denied on /demo (self, not wildcard)', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const rules = parseHeadersFile(await fs.readFile(result.outputPath, 'utf8'));
    const csp = matchHeaders(rules, ROUTES.DEMO)['Content-Security-Policy'];
    expect(csp).not.toContain('frame-ancestors *');
    expect(csp).not.toContain('frame-ancestors https:');
  });

  it('leaves ordinary SPA routes fully frame-blocked (regression guard)', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const rules = parseHeadersFile(await fs.readFile(result.outputPath, 'utf8'));
    const headers = matchHeaders(rules, ROUTES.CHAT);
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('preserves the rest of the SPA policy on /demo (only frame controls relaxed)', async () => {
    await seedAllMarketingRoutes(path.join(repoRoot, 'apps/web/dist'));
    const result = await generateHeaders({ repoRoot, apiUrl: 'https://api.hushbox.ai' });
    const rules = parseHeadersFile(await fs.readFile(result.outputPath, 'utf8'));
    const csp = matchHeaders(rules, ROUTES.DEMO)['Content-Security-Policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com"
    );
    expect(csp).not.toContain('sha256-');
  });
});

describe('deriveApiOrigin', () => {
  it('derives wss:// from https://', () => {
    expect(deriveApiOrigin('https://api.hushbox.ai')).toEqual({
      http: 'https://api.hushbox.ai',
      ws: 'wss://api.hushbox.ai',
    });
  });

  it('derives ws:// from http://', () => {
    expect(deriveApiOrigin('http://localhost:8787')).toEqual({
      http: 'http://localhost:8787',
      ws: 'ws://localhost:8787',
    });
  });

  it('strips path/query from the URL, keeping origin only', () => {
    expect(deriveApiOrigin('https://api.hushbox.ai/v1/whatever?q=1').http).toBe(
      'https://api.hushbox.ai'
    );
  });

  it('throws on malformed URL', () => {
    expect(() => deriveApiOrigin('not-a-url')).toThrow(/not a valid URL/);
  });

  it('throws on non-http(s) scheme', () => {
    expect(() => deriveApiOrigin('ftp://example.com')).toThrow(/must use http or https/);
  });
});

describe('deriveLocalR2Origin', () => {
  const localApi = deriveApiOrigin('http://localhost:8787');
  const productionApi = deriveApiOrigin('https://api.hushbox.ai');

  it('returns http://localhost:<port> for a localhost API + numeric port', () => {
    expect(deriveLocalR2Origin(localApi, '9000')).toBe('http://localhost:9000');
  });

  it('returns the worktree-offset port verbatim (no rewriting)', () => {
    // The port comes from .env.scripts already slot-adjusted by
    // generate-env.ts; the headers generator must NOT recompute the offset.
    expect(deriveLocalR2Origin(localApi, '9142')).toBe('http://localhost:9142');
  });

  it('returns null when the API origin is production (prevents leak)', () => {
    expect(deriveLocalR2Origin(productionApi, '9000')).toBeNull();
  });

  it('returns null when the API origin is any non-localhost host', () => {
    const stagingApi = deriveApiOrigin('https://staging-api.hushbox.ai');
    expect(deriveLocalR2Origin(stagingApi, '9000')).toBeNull();
  });

  it('returns null when the port is omitted', () => {
    expect(deriveLocalR2Origin(localApi)).toBeNull();
  });

  it('returns null when the port is an empty string', () => {
    expect(deriveLocalR2Origin(localApi, '')).toBeNull();
  });

  it('throws when the port is non-numeric', () => {
    expect(() => deriveLocalR2Origin(localApi, '9000a')).toThrow(/numeric port string/);
  });

  it('throws when the port contains whitespace', () => {
    expect(() => deriveLocalR2Origin(localApi, ' 9000')).toThrow(/numeric port string/);
  });
});
