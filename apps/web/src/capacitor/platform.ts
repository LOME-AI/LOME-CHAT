import { z } from 'zod';
import { VALID_PLATFORMS, isPaymentDisabledPlatform } from '@hushbox/shared';
import type { Platform } from '@hushbox/shared';

// Registry-backed: `envConfig` supplies VITE_PLATFORM for every mode (validated
// there as `z.enum(VALID_PLATFORMS)`), so a missing/invalid value is a broken
// bootstrap that must fail fast (zod throws), never silently resolve to 'web'.
const platform: Platform = z.enum(VALID_PLATFORMS).parse(import.meta.env['VITE_PLATFORM']);

/** Returns the build-time platform target. */
export function getPlatform(): Platform {
  return platform;
}

/** Returns true when running inside a Capacitor native shell (iOS or Android). */
export function isNative(): boolean {
  return platform !== 'web';
}

/** Returns true when in-app payment must be disabled (App Store / Play Store). */
export function isPaymentDisabled(): boolean {
  return isPaymentDisabledPlatform(platform);
}
