import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createServer } from 'node:http';
import { isSafePath, renderPage, resolvePort, startServer } from './preview-readme.js';

const readFileSyncMock = vi.hoisted(() => vi.fn());
const watchMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: readFileSyncMock, watch: watchMock };
});

const MINIMAL_CSS = '.markdown-body { color: #24292f; }';

describe('resolvePort', () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env['HB_README_PREVIEW_PORT'];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env['HB_README_PREVIEW_PORT'];
    } else {
      process.env['HB_README_PREVIEW_PORT'] = originalValue;
    }
  });

  it('returns the port number from HB_README_PREVIEW_PORT', () => {
    process.env['HB_README_PREVIEW_PORT'] = '6419';

    expect(resolvePort()).toBe(6419);
  });

  it('returns worktree-offset port when env var is set differently', () => {
    process.env['HB_README_PREVIEW_PORT'] = '6461';

    expect(resolvePort()).toBe(6461);
  });

  it('throws when HB_README_PREVIEW_PORT is not set', () => {
    delete process.env['HB_README_PREVIEW_PORT'];

    expect(() => resolvePort()).toThrow('HB_README_PREVIEW_PORT is not set');
  });

  it('throws when HB_README_PREVIEW_PORT is not a valid port', () => {
    process.env['HB_README_PREVIEW_PORT'] = 'not-a-number';

    expect(() => resolvePort()).toThrow('invalid');
  });

  it('throws when HB_README_PREVIEW_PORT is out of range', () => {
    process.env['HB_README_PREVIEW_PORT'] = '99999';

    expect(() => resolvePort()).toThrow('invalid');
  });

  it('throws when HB_README_PREVIEW_PORT is zero', () => {
    process.env['HB_README_PREVIEW_PORT'] = '0';

    expect(() => resolvePort()).toThrow('invalid');
  });
});

describe('isSafePath', () => {
  it('accepts simple relative paths', () => {
    expect(isSafePath('/packages/ui/src/assets/icons/globe.svg')).toBe(true);
    expect(isSafePath('/.github/readme/banner-dark.svg')).toBe(true);
  });

  it('rejects paths containing ..', () => {
    expect(isSafePath('/../etc/passwd')).toBe(false);
    expect(isSafePath('/foo/../../etc/passwd')).toBe(false);
  });

  it('rejects the root path', () => {
    expect(isSafePath('/')).toBe(false);
  });
});

describe('renderPage', () => {
  it('returns a full HTML document', () => {
    const html = renderPage('# Hello', MINIMAL_CSS);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
  });

  it('embeds the provided CSS', () => {
    const html = renderPage('# Hello', MINIMAL_CSS);

    expect(html).toContain(MINIMAL_CSS);
  });

  it('renders markdown headings', () => {
    const html = renderPage('# Hello World', MINIMAL_CSS);

    expect(html).toContain('<h1');
    expect(html).toContain('Hello World');
  });

  it('renders GFM tables', () => {
    const markdown = `
| A | B |
|---|---|
| 1 | 2 |
`;
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders GitHub alert blocks via marked-alert', () => {
    const markdown = `> [!NOTE]\n> Important message`;
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('markdown-alert');
    expect(html).toContain('markdown-alert-note');
  });

  it('applies syntax highlighting to fenced code blocks', () => {
    const markdown = '```typescript\nconst x = 42;\n```';
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('hljs');
    expect(html).toContain('language-typescript');
  });

  it('includes the live-reload EventSource script', () => {
    const html = renderPage('# test', MINIMAL_CSS);

    expect(html).toContain("new EventSource('/reload')");
  });

  it('sets markdown-body class on body', () => {
    const html = renderPage('# test', MINIMAL_CSS);

    expect(html).toContain('class="markdown-body"');
  });

  it('auto-detects highlighting for fenced code blocks without a language', () => {
    const markdown = '```\nconst x = 42;\n```';
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('hljs-number');
  });

  it('auto-detects highlighting for unknown languages', () => {
    const markdown = '```notareallanguage\nconst x = 42;\n```';
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('hljs');
  });
});

describe('startServer', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const openControllers: AbortController[] = [];

  beforeEach(async () => {
    readFileSyncMock.mockReset();
    watchMock.mockReset();
    // Returns strings even for binary fixtures: res.end() accepts both, and a
    // single return type keeps the fake aligned with the utf8 read paths.
    readFileSyncMock.mockImplementation((filePath: string | Buffer): string => {
      const asString = String(filePath);
      if (asString.endsWith('README.md')) return '# Preview Heading';
      if (asString.endsWith('.css')) return MINIMAL_CSS;
      if (asString.endsWith('icon.svg')) return '<svg></svg>';
      if (asString.endsWith('data.bin')) return 'binary-bytes';
      throw Object.assign(new Error(`ENOENT: ${asString}`), { code: 'ENOENT' });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    server = startServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an ephemeral TCP port');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    for (const controller of openControllers) controller.abort();
    openControllers.length = 0;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    vi.restoreAllMocks();
  });

  it('logs the preview URL once listening', () => {
    const logSpy = vi.mocked(console.log);
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('README preview: http://localhost:'))).toBe(true);
  });

  it('serves the rendered README at the root path', async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('Preview Heading');
  });

  it('serves static files with a known MIME type', async () => {
    const response = await fetch(`${baseUrl}/icon.svg`);

    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(await response.text()).toBe('<svg></svg>');
  });

  it('serves unknown file extensions as octet-stream', async () => {
    const response = await fetch(`${baseUrl}/data.bin`);

    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('falls back to the README page when a static file is missing', async () => {
    const response = await fetch(`${baseUrl}/missing.png`);

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('Preview Heading');
  });

  it('renders the README instead of serving path-traversal requests', async () => {
    const response = await fetch(`${baseUrl}/%2e%2e/secrets.txt`);

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('watches the README for changes', () => {
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(String(watchMock.mock.calls[0]?.[0])).toContain('README.md');
  });

  it('pushes a reload event to connected clients when the README changes', async () => {
    const controller = new AbortController();
    openControllers.push(controller);
    // SSE headers only flush with the first body write, so the response
    // cannot be awaited until the watcher pushes an event.
    const responsePromise = fetch(`${baseUrl}/reload`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const watchCallback = watchMock.mock.calls[0]?.[1] as () => void;
    watchCallback();

    const response = await responsePromise;
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('data: reload\n\n');
  });

  it('keeps serving after a reload client disconnected', async () => {
    const controller = new AbortController();
    const responsePromise = fetch(`${baseUrl}/reload`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await responsePromise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const watchCallback = watchMock.mock.calls[0]?.[1] as () => void;
    expect(() => {
      watchCallback();
    }).not.toThrow();

    const response = await fetch(`${baseUrl}/`);
    expect(await response.text()).toContain('Preview Heading');
  });
});
