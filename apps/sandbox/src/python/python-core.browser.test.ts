import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from '@playwright/test';
import {
  launchBrowser,
  startSandboxOrigin,
  type BridgeLike,
  type SandboxOrigin,
} from '../embed-harness.js';
import { openPythonPage, type PythonPage } from './browser-harness.js';

/**
 * Drives the real `/python.html` runtime in a headless browser under the
 * production sandbox CSP, embedded in a real `sandbox="allow-scripts"` iframe —
 * so the runtime's origin is opaque and the transport under test is the one the
 * app uses. One page is reused across the lightweight documents so Pyodide loads
 * once; the heavier matplotlib and micropip paths live in sibling files to keep
 * each browser file well under the pole threshold.
 */

let sandbox: SandboxOrigin;
let browser: Browser;
let page: PythonPage;

/** Sleep in Node, so a page with a mocked clock cannot stall the waiter. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  sandbox = await startSandboxOrigin();
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

describe('python runtime bridge transport (embedded in a sandboxed frame)', () => {
  it('runs a document from an init and run delivered only through the transferred port', async () => {
    // The delivery test the top-level harness could not express. The embedder's
    // origin never reaches this frame — the frame's own origin is opaque, so an
    // explicitly-targeted `window.postMessage` is discarded without an error —
    // and the port is the only channel the app has.
    expect(await page.frame.hasPort()).toBe(true);
    await page.frame.send({
      type: 'init',
      kind: 'python',
      code: `print("delivered over the port")`,
      requestId: 'port-1',
    });
    await page.frame.send({ type: 'run', requestId: 'port-1' });
    const messages = await page.frame.waitForMessage(
      (m) => m.type === 'result' && m.requestId === 'port-1',
      120_000
    );
    const mine = messages.filter((m) => m.requestId === 'port-1');
    expect(consoleText(mine, 'stdout')).toContain('delivered over the port');
    expect(mine.some((m) => m.type === 'error')).toBe(false);
  }, 150_000);

  it('ignores an init and run posted at its window instead of the port', async () => {
    // Anything sharing the embedder's realm — including a document the app is
    // showing elsewhere — can post at this frame's window with '*', and the
    // browser delivers it. The frame registers no window listener, so the
    // forgery reaches nothing. The port run that follows is the control: it
    // proves the frame was alive and simply refused the window messages.
    await page.frame.postToFrameWindow({
      type: 'init',
      kind: 'python',
      code: `print("forged")`,
      requestId: 'forged-1',
    });
    await page.frame.postToFrameWindow({ type: 'run', requestId: 'forged-1' });
    await sleep(500);
    const afterForgery = await page.frame.messages();
    expect(afterForgery.some((m) => m.requestId === 'forged-1')).toBe(false);

    const control = await page.run(`print("genuine")`, 'genuine-1');
    expect(consoleText(control, 'stdout')).toContain('genuine');
    expect(control.some((m) => m.type === 'result')).toBe(true);
  }, 120_000);
});

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
    const hung = await openPythonPage(browser, sandbox.origin, async (target) => {
      await target.clock.install();
      await target.route(
        (url) => url.pathname.endsWith('/pyodide/pyodide.mjs'),
        () => {
          // Deliberately never fulfilled or aborted.
        }
      );
    });
    try {
      await hung.frame.send({
        type: 'init',
        kind: 'python',
        code: 'print("never runs")',
        requestId: 'hang-1',
      });
      await hung.frame.send({ type: 'run', requestId: 'hang-1' });
      // The `loading-runtime` message is the frame saying it has begun the load
      // and armed the deadline; fast-forwarding before that would advance a clock
      // no timer is waiting on. Every wait here polls from Node — a page-side
      // waiter would need the page's own (mocked) timers to tick.
      await hung.frame.waitForMessage((m) => m.type === 'loading' && m.requestId === 'hang-1');
      await hung.frame.page.clock.fastForward(600_000);
      const messages = await hung.frame.waitForMessage((m) => m.type === 'error');
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
