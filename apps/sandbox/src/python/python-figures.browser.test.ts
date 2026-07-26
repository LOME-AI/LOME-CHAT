import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from '@playwright/test';
import { launchBrowser, startSandboxOrigin, type SandboxOrigin } from '../embed-harness.js';
import { openPythonPage, type PythonPage } from './browser-harness.js';

/**
 * Isolated so the heavy matplotlib wheel load does not pile onto the core file's
 * runtime — each browser file stays well under the pole threshold.
 */

let sandbox: SandboxOrigin;
let browser: Browser;
let page: PythonPage;

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

describe('python matplotlib figures (real browser)', () => {
  it('returns a matplotlib figure as an image/png result output', async () => {
    const code = `import matplotlib.pyplot as plt
plt.plot([0, 1, 2, 3], [0, 1, 4, 9])
plt.title("squares")`;
    const messages = await page.run(code, 'fig-1');

    expect(messages.some((m) => m.type === 'error')).toBe(false);
    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    const outputs = result?.outputs ?? [];
    expect(outputs.length).toBe(1);
    expect(outputs[0]?.type).toBe('image/png');
    // A base64-encoded PNG always begins with the signature bytes 89 50 4E 47,
    // which encode to `iVBORw0KGgo` — proof the Agg backend produced a real image.
    expect(outputs[0]?.data ?? '').toMatch(/^iVBORw0KGgo/);
    expect(page.pageErrors).toEqual([]);
  }, 120_000);
});
