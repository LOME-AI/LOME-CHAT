import type { Bindings, RequiredBindings } from './app-env.js';

/**
 * Completeness-enforced: `satisfies Record<keyof RequiredBindings, true>`
 * makes adding a key to `RequiredBindings` without listing it here a compile
 * error, so the fail-fast gate can never silently skip a new binding.
 */
const REQUIRED_BINDING_PRESENCE = {
  DATABASE_URL: true,
  UPSTASH_REDIS_REST_URL: true,
  UPSTASH_REDIS_REST_TOKEN: true,
  IRON_SESSION_SECRET: true,
} as const satisfies Record<keyof RequiredBindings, true>;

const REQUIRED_BINDING_NAMES = Object.keys(
  REQUIRED_BINDING_PRESENCE
) as readonly (keyof RequiredBindings)[];

/**
 * Fail-fast gate on the Worker's bindings: every binding the pipeline needs
 * is checked here, once, at the top of the request — a missing one throws a
 * defect naming it (deployment misconfiguration), never a downstream null
 * deref. Empty strings count as missing: a blank var in wrangler config is
 * the same operator error as an absent one.
 */
export function assertRequiredBindings(env: Bindings): RequiredBindings {
  const missing = REQUIRED_BINDING_NAMES.filter((name) => {
    const value = env[name];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `pipeline: missing required binding(s): ${missing.join(', ')}. ` +
        'Set them in wrangler config / .dev.vars — the pipeline fails fast instead of degrading.'
    );
  }
  return env as RequiredBindings;
}
