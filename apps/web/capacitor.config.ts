import type { CapacitorConfig } from '@capacitor/cli';

import { createEnvUtilities } from '@hushbox/shared';

/**
 * WebView remote debugging is a release-time attack convenience, so it is on
 * only for development builds. This file is evaluated by the Capacitor CLI in a
 * plain Node process: `import.meta.env` (the app's usual env-mode source) does
 * not exist here and the CLI passes no mode signal, so the mode is read from
 * `process.env.NODE_ENV` and classified through the shared `createEnvUtilities`
 * detector rather than a raw string compare. NODE_ENV is unset during a bare
 * `cap sync`; that absence resolves to disabled (secure default) — feeding
 * `undefined` to `createEnvUtilities` fail-fasts by design and would break sync.
 */
export function resolveWebContentsDebugging(nodeEnv: string | undefined): boolean {
  if (nodeEnv === undefined) return false;
  return createEnvUtilities({ NODE_ENV: nodeEnv }).isDev;
}

const config: CapacitorConfig = {
  appId: 'ai.hushbox.app',
  appName: 'HushBox',
  webDir: 'dist',
  server: {
    // Use http scheme so the WebView origin (http://localhost) is same-site with
    // the dev API (http://localhost:PORT). SameSite=lax cookies require same-site.
    // Production uses SameSite=none;Secure=true so the scheme doesn't matter.
    androidScheme: 'http',
  },
  android: {
    webContentsDebuggingEnabled: resolveWebContentsDebugging(process.env['NODE_ENV']),
  },
  plugins: {
    CapacitorUpdater: {
      autoUpdate: false,
    },
    CapacitorCookies: { enabled: true },
    CapacitorHttp: { enabled: false },
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#000000',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
