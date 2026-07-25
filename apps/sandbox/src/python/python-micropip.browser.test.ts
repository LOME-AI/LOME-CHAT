import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from '@playwright/test';
import {
  startPythonSandbox,
  launchBrowser,
  openPythonPage,
  installPyPIInterception,
  type PythonSandbox,
  type PythonPage,
} from './browser-harness.js';

/**
 * The micropip fallback path: a document imports a pure-Python PyPI package that
 * is NOT in the Pyodide lock, so loadPackagesFromImports cannot satisfy it and
 * the micropip fallback must fetch it from pypi.org + files.pythonhosted.org
 * under the sandbox connect-src. The three PyPI resources micropip fetches are
 * replayed from committed fixtures (see installPyPIInterception), so the path
 * runs with zero live network in CI while still exercising the real micropip
 * install against the real sandbox CSP.
 */

let sandbox: PythonSandbox;
let browser: Browser;
let page: PythonPage;

beforeAll(async () => {
  sandbox = await startPythonSandbox();
  browser = await launchBrowser();
  page = await openPythonPage(browser, sandbox.origin, installPyPIInterception);
}, 120_000);

afterAll(async () => {
  await page.close();
  await browser.close();
  await sandbox.close();
});

describe('python micropip fallback (real browser, replayed PyPI)', () => {
  it('auto-installs a pure-Python PyPI package not in the Pyodide lock', async () => {
    // `cowsay` is pure-Python, dependency-free, and absent from the Pyodide lock,
    // so loadPackagesFromImports cannot satisfy it and the micropip fallback must.
    const code = `import cowsay
print("cowsay module:", cowsay.__name__)`;
    const messages = await page.run(code, 'micropip-1');

    expect(messages.some((m) => m.type === 'error')).toBe(false);
    const stdout = messages
      .filter((m) => m.type === 'console' && m.stream === 'stdout')
      .map((m) => m.text ?? '')
      .join('');
    expect(stdout).toContain('cowsay module: cowsay');
    expect(messages.some((m) => m.type === 'result')).toBe(true);
    expect(page.pageErrors).toEqual([]);
  }, 120_000);
});
