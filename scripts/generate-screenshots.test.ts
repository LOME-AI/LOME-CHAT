import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getScreenshotConfigs,
  getResolutionConfigs,
  getScreenshotOutputPath,
  generateScreenshots,
  generateSingleScreenshot,
  assertScreenshotSeedDefined,
  SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE,
} from './generate-screenshots.js';
import { seedUUID } from './lib/seed-uuid.js';

const launchMock = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch: launchMock } }));

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_CLI = path.join(SCRIPTS_DIR, 'generate-screenshots.ts');

interface FakeLocator {
  waitFor: (options?: unknown) => Promise<void>;
  click: () => Promise<void>;
  first: () => FakeLocator;
  locator: (selector: string) => FakeLocator;
  evaluate: (function_: (element: { scrollTop: number }) => void) => Promise<void>;
  evaluateAll: (
    function_: (elements: { getAttribute: (name: string) => string | null }[]) => unknown
  ) => Promise<unknown>;
}

interface BrowserHarness {
  gotos: string[];
  clicks: string[];
  screenshots: string[];
  contextOptions: unknown[];
  storageStatePaths: string[];
  browserClose: ReturnType<typeof vi.fn>;
  /** Selectors whose waitFor() should reject. */
  failWaitForSelectors: Set<string>;
  /** When set, page.screenshot() rejects on this (1-based) call. */
  failScreenshotAtCall: number | null;
  browser: unknown;
}

function createBrowserHarness(): BrowserHarness {
  const harness: BrowserHarness = {
    gotos: [],
    clicks: [],
    screenshots: [],
    contextOptions: [],
    storageStatePaths: [],
    browserClose: vi.fn(),
    failWaitForSelectors: new Set<string>(),
    failScreenshotAtCall: null,
    browser: null,
  };

  function makeLocator(selector: string): FakeLocator {
    const locator: FakeLocator = {
      waitFor: (): Promise<void> =>
        harness.failWaitForSelectors.has(selector)
          ? Promise.reject(new Error(`waitFor timed out: ${selector}`))
          : Promise.resolve(),
      click: (): Promise<void> => {
        harness.clicks.push(selector);
        return Promise.resolve();
      },
      first: (): FakeLocator => locator,
      locator: (child: string): FakeLocator => makeLocator(`${selector} >> ${child}`),
      evaluate: (function_): Promise<void> => {
        function_({ scrollTop: 1 });
        return Promise.resolve();
      },
      evaluateAll: (function_): Promise<unknown> =>
        Promise.resolve(function_([{ getAttribute: (): string => 'composer-input' }])),
    };
    return locator;
  }

  function makePage(): unknown {
    return {
      goto: (url: string): Promise<void> => {
        harness.gotos.push(url);
        return Promise.resolve();
      },
      getByRole: (role: string, options: { name: string }): FakeLocator =>
        makeLocator(`role=${role}[name="${options.name}"]`),
      locator: (selector: string): FakeLocator => makeLocator(selector),
      screenshot: (options: { path: string }): Promise<void> => {
        harness.screenshots.push(options.path);
        if (
          harness.failScreenshotAtCall !== null &&
          harness.screenshots.length === harness.failScreenshotAtCall
        ) {
          return Promise.reject(new Error('screenshot failed'));
        }
        return Promise.resolve();
      },
      url: (): string => 'http://localhost:5173/somewhere',
      waitForURL: (): Promise<void> => Promise.resolve(),
      waitForTimeout: (): Promise<void> => Promise.resolve(),
    };
  }

  const context = {
    newPage: (): Promise<unknown> => Promise.resolve(makePage()),
    close: (): Promise<void> => Promise.resolve(),
    storageState: (options: { path: string }): Promise<unknown> => {
      harness.storageStatePaths.push(options.path);
      return Promise.resolve({});
    },
  };

  harness.browser = {
    newContext: (options?: unknown): Promise<unknown> => {
      harness.contextOptions.push(options);
      return Promise.resolve(context);
    },
    close: harness.browserClose,
  };

  return harness;
}

describe('assertScreenshotSeedDefined', () => {
  it('throws the seed-not-defined error', () => {
    expect(() => {
      assertScreenshotSeedDefined();
    }).toThrow(SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE);
  });

  it('says what is missing in the message', () => {
    expect(SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE).toContain(
      'seed data for the redesigned schema is not yet defined'
    );
  });

  it('says what must happen in the message', () => {
    expect(SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE).toContain('Define seed data');
  });

  it('does not reference any legacy path in the message', () => {
    expect(SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE).not.toMatch(/legacy/i);
  });
});

describe('generate-screenshots CLI entry point', () => {
  it('exits with code 1 before doing any work', async () => {
    const result = await execa('tsx', [SCREENSHOTS_CLI], { reject: false });
    expect(result.exitCode).toBe(1);
  }, 30_000);

  it('prints the seed-not-defined error to stderr', async () => {
    const result = await execa('tsx', [SCREENSHOTS_CLI], { reject: false });
    expect(result.stderr).toContain('seed data for the redesigned schema is not yet defined');
  }, 30_000);
});

describe('screenshot capture flows', () => {
  let rootDir: string;
  let harness: BrowserHarness;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'hushbox-screenshot-test-'));
    harness = createBrowserHarness();
    launchMock.mockReset();
    launchMock.mockResolvedValue(harness.browser);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('generateScreenshots', () => {
    it('creates an output directory per resolution', async () => {
      await generateScreenshots(rootDir);

      for (const resolution of getResolutionConfigs()) {
        const directory = path.join(
          rootDir,
          'apps',
          'web',
          'resources',
          'assets',
          'screenshots',
          resolution.name
        );
        expect(existsSync(directory)).toBe(true);
      }
    });

    it('authenticates via the persona page before capturing', async () => {
      await generateScreenshots(rootDir);

      expect(harness.gotos[0]).toBe('http://localhost:5173/dev/personas');
      expect(harness.clicks).toContain('[data-testid="persona-card-alice"]');
      expect(harness.storageStatePaths).toHaveLength(1);
      expect(harness.storageStatePaths[0]).toContain('alice-storage-state.json');
    });

    it('reuses the saved storage state for every capture context', async () => {
      await generateScreenshots(rootDir);

      const captureContexts = harness.contextOptions.slice(1) as {
        storageState?: string;
      }[];
      expect(captureContexts).toHaveLength(24);
      for (const options of captureContexts) {
        expect(options.storageState).toBe(harness.storageStatePaths[0]);
      }
    });

    it('captures every screenshot at every resolution', async () => {
      await generateScreenshots(rootDir);

      expect(harness.screenshots).toHaveLength(24);
      for (const screenshot of getScreenshotConfigs()) {
        for (const resolution of getResolutionConfigs()) {
          expect(harness.screenshots).toContain(
            getScreenshotOutputPath(rootDir, resolution.name, screenshot.filename)
          );
        }
      }
    });

    it('navigates to the conversation derived from the seed key', async () => {
      await generateScreenshots(rootDir);

      const chatConversation = seedUUID('screenshot-conv-chat');
      expect(harness.gotos).toContain(`http://localhost:5173/chat/${chatConversation}`);
    });

    it('opens the model selector for the model-picker screenshot', async () => {
      await generateScreenshots(rootDir);

      const selectorClicks = harness.clicks.filter(
        (selector) => selector === '[data-testid="model-selector-button"]'
      );
      expect(selectorClicks).toHaveLength(4);
    });

    it('opens the document panel for document screenshots', async () => {
      await generateScreenshots(rootDir);

      const documentClicks = harness.clicks.filter(
        (selector) => selector === '[data-testid="document-card"]'
      );
      expect(documentClicks).toHaveLength(8);
    });

    it('closes the browser after a successful run', async () => {
      await generateScreenshots(rootDir);

      expect(harness.browserClose).toHaveBeenCalledTimes(1);
    });

    it('closes the browser when a capture fails', async () => {
      harness.failScreenshotAtCall = 3;

      await expect(generateScreenshots(rootDir)).rejects.toThrow('screenshot failed');
      expect(harness.browserClose).toHaveBeenCalledTimes(1);
    });

    it('logs page diagnostics when the message list never appears', async () => {
      harness.failWaitForSelectors.add('role=log[name="Chat messages"]');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(generateScreenshots(rootDir)).rejects.toThrow('waitFor timed out');
      const printed = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(printed.some((line) => line.includes('Page URL:'))).toBe(true);
      expect(printed.some((line) => line.includes('Visible testids: composer-input'))).toBe(true);
    });
  });

  describe('generateSingleScreenshot', () => {
    it('rejects an unknown screenshot name without launching a browser', async () => {
      await expect(generateSingleScreenshot(rootDir, 'nope')).rejects.toThrow(
        'Unknown screenshot: nope'
      );
      expect(launchMock).not.toHaveBeenCalled();
    });

    it('captures the named screenshot at every resolution', async () => {
      await generateSingleScreenshot(rootDir, 'group-chat');

      expect(harness.screenshots).toHaveLength(4);
      for (const resolution of getResolutionConfigs()) {
        expect(harness.screenshots).toContain(
          getScreenshotOutputPath(rootDir, resolution.name, 'group-chat.png')
        );
      }
    });

    it('captures the model-picker screenshot', async () => {
      await generateSingleScreenshot(rootDir, 'model-picker');
      expect(harness.screenshots).toHaveLength(4);
    });

    it('captures the document-code screenshot', async () => {
      await generateSingleScreenshot(rootDir, 'document-code');
      expect(harness.screenshots).toHaveLength(4);
    });

    it('renders the mermaid diagram before capturing document-mermaid', async () => {
      harness.failWaitForSelectors.add('[data-testid="mermaid-diagram"]');

      await expect(generateSingleScreenshot(rootDir, 'document-mermaid')).rejects.toThrow(
        'waitFor timed out'
      );
    });

    it('closes the browser when a capture fails', async () => {
      harness.failScreenshotAtCall = 1;

      await expect(generateSingleScreenshot(rootDir, 'privacy')).rejects.toThrow(
        'screenshot failed'
      );
      expect(harness.browserClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getScreenshotConfigs', () => {
  it('returns exactly 6 screenshot configurations', () => {
    const configs = getScreenshotConfigs();
    expect(configs).toHaveLength(6);
  });

  it('includes all required screenshot names', () => {
    const configs = getScreenshotConfigs();
    const names = configs.map((c) => c.name);
    expect(names).toContain('chat');
    expect(names).toContain('model-picker');
    expect(names).toContain('group-chat');
    expect(names).toContain('document-code');
    expect(names).toContain('document-mermaid');
    expect(names).toContain('privacy');
  });

  it('has a conversation seed key for each screenshot', () => {
    const configs = getScreenshotConfigs();
    for (const config of configs) {
      expect(config.conversationSeedKey).toMatch(/^screenshot-conv-/);
    }
  });

  it('model-picker uses the same conversation as chat', () => {
    const configs = getScreenshotConfigs();
    const chat = configs.find((c) => c.name === 'chat');
    const modelPicker = configs.find((c) => c.name === 'model-picker');
    expect(chat).toBeDefined();
    expect(modelPicker).toBeDefined();
    expect(modelPicker!.conversationSeedKey).toBe(chat!.conversationSeedKey);
  });

  it('has PNG filenames for each screenshot', () => {
    const configs = getScreenshotConfigs();
    for (const config of configs) {
      expect(config.filename).toBe(`${config.name}.png`);
    }
  });
});

describe('getResolutionConfigs', () => {
  it('returns exactly 4 resolution configurations', () => {
    const configs = getResolutionConfigs();
    expect(configs).toHaveLength(4);
  });

  it('includes apple-phone at 1320x2868 output', () => {
    const configs = getResolutionConfigs();
    const applePhone = configs.find((c) => c.name === 'apple-phone');
    expect(applePhone).toBeDefined();
    expect(applePhone!.outputWidth).toBe(1320);
    expect(applePhone!.outputHeight).toBe(2868);
  });

  it('includes apple-tablet at 2064x2752 output', () => {
    const configs = getResolutionConfigs();
    const appleTablet = configs.find((c) => c.name === 'apple-tablet');
    expect(appleTablet).toBeDefined();
    expect(appleTablet!.outputWidth).toBe(2064);
    expect(appleTablet!.outputHeight).toBe(2752);
  });

  it('includes google-phone at 1080x1920 output', () => {
    const configs = getResolutionConfigs();
    const googlePhone = configs.find((c) => c.name === 'google-phone');
    expect(googlePhone).toBeDefined();
    expect(googlePhone!.outputWidth).toBe(1080);
    expect(googlePhone!.outputHeight).toBe(1920);
  });

  it('includes google-tablet at 1200x1920 output', () => {
    const configs = getResolutionConfigs();
    const googleTablet = configs.find((c) => c.name === 'google-tablet');
    expect(googleTablet).toBeDefined();
    expect(googleTablet!.outputWidth).toBe(1200);
    expect(googleTablet!.outputHeight).toBe(1920);
  });

  it('has cssWidth * dpr equal to outputWidth for all resolutions', () => {
    const configs = getResolutionConfigs();
    for (const config of configs) {
      expect(config.cssWidth * config.dpr).toBe(config.outputWidth);
    }
  });

  it('has cssHeight * dpr equal to outputHeight for all resolutions', () => {
    const configs = getResolutionConfigs();
    for (const config of configs) {
      expect(config.cssHeight * config.dpr).toBe(config.outputHeight);
    }
  });

  it('uses DPR 3 for phones with realistic CSS viewports', () => {
    const configs = getResolutionConfigs();
    const applePhone = configs.find((c) => c.name === 'apple-phone')!;
    expect(applePhone.dpr).toBe(3);
    expect(applePhone.cssWidth).toBe(440);
    expect(applePhone.cssHeight).toBe(956);

    const googlePhone = configs.find((c) => c.name === 'google-phone')!;
    expect(googlePhone.dpr).toBe(3);
    expect(googlePhone.cssWidth).toBe(360);
    expect(googlePhone.cssHeight).toBe(640);
  });

  it('uses DPR 2 for tablets', () => {
    const configs = getResolutionConfigs();
    const tablets = configs.filter((c) => c.name.includes('tablet'));
    for (const tablet of tablets) {
      expect(tablet.dpr).toBe(2);
    }
  });
});

describe('getScreenshotOutputPath', () => {
  it('returns path under resources/assets/screenshots', () => {
    const result = getScreenshotOutputPath('/root', 'apple-phone', 'chat.png');
    expect(result).toBe('/root/apps/web/resources/assets/screenshots/apple-phone/chat.png');
  });

  it('handles different resolutions and filenames', () => {
    const result = getScreenshotOutputPath('/project', 'google-tablet', 'privacy.png');
    expect(result).toBe('/project/apps/web/resources/assets/screenshots/google-tablet/privacy.png');
  });
});
