import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getAssetConfigs,
  getOutputPath,
  generateAssets,
  generateSingleAsset,
} from './generate-assets.js';

const launchMock = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch: launchMock } }));

interface AssetHarness {
  gotos: string[];
  screenshots: string[];
  contextOptions: unknown[];
  browserClose: ReturnType<typeof vi.fn>;
  /** When set, page.screenshot() rejects on this (1-based) call. */
  failScreenshotAtCall: number | null;
  browser: unknown;
}

function createAssetHarness(): AssetHarness {
  const harness: AssetHarness = {
    gotos: [],
    screenshots: [],
    contextOptions: [],
    browserClose: vi.fn(),
    failScreenshotAtCall: null,
    browser: null,
  };

  const page = {
    goto: (url: string): Promise<void> => {
      harness.gotos.push(url);
      return Promise.resolve();
    },
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
  };

  const context = {
    newPage: (): Promise<unknown> => Promise.resolve(page),
    close: (): Promise<void> => Promise.resolve(),
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

describe('asset generation flows', () => {
  let rootDir: string;
  let harness: AssetHarness;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'hushbox-assets-test-'));
    harness = createAssetHarness();
    launchMock.mockReset();
    launchMock.mockResolvedValue(harness.browser);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('generateAssets', () => {
    it('creates the assets output directory', async () => {
      await generateAssets(rootDir);

      expect(existsSync(path.join(rootDir, 'apps', 'web', 'resources', 'assets'))).toBe(true);
    });

    it('captures every asset at its output path', async () => {
      await generateAssets(rootDir);

      expect(harness.screenshots).toHaveLength(5);
      for (const config of getAssetConfigs()) {
        expect(harness.screenshots).toContain(getOutputPath(rootDir, config.filename));
      }
    });

    it('navigates to each render URL on the dev server', async () => {
      await generateAssets(rootDir);

      for (const config of getAssetConfigs()) {
        expect(harness.gotos).toContain(`http://localhost:5173${config.renderUrl}`);
      }
    });

    it('opens a context sized to the asset CSS viewport and DPR', async () => {
      await generateAssets(rootDir);

      const splash = getAssetConfigs().find((config) => config.name === 'splash');
      expect(harness.contextOptions).toContainEqual({
        viewport: { width: splash!.cssWidth, height: splash!.cssHeight },
        deviceScaleFactor: splash!.dpr,
      });
    });

    it('closes the browser after a successful run', async () => {
      await generateAssets(rootDir);

      expect(harness.browserClose).toHaveBeenCalledTimes(1);
    });

    it('closes the browser when a capture fails', async () => {
      harness.failScreenshotAtCall = 2;

      await expect(generateAssets(rootDir)).rejects.toThrow('screenshot failed');
      expect(harness.browserClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateSingleAsset', () => {
    it('rejects an unknown asset name without launching a browser', async () => {
      await expect(generateSingleAsset(rootDir, 'nope')).rejects.toThrow('Unknown asset: nope');
      expect(launchMock).not.toHaveBeenCalled();
    });

    it('captures only the named asset', async () => {
      await generateSingleAsset(rootDir, 'icon-only');

      expect(harness.screenshots).toEqual([getOutputPath(rootDir, 'icon-only.png')]);
    });

    it('closes the browser when the capture fails', async () => {
      harness.failScreenshotAtCall = 1;

      await expect(generateSingleAsset(rootDir, 'splash-dark')).rejects.toThrow(
        'screenshot failed'
      );
      expect(harness.browserClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getAssetConfigs', () => {
  it('returns exactly 5 asset configurations', () => {
    const configs = getAssetConfigs();
    expect(configs).toHaveLength(5);
  });

  it('includes icon-only at 1024x1024 output', () => {
    const configs = getAssetConfigs();
    const iconOnly = configs.find((c) => c.name === 'icon-only');
    expect(iconOnly).toBeDefined();
    expect(iconOnly!.outputWidth).toBe(1024);
    expect(iconOnly!.outputHeight).toBe(1024);
  });

  it('includes icon-background at 1024x1024 output', () => {
    const configs = getAssetConfigs();
    const bg = configs.find((c) => c.name === 'icon-background');
    expect(bg).toBeDefined();
    expect(bg!.outputWidth).toBe(1024);
    expect(bg!.outputHeight).toBe(1024);
  });

  it('includes icon-foreground at 1024x1024 output', () => {
    const configs = getAssetConfigs();
    const fg = configs.find((c) => c.name === 'icon-foreground');
    expect(fg).toBeDefined();
    expect(fg!.outputWidth).toBe(1024);
    expect(fg!.outputHeight).toBe(1024);
  });

  it('includes splash-dark at 2732x2732 output', () => {
    const configs = getAssetConfigs();
    const dark = configs.find((c) => c.name === 'splash-dark');
    expect(dark).toBeDefined();
    expect(dark!.outputWidth).toBe(2732);
    expect(dark!.outputHeight).toBe(2732);
  });

  it('includes splash at 2732x2732 output', () => {
    const configs = getAssetConfigs();
    const splash = configs.find((c) => c.name === 'splash');
    expect(splash).toBeDefined();
    expect(splash!.outputWidth).toBe(2732);
    expect(splash!.outputHeight).toBe(2732);
  });

  it('has cssWidth * dpr equal to outputWidth for all assets', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.cssWidth * config.dpr).toBe(config.outputWidth);
    }
  });

  it('has cssHeight * dpr equal to outputHeight for all assets', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.cssHeight * config.dpr).toBe(config.outputHeight);
    }
  });

  it('uses DPR 2 for icons with 512x512 CSS viewport', () => {
    const configs = getAssetConfigs();
    const icons = configs.filter((c) => c.name.startsWith('icon'));
    for (const icon of icons) {
      expect(icon.dpr).toBe(2);
      expect(icon.cssWidth).toBe(512);
      expect(icon.cssHeight).toBe(512);
    }
  });

  it('uses DPR 2 for splashes with 1366x1366 CSS viewport', () => {
    const configs = getAssetConfigs();
    const splashes = configs.filter((c) => c.name.startsWith('splash'));
    for (const splash of splashes) {
      expect(splash.dpr).toBe(2);
      expect(splash.cssWidth).toBe(1366);
      expect(splash.cssHeight).toBe(1366);
    }
  });

  it('has a render URL for each asset', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.renderUrl).toBe(`/dev/render-asset/${config.name}`);
    }
  });

  it('has a PNG filename for each asset', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.filename).toBe(`${config.name}.png`);
    }
  });
});

describe('getOutputPath', () => {
  it('returns path under resources/assets', () => {
    const result = getOutputPath('/root', 'app-icon.png');
    expect(result).toBe('/root/apps/web/resources/assets/app-icon.png');
  });

  it('handles different filenames', () => {
    const result = getOutputPath('/project', 'splash-dark.png');
    expect(result).toBe('/project/apps/web/resources/assets/splash-dark.png');
  });
});
