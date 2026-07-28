import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  recordServiceEvidence,
  SERVICE_NAMES,
  type Database,
} from '@hushbox/db';
import { createEnvUtilities, type EnvContext, type EnvUtilities } from '@hushbox/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectFcmErrorCodes, createFcmPushSender } from './push-fcm.js';

/**
 * The real FCM send path against Google, CI-vitest only. It proves what no
 * mocked test can: that the service-account JWT our RS256 signer produces is
 * accepted by Google's own token endpoint, and that the request our adapter
 * builds reaches FCM's v1 API as a well-formed, authenticated, correctly
 * scoped send. `validate_only` keeps it off real devices; the token is
 * fabricated, so FCM is expected to reject the message itself — which is the
 * part that also lets the test check our error classifier against a real
 * Google error body instead of a fixture we wrote.
 *
 * `SERVICE_NAMES.PUSH_FCM` evidence is recorded only after that real call
 * succeeded, so `pnpm verify:evidence --require=push-fcm` cannot be satisfied
 * by a mocked seam. Without the credentials the suite skips and that step
 * fails loudly — the intended guard.
 */

function readEnv(): EnvContext {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
  };
}

/** CI-vitest (CI, not E2E) with the credentials — the only shell that calls Google. */
function deriveFcmLiveGate(envUtilities: EnvUtilities, hasCredentials: boolean): boolean {
  return envUtilities.isCI && !envUtilities.isE2E && hasCredentials;
}

const projectId = process.env['FCM_PROJECT_ID_CI'];
const serviceAccountJson = process.env['FCM_SERVICE_ACCOUNT_JSON_CI'];
const HAS_CREDENTIALS =
  projectId !== undefined &&
  projectId.length > 0 &&
  serviceAccountJson !== undefined &&
  serviceAccountJson.length > 0;

/** THE one `createEnvUtilities` derivation for this harness (vitest sets NODE_ENV). */
const AMBIENT_ENV = createEnvUtilities(readEnv());

const shouldRun = deriveFcmLiveGate(AMBIENT_ENV, HAS_CREDENTIALS);

describe('deriveFcmLiveGate', () => {
  it('refuses a local vitest shell even with the credentials present', () => {
    expect(
      deriveFcmLiveGate(createEnvUtilities({ NODE_ENV: 'development', VITEST: 'true' }), true)
    ).toBe(false);
  });

  it('refuses a CI-E2E shell', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(false);
  });

  it('refuses CI-vitest without the credentials (skip — verify:evidence is the loud guard)', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        false
      )
    ).toBe(false);
  });

  it('admits only CI-vitest with the credentials', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(true);
  });
});

/** A syntactically plausible device token that was never issued by FCM. */
const FABRICATED_TOKEN = 'hushbox-ci-validation-token-never-issued-by-fcm';

interface CapturedLeg {
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Google minted an access token for our RS256-signed service-account JWT. */
function expectOAuthAccepted(leg: CapturedLeg | undefined): void {
  expect(leg?.url).toBe('https://oauth2.googleapis.com/token');
  const accessToken = (leg?.body as { access_token?: unknown } | undefined)?.access_token;
  expect(typeof accessToken).toBe('string');
}

/**
 * FCM answered the send as FCM: either it accepted the message, or it rejected
 * the fabricated token in its documented error shape. Neither the HTTP status
 * of a rejection nor the success placeholder is contractual, so only the shape
 * is asserted — except 401, which would mean our credential or scope was
 * refused and is the one answer that falsifies this proof.
 */
function expectFcmVerdict(leg: CapturedLeg | undefined): void {
  expect(leg?.status).not.toBe(401);
  const body = leg?.body as { name?: unknown; error?: unknown } | undefined;
  if (typeof body?.name === 'string') {
    expect(body.name.length).toBeGreaterThan(0);
    return;
  }
  const details = (body?.error as { details?: unknown } | undefined)?.details;
  expect(Array.isArray(details)).toBe(true);
  const detailTypes = (details as { '@type'?: unknown }[]).map((detail) => String(detail['@type']));
  expect(
    detailTypes.some(
      (type) =>
        type.endsWith('google.firebase.fcm.v1.FcmError') || type.endsWith('google.rpc.BadRequest')
    )
  ).toBe(true);
  // Our own classifier, run against Google's real error body rather than a
  // fixture written to match it.
  expect(collectFcmErrorCodes(body?.error).length).toBeGreaterThan(0);
}

describe.skipIf(!shouldRun)('createFcmPushSender — real FCM', () => {
  let db: Database;

  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error(
        'DATABASE_URL is required for the FCM live integration test — envConfig sets it in CI Vitest; verify the env-generation step ran.'
      );
    }
    db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  it(
    'exchanges a real service-account JWT and reaches FCM with a well-formed send',
    { timeout: 30_000 },
    async () => {
      if (projectId === undefined || serviceAccountJson === undefined) {
        throw new Error('unreachable');
      }

      // Both legs go to the real endpoints; the wrapper only records what came
      // back, so every byte the adapter sends is the adapter's own.
      const legs: CapturedLeg[] = [];
      const capturingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        legs.push({
          url: requestUrl(input),
          status: response.status,
          // A non-JSON body from either endpoint means the proof failed; let
          // the parse throw rather than hide it behind a fallback.
          body: await response.clone().json(),
        });
        return response;
      };

      const sender = createFcmPushSender({
        projectId,
        serviceAccountJson,
        fetchImpl: capturingFetch,
        validateOnly: true,
      });

      const result = await sender.send({
        recipients: [{ platform: 'android', userId: crypto.randomUUID(), token: FABRICATED_TOKEN }],
        payload: { category: 'message', conversationId: crypto.randomUUID() },
      });

      // A per-token rejection is a delivery count, never a transport error.
      expect(result.isOk()).toBe(true);

      const [oauthLeg, sendLeg] = legs;
      expectOAuthAccepted(oauthLeg);
      expect(sendLeg?.url).toBe(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`
      );
      expectFcmVerdict(sendLeg);

      await recordServiceEvidence(db, AMBIENT_ENV.isCI, SERVICE_NAMES.PUSH_FCM, {
        sendStatus: sendLeg?.status ?? 0,
        validateOnly: true,
      });
    }
  );
});
