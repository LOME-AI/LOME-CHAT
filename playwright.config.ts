import { defineConfig, devices } from '@playwright/test';

import { TIMEOUTS } from './e2e/config/timeouts';

const isCI = !!process.env['CI'];

// All projects render at DPR 1. The retina presets (iPhone 15 = 3, Pixel 7 ≈
// 2.625, iPad Pro = 2, Desktop Safari = 2) rasterize several× the pixels for no
// coverage gain — the CSS viewport is unchanged, only raster fidelity drops. Set
// per-project because a top-level `use` is overridden by each `...devices[...]`.
const DEVICE_SCALE_FACTOR = 1;

const previewPort = process.env['HB_PREVIEW_PORT']!;
const apiPort = process.env['HB_API_PORT']!;
const adminPort = process.env['HB_ADMIN_PORT']!;
const previewUrl = `http://localhost:${previewPort}`;
const apiUrl = `http://localhost:${apiPort}`;
const adminUrl = `http://localhost:${adminPort}`;

// Chromium-only launch flag, scoped to chromium-based projects (WebKit rejects
// unknown flags and fails to launch). --disable-dev-shm-usage keeps Chromium
// off the small /dev/shm tmpfs; the DevBox entrypoint also grows /dev/shm. GPU
// acceleration is intentionally left enabled so the iGPU offloads rendering —
// the renderer each engine resolves to is printed once per run by
// e2e/global-setup.ts.
const chromiumLaunchOptions = { args: ['--disable-dev-shm-usage'] };

// Project-level gate for the `@chromium-only` tag: tests carrying it run on the
// `chromium` project only. Spread into every other project so they skip those
// tests in both CI and local runs. Project `grepInvert` composes (AND) with the
// CLI `--grep-invert` the CI matrix passes for `@local-only`/`@webhook`, so the
// two gating mechanisms don't interfere. Matched against the tagged test title.
const excludeChromiumOnly = { grepInvert: /@chromium-only/ } as const;

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  maxFailures: isCI ? 1 : 0,
  workers: isCI ? 7 : '50%',
  timeout: TIMEOUTS.LONG,
  // Backstop so a wedged run can't hang forever. Playwright aborts via its
  // normal shutdown, which group-kills each webServer — so it won't leak orphan
  // dev servers the way a hard Ctrl+C of a stuck run does. Sized above the
  // observed full local matrix (~46m); the multiplier is a fixed count of the
  // per-test budget, not runtime scaling. Raise the count if the matrix grows.
  globalTimeout: 75 * TIMEOUTS.LONG,
  expect: {
    timeout: TIMEOUTS.ASSERT,
  },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }], ['./scripts/e2e-reporter.ts']],
  use: {
    baseURL: previewUrl,
    // CI captures nothing (failures reproduce locally); local keeps what the
    // debug report consumes — trace, failure screenshot, HAR (in fixtures),
    // console/api/snapshot. Video is off everywhere: the report never reads it.
    trace: isCI ? 'off' : 'retain-on-first-failure',
    screenshot: isCI ? 'off' : 'only-on-failure',
    video: 'off',
    // Determinism: pin clock zone and locale so date/number/collation behaviour
    // is identical on every machine and in CI. Time itself is controlled
    // per-test via page.clock where a test depends on it.
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  webServer: [
    {
      // Builds marketing + web, merges them, then serves the result. The merged
      // dist is exactly what Cloudflare Pages serves in production (/chat,
      // /roadmap, /welcome, /blog reachable from one origin), so E2E covers the
      // same routing as users see. The build is inside the webServer command
      // (not globalSetup) because Playwright spawns webServer in parallel with
      // globalSetup — `vite preview` would race against the build otherwise.
      //
      // `build:e2e` is the single web-bundle build path (Turbo-cached + parallel,
      // self-regenerating its e2e env). When `HB_E2E_PREBUILT` is set the bundle
      // was already built and downloaded (CI's e2e-build job), so skip straight
      // to serving it.
      command:
        (process.env['HB_E2E_PREBUILT'] ? '' : 'pnpm build:e2e && ') +
        `pnpm --filter @hushbox/web preview --port ${previewPort}`,
      url: previewUrl,
      reuseExistingServer: false,
      timeout: 300_000,
      name: 'Preview',
      stdout: 'ignore',
    },
    {
      // `e2e:prepare` (run before `playwright test`) brings up containers via
      // ensure-stack, runs migrations, then seeds the e2e personas. The
      // webServer just spawns wrangler dev.
      command: 'pnpm --filter @hushbox/api dev',
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      name: 'API',
      stdout: 'ignore',
    },
    {
      // The admin SPA's vite dev server (not a preview build): its `/api`
      // proxy to the Worker and its dev-JWT self-auth are dev-server behavior,
      // so the dev server IS the surface under test for the admin project.
      command: 'pnpm --filter @hushbox/admin dev',
      url: adminUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      name: 'Admin',
      stdout: 'ignore',
    },
  ],
  projects: [
    // One setup project per test project; each authenticates that project's
    // personas (suffixed with the project name) to e2e/.auth/<project>/*.json.
    // Naturally gated: setup runs only when its dependent project is in the
    // run, so CI matrix jobs touch a single user pool.
    {
      name: 'setup-chromium',
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'setup-firefox',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Firefox'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
      // Per-project worker cap. Firefox content-process inits are race-prone
      // on lower-spec CPUs (Ryzen 5 5500 without iGPU SIGSEGV'd at workers=5
      // / 45% of cores in the firefox project specifically). Capping just
      // the firefox projects keeps other projects at the full global pool.
      workers: isCI ? 4 : '30%',
    },
    {
      name: 'setup-webkit',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Safari'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
    },
    {
      name: 'setup-iphone-15',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['iPhone 15'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
    },
    {
      name: 'setup-pixel-7',
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices['Pixel 7'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'setup-ipad-pro',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['iPad Pro 11'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
    },
    {
      name: 'setup-auth-tests',
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'auth-tests',
      ...excludeChromiumOnly,
      testDir: './e2e/auth',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/auth-tests/test-alice.json',
        launchOptions: chromiumLaunchOptions,
      },
      dependencies: ['setup-auth-tests'],
    },
    {
      // Admin SPA project: points at the admin dev server, not the web
      // preview. No storageState and no auth.setup dependency — the SPA
      // self-authenticates in dev (its fetch wrapper mints a dev Access JWT
      // from GET /api/dev/admin-token), and API-level specs mint their own
      // JWT via the adminApi fixture. e2e/admin/** is excluded from every
      // browser-matrix project below, so admin specs run here only.
      name: 'admin',
      testDir: './e2e/admin',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        baseURL: adminUrl,
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/chromium/test-alice.json',
        launchOptions: chromiumLaunchOptions,
      },
      testDir: './e2e',
      // `**/auth/**` keeps e2e/auth/** in the auth-tests project only; those specs
      // are chromium-family-only, and auth-tests is the dedicated chromium run for
      // them. Gating here (not via the @chromium-only tag) is required because
      // auth-tests grepInverts @chromium-only, so the tag can't reach it.
      testIgnore: ['**/mobile/**', '**/auth/**', '**/admin/**'],
      dependencies: ['setup-chromium'],
    },
    {
      name: 'firefox',
      ...excludeChromiumOnly,
      use: {
        ...devices['Desktop Firefox'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/firefox/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/auth/**', '**/admin/**'],
      dependencies: ['setup-firefox'],
      // See setup-firefox above for why firefox is capped below the global
      // worker count. Other projects are unconstrained and can use the
      // remaining slots while firefox tests are throttled.
      workers: isCI ? 4 : '30%',
    },
    {
      name: 'webkit',
      ...excludeChromiumOnly,
      use: {
        ...devices['Desktop Safari'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/webkit/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/auth/**', '**/admin/**'],
      dependencies: ['setup-webkit'],
    },
    {
      name: 'iphone-15',
      ...excludeChromiumOnly,
      use: {
        ...devices['iPhone 15'],
        // Pin DPR below the device's retina factor to free render budget (see
        // DEVICE_SCALE_FACTOR). The CSS viewport is unchanged, so coverage is too.
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/iphone-15/test-alice.json',
      },
      testIgnore: ['**/auth/**', '**/admin/**'],
      dependencies: ['setup-iphone-15'],
    },
    {
      name: 'pixel-7',
      ...excludeChromiumOnly,
      use: {
        ...devices['Pixel 7'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/pixel-7/test-alice.json',
        launchOptions: chromiumLaunchOptions,
      },
      testIgnore: ['**/auth/**', '**/admin/**'],
      dependencies: ['setup-pixel-7'],
    },
    {
      name: 'ipad-pro',
      ...excludeChromiumOnly,
      use: {
        ...devices['iPad Pro 11'],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        storageState: 'e2e/.auth/ipad-pro/test-alice.json',
      },
      testIgnore: ['**/auth/**', '**/admin/**'],
      dependencies: ['setup-ipad-pro'],
    },
  ],
});
