import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpaqueServer } from '@cloudflare/opaque-ts';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
} from './opaque-client.js';
import {
  createOpaqueServerFromEnv,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueServerConfig,
  OPAQUE_SERVER_IDENTIFIER,
} from './opaque-server.js';
import { opaqueStepUpInit, opaqueStepUpFinish } from './opaque-step-up.js';

const TEST_MASTER_SECRET = 'test-master-secret-at-least-32-bytes-long-for-testing';
const TEST_USER_ID = '00000000-0000-0000-0000-000000000042';

async function buildRegisteredUser(password: string): Promise<{
  opaqueRegistration: Uint8Array;
}> {
  const server = await createOpaqueServerFromEnv(TEST_MASTER_SECRET);
  const regClient = createOpaqueClient();
  const { serialized } = await startRegistration(regClient, password);

  const request = OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized);
  const regInit = await server.registerInit(request, TEST_USER_ID);
  if (regInit instanceof Error) throw regInit;

  const { record } = await finishRegistration(
    regClient,
    regInit.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );

  const recordObject = OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, record);
  return { opaqueRegistration: new Uint8Array(recordObject.serialize()) };
}

describe('opaqueStepUpInit + opaqueStepUpFinish', () => {
  const masterSecret = new TextEncoder().encode(TEST_MASTER_SECRET);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Characterization of error propagation: opaque-ts reports authInit
  // failures as returned Error values, and opaqueStepUpInit must surface
  // them as a throw. No real input can make authInit fail after the
  // deserialize steps succeed, so the library boundary is stubbed once.
  it('throws when the OPAQUE server authInit reports an Error value', async () => {
    const password = 'forced-authinit-password';
    const { opaqueRegistration } = await buildRegisteredUser(password);
    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    vi.spyOn(OpaqueServer.prototype, 'authInit').mockResolvedValueOnce(
      new Error('forced authInit failure')
    );

    await expect(
      opaqueStepUpInit({
        masterSecret,
        opaqueRegistration,
        username: TEST_USER_ID,
        ke1: new Uint8Array(ke1),
      })
    ).rejects.toThrow('forced authInit failure');
  });

  it('completes a full step-up round-trip with a real OPAQUE client', async () => {
    const password = 'roundtrip-password';
    const { opaqueRegistration } = await buildRegisteredUser(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const initResult = await opaqueStepUpInit({
      masterSecret,
      opaqueRegistration,
      username: TEST_USER_ID,
      ke1: new Uint8Array(ke1),
    });

    expect(initResult.ke2).toBeInstanceOf(Uint8Array);
    expect(initResult.ke2.length).toBeGreaterThan(0);
    expect(Array.isArray(initResult.expectedSerialized)).toBe(true);
    expect(initResult.expectedSerialized.length).toBeGreaterThan(0);

    const { ke3 } = await finishLogin(loginClient, [...initResult.ke2], OPAQUE_SERVER_IDENTIFIER);

    const finishResult = opaqueStepUpFinish({
      ke3: new Uint8Array(ke3),
      expectedSerialized: initResult.expectedSerialized,
    });

    expect(finishResult).toEqual({ ok: true });
  });

  it('rejects a tampered ke3 with { ok: false, reason: "bad-proof" }', async () => {
    const password = 'tampered-ke3-password';
    const { opaqueRegistration } = await buildRegisteredUser(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const initResult = await opaqueStepUpInit({
      masterSecret,
      opaqueRegistration,
      username: TEST_USER_ID,
      ke1: new Uint8Array(ke1),
    });

    const { ke3 } = await finishLogin(loginClient, [...initResult.ke2], OPAQUE_SERVER_IDENTIFIER);

    const tampered = new Uint8Array(ke3);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;

    const finishResult = opaqueStepUpFinish({
      ke3: tampered,
      expectedSerialized: initResult.expectedSerialized,
    });

    expect(finishResult).toEqual({ ok: false, reason: 'bad-proof' });
  });

  it('expectedSerialized round-trips through JSON without losing validity', async () => {
    const password = 'json-roundtrip-password';
    const { opaqueRegistration } = await buildRegisteredUser(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const initResult = await opaqueStepUpInit({
      masterSecret,
      opaqueRegistration,
      username: TEST_USER_ID,
      ke1: new Uint8Array(ke1),
    });

    // Simulate Redis serialization: JSON encode then decode the expected blob.
    const jsonText = JSON.stringify(initResult.expectedSerialized);
    const parsedExpected = JSON.parse(jsonText) as number[];

    expect(parsedExpected).toEqual(initResult.expectedSerialized);

    const { ke3 } = await finishLogin(loginClient, [...initResult.ke2], OPAQUE_SERVER_IDENTIFIER);

    const finishResult = opaqueStepUpFinish({
      ke3: new Uint8Array(ke3),
      expectedSerialized: parsedExpected,
    });

    expect(finishResult).toEqual({ ok: true });
  });

  it('rejects an unrelated ke3 produced by a parallel auth session against the same record', async () => {
    const password = 'parallel-session-password';
    const { opaqueRegistration } = await buildRegisteredUser(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const initResult = await opaqueStepUpInit({
      masterSecret,
      opaqueRegistration,
      username: TEST_USER_ID,
      ke1: new Uint8Array(ke1),
    });

    // Run a fully independent OPAQUE session with the same password+record but
    // a fresh client and authInit. The resulting ke3 is structurally valid
    // (correct length, parseable) but binds the *other* session's MAC.
    // authFinish on the original expected must reject it.
    const parallelClient = createOpaqueClient();
    const { ke1: parallelKe1 } = await startLogin(parallelClient, password);
    const parallelInit = await opaqueStepUpInit({
      masterSecret,
      opaqueRegistration,
      username: TEST_USER_ID,
      ke1: new Uint8Array(parallelKe1),
    });
    const { ke3: unrelatedKe3 } = await finishLogin(
      parallelClient,
      [...parallelInit.ke2],
      OPAQUE_SERVER_IDENTIFIER
    );

    const finishResult = opaqueStepUpFinish({
      ke3: new Uint8Array(unrelatedKe3),
      expectedSerialized: initResult.expectedSerialized,
    });

    expect(finishResult).toEqual({ ok: false, reason: 'bad-proof' });
  });
});
