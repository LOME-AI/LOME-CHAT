import { describe, it, expect } from 'vitest';
import {
  createOpaqueClient,
  OpaqueClientConfig,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
} from './opaque-client.js';
import {
  createOpaqueServerFromEnv,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  OpaqueRegistrationRecord,
  OpaqueKE1,
  OPAQUE_SERVER_IDENTIFIER,
} from './opaque-server.js';

const TEST_MASTER_SECRET = 'test-master-secret-at-least-32-bytes-long-for-testing';
const TEST_CREDENTIAL_ID = '00000000-0000-0000-0000-000000000042';

describe('opaque-client', () => {
  describe('createOpaqueClient', () => {
    it('creates an OPAQUE client instance', () => {
      const client = createOpaqueClient();

      expect(client).toBeDefined();
    });
  });

  describe('OpaqueClientConfig', () => {
    it('exports the OPAQUE configuration', () => {
      expect(OpaqueClientConfig).toBeDefined();
    });
  });

  describe('startRegistration', () => {
    it('returns a registration request with serialized array', async () => {
      const client = createOpaqueClient();

      const result = await startRegistration(client, 'test-password');

      expect(result).toHaveProperty('serialized');
      expect(Array.isArray(result.serialized)).toBe(true);
      expect(result.serialized.length).toBeGreaterThan(0);
    });

    it('returns different results for different passwords', async () => {
      const client1 = createOpaqueClient();
      const client2 = createOpaqueClient();

      const result1 = await startRegistration(client1, 'password1');
      const result2 = await startRegistration(client2, 'password2');

      // Requests should be different due to random blinding
      expect(result1.serialized).not.toEqual(result2.serialized);
    });

    it('throws when client is reused', async () => {
      const client = createOpaqueClient();

      await startRegistration(client, 'test-password');

      // Second call should throw because client is in REG_STARTED state
      await expect(startRegistration(client, 'test-password')).rejects.toThrow();
    });
  });

  describe('finishRegistration', () => {
    it('throws for invalid server response', async () => {
      const client = createOpaqueClient();
      await startRegistration(client, 'test-password');

      const invalidResponse = [1, 2, 3]; // Too short to be valid

      await expect(finishRegistration(client, invalidResponse)).rejects.toThrow();
    });

    // Characterization: opaque-ts signals state-machine misuse by returning
    // an Error value; the wrapper must surface it as a throw, not a result.
    it('throws "client not ready" when the client never started registration', async () => {
      const startedClient = createOpaqueClient();
      const { serialized } = await startRegistration(startedClient, 'test-password');
      const server = await createOpaqueServerFromEnv(TEST_MASTER_SECRET);
      const request = OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized);
      const response = await server.registerInit(request, TEST_CREDENTIAL_ID);
      if (response instanceof Error) throw response;

      const freshClient = createOpaqueClient();

      await expect(finishRegistration(freshClient, response.serialize())).rejects.toThrow(
        'client not ready'
      );
    });
  });

  describe('startLogin', () => {
    it('returns a login request with ke1 array', async () => {
      const client = createOpaqueClient();

      const result = await startLogin(client, 'test-password');

      expect(result).toHaveProperty('ke1');
      expect(Array.isArray(result.ke1)).toBe(true);
      expect(result.ke1.length).toBeGreaterThan(0);
    });

    it('returns different results for different passwords', async () => {
      const client1 = createOpaqueClient();
      const client2 = createOpaqueClient();

      const result1 = await startLogin(client1, 'password1');
      const result2 = await startLogin(client2, 'password2');

      // ke1 should be different due to random ephemeral key
      expect(result1.ke1).not.toEqual(result2.ke1);
    });

    it('throws when client is reused', async () => {
      const client = createOpaqueClient();

      await startLogin(client, 'test-password');

      // Second call should throw because client is in AUTH_STARTED state
      await expect(startLogin(client, 'test-password')).rejects.toThrow();
    });
  });

  describe('finishLogin', () => {
    it('throws for invalid server response', async () => {
      const client = createOpaqueClient();
      await startLogin(client, 'test-password');

      const invalidKe2 = [1, 2, 3]; // Too short to be valid

      await expect(finishLogin(client, invalidKe2)).rejects.toThrow();
    });

    // Characterization: a wrong password makes envelope recovery fail inside
    // authFinish, which opaque-ts reports as a returned Error value; the
    // wrapper must surface it as a throw.
    it('throws EnvelopeRecoveryError when the password does not match the record', async () => {
      const server = await createOpaqueServerFromEnv(TEST_MASTER_SECRET);

      const regClient = createOpaqueClient();
      const { serialized } = await startRegistration(regClient, 'correct-password');
      const request = OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized);
      const regResponse = await server.registerInit(request, TEST_CREDENTIAL_ID);
      if (regResponse instanceof Error) throw regResponse;
      const { record } = await finishRegistration(
        regClient,
        regResponse.serialize(),
        OPAQUE_SERVER_IDENTIFIER
      );

      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, 'wrong-password');
      const ke1Object = OpaqueKE1.deserialize(OpaqueServerConfig, ke1);
      const recordObject = OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, record);
      const authInit = await server.authInit(ke1Object, recordObject, TEST_CREDENTIAL_ID);
      if (authInit instanceof Error) throw authInit;

      await expect(
        finishLogin(loginClient, authInit.ke2.serialize(), OPAQUE_SERVER_IDENTIFIER)
      ).rejects.toThrow('EnvelopeRecoveryError');
    });
  });
});
