import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  rewrapAccountKeyForPasswordChange,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES, fromBase64, toBase64 } from '@hushbox/shared';
import {
  KEY_BLOBS,
  NEW_WRAPPED_KEY,
  PREFIX,
  db,
  evictedUserIds,
  expectStatus,
  get,
  login,
  post,
  registerAccount,
  registerLoginFull,
  sentPasswordChanged,
  sentPasswordReset,
  uniqueAccount,
} from './routes.integration.setup.js';

describe('identity routes: password change', () => {
  async function changePassword(
    cookie: string,
    oldPassword: string,
    newPassword: string
  ): Promise<Response> {
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, oldPassword);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(init.status).toBe(200);
    const initBody = await init.json<{
      ke2: number[];
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
    const { ke3 } = await opaqueClientFinishLogin(
      stepClient,
      initBody.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    return post(
      '/auth/change-password/finish',
      {
        ke3,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
  }

  it('rotates the password, stales prior sessions, and logs in with the new password', async () => {
    const { account, cookie } = await registerLoginFull();
    await expectStatus(get('/t/session', cookie), 200);
    const newPassword = `${account.password} rotated`;
    const finish = await changePassword(cookie, account.password, newPassword);
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The rotation forwards the eviction port through to close staled sockets.
    expect(evictedUserIds).toContain(account.userId);

    // The security notification reaches the account's address.
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(1);

    // AC3: the cookie issued before the watermark is now rejected.
    const stale = await get('/t/session', cookie);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });

    // The new password authenticates (the old one can no longer recover its
    // OPAQUE envelope client-side, so it cannot even produce a finish request).
    const relogin = await login(account.email, newPassword);
    expect(relogin.status).toBe(200);
  });

  it('rejects a wrong old password with the typed auth failure', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'new password here');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post(
      '/auth/change-password/finish',
      {
        ke3: [0, 1, 2],
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
    expect(finish.status).toBe(401);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    // A refused change never notifies.
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(0);
  });

  it('a revoked session cannot start a step-up op', async () => {
    const { cookie } = await registerLoginFull();
    await expectStatus(post('/auth/logout', {}, cookie), 200);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, 'whatever');
    const { serialized } = await opaqueClientStartRegistration(createOpaqueClient(), 'whatever');
    const res = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('identity routes: recovery', () => {
  it('returns the stored wrapped key for a known account', async () => {
    const account = await registerAccount();
    const res = await post('/auth/recovery/get-wrapped-key', { identifier: account.email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
    });
  });

  it('returns a same-shape dummy for an unknown account (enumeration safety)', async () => {
    const known = await registerAccount();
    const knownRes = await post('/auth/recovery/get-wrapped-key', { identifier: known.email });
    const unknownRes = await post('/auth/recovery/get-wrapped-key', {
      identifier: `${PREFIX}nobody@identity-routes.test`,
    });
    expect(unknownRes.status).toBe(knownRes.status);
    const unknownBody = await unknownRes.json<{ recoveryWrappedPrivateKey: string }>();
    const knownBody = await knownRes.json<{ recoveryWrappedPrivateKey: string }>();
    // Same JSON shape: exactly the one key, a base64 string, on both.
    expect(Object.keys(unknownBody)).toEqual(Object.keys(knownBody));
    expect(typeof unknownBody.recoveryWrappedPrivateKey).toBe('string');
  });

  it('answers a known and an unknown account with byte-identical response length', async () => {
    // A canonical client stores an ECIES wrap of the 32-byte account private
    // key; the dummy must be the same length or the body is an existence oracle.
    const realBlob = rewrapAccountKeyForPasswordChange(new Uint8Array(32), new Uint8Array(32));
    const known = await registerAccount(uniqueAccount(), {
      ...KEY_BLOBS,
      recoveryWrappedPrivateKey: toBase64(realBlob),
    });
    const knownRes = await post('/auth/recovery/get-wrapped-key', { identifier: known.email });
    const unknownRes = await post('/auth/recovery/get-wrapped-key', {
      identifier: `${PREFIX}void@identity-routes.test`,
    });
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    const knownBody = await knownRes.text();
    const unknownBody = await unknownRes.text();
    expect(unknownBody.length).toBe(knownBody.length);
  });

  async function unknownDummyBytes(identifier: string): Promise<Uint8Array> {
    const res = await post('/auth/recovery/get-wrapped-key', { identifier });
    expect(res.status).toBe(200);
    const body = await res.json<{ recoveryWrappedPrivateKey: string }>();
    return fromBase64(body.recoveryWrappedPrivateKey);
  }

  it('answers repeated queries for the same unknown identifier with the identical dummy', async () => {
    const ghost = `${PREFIX}stable-dummy@identity-routes.test`;
    const first = await unknownDummyBytes(ghost);
    const second = await unknownDummyBytes(ghost);
    expect([...second]).toEqual([...first]);
  });

  it('answers different unknown identifiers with different dummies', async () => {
    const first = await unknownDummyBytes(`${PREFIX}dummy-a@identity-routes.test`);
    const second = await unknownDummyBytes(`${PREFIX}dummy-b@identity-routes.test`);
    expect([...second]).not.toEqual([...first]);
  });

  it('never answers an unknown identifier with an all-zero dummy body', async () => {
    const bytes = await unknownDummyBytes(`${PREFIX}nonzero@identity-routes.test`);
    expect(bytes.slice(1).some((byte) => byte !== 0)).toBe(true);
  });

  it('stamps the real ECIES version byte on the dummy', async () => {
    const realBlob = rewrapAccountKeyForPasswordChange(new Uint8Array(32), new Uint8Array(32));
    const bytes = await unknownDummyBytes(`${PREFIX}versioned@identity-routes.test`);
    expect(bytes[0]).toBe(realBlob[0]);
  });

  it('resets the password via the recovery handshake and stales prior sessions', async () => {
    const { account, cookie } = await registerLoginFull();
    const newPassword = `${account.password} recovered`;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    expect(init.status).toBe(200);
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      recoverySessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post('/auth/recovery/reset/finish', {
      identifier: account.email,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The reset forwards the eviction port through to close staled sockets.
    expect(evictedUserIds).toContain(account.userId);

    // The reset sends the distinct password-reset notice, never the alarming
    // password-changed one, to the account's address.
    expect(sentPasswordReset.filter((sent) => sent.to === account.email)).toHaveLength(1);
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(0);

    await expectStatus(get('/t/session', cookie), 401);
    const relogin = await login(account.email, newPassword);
    expect(relogin.status).toBe(200);
  });

  it('answers reset init for an unknown identifier with the same started shape', async () => {
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'brand new password');
    const res = await post('/auth/recovery/reset/init', {
      identifier: `${PREFIX}ghost@identity-routes.test`,
      newRegistrationRequest: serialized,
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'newRegistrationResponse',
      'recoverySessionId',
    ]);
  });

  it('rejects a reset finish whose identifier does not match the handshake', async () => {
    const account = await registerAccount();
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'another password');
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      recoverySessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post('/auth/recovery/reset/finish', {
      identifier: `other-${account.email}`,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });
});

describe('identity routes: recovery/save', () => {
  it('persists the recovery-wrapped key and flags phrase acknowledgement', async () => {
    const { account, cookie } = await registerLoginFull();
    const blob = new Uint8Array([9, 8, 7]);
    const res = await post(
      '/auth/recovery/save',
      { recoveryWrappedPrivateKey: toBase64(blob) },
      cookie
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const [row] = await db
      .select({
        recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
      })
      .from(users)
      .where(eq(users.id, account.userId));
    expect([...(row?.recoveryWrappedPrivateKey ?? [])]).toEqual([...blob]);
    expect(row?.hasAcknowledgedPhrase).toBe(true);
  });

  it('rejects a malformed base64 body with a validation error', async () => {
    const { cookie } = await registerLoginFull();
    const res = await post('/auth/recovery/save', { recoveryWrappedPrivateKey: '!' }, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('denies recovery/save without a session (session-class default-deny)', async () => {
    const res = await post('/auth/recovery/save', {
      recoveryWrappedPrivateKey: toBase64(new Uint8Array([1])),
    });
    expect(res.status).toBe(401);
  });
});
