import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from '@playwright/test';
import {
  startPythonSandbox,
  launchBrowser,
  openPythonPage,
  type PythonSandbox,
  type PythonPage,
  type BridgeLike,
} from './browser-harness.js';

/**
 * Drives the real `/python.html` runtime in a headless browser under the
 * production sandbox CSP. One page is reused across the lightweight documents so
 * Pyodide loads once; the heavier matplotlib and micropip paths live in sibling
 * files to keep each browser file well under the pole threshold.
 */

let sandbox: PythonSandbox;
let browser: Browser;
let page: PythonPage;

beforeAll(async () => {
  sandbox = await startPythonSandbox();
  browser = await launchBrowser();
  page = await openPythonPage(browser, sandbox.origin);
}, 120_000);

afterAll(async () => {
  await page.close();
  await browser.close();
  await sandbox.close();
});

const consoleText = (messages: BridgeLike[], stream: string): string =>
  messages
    .filter((m) => m.type === 'console' && m.stream === stream)
    .map((m) => m.text ?? '')
    .join('');

describe('python runtime (real browser)', () => {
  it('streams a print round-trip on stdout and finishes with a result', async () => {
    const messages = await page.run(`print("hello from python")`, 'print-1');
    expect(consoleText(messages, 'stdout')).toContain('hello from python');
    expect(messages.some((m) => m.type === 'result')).toBe(true);
    expect(messages.some((m) => m.type === 'error')).toBe(false);
  }, 120_000);

  it('emits the runtime lifecycle loading phases on first load', async () => {
    // A fresh page proves `loading-runtime` fires on the actual interpreter load,
    // independent of which other test happened to warm the shared page first.
    const fresh = await openPythonPage(browser, sandbox.origin);
    try {
      const messages = await fresh.run(`print("phases")`, 'phases-1');
      const phases = messages.filter((m) => m.type === 'loading').map((m) => m.phase);
      expect(phases).toContain('loading-runtime');
      expect(phases).toContain('loading-packages');
      expect(phases).toContain('executing');
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it('auto-loads numpy and computes with it', async () => {
    const code = `import numpy as np
print(int(np.arange(15).sum()))`;
    const messages = await page.run(code, 'numpy-1');
    expect(consoleText(messages, 'stdout')).toContain('105');
    expect(messages.some((m) => m.type === 'result')).toBe(true);
  }, 120_000);

  it('surfaces a traceback as a typed python_error', async () => {
    const messages = await page.run(`raise ValueError("boom")`, 'err-1');
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('python_error');
    expect(error?.message).toContain('ValueError');
    expect(error?.message).toContain('boom');
  }, 120_000);

  it('fails fast with input_unsupported when the document calls input()', async () => {
    const messages = await page.run(`name = input("your name? ")`, 'input-1');
    const error = messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('input_unsupported');
    expect(messages.some((m) => m.type === 'result')).toBe(false);
  }, 120_000);

  it('gives each run fresh globals — a name bound in one run is gone in the next', async () => {
    const first = await page.run(`leaked = 42`, 'fresh-1');
    expect(first.some((m) => m.type === 'result')).toBe(true);

    const second = await page.run(`print(leaked)`, 'fresh-2');
    const error = second.find((m) => m.type === 'error');
    expect(error?.code).toBe('python_error');
    expect(error?.message).toContain('NameError');
    expect(error?.message).toContain('leaked');
  }, 120_000);

  it('reports a typed error when the runtime never finishes loading', async () => {
    // The loader request is held open forever, so the interpreter import never
    // settles and the run reports nothing at all — the shape the panel reads as
    // "still working". Time is mocked, so the deadline is exercised without the
    // test waiting it out.
    const hung = await browser.newPage();
    try {
      await hung.clock.install();
      await hung.route(
        (url) => url.pathname.endsWith('/pyodide/pyodide.mjs'),
        () => {
          // Deliberately never fulfilled or aborted.
        }
      );
      await hung.addInitScript(() => {
        (globalThis as unknown as { __msgs: unknown[] }).__msgs = [];
        window.addEventListener('message', (event) =>
          (globalThis as unknown as { __msgs: unknown[] }).__msgs.push(event.data)
        );
      });
      await hung.goto(`${sandbox.origin}/python.html`);
      // Polled from Node: the page's own timers are mocked, so a page-side wait
      // would never tick.
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await hung.evaluate(() =>
          (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs.some((m) => m.type === 'ready')
        );
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await hung.evaluate(() => {
        // eslint-disable-next-line sonarjs/post-message -- test harness posts to its own window
        window.postMessage(
          { type: 'init', kind: 'python', code: 'print("never runs")', requestId: 'hang-1' },
          '*'
        );
        // eslint-disable-next-line sonarjs/post-message -- test harness posts to its own window
        window.postMessage({ type: 'run', requestId: 'hang-1' }, '*');
      });
      await hung.clock.fastForward(600_000);
      const messages: BridgeLike[] = await hung.evaluate(
        () => (globalThis as unknown as { __msgs: BridgeLike[] }).__msgs
      );
      const error = messages.find((m) => m.type === 'error');
      expect(error?.code).toBe('timed_out');
      expect(messages.some((m) => m.type === 'result')).toBe(false);
    } finally {
      await hung.close();
    }
  }, 60_000);

  it('neutralizes the WebRTC constructors on the runtime frame', async () => {
    const probe = await page.probe(() => {
      const w = globalThis as unknown as Record<string, unknown>;
      const construct = (): boolean => {
        try {
          new (w['RTCPeerConnection'] as new () => unknown)();
          return false;
        } catch {
          return true;
        }
      };
      return {
        peer: w['RTCPeerConnection'],
        webkit: w['webkitRTCPeerConnection'],
        moz: w['mozRTCPeerConnection'],
        dataChannel: w['RTCDataChannel'],
        constructThrows: construct(),
      };
    });
    expect(probe.peer).toBeUndefined();
    expect(probe.webkit).toBeUndefined();
    expect(probe.moz).toBeUndefined();
    expect(probe.dataChannel).toBeUndefined();
    expect(probe.constructThrows).toBe(true);
  }, 30_000);

  it('runs without any uncaught page errors', () => {
    expect(page.pageErrors).toEqual([]);
  });
});
