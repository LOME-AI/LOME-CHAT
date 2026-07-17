import { requireEnv } from '../../helpers/env.js';
import { withRequestRetry } from '../../helpers/resilient-request.js';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * The header Cloudflare Access forwards its signed identity assertion in
 * (mirrors `CF_ACCESS_JWT_HEADER` in apps/api's admin pipeline stage). The
 * garbage-token boundary test needs the literal without minting anything,
 * so it lives here rather than being read off a mint response.
 */
export const CF_ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

type PlaywrightApi = PlaywrightWorkerArgs['playwright'];

/**
 * Raw request contexts for the auth-boundary spec: unlike `adminApi`, these
 * deliberately carry NO assertion (or a hostile one), because the subject
 * under test is the Worker's refusal. Retry-wrapped like every harness
 * context so a transient saturation drop never masquerades as a denial.
 */
export async function anonApiContext(playwright: PlaywrightApi): Promise<APIRequestContext> {
  return withRequestRetry(await playwright.request.newContext({ baseURL: API_BASE }));
}

/** A context presenting the given value under the Access assertion header. */
export async function tokenApiContext(
  playwright: PlaywrightApi,
  token: string,
  header: string = CF_ACCESS_JWT_HEADER
): Promise<APIRequestContext> {
  return withRequestRetry(
    await playwright.request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { [header]: token },
    })
  );
}

export interface MintedDevToken {
  readonly token: string;
  readonly header: string;
}

/**
 * Mint a dev Access JWT for an arbitrary email via `GET /dev/admin-token`.
 * The dev mint signs for ANY syntactically-valid email by design (the
 * allowlist is enforced at verification, not at mint — a non-allowlisted
 * mint is a deliberate denial fixture); throws on a non-200 so a broken
 * mint fails at setup, never mid-assertion.
 */
export async function mintDevToken(
  context: APIRequestContext,
  email: string
): Promise<MintedDevToken> {
  const response = await context.get('/dev/admin-token', { params: { email } });
  if (response.status() !== 200) {
    throw new Error(`dev admin token mint for ${email} failed: ${String(response.status())}`);
  }
  return (await response.json()) as MintedDevToken;
}

/** Dispose every context a test built, in one shot (finally-block hygiene). */
export async function disposeAll(contexts: readonly APIRequestContext[]): Promise<void> {
  for (const context of contexts) {
    await context.dispose();
  }
}
